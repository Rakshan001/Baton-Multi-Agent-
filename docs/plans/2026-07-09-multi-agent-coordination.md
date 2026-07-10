# Every-agent coordination — implementation plan

> Goal: a developer runs **Claude Code (backend) + Antigravity (UI) + Cursor + Codex at the
> same time** on production code — in worktrees or plain terminals at the repo root, daemon
> optional — and every session sees what the others are editing, shares the one knowledge
> base, and never re-fixes a fixed bug.
>
> Working rule: a phase is implemented only at **≥95% confidence** in the underlying
> platform facts; anything version-gated or single-sourced stays in this plan as research
> until verified. Update the checkboxes + progress log as phases land (this file is the
> traceability record).

## Agent capability matrix (researched 2026-07-08, Ponytail adapters + vendor docs)

| Agent | Per-edit hook | Session id | MCP config | Instructions | Detect (`ps`) |
|---|---|---|---|---|---|
| Claude Code | ✅ `PreToolUse` (`.claude/settings.json`) | `session_id` | `.mcp.json` | `CLAUDE.md` | `claude` |
| Cursor | ✅ `afterFileEdit` (`.cursor/hooks.json`, v1.7+) | `conversation_id` | `.cursor/mcp.json` | `.cursor/rules/`, `AGENTS.md` | `Cursor` app / `cursor-agent` |
| Codex CLI | ⚠ `PostToolUse` `apply_patch` — needs per-user `/hooks` trust, version-gated | `session_id` | `~/.codex/config.toml` | `AGENTS.md` | `codex` |
| Gemini CLI | ⚠ `AfterTool` (`.gemini/settings.json`) — edit-tool names unverified; **EOL 2026-06-18** | `session_id` | same settings.json | `GEMINI.md`/`AGENTS.md` | `gemini` |
| Antigravity CLI | ⚠ inherits Gemini JSON hooks (migration docs; unverified on install) | presumed | `.agents/mcp_config.json` (paths conflict across sources) | `AGENTS.md` + `.agents/rules/` | `agy` |
| Antigravity IDE | ❌ none documented | n/a | `~/.gemini/config/mcp_config.json` | `AGENTS.md` + `.agents/rules/` | `Antigravity` app |
| OpenCode | ✅ via JS plugin `tool.execute.before/after` (`.opencode/plugins/*.mjs`) | `sessionID` (medium confidence) | `opencode.json` | `AGENTS.md` | `opencode` |
| aider | ❌ no hooks, no MCP | n/a | — | `CONVENTIONS.md` | `aider` |

**Coordination tiers.** Tier 1 (per-edit hook writes signals): claude, cursor — live today.
Tier 2 (MCP identity: auto session registration + `touch_files`/`report_progress`, instructed
by AGENTS.md): codex, gemini, antigravity, opencode — live today, compliance-based.
Tier 3 (safety net, daemon running): fs-watcher on worktrees (today) + main checkout (M6).
aider: git-native (auto-commits every edit → post-commit signals) — M7.

## Phases

- [x] **M1 — MCP session identity for every agent** *(shipped 2026-07-09, 439 tests)*
  `baton mcp` runs one process per agent session → pid = session (`sess-p<pid>`), parent
  process chain = agent (`detectParentAgent`, zero config; `BATON_AGENT` env override).
  Auto-registers in `hook_sessions`; `report_progress` now works without a worktree;
  new `touch_files` tool records edit signals; AGENTS.md guide teaches both.
  *Proof: smoke — MCP session at repo root touched a file → `baton signals` showed
  `sess-p15263 (claude)` with the agent detected from the parent chain.*
- [x] **M2 — Cursor edit hooks** *(shipped 2026-07-09)*
  `baton hooks install cursor [--project]` writes `afterFileEdit → baton guard --agent
  cursor` into `.cursor/hooks.json` (non-destructive, idempotent). The guard normalizes
  Cursor's payload (`conversation_id`/`file_path`/`workspace_roots`) onto the Claude shape
  and records the signal; it stays silent to non-Claude hosts (their reply protocol for
  context injection is undocumented). Every Cursor edit is now a live signal — IDE or CLI,
  root or worktree, daemon or not.
- [x] **M3 — Antigravity in the registry** *(shipped 2026-07-09; detection-only)*
  `agy` CLI + Antigravity.app detected in process scans and parent-chain identity; web
  `AgentId` extended. Launchers deliberately omitted (flags inherited-from-gemini per
  migration docs but unverified — don't guess spawn args). MCP config write deferred:
  three sources give three different config paths; verify on a real install first.
- [ ] **M4 — Codex hooks adapter** *(blocked <95%: hooks need per-user `/hooks` trust and
  are version-gated; two config shapes documented)*. Until then Codex uses Tier 2 — which
  its `AGENTS.md` reading makes reliable. Verify on a real codex install, then reuse the
  M2 pattern (`baton guard --agent codex`, `PostToolUse` matcher `apply_patch`).
- [ ] **M5 — Antigravity/Gemini hooks + skills target** *(blocked <95%: `AfterTool` edit-tool
  names unverified; Antigravity plugin hook events undocumented)*. Also: skills install
  target `.agents/rules/<id>.md` for Antigravity once verified — extends "Add to all".
- [ ] **M6 — Daemon main-checkout watcher (safety net)**. Watch the main repo root like a
  worktree; attribute edits to a `main-checkout` pseudo-session (agent via process scan).
  Catches any agent that has neither hooks nor MCP compliance — daemon required, by design.
- [ ] **M7 — aider via git**. aider auto-commits every edit; a post-commit signal (author
  prefix `aider:`) is cleaner than fs events. Low priority until aider is actually used.
- [ ] **M8 — OpenCode plugin**. Ship a ~20-line `.opencode/plugins/baton.mjs` calling
  `baton guard --agent opencode` on `tool.execute.after`. Straightforward; needs an
  opencode install to verify the plugin API surface.

## Edge cases (tracked)

- **Two sessions of the same agent at the root** — distinct hook session ids / MCP pids →
  distinct `sess-*` slugs. ✅ covered (G2/M1).
- **Hook fires before the file hits disk** — 15s reconcile grace period. ✅ (G2)
- **Signal for a file later committed/reverted with no daemon** — read-time reconcile
  against the session's own checkout. ✅ (P6/G2)
- **Cursor: several IDE windows** — one `conversation_id` per chat, so parallel chats are
  distinct sessions; one shared MCP server per window is possible → pid identity may
  conflate chats in the same window (documented; hook identity wins for cursor). ⚠ accepted
- **pid recycling** — `sess-p<pid>` could theoretically be reused after reboot within the
  30-min signal window; registration overwrite makes the newer session win. ⚠ accepted
- **Hub roots** — session registration stores the session's own git root; reconcile runs
  there, not at the hub root. ✅ (G2)
- **`hook_sessions` growth** — rows are upserts keyed by slug; stale rows are harmless
  (only consulted for live signals). GC with signals TTL if it ever matters. ⚠ accepted
- **Windows** — `/proc` vs `lsof` paths handled in detection; `ps -o ppid=` parent walk is
  POSIX-only → parent-agent detection silently degrades to `BATON_AGENT`/null. ⚠ accepted

## Live-hub bugs (found on the real FAT_FOX 5-project hub, 2026-07-09)

- [x] **B1 — dashboard blind to root-terminal sessions** *(fixed 2026-07-09, 447 tests)*
  Symptom: 6+ live Claude sessions in plain terminals at the hub root, dashboard
  said "No agents attached right now." Cause: `collectStatus`/`detectAgents` are
  entirely task-worktree-scoped; a session at the hub root matches no worktree.
  Fix: `detectRootAgents` (scans the whole process table, matches cwd against the
  hub root + every kb project, excludes task worktrees, collapses launcher/worker
  process pairs so one GUI-hosted session isn't double-counted) → `rootAgentSummary`
  → `GET /api/agents/root` → CommandCenter merges the counts into "Active sessions"
  + the agent chips, with an "N at repo root" note. *Live-verified against FAT_FOX:
  reports 9 (6 terminal + 3 Claude-Desktop-hosted), matching the real process tree.*
- [x] **B2 — history shows no commits made outside `baton merge`** *(fixed 2026-07-09,
  453 tests)*. Symptom: dozens of real merged commits on the FAT_FOX sub-repos,
  `history.db` `commits` table empty. Cause: the table is written ONLY by
  `recordMerge()`, called only from `baton merge <slug>`; these agents merge via
  GitHub PRs directly on the sub-repos, which Baton never sees. Fix: `git.recentCommits`
  reads a repo's last N non-merge commits + files; `history.ingestGitLog` upserts them
  into a synthetic per-project bucket (slug `git:<projectId>`, task `<name> · direct
  commits`, agent null) — idempotent (ON CONFLICT sha DO NOTHING; files inserted only
  for genuinely-new shas, so a commit a real task already owns keeps its attribution).
  Daemon runs `ingestAllProjects` at startup + every 60s. History page + who_touched/
  blame need no change (they JOIN the bucket task row). *Live-verified: 100 real FAT_FOX
  commits ingested with correct messages across the two active sub-repos.*
- [ ] **B3 — Cursor IDE not counted at root**. The registry detects `cursor-agent`
  (the CLI) but not the Cursor IDE app, whose agent runs inside the extension host
  with no repo-cwd process to scan. Cursor coordination is via hooks (M2:
  `baton hooks install cursor`)/MCP, not process detection — process-counting the
  IDE would false-positive on every window. Document rather than hack.

## W-round: workspace hygiene + honest-graph + parity (from the 2026-07-09 audit scores)

- [x] **W1 — worktree GC** *(shipped 2026-07-10)*. `baton clean` now also surveys every
  registered worktree per kb project (`git worktree list --porcelain`), classifies
  main/dirty/unmerged/locked/merged (merge target: `origin/<default>` first — the
  PR-merge workflow — then local main/master; nothing resolvable → all unmerged,
  fail safe), and with `--fix` removes ONLY merged+clean trees via `git worktree
  remove` (no --force: git is the second safety net). Branches are never deleted.
  Baton tasks whose tree is removed are dropped from the store (canonicalized
  paths — macOS /var symlink). du only on removable candidates (RAM/time-light).
  *Live dry-run on FAT_FOX: 42 removable, ~8.8G reclaimable, dirty/unmerged all
  correctly protected.*
- [x] **W2 — branch-divergence graph warning** *(shipped 2026-07-10)*. Found worse than
  planned: in a hub, a worktree session matched NO kb project → no freshness note at
  all. `projectForCwd` now resolves the owning project via git-common-dir, and orient
  appends `renderBranchDivergenceNote` — the indexable files where the session's
  branch differs from the graph's build commit ("the graph describes code this branch
  does not have — re-read these"). Direct two-commit diff, no ancestry assumption.
- [x] **W3 — unmanaged-worktree truth-telling** *(shipped 2026-07-10)*. The G2 nudge
  wrongly told foreign-worktree sessions "working in the main checkout". Linked-
  worktree detection (git-dir ≠ git-common-dir) now yields the honest hint: unmanaged
  worktree, nothing auto-cleans it, prefer `baton new`.
- [x] **W4 — Antigravity skills** *(shipped 2026-07-10)*. SKILL_AGENTS += antigravity →
  `.agents/skills/<id>/SKILL.md` + references/, verbatim SKILL.md format shared with
  Claude — evidenced by a live Antigravity workspace layout, not docs. "Add to all"
  covers it; web SkillAgent + registry glyph added.
- [x] **W5 — downshift routing** *(shipped 2026-07-10)*. A keyword rule always won even
  when severity said trivial ("quick typo fix in the plan doc" → 'plan' rule →
  claude/opus). Rules still win (explicit config), but clearly-trivial tasks
  (severity <25) now carry an advisory `downshift` (light/local chain + reason) —
  suggest-only, like escalation. Mirrored in web/src/lib/routing.ts; parity suite
  gained a downshift case so the mirror can't drift. `baton route` prints
  "💡 cheaper option".
- [ ] **W6 — memory auto-capture** *(deferred BELOW the 95% gate, deliberately)*. The
  only real mechanism is a Claude Stop-hook `{"decision":"block"}` that forces a
  save_memory pass before the session ends (with `stop_hook_active` as the loop
  guard). The exact contract is unverified here and the pattern is intrusive-by-design
  (blocks every stop). Verify on a real session first; alternative: a conditional
  UserPromptSubmit nudge (mechanism proven by Ponytail) gated on "N commits and no
  memory saved" — needs a cheap per-session detection story. Do not ship a guess.

## Improvement roadmap — every subsystem toward 8.5 (honest ceilings)

> Rule: no faked rankings. Each subsystem lists its real levers, the score they can
> honestly reach, and — where 8.5 is NOT reachable — why, explicitly. Priority order
> per the owner: token economy first; handoff = the manual relay UX now, full
> auto-resume later; the graph's ceiling is capped by an upstream tool we don't own.

### T — Token economy: 6.5 → 8.5 ✅ reachable (top priority)
- [ ] **T1 — slim the MCP tool schemas.** ~2–2.5k tokens of prose descriptions are paid
  by EVERY session. Rewrite each description to its minimum effective form (target
  ≥45% cut), verify agents still call tools correctly. Measure before/after with a
  tokenizer — the number goes in the README.
- [ ] **T2 — slim orient + AGENTS.md guide.** Orient is already budgeted (~800); the
  guide (~350) can drop to ~180 without losing the check→touch→report loop.
- [ ] **T3 — graph-answer caps.** `who_touched` is capped; audit graph proxy answers and
  `list_signals` for unbounded lists; cap with "(+N more)" like freshness notes.
- [ ] **T4 — overhead meter (feeds P1).** Record the actual injected overhead per session
  so the cost is a measured number, not an estimate.
  *Ceiling honesty: fixed overhead can drop to ~2–2.5k/session but never to zero — MCP
  schemas must live in context. 8.5 = lean overhead + measured net savings; 10 would
  require host-side lazy tool loading we don't control.*

### H — Handoff (manual relay first): 5 → 8.5 ✅ reachable
The owner's real flow: an agent near its usage limit is told "create handoff" → it
writes a structured brief (done / pending / next steps / files / gotchas) → the human
copies it into the next agent, which continues. Full auto-resume (orphan detection,
queues) is deliberately LATER.
- [ ] **H1 — `create_handoff` MCP tool** so ANY agent (cursor/codex/antigravity — not
  just Claude's Stop hook) can write the brief on request; store per-session, not
  per-task-slug only, so root sessions can hand off too.
- [ ] **H2 — bundled `handoff` skill**: teaches the agent WHAT a good brief contains
  (completed %, remaining work as a checklist, files in flight, decisions made,
  next command to run) — invoked by "create a handoff", zero standing token cost.
- [ ] **H3 — copy UX in the dashboard**: the Handoff dialog gets "Copy brief",
  "Copy file path", and "Copy resume prompt" (a paste-ready prompt for the next
  agent: "You are resuming task X; here is the brief: …").
- [ ] **H4 — `baton take` with no slug** lists takeable briefs newest-first; `baton
  resume` as the alias that prints the resume prompt for the top one.
  *Later (X2): dead-session detection + orphaned-task queue + auto-notify.*

### P — Proof / instrumentation: 2 → 8.5 ✅ reachable (answers the critics)
- [ ] **P1 — savings ledger.** Count, per session: overhead injected (T4); map reads vs
  `repoTokens` (the exploration a map read replaced); memory recalls (× the measured
  rediscovery cost); `bugs`/`get_report` hits; guard collisions surfaced.
  `baton usage --verdict` prints net tokens saved/spent, honestly signed.
- [ ] **P2 — A/B benchmark harness** (Ponytail's pattern): same task set, same repo,
  with and without Baton wiring; publish the numbers, favorable or not.
- [ ] **P3 — "When NOT to use Baton" README section** with the break-even table
  (small repo / solo / one-off session ⇒ net cost). Honesty is the marketing.

### A — Agent parity: 6.5 → 8.5 ✅ reachable (needs 2 live verifications)
- [ ] **A1 — verification session on the owner's real installs**: run codex + agy once,
  capture hook config shape + payloads (`baton doctor --agents` helper that probes
  installed CLIs and reports what's wirable). This unlocks M4/M5 at ≥95%.
- [ ] **A2 — M4 codex hooks, A3 — M5 antigravity/gemini hooks, A4 — M8 opencode plugin**
  (reuse the M2 guard pattern; each lands only after A1 verifies its facts).

### HI — History/attribution: 7 → 8.5 ✅ reachable
- [ ] **HI1 — inferred attribution for PR commits.** Commits land under the human's git
  identity (by policy), so author ≠ agent. Correlate branch↔task-slug and
  files+time-window↔edit signals to attribute `git:` bucket commits to a session —
  ALWAYS labelled "inferred", never presented as fact.
- [ ] **HI2 — `baton bugs` uses the ingested PR history** for suspect-commit ranking
  (it currently leans on task history).

### K — Knowledge graph: 5.5 → ~7.5–8 ⚠ 8.5 NOT honestly reachable today
- [ ] **K1 — auto re-merge the hub graph** when a sub-project graph.json changes
  (daemon mtime watch, debounced). Kills the hub-lag staleness.
- [ ] **K2 — bound serving RAM**: recycle a graphify backend past an RSS threshold /
  query count (pool already reaps idle). The BUILD spike (720MB→1.8GB) is inside
  graphify itself — upstream work, out of our tree.
- [ ] **K3 — opt-in idle incremental rebuild** (`kb.autoRebuild`): debounced `graphify
  update` after edit signals go quiet — CPU cost, zero token cost, keeps the graph
  fresher than commit-gating without rebuild-per-keystroke.
  *Ceiling honesty: per-branch graphs for every worktree would fix branch-blindness
  but cost a build per worktree per rebase — not economical; we warn instead (W2).
  Build-RAM is graphify's. With K1–K3: ~7.5–8. Claiming 8.5 would be the kind of
  fake ranking this plan forbids.*

### Overall: 6.5 → ~8.3 with T+H+P+A+HI landed; >8.5 additionally needs X2 (auto-resume)
and the graph ceiling accepted or graphify improved upstream.

## Progress log

- 2026-07-08: G1 (graph-freshness golden rule) + G2 (root sessions via Claude hooks) shipped.
- 2026-07-09: research matrix (Ponytail 16 adapters + vendor docs); M1 + M2 + M3 shipped;
  439 tests green; this plan created.
- 2026-07-09 (FAT_FOX live-hub debugging): B1 (root-terminal sessions now counted on the
  dashboard) + B2 (git-history ingestion so PR-merged commits show) shipped; 453 tests
  green; both live-verified against the real 5-project hub. B3 (Cursor IDE) documented.
- 2026-07-10: honest audit of the live hub (25GB total; 13GB = 60+ agent-created orphaned
  worktrees, ~90% already merged; Baton's own footprint 29MB) → W-round shipped W1–W5,
  W6 deferred below the confidence gate. 476 tests green.
