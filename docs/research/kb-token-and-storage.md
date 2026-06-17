# Baton KB: Token & Storage Economics

> Research report — how a knowledge-graph + repo-map + shared-memory design keeps
> AI-agent **token** usage *down* and **on-disk storage** *bounded*, for a multi-repo
> "hub" setup (one backend + admin/user/driver frontends).
>
> Grounded in Baton's actual implementation (`src/kb/`, `src/memory.ts`,
> `.baton/`, `graphify-out/`) and cited against open-source prior art.
> Date: 2026-06-17.

---

## TL;DR (executive summary)

1. **The repo-map is the token win, not the graph.** On this repo, the generated
   `CODEBASE.md` map measures **824 tokens** vs **~247,600 tokens** to read the whole
   repo — a **~300× reduction** (numbers straight out of `.baton/kb.json`:
   `mapTokens: 824`, `repoTokens: 247598`). But the underlying `graph.json` is
   **1.06 MB ≈ 266k tokens** — *more* than reading the repo. The map saves tokens
   precisely *because agents never load the graph*; they query it on demand. Loading
   the raw graph into context would be a catastrophic anti-pattern.
2. **Baton's design already matches the state of the art on the cheap dimensions:**
   a ~1k-token map (same budget as Aider's repo-map default of 1k tokens), a
   markdown/llms.txt-style flat artifact, and a deterministic build (no LLM calls).
   It deliberately avoids the expensive dimension — **LLM-based graph construction**,
   which is what makes Microsoft GraphRAG cost $20–40 per 1M tokens indexed.
3. **Memory growth is hard-capped and that's the right call.** 500 facts × 1,200
   chars ≈ **600 KB max** on disk, recall capped at 10 (max 50). Mem0's published
   result — **~1,764 tokens/conversation vs 26,031 full-context (~90% savings)** at
   67.13% LOCOMO — is the proof that *bounded, ranked* recall beats stuffing. Baton
   does dedup (supersede-by-fingerprint) and staleness eviction (content-hash
   anchors) but is **missing recency decay/TTL and summarization-consolidation**.
4. **Storage is bounded everywhere that matters except the graphs.** Memory ≤600 KB,
   `history.db` is tiny (57 KB today, append-only sqlite — the one thing that grows
   unbounded over time). The graphs are the heavy artifacts (~1 MB each) and **must
   stay gitignored** — `graphify-out/` already is. The real footgun is a 5-repo hub
   keeping `graph.html` (946 KB of D3 viz) per repo and re-indexing `node_modules`.
5. **The multi-repo footguns are real and mostly preventable:** loading the *merged*
   cross-project graph when a single-repo answer would do, over-broad memory recall
   pulling another repo's facts, and re-indexing `node_modules`/`dist`. Mitigations
   (per-repo graph default, repo-scoped recall, self-healing `.graphifyignore`) are
   mostly small/medium effort and several are already shipped.

---

## 1. Why a repo-map / knowledge-graph saves tokens

### The core arithmetic (measured on this repo)

| Artifact | Bytes | ~Tokens (chars/4) | Notes |
|---|---|---|---|
| `CODEBASE.md` (the map) | 3,355 | **824** (per `kb.json`) | What agents actually read first |
| Whole repo (tracked text, ex-lockfiles) | ~1.08 MB | **~247,600** | Naive "read everything" |
| `graphify-out/graph.json` | 1.06 MB | **~266,000** | 1,068 nodes / 2,565 links — **never** load into context |
| `graphify-out/graph.html` (D3 viz) | 946 KB | n/a | Human dashboard only, not for agents |
| `GRAPH_REPORT.md` | 17 KB | ~4,300 | Optional deeper-than-map summary |

**The headline: ~300× fewer tokens** to orient an agent (824 vs 247,600). This is the
number Baton's KB page already surfaces ("map ≈ 824 tokens vs ≈ 248k reading it").

### Why this works (and the subtlety staff engineers miss)

- **Naive file-reading / full-context stuffing is O(repo size).** A 250k-token repo
  blows past a budget on every task, and "lost-in-the-middle" degradation means even
  models with huge windows *use* the buried context poorly — as context grows, models
  "struggle to make good use of all the information they're given."
  ([JetBrains Research](https://blog.jetbrains.com/research/2025/12/efficient-context-management/),
  [analyticsvidhya](https://www.analyticsvidhya.com/blog/2026/04/memory-systems-in-ai-agents/))
- **The map is a *flattened, structured* index, not the data.** Same idea as
  `llms.txt`: "HTML wastes tokens… provide a flattened, structured view of your best
  content, tailored explicitly for AI use."
  ([vibe-marketing.org](https://vibe-marketing.org/blog/llms-txt-file-purpose))
  Baton's `CODEBASE.md` gives stack, tree, the 20 most-connected symbols (god-nodes
  by graph degree), and query pointers — enough to *navigate*, then drill in.
- **The graph is for retrieval, not ingestion.** The 266k-token `graph.json` is queried
  via the `query_graph` MCP tool / `graphify query`, returning only the relevant
  sub-graph. This is the graph-RAG value prop: "retrieved by traversing explicit
  relationships… auditable and multi-hop capable."
  ([instaclustr](https://www.instaclustr.com/education/retrieval-augmented-generation/graph-rag-vs-vector-rag-3-differences-pros-and-cons-and-how-to-choose/))

**The trap:** treating the graph as a context artifact. If anything ever inlines
`graph.json` (or the merged graph) into a prompt, you spend *more* tokens than reading
the repo. The map exists to keep the graph out of context.

---

## 2. Open-source prior art — what to borrow

| Approach | What it does | Token cost | Storage cost | What Baton should borrow |
|---|---|---|---|---|
| **Aider repo-map** | tree-sitter parses symbols; **PageRank** over the file/symbol dependency graph; renders top-ranked elided defs to a budget. 130+ languages. | **~1k tokens default** (`--map-tokens`), expands when chat is empty | Ephemeral (rebuilt per turn), tree-sitter cache | **Rank symbols by PageRank**, not just raw graph degree; **dynamically re-rank** toward files in the current task |
| **Repomix** | Packs whole repo into one AI-friendly file; `--compress` uses tree-sitter to keep signatures, drop bodies (~**70% token reduction**); respects `.gitignore`; Secretlint scan | Full pack is huge; compressed ≈ signatures only | One output file | Offer a **`--compress`-style signature-only export**; Baton already does Secretlint-equivalent secret rejection in memory |
| **llms.txt** | Flat markdown index of a site's high-value content for LLMs | Tiny (curated) | One file | Validates `CODEBASE.md`'s flat-markdown shape; consider an **`AGENTS.md` → `CODEBASE.md` → graph** tiered cascade |
| **Microsoft GraphRAG** | LLM extracts entities/relations + community summaries from unstructured text | **Indexing $20–40 / 1M tokens**, $33K to index large corpora; query-time LLM per chunk | Large (graph + summaries) | **Cautionary tale** — Baton's graphify is *deterministic AST parsing, zero LLM cost*. Keep it that way. Borrow only "community summaries" idea cheaply (graphify already has labels/communities) |
| **LazyGraphRAG / Fast GraphRAG** | Defer/avoid LLM indexing; cut cost **50–6,000×** | Near-zero index | Smaller | Confirms the "index structure deterministically, summarize lazily" stance Baton already takes |
| **Vector/embedding code RAG** | Chunk + embed code, retrieve by cosine similarity | Cheap & fast retrieval; embedding compute once | **Vector DB** (can dwarf source) | Add as a **complementary** semantic layer for "find code like X"; route relationship/structure queries to the graph, fuzzy queries to vectors |
| **mem0** | Extract → store → rank salient facts; framework-agnostic SDK | **~1,764 vs 26,031 tokens (~90% savings)**, p95 search ~0.2s, 67.13% LOCOMO | Vector + graph store | Borrow **recency + importance scoring** and the extract-then-store discipline |
| **Letta / MemGPT** | OS-style tiered memory (in-context core + paged archival); agent runs *inside* Letta | Pages memory in/out of context | Archival store | Borrow the **core vs archival tier** mental model; Baton's "fresh in brief, rest on-demand" is the same idea |
| **Claude prompt caching** | Cache reused prefix (system prompt, docs, KB); cache **read = 0.1× input (90% off)**, write = 1.25–2× | Break-even on 2nd hit | Provider-side, ephemeral (5-min/1-hr TTL) | **High-leverage, low-effort:** mark the stable `CODEBASE.md` + memory brief as a **cache breakpoint** so repeated agent turns read it at 10% cost |

Sources:
[Aider repomap blog](https://aider.chat/2023/10/22/repomap.html) ·
[Aider repomap docs](https://aider.chat/docs/repomap.html) ·
[Repomix compress](https://repomix.com/guide/code-compress) ·
[Repomix repo](https://github.com/yamadashy/repomix) ·
[GraphRAG costs (MS)](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/graphrag-costs-explained-what-you-need-to-know/4207978) ·
[GraphRAG cost estimation](https://khaledalam.medium.com/how-i-added-token-llm-cost-estimation-to-the-indexing-pipeline-of-microsoft-graphrag-c310dd56cb0c) ·
[FalkorDB: reduce GraphRAG cost](https://www.falkordb.com/blog/reduce-graphrag-indexing-costs/) ·
[Graph RAG vs vector RAG](https://www.instaclustr.com/education/retrieval-augmented-generation/graph-rag-vs-vector-rag-3-differences-pros-and-cons-and-how-to-choose/) ·
[Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta) ·
[Mem0 paper](https://arxiv.org/pdf/2504.19413) ·
[Anthropic prompt caching savings](https://tygartmedia.com/anthropic-prompt-caching-90-percent-token-savings/) ·
[Anthropic API pricing 2026](https://www.finout.io/blog/anthropic-api-pricing) ·
[llms.txt](https://vibe-marketing.org/blog/llms-txt-file-purpose)

---

## 3. Memory systems — bounding growth & avoiding context bloat

The field's consensus techniques, and Baton's status against each:

| Technique | What it does | Baton today | Verdict |
|---|---|---|---|
| **Hard caps** | Cap count/size so the store can't explode | **Yes** — `FACT_CAP=500`, `FACT_MAX_CHARS=1200` (`src/memory.ts:59-60`), recall `limit` default 10 / **max 50** (`recallMemories`) | ✅ Already done, strong |
| **Deduplication** | Merge/replace semantically-equal entries | **Yes** — supersede-by-fingerprint (first-6-words candidate filter, then replace; old fact removed atomically) | ✅ Done (cheap heuristic; could add embedding dedup) |
| **Eviction by staleness** | Remove entries no longer valid | **Yes (strong & novel)** — every fact anchors to commit + per-file **content sha1**; on read, changed/removed anchor ⇒ `stale`, **withheld from agents** + GC'd (`gcMemories`) | ✅ Best-in-class for *code* facts (anti-hallucination) |
| **Relevance ranking** | Rank by similarity/importance before recall | **Partial** — keyword `\b`-boundary scoring only (`scoreMemory`); no semantic similarity, no importance weight | ⚠️ Should improve |
| **Recency decay / TTL** | Down-weight or expire old memories over time | **No** — freshness is `fresh/aging/stale` from anchors, but there's **no time-based decay** in ranking | ❌ Should add (LRU/recency score) |
| **Summarization / consolidation** | Condense many low-signal entries into fewer dense ones | **No** — facts are atomic, never merged into summaries | ❌ Consider (periodic consolidation pass) |
| **Capped recall into context** | Never inject the whole store | **Yes** — recall slices to `limit`; brief embeds only a "token-cheap Project memory" section + a "N stale withheld" note | ✅ Done |

**Evidence the bounded approach is correct:** "An agent that remembers everything
eventually remembers nothing useful… storing every detail leads to bloat."
([analyticsvidhya](https://www.analyticsvidhya.com/blog/2026/04/memory-systems-in-ai-agents/))
Formal forgetting (LRU eviction, priority decay) is the recommended way to "prune
storage bloat without manual intervention."
([apxml](https://apxml.com/courses/agentic-llm-memory-architectures/chapter-3-designing-memory-systems/memory-consolidation-summarization))
Mem0's headline (~90% token savings at competitive accuracy) is the quantified payoff
of *ranked, bounded* recall over full-context. ([Mem0](https://mem0.ai/compare/mem0-vs-letta))

**Where Baton is ahead of the pack:** content-hash anchoring + withholding stale facts.
Most memory frameworks decay by *time*; Baton decays by *truth* (did the underlying code
change?). For a code-agent hub that's the more important axis — it prevents an agent
acting on a fact about a function that was since rewritten. Keep this; *add* time-decay
as a secondary ranking signal, don't replace.

---

## 4. Storage footprint of a 5-repo hub

Per-repo measured footprint (this repo, mid-size TS project):

| Item | Size here | Grows with | Bounded? |
|---|---|---|---|
| `graphify-out/graph.json` | **1.06 MB** | repo size (nodes/edges) | Bounded by code size; rebuilt, not appended |
| `graphify-out/graph.html` | **946 KB** | repo size | **Pure waste for agents** — D3 viz, dashboard-only |
| `graphify-out/cache/` + `GRAPH_REPORT.md` + labels | ~20 KB+ | repo size | Bounded |
| `.baton/memory/facts/*.md` | ≤ **600 KB** (500 × 1,200 B) | facts written | **Hard-capped** ✅ |
| `.baton/history.db` (sqlite) | **57 KB** today | **events over time (append-only)** | ⚠️ **Unbounded** |
| `.baton/reports/*.md`, `tasks.json`, `kb.json` | KBs | tasks/merges | Effectively bounded by activity |

### Projected 5-repo hub

- **Graphs:** ~5 × (1 MB json + ~1 MB html) ≈ **~10 MB**, plus a **merged cross-project
  graph** (sum of nodes/edges, easily 3–5 MB). Call it **~12–15 MB** of graph artifacts.
- **Memory:** ≤ 600 KB *per memory store*. Note: Baton writes memory to the **main repo**
  even from worktrees (`.baton/memory/facts/`, "always the MAIN repo"). A hub with a
  shared store ⇒ one ≤600 KB store; per-repo stores ⇒ ≤600 KB each.
- **history.db:** the only thing that grows without a cap. 57 KB after light use; a busy
  5-repo hub running for months will accumulate event rows indefinitely.

### What's capped vs unbounded

- **Capped:** memory facts (500/1200), recall (10/50), report sizes by activity.
- **Bounded-by-code:** all graph artifacts (rebuild replaces, never appends).
- **Unbounded:** `history.db` (append-only events) and graph artifacts *across many
  re-indexes if cache isn't reused* (each rebuild rewrites in place, so this is fine —
  the risk is committing them, see footguns).

### .gitignore footguns

- ✅ **Already handled:** `.gitignore` ignores `graphify-out/`, `.baton/`, `.mcp.json`,
  `dist/`. Good — committing `graphify-out/` would add **~2 MB of binary-ish JSON+HTML
  per repo per rebuild** to git history (and `graph.json` churns on every commit via the
  rebuild hook → enormous diff noise and repo bloat).
- ⚠️ **Hub footgun:** `baton setup` auto-`git init`s the container root for a centralized
  hub. That new root needs a `.gitignore` ignoring **every** sub-repo's `graphify-out/`
  and the merged-graph output, or `git add .` at the hub root will swallow megabytes of
  generated graphs. (STATUS notes setup writes a `.gitignore` at the container root —
  verify it covers `**/graphify-out/` and the merged-graph path.)
- ⚠️ **`.graphifyignore` shadowing:** recent commits (`fcae7bc`, `183a4c8`) already fixed
  a real footgun — a generated `.graphifyignore` shadowing the repo's `.gitignore`. The
  self-healing mirror is the right fix; keep it.
- ⚠️ **`graph.html` in `kb export`:** the export tar includes graphs + CODEBASE.md. Ensure
  the **946 KB `graph.html` is excluded** from the pack (agents/teammates need `graph.json`
  + `CODEBASE.md`, not the D3 viz). Shaves ~50% off every pack.

---

## 5. Multi-repo token-saving footguns & mitigations

| Footgun | Why it costs tokens/disk | Mitigation | Status |
|---|---|---|---|
| **Loading the merged graph when one repo would answer** | Merged graph = Σ all repos; querying it pulls cross-repo noise, larger sub-graphs, more tokens | **Default to the per-repo graph**; only touch merged for explicitly cross-project questions ("does admin call the same backend endpoint as driver?"). Route by query scope. | Design — verify routing |
| **Over-broad memory recall across repos** | A driver-frontend task recalls backend facts → irrelevant context, wasted tokens, possible wrong action | **Scope recall to the active repo/project** by default; tag facts with project id; require opt-in for cross-repo recall | ⚠️ Add (facts anchor files but recall isn't repo-scoped) |
| **Re-indexing `node_modules` / `dist` / `web/dist`** | CODEBASE.md already shows `node_modules/ (2003 files)`, `dist/ (86 files)` in the tree — indexing them bloats the graph and the map's tree section | Ensure `.graphifyignore` (mirroring `.gitignore`) excludes `node_modules/`, `dist/`, `build/`, `coverage/`, `.refs/` for **every** sub-repo | ✅ Partially — self-healing `.graphifyignore` mirrors `.gitignore` (commit `fcae7bc`); confirm it's applied per sub-repo in a hub |
| **Inlining `graph.json` into a prompt** | 266k tokens — worse than reading the repo | Agents must only ever call `query_graph`; never serialize the graph. Map + MCP tool is the contract. | ✅ By design |
| **Map staleness → agents re-scan files anyway** | If `CODEBASE.md` is stale, agents distrust it and fall back to reading files (full cost) | Staleness footer tied to graph commit + git rebuild hook keeps it fresh; surface "N commits behind" | ✅ Done |
| **Per-repo `graph.html` shipped to agents/exports** | 946 KB of viz no agent reads | Exclude from `kb export`; never reference from `CODEBASE.md` | ⚠️ Verify export filter |
| **history.db unbounded growth** | Not a token cost, but disk + slow queries over time | Add retention/rollup (e.g. keep N days of raw events, summarize older) | ❌ Add |
| **Duplicate facts across repos in a shared store** | Same insight saved from 3 frontends → 3 facts → noisier recall | Fingerprint dedup exists; ensure it operates within the shared store and consider project-tagging to avoid false merges | ⚠️ Review |

---

## 6. Prioritized recommendations

Tags: **Effort** S(mall)/M(edium)/L(arge) · **Status** ✅ done / ⚠️ partial / ❌ not yet.

### Token savings

1. **Mark `CODEBASE.md` + memory brief as a Claude prompt-cache breakpoint.** Repeated
   agent turns then read the stable KB prefix at **0.1× input cost (90% off)**; break-even
   on the 2nd turn. Huge leverage for long sessions. **[S · ❌]**
   ([Anthropic caching](https://www.finout.io/blog/anthropic-api-pricing))
2. **Default graph queries to the per-repo graph; route to merged only for explicit
   cross-project questions.** Stops paying merged-graph token tax on single-repo work.
   **[M · ⚠️ verify]**
3. **Scope memory recall to the active project by default.** Tag facts with project id;
   cross-repo recall is opt-in. Prevents wrong-repo facts polluting context. **[M · ❌]**
4. **Rank symbols in `CODEBASE.md` by PageRank, not raw degree.** Aider's evidence:
   PageRank surfaces the *most-referenced* identifiers, the highest-signal-per-token map.
   Baton already has the graph; add the ranking. **[M · ⚠️]**
   ([Aider](https://aider.chat/2023/10/22/repomap.html))
5. **Add a `--compress`/signature-only KB query mode** (function signatures, no bodies)
   for "show me the shape" questions — Repomix reports ~70% token reduction this way.
   **[M · ❌]** ([Repomix](https://repomix.com/guide/code-compress))
6. **Keep graph construction LLM-free.** Do *not* adopt GraphRAG-style LLM entity
   extraction ($20–40/1M tokens indexed). graphify's deterministic AST parse is the whole
   cost advantage. **[—  · ✅ guardrail]**

### Storage

7. **Verify the hub-root `.gitignore` covers `**/graphify-out/` + merged-graph path.**
   One missing glob ⇒ megabytes of generated graphs in git history, churning every commit.
   **[S · ⚠️ verify]**
8. **Exclude `graph.html` (946 KB/repo) from `kb export` and never reference it from
   agent-facing artifacts.** Roughly halves every export pack. **[S · ⚠️ verify]**
9. **Add `history.db` retention/rollup** (raw events for N days, summarized older). It's
   the only unbounded store. **[M · ❌]**
10. **Confirm per-sub-repo `.graphifyignore` excludes `node_modules/`, `dist/`, `web/dist/`,
    `build/`, `coverage/`, `.refs/` in a hub.** The self-healing mirror exists; ensure it
    runs for *every* sub-repo, not just the container root. **[S · ⚠️ partial]**

### Memory quality

11. **Add recency/importance to recall ranking** (current ranking is keyword-only). Combine
    keyword/semantic similarity + recency decay + an importance flag — the field-standard
    scoring function. **[M · ❌]**
    ([apxml](https://apxml.com/courses/agentic-llm-memory-architectures/chapter-3-designing-memory-systems/memory-consolidation-summarization))
12. **Optional periodic consolidation pass** — condense clusters of low-signal facts into
    fewer dense ones before hitting the 500 cap, instead of just GC'ing stale ones. **[L · ❌]**
13. **Keep & promote content-hash anchoring.** It's Baton's differentiator vs mem0/Letta
    (truth-decay, not just time-decay). Document it as the headline memory feature. **[S · ✅]**

---

## Appendix — measured ground truth (this repo)

```
.baton/kb.json     → mapTokens: 824   repoTokens: 247598      (~300×)
graph.json         → 1,068 nodes / 2,565 links / 1,064,151 B  (~266k tokens RAW)
graph.html         → 945,976 B  (D3 viz, dashboard-only)
GRAPH_REPORT.md    → 17,193 B (~4,300 tokens)
CODEBASE.md        → 3,355 B (824 tokens per kb.json)
.baton/history.db  → 57,344 B (sqlite, append-only — unbounded over time)
src/memory.ts      → FACT_MAX_CHARS=1200, FACT_CAP=500, recall limit default 10 / max 50
.gitignore         → ignores graphify-out/, .baton/, .mcp.json, dist/  ✅
```

### Sources

- Aider repo-map (PageRank + tree-sitter): https://aider.chat/2023/10/22/repomap.html · https://aider.chat/docs/repomap.html
- Repomix (compress ~70%, gitignore-aware, Secretlint): https://repomix.com/guide/code-compress · https://github.com/yamadashy/repomix
- llms.txt: https://vibe-marketing.org/blog/llms-txt-file-purpose
- Microsoft GraphRAG costs: https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/graphrag-costs-explained-what-you-need-to-know/4207978 · https://khaledalam.medium.com/how-i-added-token-llm-cost-estimation-to-the-indexing-pipeline-of-microsoft-graphrag-c310dd56cb0c
- LazyGraphRAG / Fast GraphRAG cost cuts: https://www.falkordb.com/blog/reduce-graphrag-indexing-costs/
- Graph RAG vs vector RAG tradeoffs: https://www.instaclustr.com/education/retrieval-augmented-generation/graph-rag-vs-vector-rag-3-differences-pros-and-cons-and-how-to-choose/
- Mem0 (90% token savings, LOCOMO 67.13%): https://mem0.ai/compare/mem0-vs-letta · https://vectorize.io/articles/mem0-vs-letta · https://arxiv.org/pdf/2504.19413
- Letta/MemGPT tiered memory: https://vectorize.io/articles/mem0-vs-letta
- Anthropic prompt caching (90% read discount): https://www.finout.io/blog/anthropic-api-pricing · https://tygartmedia.com/anthropic-prompt-caching-90-percent-token-savings/
- Agent memory techniques (eviction/TTL/summarization/dedup): https://apxml.com/courses/agentic-llm-memory-architectures/chapter-3-designing-memory-systems/memory-consolidation-summarization · https://www.analyticsvidhya.com/blog/2026/04/memory-systems-in-ai-agents/ · https://blog.jetbrains.com/research/2025/12/efficient-context-management/
