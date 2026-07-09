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

## Progress log

- 2026-07-08: G1 (graph-freshness golden rule) + G2 (root sessions via Claude hooks) shipped.
- 2026-07-09: research matrix (Ponytail 16 adapters + vendor docs); M1 + M2 + M3 shipped;
  439 tests green; this plan created.
- 2026-07-09 (FAT_FOX live-hub debugging): B1 (root-terminal sessions now counted on the
  dashboard) + B2 (git-history ingestion so PR-merged commits show) shipped; 453 tests
  green; both live-verified against the real 5-project hub. B3 (Cursor IDE) documented.
