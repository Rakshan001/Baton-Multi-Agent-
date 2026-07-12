# Multi-agent coordination audit — third-order improvement plan (2026-07-06)

**Method.** 6 read-only codebase auditors + 6 web researchers ran in parallel, a
senior-architect pass consolidated their findings into 12 ranked proposals, and
each proposal was then attacked by two adversarial skeptics — one *feasibility*
(reads the real code, enforces Baton's hard conventions) and one *value* (hunts
over-engineering, nets out token cost). Only proposals that survive both are
kept; every claim below is anchored to `file:line`. This is the 95%-confidence
bar: nothing here is a hunch that wasn't checked against the source.

**Scope.** The brief was to make Baton the best coordination layer for 4–5 coding
agents on one repo, against five goals:

| | Goal |
|---|---|
| **A** | Token efficiency — N agents run at once without each burning full context; lean tools like Serena/Ponytail, no over-engineering |
| **B** | Live cross-agent awareness — an agent knows, at edit time, who else is editing what and what just got fixed |
| **C** | One central KB with full history — a brand-new agent onboards with zero human explanation |
| **D** | File hygiene — no scattered `.md` sprawl; one clean layout for agents *and* humans |
| **E** | Setup skill — one command wires a target repo end-to-end (MCP + docs + KB) for every agent kind |

---

## The tool you were benchmarking against: Ponytail

The voice transcript's "Ponetic … skills … avoids over-engineering … 1.8 …
research maker" is **Ponytail** (`github.com/DietrichGebert/ponytail`, MIT, ~76k
stars in its first weeks of June 2026). It is not a coding agent — it is a
*skill* that 16+ agents (Claude Code, Cursor, Codex, OpenCode, Gemini) load. Its
whole thesis is Baton's goal A: a **7-rung decision ladder** (YAGNI → already in
codebase? → stdlib? → native platform feature? → installed dep? → one-liner? →
only then minimal code) that stops agents gold-plating simple tasks. Corrected
benchmarks: −54% LOC, −22% tokens, −20% cost at 100% safety (its earlier
80–94% claims were retracted as padded — we cite only the corrected numbers).

**Two patterns we steal from it, not the tool itself:**

1. **A `lite / full / ultra` enforcement dial** — surfaced in **P2** (edit-guard
   modes: advise → ask → block).
2. **One canonical `SKILL.md` → generated per-agent adapters, CI-kept in sync** —
   surfaced in **P7** (one `baton setup` writes every agent's config from a
   single source, never hand-maintained parallel copies).

Ponytail is orthogonal to Baton (it disciplines *one* agent's code; Baton
coordinates *many*). The clean composition story — "install Ponytail for
restraint, Baton for coordination" — is worth stating on the landing page.

---

## Executive summary — the ranked plan

Tiering is impact-per-effort, deduplicated against work already specced
(unified-search, context-pack, shared-graphify-server, hardening-bundle,
memory-v2 roadmap — see `docs/superpowers/`). **The single most important
finding first:**

> **P1 is a latent bug that silently breaks coordination in the exact 4–5-agent
> scenario this whole product is for.** `src/mcp.ts:29` resolves the store with
> `gitRoot()`, which returns the *worktree* path when an agent's `baton mcp` runs
> from inside `.baton/wt/<slug>` (the normal case). So `check_files`,
> `list_signals`, `list_tasks`, `get_report` read an **empty per-worktree shadow
> store** — every agent sees no signals and no tasks. All of goal B/C is built on
> this data being correct. Fix it before anything else.

### Tier 1 — do first (all low-effort, high-impact, verified)

| ID | What | Goals | Verdict |
|----|------|-------|---------|
| **P1** | Fix coordination-tool root (`gitRoot`→`resolveBatonRoot`) + inject agent identity env at launch | A, B | feas modify(88) · value keep(90) |
| **P2** | PreToolUse edit-guard hook — push a collision warning *at edit time*; advise-only to start | B | feas modify(88) · value modify(85) |
| **P3** | SessionStart hook + one `orient()` MCP tool — hard-budgeted onboarding brief | C, A | feas modify(85) · value modify(78) |
| **P4** | Serena-style output contracts on every MCP response — compact JSON, hard caps, scoped recall | A | **feas keep(88) · value keep(88)** |
| **P5** | `report_progress` write-tool — interactive agents state intent, surfaced in `check_files` | B, A | feas modify(88) · value modify(82) |

### Tier 2 — next

| ID | What | Goals | Verdict |
|----|------|-------|---------|
| **P6** | Fix stale signals when no dashboard tab is open — via lazy read-time reconciliation, not a background poller | B | feas modify(85) · value modify(85) |
| **P7** | `baton setup --agents claude,cursor,codex,gemini` — one command writes all configs/hooks/skills | E, C | feas modify(85) · value modify(80) |
| **P8** | Zero-footprint install — **gitignore the artifacts at `kb init` (part 1 only)** | D | feas modify(83) · value modify(80) |
| **P9** | Declared task scope (keep) + `claim_files` intent (**cut**) | B | feas modify(78) · value modify(76) |
| **P10** | Append-only KB journal — archive superseded facts (**drop the MCP view**) | C | feas modify(83) · value modify(72) |

### Tier 3 — later bets

| ID | What | Goals | Verdict |
|----|------|-------|---------|
| **P11** | Cut hub graphify token duplication — **one-line "merged-only" default, not a `query_kb` facade** | A | feas modify(78) · value modify(76) |
| **P12** | `baton doctor` `.md`-sprawl scan (**piece 1 only; drop runtime litter-watch**) | D | feas modify(72) · value modify(72) |

*Every proposal survived adversarial verification as **modify** — none was
dropped, but each carries scoping corrections that materially shrink it. The
corrections are the most valuable output here: they cut roughly a third of the
originally-proposed surface as over-engineering or false premises.*

---

## Current-state audit (what exists today)

### B — live edit awareness is *pull-only and voluntary*
The pipeline works: per-worktree `fs.watch` (`src/watch.ts:70`, 300ms debounce)
→ `file.edited` on the bus → `SignalTracker` records into
`.baton/history.db` and emits `signal.overlap` when 2+ slugs touch a path within
30 min (`src/signals.ts:51,111-119`). **But agents only get PULL access**
(`check_files`, `list_signals`, `who_touched` — `src/mcp.ts:32-82`); the live
SSE *push* goes only to the **dashboard** (`web/src/features/Live.tsx:216-241`).
Nothing injects a "being edited by agent-2" note into another agent's context at
the moment it matters — no `PreToolUse` hook is shipped (`src/commands/hooks.ts`
wires only `Stop`+`PreCompact`), so the "call check_files BEFORE editing"
contract is honor-system. The colliding agents are the last to know.
Two structural weaknesses: signals are **retroactive** (exist only after the
first write lands, so simultaneous starts both see all-clear) and
**file-level** (disjoint functions in one file look like a true collision).

### C — zero-onboarding depends on the agent voluntarily reading a file
No `SessionStart` hook exists, so a brand-new session receives **zero tokens**
automatically. The renderers all exist (`CODEBASE.md` pointer, `memoryBriefSection`
`src/memory.ts:533`, reports, signals) but nothing composes and pushes them.
Change history is captured per-merge (`src/reports.ts`) and per-handoff, not as a
queryable "what changed since yesterday."

### A — the MCP surface is mostly lean, with real waste at the edges
`asText()` pretty-prints every response (`src/mcp.ts:24-26`) — a flat ~15–25%
tax. `who_touched` (`src/history.ts:150`) and no-slug `get_report` (returns **10
full reports**, `src/reports.ts:140`) are unbounded. `recallMemories`
(`src/memory.ts:419`) ignores `deriveProject`, so in a hub a frontend agent is
served backend facts. In hub mode, `src/kb/mcp.ts:38` registers `graphify-<id>`
per project **plus** `graphify-merged` — ~4k tokens of near-duplicate tool
definitions per agent per session before any call.

### D — Baton currently *adds* to the sprawl it wants to fix
Single-repo `kb init` leaves 5–6 untracked items in `git status` (`.baton/`,
`graphify-out/`, `.graphifyignore`, `.mcp.json`, `CODEBASE.md`,
`GETTING_STARTED.md`) because only hub mode writes a gitignore
(`src/commands/setup.ts:227-241`). Baton's own repo has 9 root `.md` files with
the build recipe duplicated 3×.

### E — one-command setup exists for Claude Code only
`kbMcpCmd` **prints** snippets for Cursor/Codex/Gemini rather than writing them
(`src/commands/kb.ts:331-351`); hooks are a separate command; skills have no CLI.
Crucially, the *writers already exist* — `connectAgentMcp`
(`src/agents/connect.ts:198-225`) writes all four agents' configs but is only
reachable from the dashboard HTTP endpoint.

---

## The proposals in detail

### Tier 1

**P1 — Fix coordination-tool root + agent identity** · goals A, B · low
Swap `gitRoot()` → `resolveBatonRoot()` (`src/store.ts:71`, which correctly walks
*past* sub-repo git boundaries — the hub depends on this; `memory.ts:201-216`
already uses this pattern via `mainRepoRoot`). Then set `BATON_SLUG/BATON_TASK/
BATON_ROOT` at launch so tools know the caller: `check_files` stops flagging the
caller's own edits, `list_signals` shows "you" vs "others."
*Required modifications from verification:* (1) the plain swap is **defeated in
already-polluted worktrees** — the current bug has been `mkdirSync`-ing
`.baton/history.db` *inside* worktrees (`signals.ts:42`), and `resolveBatonRoot`
starts at cwd, so it would find that shadow dir and still return the worktree.
Must prefer `BATON_ROOT` env when set **and** add shadow-`.baton` cleanup
(hook into `cleanup.ts`, which already scans `.baton/wt`). (2) `terminals.ts:332`
uses tmux `set-environment`, which runs *after* `new-session` — the agent never
sees it; identity env must go in the real spawn env (`spawn.ts:124`), keeping the
tmux var as metadata only. (3) Memory tools already self-resolve — fix only the 5
coordination tools. Add a regression test running handlers with cwd inside a
worktree.

**P2 — PreToolUse edit-guard hook** · goal B · low
Extend `baton hooks install claude` with a `PreToolUse` hook on
`Edit|Write|MultiEdit` that calls the existing `GET /api/signals/check`
(`src/server.ts:395-399`) and injects `additionalContext` only on collision
("`src/auth.ts` under live edit by cursor (task-b), 40s ago"). This converts the
whole pull-only system into push-at-the-moment-it-matters using infrastructure
that already exists. Research is unanimous: **advisory grant-but-warn beats hard
locks** (MCP Agent Mail always grants and surfaces conflict inline; no adopted
OSS ships enforced global locks).
*Required modifications:* (1) **Ship advise-only; cut `block` from initial
scope** — agents are in isolated worktrees, so a collision is a *future merge
conflict*, not a live clobber; hard-denying is the heavyweight-lock antipattern
the proposal's own evidence warns against. `ask`/`block` stay a documented dial
(the Ponytail `lite/full/ultra` shape) for later, backing
`docs/01-coordination-and-locking.md`'s enforced-deny research. (2) **Path
mismatch** — signals store worktree-*relative* paths but hook payloads carry
*absolute* `file_path`; the shim must relativize or matching never fires.
(3) **Self-exclusion** — `checkFiles` includes the caller's own slug; add
`?exclude=slug` or every agent warns about itself. (4) **Fail-open with a tight
~300–500ms timeout** — the hook spawns a CLI + HTTP + git diff on *every* edit;
daemon-down must never stall editing. (5) Add a `watcherActive` liveness flag so
`busy:false` can be distinguished from "daemon not running." Gemini/Cursor wiring
is a follow-up (effort stays low only for Claude).

**P3 — SessionStart bootstrap + `orient()` tool** · goals C, A · low
Compose the existing renderers into `baton orient --auto` (rename to avoid
colliding with the handoff "brief," `src/handoff/brief.ts`) wired as a
`SessionStart` hook (~500–800 token hard cap), and expose the same composition
as one `orient(topic?)` MCP tool so Cursor/Codex/Gemini get identical one-call
onboarding. Reuses `contextpack.ts`'s `TRIM_STAGES` budget machinery for an
internal-agent audience — which the context-pack spec explicitly *parks*
(`2026-07-04-context-pack-design.md:161-168`), so this is genuine white space.
Grounding: Anthropic memory tool +39% quality / −84% tokens; focused ~300-token
context beats full context by 30–60 pts (Chroma Context Rot).
*Required modifications:* (1) **Drop live signals from the brief** — a
session-start snapshot of "who's editing what" is stale within minutes, and
Baton's own thesis says stale context is worse than none; carry only durable
content (CODEBASE.md pointer, fresh memory facts, recent reports) + a one-line
pointer to the live tools. (2) **Dedupe with the spawn path** — `spawn.ts:99-117`
already injects a handoff/task brief into baton-spawned sessions; `--auto` must
no-op or emit only the delta there (mirror the existing `--auto` skip in
`cli.ts:243`). (3) For non-Claude agents `orient()` is still voluntary — soften
the "zero-effort" claim to Claude's SessionStart path. Consider setting the
unused `McpServer.instructions` field (`src/mcp.ts:30`) as the zero-cost carrier
for the "call orient() first" nudge.

**P4 — Serena-style output contracts** · goal A · low · **survived clean (keep/keep)**
The leanest goal-A win — shrinks existing outputs, adds zero tools/context.
Four fixes: (1) drop pretty-print in `asText()` (`src/mcp.ts:24-26`), ~15–25%
off every response; (2) hard caps — `LIMIT 20 + "N more"` on `who_touched`
(`src/history.ts:158`), summary rows for no-slug `get_report`
(`src/reports.ts:140`); (3) an index mode for `recall_memory` (scan ids/first
lines, fetch bodies selectively — Serena's "Shortened result" contract);
(4) pass `ProjectRel[]` scoping into `recallMemories` (`src/memory.ts:419`) so hub
installs stop serving cross-project facts (the plumbing exists — `server.ts:791`
already passes it for the dashboard). *Refinements:* treat `project=null` as
always-served (shared/hub-level); the `list_signals/list_tasks` caps are
defensive only (bounded by live session count), not real savings — don't oversell
them. Generalizes unified-search's `max_tokens` contract to *all* tools.

**P5 — `report_progress` write-tool** · goals B, A · low
The value skeptic **split this proposal**: keep `report_progress`, **drop the
`get_updates` cursor tool**. Why `get_updates` dies: the event ring it would
expose (`src/events.ts:40`, `RING_SIZE=200`) is churned by `agent.output`
(every stdout line), `file.edited`, and `status.changed` — under exactly the
multi-agent load where goal B matters, `task.merged`/`signal.overlap` get evicted
within seconds, so a digest pulled "at natural breakpoints" is silently lossy;
ids also reset on daemon restart, invalidating every cursor. And the existing 7
tools already cover ~80% of it (`list_signals` = live state, no-slug
`get_report` = recent merges). If delta semantics are wanted, add a `since`
timestamp param to `listReports` — one param, durable by construction, zero new
tool-definition tokens.
What survives and is worth building: **`report_progress`** genuinely fills a gap
— interactive tmux agents are invisible except via file edits. Implement it as a
**persisted, timestamped note** on the task (edit_signals-style sqlite row),
surfaced inside `check_files`/`list_signals` ("holder says: refactoring auth,
~2 commits left, 4m ago"), aged out with the same 30-min window and cleared on
`commit.created` — because free-text intent goes stale fast, and stale intent is
worse than none. One bus event for the dashboard Live view.

### Tier 2

**P6 — Fix headless stale signals** · goal B · medium→small
Real bug: `StatusPoller` runs only while an SSE client is connected
(`src/poller.ts:28-38`), so `commit.created` (which clears signals) never fires
with no browser tab — the "editing now" view lags up to the 30-min TTL.
**Important correction from verification:** the headline "false-busy destroys
agent trust" is *overstated* — the agent-facing `checkFiles` already unions
signals with live `git diff` (`src/conflicts.ts:10-29`), so the guard-relevant
busy answer is **already correct headlessly**; only the cosmetic "editing right
now" view lags. So **don't** add a background poller ("whenever tasks exist" =
O(tasks) git spawns every 2s on an idle machine, reversing the explicit "idle
daemon does no git work" design, `poller.ts:6-7`). Instead: **lazy read-time
reconciliation** — at `getSignals`/`checkFiles` time, drop signal rows whose path
is absent from the task's uncommitted diff (committed or reverted). Zero
background work, fixes the view exactly when read, and also fixes the
edit-then-revert case commit-detection can't. Keep the per-path clearing
refinement (`signals.ts:85`); split the event-scoped status-refresh perf work
into its own item.

**P7 — One-command multi-agent setup** · goals E, C · medium→small
`baton setup --agents claude,cursor,codex,gemini` that **writes** (not prints)
every agent's config, runs hooks install, and adds a `baton skills
list|install|import` CLI. **Cheaper than specced:** route `--agents` through the
existing `connectAgentMcp` (`src/agents/connect.ts:198`) — it already writes
JSON+TOML+httpUrl forms with a no-clobber merge and a global-scope consent gate;
the CLI delta is just wiring, not new writers. **Correction:** the "two of four
agents never auto-load AGENTS.md" claim is **stale** — Cursor reads `AGENTS.md`
natively and Gemini reads it via `"contextFileName": "AGENTS.md"` in the same
`~/.gemini/settings.json` this already writes. So **don't** write parallel
`.cursor/rules/baton.mdc` + `GEMINI.md` copies (that recreates the hand-
maintained drift the proposal forbids) — no Cursor shim, one settings key for
Gemini. Honor the global-scope consent rule for `$HOME` writes. `npx baton setup`
(STATUS.md pending #5, npm packaging) is the distribution prerequisite for vibe
coders.

**P8 — Zero-footprint install** · goal D · medium→**small** · feas modify(83) · value modify(80)
**Ship part 1 only — both skeptics independently cut parts 2 and 3.**
(1) **KEEP:** marker-delimited `.gitignore` block at `kbInitCmd` — verified gap
(`src/commands/kb.ts:118-210` writes `.baton/`, `graphify-out/`,
`.graphifyignore`, `.mcp.json`, `CODEBASE.md` but never a repo `.gitignore`;
`ensureHubGitignore` is hub-mode only, `setup.ts:227-241`). ~15 lines mirroring
the existing idempotent marker-block pattern (`kb.ts:54`,
`src/kb/graphifyignore.ts:21-53`), zero token cost, directly serves D. Optionally
use `.git/info/exclude` to avoid touching a tracked file.
(2) **DROP** moving `graphify-out/` under `.baton/`: `graphPathFor`
(`src/kb/state.ts:39-41`) only *records* a path — it doesn't control where the
graph is written. The external graphify CLI hardcodes `<path>/graphify-out/`
(`src/kb/graphify.ts:68`, no `--out` on extract/update) and installs *its own*
per-commit hook that regenerates there regardless. Relocating fights the upstream
tool and breaks `readStats`, the `/api/kb` graph stream, `mergeGraphs`, and the
incremental hook — for a cosmetic gain that part 1's gitignore already delivers.
(3) **DROP** the `GETTING_STARTED.md` fold — **false premise:** `kb init` never
writes `GETTING_STARTED.md` (grep finds it only as an *instruction* in
`AGENTS.md:159` for the human-install flow). The "zero new root files" win is
already true — `kb init` only adds `CODEBASE.md` + `.mcp.json` and injects the
guide into an *existing* `AGENTS.md` via the marker block.

**P9 — Declared scope (keep) + `claim_files` intent (cut)** · goal B · medium · feas modify(78) · value modify(76)
Both skeptics split this and **kept only the scope half.**
**KEEP — declared scope:** add optional `scope: string[]` (globs) on `Task`
(`src/store.ts:9-22`, mirrors existing optional `projectId/repoRoot`, back-compat),
warn on overlap at *task-creation* time (reusing `computeConflictsFromSets`,
which today is *not* wired into `createTask` `src/commands/new.ts:55-108`), and
inject scope into the launch prompt (`src/spawn.ts:116`) — ~tens of tokens paid
*once* per launch: "you own `src/auth/**`, avoid `src/billing/**`." This closes
the simultaneous-start race (signals fire only on `file.edited`,
`src/signals.ts:79`, i.e. *after* the first write) and matches the research
verdict exactly: multi-agent coding fails at scope-conflicting *decomposition*,
not runtime locking (Cognition's "Don't Build Multi-Agents").
**CUT — the `claim_files` TTL intent tool:** (a) a TTL lease *is* runtime locking
— the exact layer the cited research says is the wrong place to fix conflicts;
(b) it duplicates machinery Baton already ships (`signals.ts` is the live
"who's editing" layer, `check_files` is the "ask before editing" tool, 2+-session
overlap is already flagged); (c) it adds an always-on MCP tool definition to
every agent's context (goal-A cost); (d) architecturally underspecified — `mcp.ts`
is a *read-only per-agent stdio process* with no daemon client and a dead
in-process bus, so "insert intent rows" is really a brand-new mutating write
surface (and it inherits the P1 `gitRoot` hub bug). Scope-declaration captures
~80% of the collision-avoidance value at near-zero standing cost. If a claim
primitive is ever wanted, extend the existing `edit_signals` table with an
optional pre-write intent row — not a second store + tool.

**P10 — Append-only KB journal** · goal C · medium→**small** · feas modify(83) · value modify(72)
Goal C wants "full change history," but knowledge silently disappears today:
supersession hard-deletes the old fact file (`src/memory.ts:323`), gc/prune
delete permanently (`:438-490`). **KEEP the substrate:** replace deletions with a
move to `.baton/memory/archive/` plus one JSONL journal line per op
(`{op,id,supersededBy,reason,at}`) + a `baton memory log` CLI. Recall is genuinely
unchanged at zero cost — `listMemoryFacts` does a *non-recursive* readdir over
flat `*.md` (`src/memory.ts:336`), so an `archive/` subdir is excluded
automatically. Feeds the planned repair queue a STALE fact's lineage instead of
tombstones; dedup auditor confirmed KB versioning has zero existing spec coverage.
*Required corrections:* (1) **DROP the `memory_history` MCP tool** — an 8th
always-registered tool loads into every agent's context regardless of use
(goal-A cost); lineage is a rare human-driven audit query that `baton memory log`
serves at zero agent-token cost. (2) **Wrong touchpoints:** the journal lives
entirely in `src/memory.ts`; `baton memory` subcommands are in
`src/commands/memory.ts` (**not** `kb.ts`), and `src/history.ts` is unrelated
commit-attribution sqlite — **don't touch it.** (3) State honestly that the
ledger lives under gitignored `.baton/memory/` — it's an on-disk audit substrate,
not a committed-across-clones history.

### Tier 3

**P11 — Cut hub graphify token duplication** · goal A · medium→**small** · feas modify(78) · value modify(76)
**The value skeptic caught the original's token math inflated ~3–5×.** Reality:
graphify exposes **2** tools (`query_graph`, `get_node`), not 6, so a 3-project
hub is 4 backends × 2 = ~8 duplicated defs (~800–1,200 tokens), not ~40 defs /
~4,000 tokens; and the Anthropic 49%→74% accuracy result is about *dozens* of
tools, not collapsing 8 project-suffixed near-duplicates. **The `query_kb` facade
is over-built for this** — and it can't live in `src/mcp.ts` anyway (that's the
standalone stdio coordination server, which by design runs *without* `baton
serve`; the shared-graphify plan explicitly preserved that). **Simpler fix that
captures ~80%:** in hub mode, register only `graphify-merged` (it already spans
all projects) by default and make per-project `graphify-<id>` opt-in — a one-line
change in `src/kb/mcp.ts` `mcpServers()`, no new proxy route.
**The real kernel, split out as its own item:** Codex genuinely still spawns
per-project `uv graphify.serve` stdio processes (`src/kb/mcp.ts:49-59`) because
its TOML supports only command+args — resurrecting the per-agent RAM problem the
shared server solved. But this is a **RAM** bug needing a stdio→daemon bridge
process, *not* the token fix, and a facade wouldn't fix it (Codex can't speak
HTTP). Also drop the spurious "depends on P4" claim.

**P12 — `baton doctor` `.md`-sprawl scan** · goal D · high→**medium** · feas modify(72) · value modify(72)
Goal D's ambitious end — confirmed 100% white space (zero
sprawl/hygiene/Diátaxis hits across all docs). Both skeptics **kept piece 1,
dropped piece 3, and folded piece 2 into P8.**
**KEEP — piece 1 (the load-bearing 80%):** extend `src/commands/doctor.ts` (today
a 66-line wrapper over `cleanup.ts`, which already has the
audit/`--dry-run`/`--fix` pattern) to scan for stray agent files (`memory-bank/`,
`NOTES.md`, `TODO-*.md`, duplicate rule files), **propose** doc moves into a
Diátaxis-lite skeleton, dates from git history. Token-positive (a CLI, no MCP
surface; removes files agents ingest).
*Required correction:* memory-like → fact import must be **propose-only, never
auto-`--fix`** — `saveMemory` enforces a 1,200-char cap + 500-fact cap
(`src/memory.ts:83-84`), so bulk-importing a `memory-bank/` would routinely
overflow or fail validation with no safe auto-split.
**DROP — piece 3 (runtime litter-watch):** the proposal itself flags it as "no
surveyed tool does this" = no evidence it works; it's always-on surveillance for
a problem the batch scan already solves at zero per-session cost, and transient
scratch files would become dashboard false-positives.
**MERGE — piece 2 (≤150-line router skeleton + linter) into P8/P7's setup path.**
Note the linter's own 150-line budget would flag Baton's *current* `AGENTS.md`
(211 lines) — the "self-exemplary" framing is aspirational, and the sprawl
patterns it scans for don't exist in this repo's root today.

---

## What NOT to build (anti-patterns the research killed)

- **Hard global file locks / enforced deny.** No adopted OSS multi-agent tool
  ships them; agents in isolated worktrees face merge conflicts, not live
  clobbers. Advisory grant-but-warn (P2 advise mode) is the proven shape.
- **Streaming/broadcasting all events into agent context.** Anthropic's
  multi-agent post-mortem names "excessive updates pushed into context" as a real
  failure mode. Pull-based, budgeted, timestamped digests only.
- **Exposing the in-memory event ring as a durable cursor (`get_updates`).**
  Lossy under load, resets on restart — dropped in favour of a `since` param on
  the persistent `listReports`.
- **A background poller to fix stale signals.** Reverses the "idle daemon does no
  git work" design; lazy read-time reconciliation is strictly better.
- **Parallel hand-maintained guide copies per agent.** Cursor and Gemini read
  `AGENTS.md` natively now — one source, thin shims only where truly needed
  (the Ponytail single-source discipline).
- **Adopting mem0/Letta/Graphiti wholesale.** Python/DB-server runtimes conflict
  with the zero-dep daemon ethos — steal patterns, not dependencies.

## Suggested sequencing

1. **P1** (unblocks all of B/C — it's a correctness bug), then **P4** (pure win,
   survived clean), then **P3** + **P2** + **P5-`report_progress`** — the tier-1
   awareness+onboarding+efficiency core, all low-effort.
2. **P6** (small once reframed) + **P7**/**P8-part1** (setup + hygiene quick wins).
3. **P9**/**P10**, then the tier-3 bets **P11**/**P12** as hub usage and the
   docs-hygiene story mature.

Baton should also **self-measure** to prove these (tokens-per-resolved-task,
time-to-first-edit, file re-read rate) — the honest-numbers discipline from the
memory-v2 research.
