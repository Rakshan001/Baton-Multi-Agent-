# Session-continuity & handoff — improvement backlog

> **Status:** planning notes only. Nothing here is implemented yet. Do **not** push — this is a
> working reference to pick up later (Baton is still in building phase).
>
> **Purpose:** capture *why* Baton's handoff/memory system "isn't actually helping" yet, with
> root causes anchored to real `file:line`, the research that backs each fix, and how to tackle
> it. Read the **Core diagnosis** first — most individual issues are symptoms of it.
>
> **How to use later:** each issue has an ID, severity, the symptom, the root cause (with code
> location), why it matters (evidence), and a concrete fix direction. When we resume, turn the
> P1/P2 items into a proper spec via the brainstorming → writing-plans flow.
>
> **Structure:** **Part 1** = defects (ISS-01…ISS-11, code-audit + research). **Part 2** =
> forward-looking product/architecture ideas from the live field report (FWD-01…FWD-12).
> **Part 3** = additional ideas not in the field report (ADD-01…ADD-06).
>
> **Numbering caveat:** the field report refers to "18 defects" and e.g. "issue #2
> (ls/doctor/status)". Those came from a **separate live audit of the real 5-repo hub** that is
> not reproduced in Part 1, so those numbers do **not** map to the ISS-xx IDs here. When the
> full 18-defect list is available, merge it as ISS-12+ and re-link the FWD cross-references.

---

## Progress log

**2026-07-16 (cont.) — ISS-08 done: the handoff brief is now budgeted (progressive disclosure). Completes all P2 items.**
`buildBrief` concatenated every section with no total cap, unlike `orient`'s 3200-char budget — a big brief measurably
hurts the receiver (context rot). The body is now assembled as priority-tagged sections and fit to a hard
`HANDOFF_MAX_CHARS = 4500` budget via a pure `fitBriefBody`: it drops the highest-`dropOrder` (lowest-value) section
first — commands → graph excerpt → files → notes → memory → git diff — and NEVER drops the continuation essentials
(objective, where-to-work, next step, plan, ISS-07 guardrails). git diff-stat is kept longest of the optional
sections because ISS-08 prefers verifiable ground truth over prose. When anything is trimmed, a one-line pointer
tells the receiver to pull the rest just-in-time (`git diff`, `orient`, `recall_memory`) — the "hold identifiers,
re-derive on demand" pattern, so an omission never reads as "nothing there". — `src/handoff/brief.ts`. Tests: +5
(`test/brief-budget.test.ts`: drop-order, never-drop essentials, overflow accepted, JIT pointer, integration). Suite
615 passing. **Uncommitted.**

**2026-07-16 (cont.) — ISS-07 done: positive-phrased guardrails + mid-session re-injection (completes the ISS-04/06/07 loss cluster).**
Prohibition ("do NOT") instructions decay hardest across a long session (measured 73%→33% by turn 16). Two fixes:
(A) one shared source of POSITIVE-phrased guardrails (`src/handoff/guardrails.ts`) — "stay inside this worktree ·
run the tests before `baton done` · execute the plan and flag blockers" — now used by the continuation head, the
handoff brief ("## Rules to hold" replaces "## Do NOT"), and the guard, so wording never drifts. (B) the Claude
edit-guard re-injects those guardrails mid-session on a 20-min debounce (a "safe turn depth" proxy) via a per-task
`.baton/guardrail/<slug>` marker, alongside any collision advisory — so the rules are refreshed before compliance
decays, not just stated once at start. Claude-only (Cursor already re-injects via its always-apply `.mdc` rule;
Codex/Gemini post-edit hooks can't inject context). Fail-open within the guard's 1500 ms budget. — `src/handoff/guardrails.ts`,
`src/handoff/continuation.ts`, `src/handoff/brief.ts`, `src/commands/guard.ts`. Tests: +8 (`test/guardrails.test.ts` ×4,
`test/guard.test.ts` ×2, `test/snapshot.test.ts` ×1, brief rephrase). Suite 610 passing. **Uncommitted.**

**2026-07-16 — ISS-06 done: agent-agnostic plan/notes capture (the brief no longer collapses to git-only for non-Claude agents).**
`buildBrief`'s Plan / Files / Last-notes came only from Claude's JSONL transcript, so a Cursor/Codex/Gemini
handoff (or cutoff snapshot) printed "context above is from git alone" — the continuation state you most need
vanished for every non-Claude agent. New durable per-task **progress ledger** (`src/handoff/progress-ledger.ts`,
`.baton/progress/<slug>.json`): plan/notes/next REPLACE, files accumulate, atomic writes, capped like
session-brief. New **`save_progress` MCP tool** any agent calls with its current plan/notes. `buildBrief` now
merges `max(transcript, ledger)` per field and only falls back to git-only when BOTH are empty — so `snapshot`
and `baton pass` (which ride on `buildBrief`) inherit it automatically. Edge cases locked: an empty patch never
fabricates a Plan; a status-less item defaults to `pending`; corrupt/absent JSON degrades to git ground truth.
Tool-help budget raised 1900→2100 (13th always-on tool, kept lean at 197 chars). — `src/handoff/progress-ledger.ts`,
`src/handoff/brief.ts`, `src/mcp.ts`, `src/mcp-help.ts`. Tests: +7 (`test/progress-ledger.test.ts` ×6, mcp-help
budget). Suite 601 passing. This is ADD-04-lite: one agent-agnostic capture surface feeding the same brief
sections, instead of per-agent transcript parsers. **Uncommitted.**

**2026-07-15 (cont.) — ISS-05 done: memory self-heal no longer needs the daemon.**
`repairMemories` (the mechanical re-anchor pass) used to run only inside `baton serve` (startup + every
10 min), so a terminal-first user with no daemon never got stale-but-still-true facts healed — recall
withheld them forever. `recallMemories` now runs an opportunistic repair pass (`maybeRepairOnRecall`)
before it reads facts, debounced to at most once per 10 min via a shared `.baton/memory/.repair-check`
marker that the daemon, the `baton memory repair` CLI, and the recall pass all stamp — so a running
daemon keeps the recall-time pass dormant (no double work) and a no-daemon session still heals on the
first recall in the window. Best-effort: any failure falls back to plain withholding, never blocks
recall. The pre-stamp (before repairing) guards against concurrent recalls piling on. — `src/memory.ts`.
Tests: +2 (`test/memory.test.ts`) — heals on recall with no daemon; debounces a re-stale fact within the
window (still surfaced as an ISS-04 pointer). Suite 596 passing. **Uncommitted.**

**2026-07-15 (cont.) — ISS-04 done: withheld stale facts surface as re-grounding pointers, not a bare count.**
`recallMemories` now returns `staleGrounding: Regrounding[]` alongside the `staleDropped` count (additive —
every existing consumer/test untouched). Each pointer carries what the fact claimed (`was`), the short commit
it was true at (`trueAsOf`), the anchor file to re-check (`verify`), and why it went stale (`reason`). Topic
mode scopes pointers to the topic (`rankFacts`); no-topic orders by fewest commits behind; capped at 5, excludes
the opportunistic `review` pick. Surfaced on **both** the MCP `recall_memory` output (with a "verify before
trusting, don't re-derive blind" tip) **and** the injected brief/orient/contextpack sections via
`memoryBriefSection` (budgeted: ≤2 inline "was true @ commit — verify `<file>`" lines + "+N more withheld",
per ISS-08). — `src/memory.ts`, `src/mcp.ts`, `src/handoff/brief.ts`, `src/kb/orient.ts`, `src/kb/contextpack.ts`,
`src/spawn.ts`. Tests: +3 (`test/memory.test.ts`). Suite 594 passing. This is the CUPMem gated-readout shape:
tell the agent what to re-check instead of hiding it. **Uncommitted.**

**2026-07-15 (cont.) — Presence layer ADD-07 complete (A + B + C), committed.** Slice C (ISS-13) landed:
`resolveBatonRoot` resolves a hub sub-project up to the hub store instead of adopting a sub-project shadow
`.baton`, and `baton doctor` (+`--fix`) detects/reconciles shadow `.baton` dirs. See
[presence-layer-followups.md](./presence-layer-followups.md). Commits `7575df2` (round-2 signal fixes),
`27ef3c6` (slice C).

**2026-07-15 — P1 continuation cluster (ISS-01 / ISS-02 / ISS-03): first pass landed, uncommitted.**
The "manual launch is blind" + "no brief at cutoff" loop is now closed for Claude **and** Cursor.

- **ISS-02 + ISS-01 (Claude):** `baton orient --auto` no longer *suppresses* itself when a HANDOFF
  exists — it now MERGES orientation with a tiny continuation head. A manually-launched Claude in a
  worktree gets both. A baton-*spawned* session (env `BATON_SLUG` set) still gets orient-only, no
  duplicate. — `src/commands/orient.ts`.
- **ADD-03 tiered head:** new `renderContinuationHead()` — ≤800-char must-read block (objective ·
  next open action · workdir · positive-phrased guardrails · "read HANDOFF.md before re-planning").
  Pure function of a HANDOFF.md; full detail pulled JIT. — `src/handoff/continuation.ts`.
- **ISS-03 (agent-agnostic snapshot):** new hidden `baton snapshot [slug]` — refreshes a worktree's
  HANDOFF.md from git+transcript ground truth, **debounced (5 min), no commit, status-preserving**
  (won't un-take an in-progress brief or clobber a done one). The edit-guard fires it **detached** on
  every edit (mtime-gated, so the guard's 1500 ms budget is never spent on a rebuild). Works for
  Cursor/Codex/hand-edits via `git diff` — no transcript required. — `src/commands/snapshot.ts`,
  wired in `src/commands/guard.ts`. Root resolves via `resolveMcpRoot` (BATON_ROOT + git-common-dir
  escape) so it's correct in a linked worktree / hub.
- **Tests:** `test/continuation.test.ts` (10), `test/snapshot.test.ts` (9) — all green; full suite
  563 pass (1 pre-existing unrelated failure: `stack-migration.explain.how` in WIP `catalog.ts`).
- **Verified end-to-end:** Cursor edit → guard → detached snapshot writes HANDOFF.md (WIP stays
  uncommitted) → `baton take` → manual launch → `orient --auto` injects the resume head.

**2026-07-15 (cont.) — cluster completed for all four agents.**
- **ISS-01 (Cursor read side): DONE.** `snapshotTask` now also mirrors the continuation head to
  `.cursor/rules/baton-continuation.mdc` (Cursor auto-loads `.cursor/rules/*.mdc`, `alwaysApply: true`)
  and git-excludes it via the checkout's `.git/info/exclude` so `pass`'s checkpoint commit can never
  sweep the artifact into the user's branch. A manual Cursor launch now resumes with no paste step. —
  `src/handoff/continuation.ts` (`renderCursorRule`), `src/commands/snapshot.ts` (`writeCursorRule` +
  `gitExcludeLocal`).
- **ISS-03 (Codex/Gemini write side): DONE.** The MCP `touch_files` handler now fires `snapshotTask`
  (debounced, best-effort, non-blocking) for a real task, so agents that coordinate via MCP rather
  than an edit hook also keep a resumable brief fresh. — `src/mcp.ts`.
- **Tests:** +3 (`renderCursorRule` ×2, Cursor-rule write+exclude ×1). Full suite **566 pass** (same
  1 pre-existing WIP failure). E2E verified: snapshot writes the `.mdc` rule and git ignores it.

**The P1 continuation cluster (ISS-01 / ISS-02 / ISS-03 + ADD-03) is functionally complete for
Claude, Cursor, Codex, and Gemini.** Remaining polish (optional, not blocking):
- **ISS-03 depth:** a lightweight burst-lock so a rapid edit burst can't spawn 2–3 snapshots in the
  same window (currently tolerated; last-writer-wins, near-identical content).
- **Docs:** mention `baton snapshot` + the `.cursor/rules` artifact in AGENTS.md / SETUP.md.

**2026-07-15 (cont.) — Presence layer (ADD-07), slice B landed: the session registry is surfaced.**
The "#1 reason the hub feels broken" — a Cursor/Claude/codex session in a plain terminal (or wired
only via MCP) never appears on the dashboard because both presence panels are built from task
worktrees only (`collectStatus` → `loadTasks`). Those sessions *do* register in `hook_sessions`
(MCP connect / edit hooks) but that table was never read for display (ISS-12 / ISS-14).

- **Backend:** `liveSessions(root)` reads `hook_sessions` within a `PRESENCE_WINDOW_MIN` (30 min)
  window; `collectPresence(root)` filters out any slug that is already a task worktree (so a task's
  own MCP session isn't double-listed) and flags each as `live` when seen within the heartbeat window
  (≈2 min → actively working) vs idle-but-connected. — `src/signals.ts`, `src/board.ts`.
- **API:** `GET /api/sessions` → `collectPresence`. Additive; no existing endpoint changed. —
  `src/server.ts`.
- **Web:** a "Connected agents" panel on Activity (real mode only, polled 5 s) showing agent badge ·
  slug · short checkout path · last-seen, with a live/idle dot. Hidden when empty; demo mode
  untouched (returns `[]`, section stays quiet — consistent with `getRootAgents`). —
  `web/src/features/Activity.tsx`, `web/src/lib/api.ts` (`getSessions`), `web/src/types.ts`.
- **Tests:** `test/presence.test.ts` (4) — registry surfaced, task-slug dedup, window cutoff,
  live-vs-idle flag. Full suite **570 pass** (same 1 pre-existing WIP failure in `catalog.ts`); web
  build clean.

**2026-07-15 (cont.) — Presence layer (ADD-07), slice A landed: agent-agnostic capture.**
A live signal used to require a Claude hook, a Cursor hook, or a voluntary MCP `touch_files` call,
and the daemon's `WorktreeWatcher` only watched `baton new` task worktrees — so the common case (an
agent working in the plain repo checkout, no worktree) and codex/gemini/hand-edits produced nothing
live. The watcher now also watches every non-task git checkout in the hub and derives signals from
git dirty state, with zero per-agent setup.

- **Watcher:** `resync` now reconciles task worktrees PLUS checkout roots — the sub-projects in a
  multi-repo hub (`co-<projectId>`), or the hub root itself in a single-repo setup (`co-root`). The
  hub root is skipped when sub-projects exist so a recursive root watch can't double-count files a
  sub-project watch already sees. — `src/watch.ts` (`checkoutRoots`).
- **Registry:** a `watched_roots` table (slug → checkout path) the watcher keeps in sync with the
  checkout watchers it holds (cleared on `stop()` — the daemon owns it). — `src/signals.ts`.
- **Reconcile + attribution:** read-time reconcile now verifies `co-*` checkout signals against their
  checkout's git dirty state (so a settled/committed file's signal is pruned, not left to linger the
  full TTL). `getSignals` layers the agent name onto a checkout signal from any session registered at
  that checkout root (fs-watch sees *what* changed, the registry says *who*). — `src/signals.ts`.
- **Tests:** `test/watch-checkouts.test.ts` (5) — single-repo watches `co-root`; hub watches each
  sub-project not the root; `stop()` clears the registry; settled-vs-dirty reconcile; agent layering.
  Full suite **575 pass** (same 1 pre-existing WIP failure). E2E: a hand-edit in a plain checkout
  (no hook/MCP/worktree) surfaces as a live `co-root` signal end-to-end through the real watcher.

Remaining ADD-07 slice (this track continues):
- **C · One coherent hub DB:** guarantee a single DB all agents write to and the daemon reads
  regardless of sub-project `.baton/` dirs (fixes ISS-13, the silent write/read divergence);
  `doctor` detects and reconciles shadow `.baton/` dirs under the hub.

---

## Core diagnosis (the one thing to internalise)

Baton's *ideas* are sound and the research validates all three bets (evidence-anchored memory,
knowledge-graph over raw reads, one-file handoff). The failure is the **last mile: the good
context almost never lands in the receiving agent's context window automatically.**

Every link in the chain is **voluntary**:
- the previous agent must *choose* to `save_memory` / `create_handoff`,
- the human must *paste* `baton take` output,
- the receiving agent must *choose* to call `recall_memory` / `orient`.

Every tool that actually works at continuity uses **unconditional auto-injection**, not opt-in:
- **Cline Memory Bank** — custom instructions force *"I MUST read ALL memory bank files at the
  start of EVERY task — this is not optional"* (docs.cline.bot). *[verified]*
- **Claude Code auto-memory** — `MEMORY.md` auto-loaded every session, capped at 200 lines / 25KB
  (code.claude.com). *[verified]*
- **Codex** — `memory_summary.md` auto-injected into the system prompt, ~5K-token budget. *[sourced]*

**The single switch between "real saving" and "infra nobody uses" is P1 below — whether context
reaches the next agent without anyone remembering to do anything.**

---

## Prioritised issues

Severity: **P1** = blocks the core goal (an agent continuing after a session limit) · **P2** =
causes hallucination / silent context loss · **P3** = efficiency / polish.

### ISS-01 · P1 · Handoff never auto-reaches a human-launched agent
- **Symptom:** you open Cursor/Claude yourself in the worktree and the agent starts blind; it
  re-plans, re-reads, or hallucinates the prior state.
- **Root cause:** `baton take` only **prints the brief to stdout** for a human to paste
  (`src/commands/take.ts:37-40`); `baton resume` is the same (`src/commands/resume.ts:59-64`).
  The *only* auto-injection is when Baton itself headlessly spawns the agent and passes the brief
  as the CLI prompt (`src/spawn.ts:104-108`). Manual launches get nothing.
- **Why it matters:** this is the placebo failure mode — the artifact exists but is not consumed.
- **Fix direction:** write the continuation brief into the channel each agent *already
  auto-loads* — `CLAUDE.md` / `.cursor/rules/` / `AGENTS.md` (a managed, clearly-delimited
  Baton block that gets rewritten each handoff, not appended). Piggyback on the mechanism that
  already injects, instead of inventing a paste step. Keep the block small (see ISS-08).

### ISS-02 · P1 · Orient is suppressed exactly when a handoff exists
- **Symptom:** a partial hook install leaves an agent with *neither* orientation *nor* handoff.
- **Root cause:** `orient --auto` emits nothing when a non-`done` `HANDOFF.md` is present
  (`src/kb/orient.ts:23-28`), on the assumption the spawn path already injected orientation. For a
  manually-launched agent that assumption is false, so both channels stay silent.
- **Why it matters:** the two fallbacks cancel each other out precisely in the common case.
- **Fix direction:** **merge** orient + handoff into one injected brief rather than making them
  mutually exclusive. Orientation (durable repo map + memory) and the handoff (this task's state)
  are complementary; the receiver needs both.

### ISS-03 · P1 · Session death captures nothing unless it's Claude + hooks + worktree
- **Symptom:** you hit a usage/context limit and there is no HANDOFF.md to resume from — the work
  just evaporates. This is *the* scenario you care about ("after session limit, another agent
  continues").
- **Root cause:** auto-capture rides Claude's **Stop / PreCompact** hooks → `baton pass --auto`
  (`src/commands/hooks.ts:4-8, 39-40`). Restrictions: only Claude (not Cursor/Codex/Gemini —
  `hooks.ts:68-73`), only if hooks are installed, only inside a baton worktree
  (`pass.ts:88-90` returns null otherwise). There is **no SessionEnd hook, no periodic snapshot,
  no rate-limit event** (the code itself concedes this — `hooks.ts:100`, `docs/session-handoff.md:124-127`).
  A hard rate-limit cutoff that skips Stop/PreCompact captures nothing.
- **Why it matters:** the exact event you want to survive (limit reached) is the one least likely
  to fire a capture hook.
- **Fix direction:** (a) periodic HANDOFF snapshots — debounced, every N minutes or N edits, so a
  usable brief always exists on disk; (b) an agent-agnostic capture path so Cursor/Codex/Gemini
  aren't dead ends; (c) treat git checkpoint + last-good snapshot as the resumable unit.
  Precedent: Anthropic's Claude-plays-Pokémon agent continues across hard context resets purely by
  reading its own persisted `NOTES.md` *[verified]* — durable notes beat live hooks.

### ISS-04 · P2 · Stale memory vanishes as a bare count → invites re-derivation (hallucination) — **DONE 2026-07-15** (see progress log)
- **Symptom:** the receiving agent hallucinates a fact the project already settled.
- **Root cause:** `recallMemories` drops stale facts and returns only a `staleWithheld` **count**
  (`src/memory.ts:542-585`, surfaced at `src/mcp.ts:250`). From the agent's view the knowledge is
  simply gone — a gap, not a warning.
- **Why it matters:** the STALE benchmark found even the best model is only ~55% at noticing its
  own memory went invalid, and drops from 92% → 30% when a task *presupposes* the stale fact
  *[sourced]*. An empty gap is exactly what triggers a confident wrong re-derivation. The
  withhold instinct is right; the *silent* part is wrong.
- **Fix direction:** surface a **re-grounding pointer** instead of a count: *"this WAS true as of
  commit X; verify against `<file>` before trusting."* The CUPMem result (write-time
  KEEP/STALE/REPLACE marking + gated readout) raised accuracy 8.7% → 68% on the same backbone
  *[sourced]* — i.e. tell the agent what to re-check, don't hide it.

### ISS-05 · P2 · Memory auto-repair only runs inside the daemon — **DONE 2026-07-15** (see progress log)
- **Symptom:** run without `baton serve` and stale facts stay dead forever; recall never heals them.
- **Root cause:** `repairMemories` is invoked only on daemon start and every 10 min
  (`src/server.ts:1180-1181`). `recallMemories` itself never repairs — it only withholds
  (`src/memory.ts:542-585`). Terminal-first users (Baton's stated default) never get repair.
- **Why it matters:** Baton advertises terminal-first / no-daemon operation, but a core
  self-healing behaviour is daemon-gated and undocumented as such.
- **Fix direction:** run a cheap repair pass opportunistically on recall (or on the git
  post-commit hook), not only in the daemon loop. Re-anchor when every mechanically-verifiable
  term still survives verbatim (the logic already exists in `repairMemories`).

### ISS-06 · P2 · Brief's plan / todos / notes are Claude-transcript-only — **DONE 2026-07-16** (see progress log)
- **Symptom:** hand off from Cursor/Codex and the "Plan", "Files edited", and "Last notes"
  sections silently collapse to git-only — the checklist and remaining-work state are lost.
- **Root cause:** those sections are parsed from Claude Code's JSONL transcript
  (`src/agents/claude-session.ts:102-127`); on no/foreign transcript the brief prints
  *"context above is from git alone"* (`src/handoff/brief.ts:111-113`).
- **Why it matters:** the continuation state you most need (what's done, what's left) is the part
  most likely to disappear for non-Claude agents.
- **Fix direction:** capture plan/checklist state through an agent-agnostic channel — e.g. an MCP
  `save_progress` tool the agent calls, or parse each agent's own transcript format, or keep a
  durable per-task ledger updated on edit-signals rather than only at pass-time.

### ISS-07 · P2 · "Do NOT" guardrails in the brief decay mid-session — **DONE 2026-07-16** (see progress log)
- **Symptom:** the receiving agent ignores "stay in the worktree / don't re-plan / run tests
  before done" once it's deep into its session.
- **Root cause:** these are static one-shot lines in the brief (`src/handoff/brief.ts:133-143`),
  injected once at start. Prohibition-type (omission) instructions decay hardest.
- **Why it matters:** a 4,416-trial study measured omission-instruction compliance falling from
  73% at turn 5 to 33% by turn 16, while requirement-type instructions held *[sourced]*. A
  one-time guardrail is worn away by mid-session.
- **Fix direction:** re-inject the critical constraints periodically (hook-driven, before a
  per-model "safe turn depth"), and phrase them as positive requirements where possible ("commit
  inside `.baton/wt/...`") rather than prohibitions.

### ISS-08 · P2 · Long brief → context rot; needs progressive disclosure — **DONE 2026-07-16** (see progress log)
- **Symptom:** a big, thorough brief paradoxically makes the receiver *less* accurate.
- **Root cause:** the brief concatenates every non-empty section (`brief.ts:75-146`); there is no
  hard budget on the handoff the way `orient` caps at 3200 chars (`orient.ts:22`).
- **Why it matters:** context rot is confirmed across all models — recall degrades as tokens grow
  *[verified]*. One paper found `AGENTS.md`-style context files can *reduce* task success and add
  ~20% cost *[sourced]*. Bigger is not safer.
- **Fix direction:** short brief + pointers. Tell the receiver what to **re-derive just-in-time**
  (Anthropic's confirmed recommendation: hold lightweight identifiers, pull detail via tools) vs
  what to trust. Prefer **verifiable ground truth** (tests-pass state, `git diff --stat`) over
  prose claims the receiver must believe.

### ISS-09 · P3 · Graph is treated as always-better; it underserves some tasks
- **Symptom:** map-first navigation misleads on work that genuinely needs full line-level source.
- **Root cause:** the workflow/docs push "navigate the map before reading files" unconditionally;
  the graph excerpt is injected into every brief (`brief.ts:116-123`).
- **Why it matters:** measured — the KG agent hits ~90% of raw-file quality at ~10× fewer tokens,
  but the raw-file agent **wins on 16/31 languages** when full source is needed and 10/31 for
  exhaustive call-site grep *[sourced]*. The map intentionally omits line-level code.
- **Fix direction:** make map-first a per-task hint, not a mandate; let tasks that need full
  source skip/deprioritise the graph excerpt.

### ISS-10 · P3 · "Use map/recall first" is unenforced (the real placebo lever)
- **Symptom:** you pay the setup/overhead but agents brute-force grep anyway, capturing none of
  the saving.
- **Root cause:** whether agents consult graph/memory before reading is governed only by prose in
  `CLAUDE.md` / `AGENTS.md` + the token-efficient-coding skill — not enforced.
- **Why it matters:** this is the single switch between "real saving" and "ceremony" (per the live
  audit of your 5-repo setup). But note ISS-08's caveat — more instruction text is not free.
- **Fix direction:** verify the coordination docs actually instruct map/recall-first; measure
  whether agents follow it; consider a lightweight nudge in the injected brief rather than a long
  standing instruction block.

### ISS-11 · P3 · `est_cost_usd` semantics are easy to misread
- **Symptom:** the number looks like the handoff's cost but is the *whole-transcript replay* cost.
- **Root cause:** `est_tokens = totalTranscriptChars / 4` (`src/agents/claude-session.ts:85,141`),
  `est_cost_usd` at flat $3/M (`brief.ts:38-40`) — it's the cost *avoided*, not incurred.
- **Fix direction:** label it explicitly as "estimated cost to replay this session from scratch
  (what the handoff saves)" so it isn't read as overhead.

### ISS-12 · P1 · Dashboard "Active sessions" / "Per-agent activity" only show Baton task worktrees
- **Symptom:** you run Cursor/Claude in a normal terminal and it never appears under Active
  sessions or Per-agent activity — even after hooks are installed.
- **Root cause:** both panels are built from `/api/status` → `collectStatus` → `loadTasks(root)`
  (`src/board.ts:25-52`, `web/src/features/Activity.tsx:105-106`), i.e. `.baton/wt/<slug>` task
  worktrees only. A session in a plain checkout has no `StatusRow`, so it structurally cannot
  appear. Only the "Live edit signals" panel (reads `edit_signals`) can reflect it. The code that
  *does* detect plain-terminal agents (`/api/agents/root`, `board.ts:66-77`) is never called by
  Activity (only `CommandCenter.tsx:94` calls it).
- **Why it matters:** this is the #1 reason the hub "feels broken" — the user's mental model
  ("any agent session shows up") does not match a worktree-only implementation.
- **Fix direction:** surface a real session registry on Activity (see ADD-07). At minimum, have
  Activity also call `/api/agents/root` and merge those sessions in.

### ISS-13 · P1 · Hub write/read DB divergence (signals written to a sub-project `.baton`)
- **Symptom:** in a multi-repo hub, an agent edits a sub-project file, a signal is written, but the
  dashboard shows nothing.
- **Root cause:** all signal I/O keys off `getDb(root)` = `<root>/.baton/history.db`
  (`src/signals.ts:53-64`). The daemon reads the **hub** root (`src/server.ts:1110`
  `resolveBatonRoot`), but the agent write path walks up to the **nearest** `.baton/`
  (`src/store.ts:74-113` `resolveMcpRoot`/`resolveBatonRoot`). If a sub-project owns its own or a
  stale shadow `.baton/` (acknowledged at `store.ts:93-95`), writes hit the sub-project DB while
  reads hit the hub DB. Because terminal agents aren't Baton-spawned, `BATON_ROOT` is unset
  (`spawn.ts:130`), so the safe fast-path is skipped and the vulnerable walk-up always runs.
- **Why it matters:** silent, hub-only, and invisible — the exact profile of "it just doesn't work
  and I can't see why." Related to the known gitRoot→worktree resolution concern.
- **Fix direction:** guarantee one hub DB (see ADD-07/C); `doctor` should detect and reconcile
  shadow `.baton/` dirs under the hub.

### ISS-14 · P2 · MCP connect registers a session but writes no signal, and the registry is never shown
- **Symptom:** wiring the Baton MCP server into an agent still shows nothing live.
- **Root cause:** on connect the MCP server calls `registerHookSession` (`src/mcp.ts:50-55`) —
  which writes only a `hook_sessions` row, never an `edit_signal`. A live signal requires the
  agent to actively call `touch_files` (`mcp.ts:136-147`). And `hook_sessions` is never surfaced as
  a session on the dashboard (see ISS-12).
- **Why it matters:** users reasonably expect "connect MCP → I'm visible"; instead visibility needs
  a voluntary per-edit tool call the agent won't make unless instructed.
- **Fix direction:** surface `hook_sessions` as presence (ADD-07/B); optionally have the daemon
  fs-watcher generate signals so `touch_files` isn't required (ADD-07/A).

### ISS-15 · P2 · Read-time hiders can prune real, current edits
- **Symptom:** a genuinely-in-progress edit doesn't show, or vanishes after a commit.
- **Root cause (`src/signals.ts`):** 30-min TTL (`SIGNAL_WINDOW_MIN`, l.67); `clear()` on
  `commit.created`/`task.merged`/`task.removed` (l.236-244); dirty-vs-HEAD reconcile that drops any
  signal whose path is no longer dirty in the resolved root, past a 15s grace (l.337-365).
- **Why it matters:** by design, but surprising — committing your fix empties the panel, and edits
  older than 30 min disappear.
- **Fix direction:** document the semantics; consider a "recently active (committed)" state instead
  of hard-clearing, so the dashboard can still show "X finished editing Y 2m ago."

### ISS-16 · P3 · Demo mode (default-on in dev) masks real signals
- **Symptom:** dev-server view shows fixtures and hides the Live edit signals section entirely.
- **Root cause:** `demo = ls.get("baton:demo", import.meta.env.DEV)` (`web/src/lib/api.ts:71`) →
  ON under `npm run dev`, persisted in localStorage; `Activity.tsx:187`
  `{!demo && <LiveSignalsSection/>}` drops the whole section in demo.
- **Note:** ruled OUT for the current report — the user can see the Live signals section, so their
  view is the real daemon, not demo. Kept for completeness.
- **Fix direction:** a visible "DEMO" banner when demo is on against a live daemon, so it's never
  mistaken for real emptiness.

---

## Priority ordering for when we resume

1. **ISS-01 + ISS-02 + ISS-03** — the P1 cluster. Together they are "another agent can continue
   after a session limit." Do these first; spec them as one feature: *durable, auto-injected,
   agent-agnostic continuation state.*
2. **ISS-04 + ISS-06 + ISS-07** — the hallucination/loss cluster (stale re-grounding, agnostic
   plan capture, guardrail re-injection).
3. **ISS-05** — decouple repair from the daemon.
4. **ISS-08** — progressive disclosure / budget the brief (do alongside ISS-01 so the injected
   block stays small).
5. **ISS-09 / ISS-10 / ISS-11** — polish and correctness of framing.

---

## Part 2 · Forward-looking product & architecture ideas (from the live field report)

These are **capabilities and design changes** — how Baton becomes better as a product, not just
less broken. Grounded in the live 5-repo audit session. Cross-refs point to the Part 1 defect the
idea would also resolve or build on.

### FWD-01 · Make freshness a first-class lifecycle, not a manual chore *(builds on ISS-05, ISS-09)*
The single biggest lever. Instead of "remember to `kb rebuild`," tie the graph to git: a
post-commit / post-merge hook rebuilds only the changed project **incrementally**, and every MCP
query returns `staleness: {commitsBehind, ageDays}`. The agent then decides whether to trust the
map. Turns the #1 hallucination risk into a self-healing property.

### FWD-02 · Confidence / provenance on every fact Baton returns *(builds on ISS-04)*
Today a graph node or memory is returned flat — the agent can't tell "verified 2h ago" from
"asserted 6 days ago against code that has since changed." Attach
`{source, lastVerified, verifiedAgainstSHA}` to memories and graph symbols so agents weight
context by provenance instead of trusting everything equally (which is how stale facts become
hallucinations).

### FWD-03 · Close the loop — measure whether the map was actually used, and self-correct *(new)*
Baton ships a map but never learns if agents used it. Log map-query events per session; if a
session did heavy grep with **zero** map queries, surface it in usage: *"this session bypassed the
KB — 0 queries, ~120K tokens of raw reads."* That one metric tells the user whether they're
getting value or paying overhead for a placebo, and gives Baton data to improve onboarding prompts.

### FWD-04 · Memory as a curated, decaying store — not an append log *(builds on ISS-04)*
It's growing into a wall of 300-word entries. Add: (a) automatic dedup/merge of overlapping facts,
(b) a decay/archival policy (facts unused for N weeks demote out of default recall), (c) a periodic
"memory GC" an agent runs to compress + verify. Memory that only grows eventually costs more tokens
than it saves — the long-term failure mode.

### FWD-05 · Task-scoped context packs instead of whole-hub context *(builds on ISS-02, ISS-08)*
`orient` today is generic. Given a task ("today sales chart hourly"), Baton could assemble a
**scoped pack**: the relevant graph subgraph (shortest-path / neighbors from the entry symbols),
the 3 most relevant memories, and recent commits touching those files. That's the real 10–50×
token win — targeted context beats a generic brief every time.

### FWD-06 · A "verify-before-done" gate Baton actually enforces *(addresses the junk-code fear)*
The stack-migration skill has a ≥95% skeptic gate, but Baton itself has no verification primitive.
A `baton verify <slug>` that runs the project's typecheck/lint/test **plus a symbol-existence check
against the graph** (did this diff reference symbols that don't exist?) catches hallucinated code
before merge — the junk-code fear turned into a guardrail.

### FWD-07 · One unified Baton state (make `status` authoritative) *(field-report issue #2)*
Instead of reconciling `ls` / `doctor` / `status`, collapse them into one source of truth with
views; everything else becomes a filter on it.

### FWD-08 · Interactive `doctor --fix` with per-item decisions *(field-report issue: orphans)*
Dirty worktrees need human judgment; empty orphans don't. `doctor` should triage into "safe to
auto-reclaim" vs "needs your call (dirty WIP)" and walk the user through the latter.

### FWD-09 · Ship a reference CLAUDE.md / AGENTS.md stanza as a template *(builds on ISS-10)*
The map-first/recall-first instruction is the difference between saving and placebo, yet it's left
to the user. Ship it via `baton setup --with-agent-instructions` that writes a proven, **versioned**
stanza so `doctor` can detect drift. (Balance against ISS-08 — keep the stanza short.)

### FWD-10 · Graph diff on PR / branch *(builds on ISS-04 re-verify)*
`get_pr_impact` exists — surface it proactively: when a branch is ready, show *"this change
adds/removes these symbols, touches these communities, and 3 memories anchor to changed files
(re-verify them)."* Makes the graph earn its keep at review time, not just discovery time.

### FWD-11 · Be honest about the break-even in the docs *(builds on ISS-11)*
Net-positive on large/unfamiliar/multi-agent work; net-negative on small solo edits (fixed MCP +
memory overhead). Say so. A `doctor` line like *"this repo is ~40K tokens — map overhead may exceed
savings; Baton shines above ~500K"* builds trust and stops users blaming it for the wrong use case.

### FWD-12 · A lightweight eval harness for Baton itself *(builds on FWD-03)*
Run the same task with/without the KB across a few repos; measure discovery tokens + correctness;
publish it. Right now nobody — including the maintainer — can prove the value. An eval turns "feels
like a gimmick" into a number.

**Field report's top-3 to build next:** FWD-01 (freshness-as-lifecycle), FWD-03 (map-usage
telemetry), FWD-05 (task-scoped context packs) — together they convert Baton from "a map you hope
agents use" into "a system that stays true, proves it's used, and delivers targeted context."

---

## Part 3 · Additional ideas (not in the field report)

### ADD-01 · Symbol-range memory anchoring *(precision fix for ISS-04 / FWD-02)*
Facts are anchored to a **whole-file** content hash (`src/memory.ts` `fileHash`), so an edit to an
unrelated function in the same file marks the fact stale — a false-stale that produces exactly the
ISS-04 knowledge gap. Anchor facts to **symbol / line ranges** instead, so a fact about
`computeHourly()` survives edits elsewhere in the file. Raises the precision of the entire freshness
system and shrinks needless withholding.

### ADD-02 · Handoff receipt / acknowledgement loop *(verifies P1)*
The receiving agent echoes back the **objective + next action** before starting work. Turns "did
the injected brief actually land?" from a hope into a verifiable checkpoint, and gives Baton a
signal to log (feeds FWD-03 telemetry). Cheap, and it directly closes the ISS-01/ISS-02 injection loop.

### ADD-03 · Tiered handoff (must-read head + pull-if-needed tail) *(marries FWD-05 + ISS-08)*
Split the brief into a tiny **always-injected head** (objective, next action, guardrails ≤ ~400
tokens) and a **pull-on-demand tail** (full plan, graph excerpt, file list) behind an MCP tool. Gets
the scoped-pack win of FWD-05 while dodging the context-rot of ISS-08 — the receiver pulls detail
just-in-time (Anthropic's confirmed pattern) instead of ingesting everything up front.

### ADD-04 · Capture-adapter registry *(the missing mirror of the skills registry — fixes ISS-06)*
Baton installs *skills* into each agent's native format (`.claude/skills/…`, `.cursor/rules/…`).
Build the symmetric half for **capture**: a per-agent transcript-parser registry so Cursor / Codex /
Gemini sessions produce plan/checklist/files state too, not just Claude. Removes the Claude-only
dependency in `src/handoff/brief.ts` at the product level.

### ADD-05 · Scoped memory visibility for subagents *(multi-agent hygiene)*
From the fleet-memory research (scoped retrieval / policy-governed propagation): a subagent should
see only memories within its task scope, not the whole hub. Prevents cross-task stale bleed and
provenance collapse when several agents run in parallel — the scenario Baton is built for.

### ADD-06 · Semantic re-verification tier for high-value facts *(hash-fresh ≠ still-true)*
A fact can be hash-**fresh** yet semantically wrong after a refactor elsewhere, or hash-**stale**
yet still true. For facts flagged high-value, allow an optional cheap LLM re-check (CUPMem-style
KEEP/STALE/REPLACE) rather than trusting the file hash alone. Complements FWD-02 provenance and the
ISS-04 re-grounding pointer.

**My top-3 additions to pair with the field report's:** ADD-03 (tiered handoff) and ADD-02
(receipt loop) make the P1 injection work *reliably and cheaply*; ADD-01 (symbol-range anchoring)
makes the freshness system stop crying wolf. Those three reinforce FWD-01/03/05 rather than compete
with them.

### ADD-07 · Centralized presence layer — "every agent communicates" *(resolves ISS-12/13/14; the hub vision)*

The goal: any agent, in any checkout, hooked or not, is visible on one live board without
per-agent setup. Baton is ~70% there — the primitives exist but presence is *worktree-centric* and
communication is *opt-in per agent*. Three changes make it a true hub:

- **A · Agent-agnostic capture (daemon-side fs watcher).** Today a live signal needs a Claude hook,
  a Cursor hook, or a voluntary MCP `touch_files` call — three opt-ins; codex/gemini get nothing
  automatic. The daemon already has `WorktreeWatcher` (`src/watch.ts:59-81`) but it only watches
  `baton new` task worktrees (`t.worktreePath`). **Extend it to watch every git checkout in the
  hub** and derive live signals from `git` dirty state. Then edit signals work for *any* agent —
  even hand-editing — with zero setup. Trade-off: fs-watch sees *what* changed, not *who*; attribute
  to checkout/branch and layer the agent name from the session registry (B) when available.
- **B · First-class session registry, surfaced.** `hook_sessions` (`src/signals.ts:44-49`) + MCP
  auto-registration (`src/mcp.ts:50-55`) already record every connected agent, but the dashboard
  shows task worktrees instead (ISS-12/ISS-14). **Surface the registry directly on Activity**, add a
  heartbeat so "active" is live, and merge it with the fs-watcher's file activity. Then "who's
  connected" and "what's being touched" are both real, for all agents.
- **C · One coherent hub DB.** Guarantee a single DB all agents write to and the daemon reads,
  regardless of sub-project `.baton/` dirs (fixes ISS-13). `doctor` detects and reconciles shadow
  `.baton/` dirs under the hub.

Net: **fs-watch (agent-agnostic "what") + surfaced session registry ("who") + one hub DB.** This is
wiring and surfacing, not a rewrite — it converts Baton from "a board of Baton-managed tasks" into
"a live presence layer over every agent on the repo," which is the centralized model the maintainer
is asking for. Pairs naturally with ADD-04 (capture-adapter registry) for the plan/checklist half.

---

## Evidence appendix (research backing)

`[verified]` = independently confirmed by ≥2 adversarial checks. `[sourced]` = from a primary
source but its verification pass was interrupted (the research run itself hit a session limit —
fittingly, the exact failure this doc is about). Treat `[sourced]` as strong-but-unconfirmed.

| Claim | Status | Source |
|---|---|---|
| Cline Memory Bank forces mandatory read of all memory files every task | verified | docs.cline.bot/prompting/cline-memory-bank |
| Claude Code auto-memory auto-loads MEMORY.md (first 200 lines / 25KB) every session | verified | code.claude.com/docs/en/how-claude-code-works |
| Context rot: recall degrades as context grows, across all models | verified | anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Agent-maintained NOTES.md enables continuation across hard context resets | verified | anthropic.com (Claude-plays-Pokémon) |
| Just-in-time retrieval > pre-loading; hold identifiers, re-derive via tools | verified | anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Codex memory_summary.md auto-injected, ~5K-token budget | sourced | codex.danielvaughan.com |
| KG agent ≈90% of raw-file quality at ~10× fewer tokens; but raw wins 16/31 langs needing full source | sourced | arxiv 2603.27277 |
| KG-over-MCP cut a 5-question test from 412K → 3.4K tokens (~99%) | sourced | toknow.ai |
| AGENTS.md-style context files can *reduce* success and add ~20% cost | sourced | arxiv 2602.11988 |
| STALE benchmark: best model 55% at noticing invalid memory; 92%→30% under false presupposition | sourced | arxiv 2605.06527 |
| CUPMem write-time staleness marking + gated readout: 8.7% → 68% accuracy | sourced | arxiv 2605.06527 |
| Omission ("do not") instruction compliance decays 73%→33% by turn 16 | sourced | arxiv 2604.20911 |
| Re-injecting constraints before a per-model safe-turn-depth restores compliance | sourced | arxiv 2604.20911 |
| Fleet-memory failure modes: stale propagation + provenance collapse mislead receivers | sourced | arxiv 2606.24535 |
| Structured, injected handoff: Transfer Continuity 0.84–0.88 vs 0.35 with none (~2.4×) | sourced | arxiv 2605.11032 |
| Handoff should go through a re-hydration pipeline (verify→filter→rank→compress→format→inject) | sourced | arxiv 2605.11032 |
