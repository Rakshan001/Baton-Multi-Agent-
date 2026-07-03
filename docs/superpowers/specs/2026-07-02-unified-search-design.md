# Unified context search (`search_context`) — design

**Date:** 2026-07-02 · **Status:** approved-pending-review · **Branch target:** `feat/worktree-orchestration`

## Problem

Baton stores four kinds of agent-usable knowledge — memory facts, completion
reports, task/commit history, and the code graph — but agents can't *find*
things across them:

- `queryFile` (history) is exact-path lookup only; "who changed the checkout
  retry logic?" returns nothing without the exact path.
- `recall_memory` is word-boundary keyword scoring; paraphrases miss.
- Commits know **files**, the graph knows **symbols**; they never join, so
  "which commits touched `handleUpgrade`?" is unanswerable.
- Each store is a separate MCP tool with no shared ranking or token budget, so
  agents burn tokens querying them one by one — or fall back to reading raw
  `git log` output.

## Evidence (why this design)

- **RepoMem** (arXiv 2510.01003): commit history + summaries as agent memory →
  **+4.9 pts** localization Acc@5. Ablation: raw commit history alone = +2.7;
  LLM summaries only +2 more (Baton's completion reports fill that slot for
  free). **Dense embeddings underperformed BM25** in their runs.
- **LocAgent** (arXiv 2503.09089): removing BM25 entity search cost **−13.1
  pts**; removing graph traversal only −2.2. Sparse search is the backbone;
  traversal is secondary. Indented-tree output beat JSON in their ablation.
- **Identifier-aware tokenization** (arXiv 2605.18561): emitting whole
  identifiers *plus* camelCase/snake_case subtokens improved BM25 code
  retrieval **~82%** over default tokenization.
- **FTS5 is in `node:sqlite`** since Node 22.16 / 24.0 (nodejs/node#57621);
  verified working with `bm25()` on this machine (Node 26.3.0). Zero new deps.
- Stale-context study (arXiv 2605.14478): stale facts injected obsolete code in
  13–15/17 samples — search results must pass the existing anchor re-check.

## Goals

1. One agent-facing MCP tool `search_context` that BM25-ranks **facts, tasks,
   commits, and reports** in a single call, joined to graph symbols, hard
   token-budgeted, every hit cited.
2. Deterministic merge-time enrichment: conventional-commit parse, per-file
   stats, **commit↔symbol rows** from git hunk headers resolved against
   graph.json. **No LLM anywhere in the index or query path.**
3. A companion expander `show_change(sha|slug)` for full detail on demand
   (two-step retrieval = the token-budget mechanism).
4. Memory facts surface through the same search **with stale-withholding
   applied after ranking** — a stale fact is never served, same as today.
5. Works in both a single repo and a multi-repo hub (rows carry `project`).

## Non-goals

- No embeddings/vector store (evidence: sparse beat dense; keeps zero-dep).
- No commit nodes inside graph.json (structure stays JSON, time stays SQLite,
  joined by path/symbol keys).
- No LLM merge summaries (reports already fill that slot).
- No rename-chasing symbol tracking (CodeTracker-style) in v1.
- No CODEBASE.md sections in the index (it's <2k tokens and served whole).
- No live working-tree indexing (arrives later with shadow-ref checkpointing).

## Schema — extend `history.db`, no new store

```sql
-- widen existing tables (data already available at merge time)
ALTER TABLE commits ADD COLUMN ctype TEXT;          -- feat|fix|refactor|… or NULL
ALTER TABLE commits ADD COLUMN cscope TEXT;
ALTER TABLE commits ADD COLUMN breaking INTEGER DEFAULT 0;
ALTER TABLE commit_files ADD COLUMN status TEXT;    -- A/M/D/R
ALTER TABLE commit_files ADD COLUMN insertions INTEGER;
ALTER TABLE commit_files ADD COLUMN deletions INTEGER;
ALTER TABLE tasks ADD COLUMN project TEXT;          -- hub sub-project id, NULL single-repo

-- the commits ↔ symbols join (the "change-history graph" edge)
CREATE TABLE IF NOT EXISTS commit_symbols (
  sha TEXT, slug TEXT, path TEXT,
  symbol TEXT,          -- graph.json node id when resolved, else raw funcname
  source TEXT,          -- 'hunk' (git funcname) | 'graph' (resolved node id)
  PRIMARY KEY (sha, path, symbol)
);
CREATE INDEX IF NOT EXISTS idx_commit_symbols_symbol ON commit_symbols(symbol);

-- FTS5 (feature-detected; LIKE-scan fallback keeps the same tool contract)
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  kind UNINDEXED,       -- 'commit' | 'fact'   (tasks/reports fold into commit rows)
  ref UNINDEXED,        -- sha or fact id
  slug UNINDEXED,
  message,              -- commit subject+body        (weight 1.0)
  task,                 -- task title                 (weight 3.0 — higher-quality text)
  symbols,              -- identifiers + subtokens    (weight 4.0)
  paths,                -- file paths + segment subtokens (weight 2.0)
  report,               -- completion-report summary  (weight 2.0)
  tokenize = "unicode61 tokenchars '_'"
);
```

Migration: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` guarded by a
`PRAGMA user_version` bump; existing DBs migrate in place on first open.
Existing rows backfill lazily (a one-shot `reindexHistory()` walks tasks →
commits → archived refs and repopulates enrichment columns + FTS).

## Merge-time pipeline (extends `recordMerge`, same transaction)

All deterministic, per commit of the merged task:

1. `git show --numstat` → per-file status/insertions/deletions.
2. Conventional-commit regex (`^(\w+)(\(([^)]+)\))?(!)?:\s`) → ctype/cscope/
   breaking; non-conforming messages leave NULLs (never guessed).
3. `git show --unified=0` hunk headers (`@@ … @@ funcName`) → enclosing-function
   names per file → `commit_symbols(source='hunk')`.
4. Resolve funcnames + changed files against the project's graph.json
   (name match within same `source_file`) → upgrade to `source='graph'`
   with the canonical node id. Graph missing/stale → keep the hunk rows.
5. Insert one `history_fts` row: message + task title + subtokenized symbols
   and paths + (report column updated when the completion report is saved,
   which happens right after merge in the same flow).

Fact rows: `saveMemory`/`removeMemory`/`gcMemories` upsert/delete their
`history_fts` row (kind='fact') at write time — facts already live as files;
the FTS row is a shadow index only.

**Tokenizer (shared helper, pure TS):** for every identifier and path segment
emit the original token *plus* subtokens split on
`/(?<=[a-z0-9])(?=[A-Z])|[_\-./]/`, lowercased. `handleWebSocketUpgrade` →
`handlewebsocketupgrade handle web socket upgrade`.

## Query flow

```
search_context(query, filters…)
  → FTS5 MATCH with bm25(history_fts, …per-column weights)   [or LIKE fallback]
  → SQL-filter: kind / path prefix / symbol / agent / project / since / until
  → facts: re-check anchors (existing memory logic) — stale hits DROPPED
  → optional focal-path bump: same-dir prefix or graph `imports` adjacency
  → render compact indented-tree rows, stop at max_tokens, set truncated
```

### Tool contracts (`baton mcp`)

**`search_context`** — input:
`{ query?, kind?: 'commit'|'fact'|'any', path?, symbol?, agent?, project?, since?, until?, limit=8, max_tokens=1200 }`
(at least one of query/path/symbol required). Output per hit (~60–90 tokens):

```
fix(server) a1b2c3d · fix-ws-auth · claude · 2026-06-11
  task: Fix WS upgrade auth bypass
  why:  reject upgrade before session check
  files: src/server.ts +41/-7 · src/signals.ts +3/-1
  symbols: handleUpgrade · notifyOverlap
  cite: a1b2c3d:src/server.ts
```

Fact hits render as: fact text (first 200 chars) + `cite: <path>@<hash>` +
freshness. Footer: `truncated: true|false` and a hint to call `show_change`.

**`show_change(sha|slug)`** — the expander: full message, complete file list,
patch fetched live from git via `src/util/exec.ts` (using `archived_ref` when
the branch is gone). The DB stays an index; git stays the source of truth.

`recall_memory`, `who_touched`, `get_report` remain unchanged (compat).

## Error handling

- FTS5 unavailable (Node < 22.16): try/catch at first open sets a capability
  flag; queries LIKE-scan the same denormalized data. Tool contract unchanged.
- Corrupt/missing graph.json: symbol resolution downgraded (hunk names only).
- `bm25()` weights guarded by the same capability flag.
- Query with no filters and no query → 400-style tool error, never a full dump.

## Testing

- Unit: tokenizer subtokens; conventional-commit parser (incl. breaking `!`,
  no-match → NULL); hunk-header funcname extraction; token budget truncation;
  ranking smoke (task-title hit outranks message hit).
- Integration (temp git repo, same style as `test/hub.test.ts`): merge a task
  → rows in commit_symbols + history_fts → `search_context` finds it by symbol
  subtoken; stale fact excluded after anchor drift; hub `project` filter.
- Fallback: force-disable FTS5 → same queries pass via LIKE path.

## Rollout

1. Schema migration + merge-time enrichment (+ `reindexHistory()` backfill).
2. `search_context` + `show_change` in `baton mcp`; `/api/search` for the
   dashboard later (not required for v1).
3. AGENTS.md guidance: "search before reading git log; cite what you use."
