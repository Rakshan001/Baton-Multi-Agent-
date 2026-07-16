# Memory deep research — constraints, landscape, and the token-optimal plan (2026-07-11)

Three-agent web sweep (Beads deep-dive, memory-system landscape, native-agent
practice + local retrieval) synthesized against a full read of `src/memory.ts`,
`src/kb/orient.ts`, and the MCP serving path. Every number below is published
or measured; vendor-only claims are flagged.

## 1. Constraints / trade-offs in Baton's current memory (from the code)

| # | Constraint | Where | Cost |
|---|-----------|-------|------|
| C1 | **Write path is 100% manual** — nothing is learned unless an agent volunteers `save_memory` | `mcp.ts` | KB grows only when agents are disciplined; free-tier agents rarely volunteer |
| C2 | **Stale = withheld forever; `gc` deletes** — a changed anchor kills the fact even when it is still true | `recallMemories` filters `stale`; `gcMemories` | True knowledge is lost; archive/journal substrate exists but nothing repairs |
| C3 | **Recall is bare keyword presence** — +1 per matched topic word, no term weighting (rare `csrf` = common `file`), no synonyms ("login" never finds "auth") | `scoreMemory` | Paraphrased queries miss; ties break by recency only |
| C4 | **Dedup misses same-knowledge-different-words** — first-6-words fingerprint + Jaccard ≥ 0.5, save-time only | `saveMemory` | Two agents phrasing one gotcha differently both persist; no consolidation pass |
| C5 | **No structure above the fact** — answers "what did we learn", never "what work exists / what's ready" | — | The Beads use-case (task graph) is simply out of scope today |
| C6 | **Anchor-less facts are graph-invisible** — `relatedByFiles` needs shared paths | `relatedByAnchors` | Facts saved without `files` never surface as related |

Already right (validated by the sweep, do not touch): stale-withholding
(novel; no other tool does read-time content-hash revalidation), the orient
brief as a small always-loaded index under a hard cap (exactly the convergent
industry shape: Claude Code 200-line/25KB MEMORY.md, aider 1k-token repo map,
Codex 32KiB AGENTS.md cap, Windsurf 6k/12k-char rules), files-as-storage
(Cursor shipped opaque auto-memory in 1.0 and **removed it** in 2.1 in favor
of user-visible rule files), and zero-dependency SQLite.

## 2. What the research established

**Beads (Steve Yegge, ~25k stars).** Issues as graph nodes (4 edge types:
blocks / related / parent-child / discovered-from), hash IDs for merge-safe
concurrent creation, and one core read: `bd ready --json` — the daemon
topo-sorts and serves only the unblocked frontier ("the tool does the
graph-thinking so the LLM doesn't"). No published token numbers. Cautionary
tales: 240k LOC bloat criticism, invasive installs backlash, a 1.0
storage-engine rewrite (JSONL+SQLite → embedded Dolt) that broke every repo,
and the field observation that **agents forget it exists by hour two without
re-prompting** — write-path discipline is the universal weakness, not storage.
Borrowable: `discovered-from` provenance edges; precompute-the-frontier
serving; atomic claim as coordination primitive. Not borrowable: the scope.

**Landscape token numbers (published).**
- Mem0 paper: ~7k tokens/conversation memory footprint vs Zep/Graphiti graph
  construction "in excess of 600k" (arXiv 2504.19413) — the rejected baseline.
- Memori: **81.95% LoCoMo at 1,294 tokens/query — plain SQL, no vectors, no
  graph DB** (arXiv 2603.19935). The strongest published evidence that the
  token-optimal path is competitive.
- A-MEM (NeurIPS 2025): links between atomic notes ≈ a knowledge graph's
  multi-hop value at ~2 LLM calls/note; ~1.2–2.5k tokens/query vs ~17k
  baseline. Baton's anchor-overlap `relatedByFiles` is this idea at zero calls.
- claude-mem (86.7k stars): 3-layer progressive disclosure — search index
  ~50–100 tokens/hit, full observations ~500–1,000 tokens fetched by id.
- Hindsight: coarse extraction ("2–5 comprehensive facts per conversation")
  beats many atomic fragments; budgeted RRF fusion of cheap rank channels.
- LangMem: debounced background consolidation (reschedule-and-cancel per
  burst) — pay one pass per burst, not per message.

**Retrieval at 50–500 facts (zero-embedding).** BM25/FTS5 wins on rare
discriminative tokens (identifiers, flags, error strings — exactly recall's
query shape); dense wins on paraphrase, but **no published benchmark shows
local embeddings beating tuned BM25 on hundreds of short technical facts**.
The cheapest local embedding stack (sqlite-vec compiled blob + 23MB int8
MiniLM + onnxruntime) breaks zero-dep to solve a synonym problem that FTS5
tuning + mechanical query expansion already address. LLM-side query expansion
published gain: +23.4 Recall@10; RRF with k=60 fuses rank lists without score
calibration.

## 3. The plan — M-round (token-optimal, zero new deps, no LLM calls by Baton)

Hard constraint honored throughout: Baton has no LLM of its own and must not
require one. Every improvement below is mechanical or harvests text agents
already wrote.

**M1 — BM25 recall (fixes C3).** Index facts in an FTS5 table (reuse the
`ensureFts`/lazy-backfill pattern from `search_history`): porter-stemmed prose
column + identifier column with camelCase/snake_case splitting, `bm25()`
column weights (fact > files > task), prefix indexes. Rank = RRF(k=60) over
BM25 rank + recency rank, freshness as a tie-boost. Small static alias map
(auth/login/session, db/database, config/settings…) expands queries
mechanically. Keep the word-scan as fallback (same shape as history's LIKE
fallback). Zero LLM tokens; pure ranking-quality win.

**M2 — Progressive-disclosure recall (serving cut).** `recall_memory` returns
compact index rows (id, type, first line ≤120 chars, files, freshness) plus
full bodies for only the top 2–3; new `full: true`/by-id fetch hydrates the
rest. claude-mem-validated ~10x read saving; orient untouched (already
budgeted).

**M3 — Repair queue (fixes C2, the knowledge-loss bug).** When an anchor file
changes: mechanically re-anchor if the fact's quoted identifiers/paths still
appear in the new content (hash update, journal line `op: reanchor`);
otherwise mark `needs-review` instead of gc-deleting, and surface at most ONE
review request opportunistically in recall answers touching the same files
("stale fact may still hold — verify and re-save"). The verifying agent is
already in-context on those files, so verification is near-free. `baton
memory repair` for batch. Archive/journal substrate already exists for this.

**M4 — Zero-cost auto-capture (fixes C1 without LLM calls).** Harvest facts
from artifacts agents already produce: `create_handoff` `decisions[]` and
completion-report summaries become memory facts, born with anchors from the
task's touched files, deduped through the existing fingerprint gate plus an
M1-powered FTS similarity check. The agent already wrote the text — capture
costs zero extra tokens. (Full Mem0-style extraction stays out: it needs an
LLM Baton doesn't have.)

**Deferred/rejected, explicitly:** local embeddings (breaks zero-dep, no
evidence of win at this scale); LLM-built knowledge graphs at ingestion (Zep
~600k tokens/conversation; cognee same family, costs unpublished); Letta-style
agentic self-editing memory (pay-per-thought write path); Beads-scale task
graphs (different product; borrow `discovered-from` provenance later if task
structure ever lands).

Sequencing: M1 → M2 → M3 → M4 (each independently shippable, TDD, budget
tests where serving shape changes).
