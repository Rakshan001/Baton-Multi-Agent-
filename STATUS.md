# Baton — Project Status

> Snapshot of what is BUILT, what is PENDING, and where things live.
> Update this file at the end of every working session.
> Last updated: **2026-07-08 (session 10: skills v2 — S1–S6 on `feat/skills-v2`)** (PR #5 = the P1–P12 coordination audit on `feat/worktree-orchestration`, still open)

## What this project is

Baton is a **centralized knowledge base + coordination hub for multiple AI coding
agents** (Claude Code, Cursor, Codex, Gemini CLI, Aider, OpenCode) working on the
same repo. Each task runs in an isolated git worktree; a local daemon + dashboard
give you: a code knowledge graph agents can query, realtime visibility into who is
editing what, warnings when two sessions touch the same file, completion reports so
waiting agents know when a bug is already fixed, and session handoff briefs so work
continues on a cheaper agent when Claude Code hits its session limit.

Vision docs: [README.md](README.md) · [BUILD.md](BUILD.md) · [MVP.md](MVP.md). Setup: [SETUP.md](SETUP.md).

## Built & verified ✅

| Feature | What it does | See it work |
|---|---|---|
| **Graphify knowledge base** | `baton kb init` indexes the repo (sub-projects auto-detected → one graph each + merged view) via the external `graphify` CLI; git hook auto-rebuilds on commit; MCP config generated so agents can `query_graph` | `baton kb init && baton kb status`; dashboard → Knowledge Graph |
| **One-command setup (`baton setup`)** | Classifies the target folder and routes (`src/commands/setup.ts` `classifyTarget`): a single repo → `kb init`; a folder holding several *separate* git repos → asks **centralized hub** (auto `git init` at the container root + `.gitignore` + merged cross-project graph + one dashboard) vs **individual** per repo; a bare project → offers `git init` here. Reuses `kbInitCmd`. Robustness: `ensureBinPath` (`src/util/path-env.ts`) augments PATH at startup so a GUI/thin-PATH daemon still finds tmux/graphify; `detectTmux` re-probes after a negative instead of caching it; `currentBranch` tolerates an unborn HEAD (no `/api/meta` 500 on a fresh hub) | `baton setup <folder-of-repos>` → choose hub; `baton setup` inside a repo; `npx vitest run test/setup.test.ts` |
| **Knowledge Graph page** | Force-directed canvas of graph.json: search + neighbor highlight, community filters, node inspector with source locations, write-gated Rebuild | dashboard → Knowledge Graph (654 nodes on this repo) |
| **SSE realtime** | `GET /api/events` pushes status/task/commit/agent/file/kb/handoff events; per-worktree fs watcher; daemon-side status diffing; UI shows "Live (push)" and updates instantly | `curl -N localhost:7077/api/events` then touch a file in a worktree |
| **Edit signals** | Live "task X is editing file Y"; 2+ sessions on one path → `signal.overlap` warning in Conflicts + Activity | edit the same file in two worktrees, watch Conflicts page |
| **check-before-edit** | Agents ask "is this file busy?" via `baton mcp` tool `check_files` or `GET /api/signals/check?files=…` | `baton signals` / curl |
| **Completion reports** | On merge: summary + files + commits persisted (`.baton/reports/<slug>.md`), pushed to overlapping sessions, shown in History; `get_report` MCP tool answers "is my bug already fixed?" | merge a task, then `curl localhost:7077/api/reports` |
| **Agent blame** | `baton blame <file>` / `GET /api/blame` — which task/agent touched a file (merged history + live editors) | `baton blame src/cli.ts` |
| **Session handoff** | `baton pass` parses the Claude Code JSONL session → `HANDOFF.md` brief (plan, files touched, git state, graph excerpt); `baton take` prints the execution prompt; `baton done`; Claude Stop/PreCompact hooks via `baton hooks install claude`; Handoff dialog in dashboard drives the real endpoint | `baton pass <slug> --to cursor` then `baton take <slug>` |
| **Static dashboard serving** | `baton serve` serves the built UI at the same port as the API (SPA fallback, traversal-guarded) | `npm run build --prefix web && baton serve` → http://localhost:7077 |
| **Real project switcher** | Connections model: register multiple daemons (one per repo, `baton serve -p <port>`), switch between them in the top-left switcher; identity from each daemon's `/api/meta` | top-left switcher → "Add connection…" |
| **Real Live Session** | Demo's fake website mock + fake dev-servers are gone; real mode streams the SSE feed per session (edits, commits, attach/detach, overlap warnings) with API backfill | open a session → Live |
| **Honest Activity page** | Real mode: active/commits/files/progress cards, per-agent commits+files rollup, live edit-signals section; fake token numbers exist only in demo mode | Activity page with demo OFF |
| **CODEBASE.md layer** | `baton kb init/rebuild` generates a <2k-token deterministic map per project (stack, tree, top graph symbols, query pointers) + a root index for multi-server containers; staleness footer tied to the graph's commit; AGENTS.md tells agents to read it first. Prior art: Aider repo-map, Repomix, llms.txt | `baton kb rebuild` → open CODEBASE.md; `baton kb status` flags staleness |
| **Agent routing** | `baton.config.json` (committed): plan→claude/opus, UI→gemini, bugfix→codex, default cursor; `baton pass` without `--to` auto-routes (word-boundary keyword scoring, no LLM); `baton route "<task>"`; `/api/routing`; Handoff dialog preselects with a "suggested" chip, Launch shows a suggestion row, Settings shows the rules. Prior art: claude-code-router | `baton route "fix the crash"` → codex; `baton pass <slug>` → routed frontmatter |
| **Tiered model routing (v2)** | Single source of truth `src/agents/registry.ts` (id/binary/detect/headless+interactive launchers/model flag) — `spawn.ts`/`terminals.ts`/`agents.ts`/`routing.ts` all derive from it. `src/routing.ts` (+ parity-locked web mirror): three **modes** (`auto`/`manual`/`single`), 0–100 **severity** score (`scoreSeverity`, deterministic hints), **tiers** heavy/standard/light/local as ordered fallback **chains** (`resolveChain` skips uninstalled CLIs), `suggestRoute` returns the explainable suggestion (matched keywords + severity signals + confidence). `model` plumbed end-to-end: `--model` on `baton start`/`baton pass`, headless + interactive launch, `/api/*` bodies. | `baton route "refactor the storage engine for concurrency"` → heavy tier (claude:opus); `baton route "fix typo"` → local tier |
| **Junk cleanup (`doctor`/`clean`)** | `baton doctor` audits junk — orphaned worktrees (tasks.json↔disk both directions), orphaned `baton/*` branches, ghost tmux sessions, leaked `*.tmp` from crashed atomic writes, stale `.baton/tmp` uploads (`src/cleanup.ts`, pure detectors + I/O wrapper). `baton clean` is **dry-run by default**; `--fix` reclaims, `--force` for dirty worktrees; reuses `removeTaskWorktree`/`removeWorktree`/`killSessionFor`. `GET /api/doctor` + `POST /api/doctor/clean` (write-gated, `{apply,force}`). **Prevention**: daemon startup sweep deletes only provably-dead temp files (dead pid + age, never live writes/worktrees); `.baton/tmp` upload dir now removed after use. Never deletes a dirty worktree or a live-pid tmp. | `baton doctor`; `baton clean --fix` (cleaned 5 stale test tasks live, 7→2); `curl localhost:7077/api/doctor` |
| **Agent roster + MCP connect** | `GET /api/agents` (`src/agents/roster.ts`) = per-agent **installed?** (PATH probe, 30s cache) / headless / interactive / **MCP wired?** / **live sessions** (process scan + headless runs + terminals unified). Rebuilt Agents screen is the real roster (no more "idle"≡"not installed"); Connect-MCP per agent via `POST /api/agents/:id/connect` (`src/agents/connect.ts`): project files (`.mcp.json`, `.cursor/mcp.json`) auto-write, global files (`~/.gemini/settings.json`, `~/.codex/config.toml`) return a preview and require `confirmGlobal`; non-destructive JSON merge / idempotent TOML append; aider/opencode surfaced as MCP-n/a. Launch + Hand-off actions on each card. | dashboard → Agents; `curl -XPOST localhost:7077/api/agents/claude/connect` writes `.mcp.json` |
| **KB export/import/share** | `baton kb export` → .tar.gz pack (graphs + CODEBASE.md + manifest with git HEAD); `baton kb import <pack\|kb/>` re-anchors paths, validates graphs, reports "N commits behind" and auto-refreshes; dashboard Export/Import buttons on the Knowledge Graph page; `baton kb share on` keeps a committed `kb/` dir so teammates clone-and-go | export, clone repo elsewhere, `baton kb import <pack>` → graphs appear with zero re-indexing |
| **Real token usage** | `baton usage` + `GET /api/usage`: parses Claude Code session JSONLs (input/output/cache tokens + est cost per session, mtime-cached), mapped to task slugs; Activity shows a real "Tokens used (Claude)" card + per-session tokens; KB page shows the savings metric (this repo: map ≈ 824 tokens vs ≈ 248k reading it — ~300× cheaper). Prior art: Orca | `baton usage` |
| **Headless agent launch** | `baton start <slug> [--agent claude\|codex\|gemini]` runs the agent's print mode in the worktree (prompt = HANDOFF.md brief when present), output streamed as `agent.output` SSE events into the Live screen; `baton stop`; Detail "Start agent" button; Launch dialog "start headless after create" (its Preview badge disappears on that path); 409 on double-start; never adds permission-bypass flags. Prior art: Rover | `baton start <slug> --prompt "say hi"` |
| **Interactive agent terminals** | Real PTY sessions in the dashboard: tmux hosts each session (`baton-<repoHash>-<slug>`, zero new daemon deps, survives daemon restarts), driven via one control-mode client per session; output → per-session SSE stream (`/api/tasks/:slug/terminal/stream`, snapshot+live), input/resize → POST (hex-encoded send-keys, injection-proof); xterm.js panel in the Live screen (Terminal tab, auto-selected when live), Launch dialog 3-way start mode (worktree only / interactive / headless), Detail "Open terminal" button; mutual 409 with headless runs; kill-on-task-remove; tmux-missing → capability flag + install hint; demo mode plays a canned transcript. All six agents launchable (`cursor-agent` for cursor; aider/opencode bare). Prior art: handler.dev (tmux+capture-pane), claude-squad | Launch → "Open interactive terminal" → type into the live claude TUI; `tmux ls`; kill daemon, restart → session reattaches |
| **Write mode follows the daemon** | The dashboard's write capability auto-follows `/api/meta.writeEnabled` in real mode (fresh browsers get terminals/merge out of the box when the daemon runs `--write`); an explicit toggle choice still wins, a read-only daemon always forces read-only; read-only/demo states explain themselves (`baton serve --write` hints in Launch, Live terminal tab, TerminalPanel footer) instead of hiding options | clear localStorage → open :7077 → Launch shows all 3 start modes with no toggle |
| **Skills (catalog + install)** | Searchable catalog of reusable agent playbooks. **File-backed** multi-file skills live under `src/skills/bundled/<id>/` — a real `SKILL.md` (gray-matter frontmatter, incl. folded multi-line descriptions) + an optional `references/` folder; the flagship `bug-fix` skill (reproduce-first → audit → blast radius → root cause → ≥95% skeptic-corroborated confidence + approved plan → fix → re-verify → auto-commit, never push) ships 3 reference files. The **efficiency & traceability pack** adds four more file-backed skills (`token-efficient-coding`, `traceable-changes`, `memory-light`, `verify-before-done`) — each a portable SKILL.md + one `references/` cheat-sheet, with optional "Baton boost" sections (CODEBASE.md/query_graph/recall_memory/who_touched). Tags/produces for file-backed skills live in `BUNDLED_META` (catalog.ts) so the source SKILL.md stays a clean name+description-only Claude skill. Plus short **inline** skills (`map-codebase`, `safe-refactor`) and **imported** skills read from `.baton/skills/*.md`. Bundled skills are cached + copied into `dist/` at build (`scripts/copy-assets.mjs`). `GET /api/skills` returns each skill with per-agent install state + reference paths (content/raw never serialized); `POST/DELETE /api/skills/:id/install` writes/removes in the agent's own format — Claude → `.claude/skills/<id>/SKILL.md` (+ `references/`, hand-authored SKILL.md written verbatim when faithful), Cursor → `.cursor/rules/<id>.mdc` (`alwaysApply:false`) with references copied to a sibling `<id>/` folder the rule points at; other CLIs unsupported. `POST /api/skills/import` adds from a path/http(s) URL (256KB cap, can't shadow a bundled id). All writes gated on `--write`. Dashboard **Skills** screen: search, source/produces/reference chips + multi-file badge, per-agent install toggles, playbook preview, import; an **"Efficiency & traceability pack"** showcase band highlights the four pack skills on the unsearched landing state (click a chip to filter to it); demo mirror (`web/src/lib/demoSkills.ts`). | dashboard → Skills; `curl -XPOST localhost:7077/api/skills/bug-fix/install -d '{"agent":"claude"}'` writes `.claude/skills/bug-fix/SKILL.md` + `references/` |
| **Project memory** | Evidence-anchored shared memory at `.baton/memory/facts/` (one md file per fact, atomic writes, always the MAIN repo even from worktrees): every fact stores the commit + content-hashes of the files it describes; on every read the anchors are re-checked — changed file ⇒ fact served as `stale` with the reason and **withheld from agents** (anti-hallucination). Agents write via `save_memory` / read via `recall_memory` MCP tools (keyword-ranked, stale-filtered); supersede-by-fingerprint dedup; secret-pattern rejection (keys/tokens/JWTs refused); 1.2k-char + 500-fact caps; handoff briefs embed a token-cheap "Project memory" section; daemon watches the store → `memory.updated` SSE; dashboard Memory page (search, fresh/aging/stale badges, quick-add, GC, delete; demo facts in demo mode); `baton memory list\|add\|rm\|gc` CLI; AGENTS.md guide tells agents to recall-before-exploring and save-after-learning | `baton memory add "…" --files src/x.ts` → edit src/x.ts → `baton memory list` shows STALE → `baton memory gc`; dashboard → Memory |

| **Shared graphify backend pool** | The daemon owns one graphify HTTP backend per **touched** project (lazy start on first query, reaped after 15 min idle); agents POST to `POST /mcp/g/<token>/<projectId>` and never spawn their own processes. Token-gated (`.baton/mcp-token`, mode 0600, embedded in the config URL); backends bind `127.0.0.1`. Claude/Cursor get `{type:'http', url}` MCP entries; Gemini gets `{httpUrl}` (Gemini CLI's streamable-HTTP schema); Codex stays on stdio. Existing setups migrate by re-running `baton kb init` (or the Agents → Connect action). RAM: ~720 MB (3 agents × 6 stdio processes on a 5-project hub) → at most 1–2 backends per touched project regardless of agent count (~120–180 MB shared vs ~720 MB–1.8 GB before). Graph freshness: graphify `--stateless` re-reads on every request (empirically verified: node count drops immediately after file modification, no flush needed). | `node dist/cli.js serve --write --port 7079` against FAT_FOX (5 projects): `/api/kb/mcp` → http URLs; POST tools/list to `merged` + `fatfox-api-server` → 2 Python backends started (HTTP 200 both); wrong token → 403; SIGTERM daemon → 0 backends remain |

| **Context pack** | `baton kb context`, `GET /api/kb/context`, dashboard "Share context" modal — budgeted (≤ ~8k tokens), deterministic, secret-redacted markdown brief of the project/hub for pasting into external chatbots. Spec: docs/superpowers/specs/2026-07-04-context-pack-design.md. | `baton kb context \| pbcopy`; dashboard → Knowledge Graph → Share context |
| **Site hosting readiness + dashboard edge cases** | env-driven site URL (`NEXT_PUBLIC_SITE_URL`), PNG OG image + favicon, correct quick-start commands, mobile nav menu, noscript reveal fallback; SSE reconnect indicator, honest error/loading/empty states on Memory/Activity/Conflicts/Knowledge Graph pages, overflow fix | `cd site && npm run build` → `/opengraph-image` + `/apple-icon` routes listed; dashboard → Memory/Activity/Conflicts/Knowledge Graph with demo OFF |

**Final-review fixes (2026-07-03, session 7 polish).** (1) Gemini `httpUrl` fix: `McpServerDef` now has a third `{ httpUrl }` variant; `mcpServersGemini()` / `serversForStateGemini()` / `geminiSnippet()` emit it; `mergeTomlConfig` handles it. (2) `--port` flag on `baton kb init` and `baton kb mcp` so non-default-port setups generate correct MCP URLs without needing the daemon running. (3) FIX 3 verified FRESH — graphify `--stateless` re-reads per request; documented in code + docs. (4) `serversForState(state, undefined)` now throws instead of silently returning baton-only. Tests: 8 new tests (gemini httpUrl, port in URL, throw behavior, misleading title renamed). **274 tests green.**

Tests: 266 vitest tests at root green (routing v2 + MCP-connect + roster + skills + graphify-server + graphify-proxy + mcp-token covered;
`test/skills.test.ts` covers render/parse/target helpers, folded-YAML parsing, multi-file
references, file-backed bundled loading, and the efficiency & traceability pack's load +
faithful raw + BUNDLED_META tags/produces). Both workspaces strict TS, both builds clean.

**Hardening pass (2026-06-17, audit-driven).** Verified multi-agent code review →
fixed: (1) HTTP response pipes now attach `'error'` handlers (static asset, graph.json,
kb-export tar) so a cancelled download / mid-stream IO error can no longer crash the
zero-dep daemon; (2) the memory `fs.watch` gets an `'error'` handler (matches watch.ts);
(3) `BatonBus` lifts the EventEmitter cap (`setMaxListeners(0)`) — no more spurious
warning past 10 SSE connections; (4) `baton kb init` reuses `mergeJsonConfig` (refuses to
clobber an unparseable `.mcp.json` instead of silently wiping the user's other MCP
servers); (5) `escapeRegExp` deduped into `src/util/regex.ts` (was copied in routing/
memory/connect); (6) SQLite history/reports DBs open `WAL` + `synchronous=NORMAL` and
`recordMerge` batches inserts in one transaction; (7) `listHistory` collapsed its 1+N
query into one grouped read; (8) memory hash/behind caches evict FIFO instead of a
blanket `clear()` (no re-scan stampede); (9) `SignalTracker.clear` re-derives overlap
announcements from live rows instead of wiping all (no duplicate overlap alerts).

**Security review + permanent storage purge (2026-06-18).** Inline security pass (the
multi-agent run stalled, so reviewed directly): daemon binds **127.0.0.1 only**, CORS is
**loopback-only**, kb-import tar extraction already guards tar-slip, JSON bodies cap at
1 MB — all good. Added a **loopback-Origin CSRF guard** (`isLoopbackOrigin`) on the new
destructive endpoint. **New: permanent data purge** (`src/purge.ts`, `GET/POST
/api/storage/purge`). Root cause of "disk keeps filling after deletes": deleting a task
removes the worktree but its commits stay reachable via the hidden `refs/baton/archive/*`
refs, so a plain gc can't reclaim them. The purge drops those refs + orphan `baton/*`
branches and runs `git gc --prune=now` (new `git.ts` helpers: `listArchiveRefs`,
`deleteRef`, `gitGc`, `objectStoreBytes`; `closeHistoryDb`/`closeReportsDb` release the
sqlite handle before unlinking history.db). Categories: archives, history, reports,
graphs, tmp, memory. **Triple-guarded**: `--write` + loopback Origin + a typed
`purge <repo>` phrase; the **Memory → Storage → Danger Zone** UI adds a 3-step flow
(select → review with sizes → type-to-confirm) and an extra acknowledgement for the
knowledge base. Never touches source, main, non-`baton/*` branches, or live worktrees.
`test/purge.test.ts` (7 tests) covers it; 235 tests green.

**Security hardening pass (2026-06-18, multi-agent audit-driven).** A 35-agent
audit (find → adversarially-verify → completeness-critic) found the loopback-Origin
CSRF guard was only on `/api/storage/purge`, leaving every other mutating endpoint
exploitable by a malicious site you visit while `baton serve --write` runs (a
"simple" `text/plain` POST skips CORS preflight and the body parser ignores
Content-Type). Worst case: `POST /api/tasks/:slug/agent/start` launches an agent
with an **attacker-chosen prompt** under your creds, and `…/terminal/input` injects
keystrokes into a live agent. **Fixes:** (1) **centralized anti-CSRF guard** —
`src/util/origin.ts` (`isLoopbackOrigin`/`isMutatingMethod`), enforced in
`handle()` for *every* mutating `/api/*` request, so new endpoints are covered by
default (loopback dashboard + curl still pass; verified end-to-end with curl).
(2) **SSRF hardening** of `POST /api/skills/import` (`fetchSkillText`): block
private/loopback/link-local/metadata hosts, re-validate each redirect hop, 10s
timeout, streamed 256KB cap (was: arbitrary URL, follow-redirects, no timeout,
buffer-then-check). (3) **DOM XSS** fix — `web/.../GraphCanvas.tsx` HTML-escapes
node label/source fields (untrusted imported `graph.json` → force-graph `innerHTML`).
(4) **graphify perf** — `readStats` now memoizes by (path, mtime, size); the polled
`/api/kb` no longer re-parses every `graph.json` each tick. (5) tightened the
GitHub-token secret pattern. New tests: `test/origin.test.ts`,
`test/skill-import-url.test.ts`, `test/graphify-stats.test.ts`. **249 tests green**,
both workspaces build clean. (Refuted as non-issues: SQL is fully parameterized,
tar-slip already guarded, git is shell-free, slugs sanitized.)

**Docs, landing page & marketing site (2026-06-19).** Turned the repo front door into a
proper product surface. (1) **README** rewritten as an accurate landing page (was stale
"planned API / WIP" — the product is built). (2) **`docs/` documentation section** — a
hub (`docs/README.md`) + 14 user-facing pages: installation, quickstart, cli-reference,
dashboard, knowledge-graph, session-handoff, skills, memory, mcp-tools, agent-routing,
configuration, security, architecture, troubleshooting (research notes preserved). All
cross-links verified resolving; no invented commands/flags. (3) **Dashboard onboarding**
— the zero-sessions board now shows a `FirstRun` panel (Baton mark, 3 getting-started
steps, "New session" CTA, copyable command, docs link) instead of a bare empty state;
verified in-browser. (4) **Marketing site** — a runnable Next.js 15 + Tailwind v4 +
framer-motion app under `site/` (dark, amber-accent, relay-baton hero animation; sections
per `docs/landing-page-prompt.md`; SVG hero instead of R3F for build reliability — see the
in-code upgrade note). `npm run build` in `site/` passes (6 static routes incl.
sitemap/robots). 249 tests still green; web + site builds clean.

**Multi-repo hub launcher + blank-terminal fix (2026-07-01).** The launcher only
worked in a single git repo; on a **multi-repo hub** (`baton setup` on a folder of
separate repos — the hub root isn't a git repo, e.g. a real FAT_FOX setup) every
launch path was broken. Root causes, all verified against the real hub: (1)
`serve()` called `gitRoot()` and **crashed** at the non-git hub root → new
`resolveBatonRoot()` (`src/store.ts`, walks up to the nearest `.baton/`, falls back
to `gitRoot`); serve/merge/rm now use it. (2) `createTask` ran `git worktree add`
at the hub root → **failed**; now takes a `projectId`, resolves the sub-project from
`kb.json`, branches the worktree off **that** repo, and stores `projectId` +
`repoRoot` on the Task. Merge/remove do git ops on `task.repoRoot` while keeping
tasks/history/reports at the hub root. `/api/meta` now returns `hub` + `projects`;
`POST /api/tasks` accepts `project`; `baton new --project <id>` for the CLI. (3)
**Blank interactive terminal** — a freshly-launched TUI (claude's Ink UI) paints its
first frame during the control-client attach gap, which tmux control mode never
replays, so the pane looked dead. Fix: the terminal stream seeds a fresh
`capture-pane` on connect (+ a delayed seed at launch), mirroring `adoptSession`.
Dashboard **Launch** + **New session** dialogs gained a **Project picker** (shown
only for a hub, driven by `/api/meta`). Docs updated (README, quickstart,
cli-reference, dashboard) + the marketing site's worktree card. `test/hub.test.ts`
(6 tests) covers resolveBatonRoot + hub create/merge/remove; **255 tests green**,
all three workspaces build clean. Verified end-to-end on the real FAT_FOX hub
(daemon boots, `/api/meta` hub:true + 5 projects, create→worktree-in-sub-repo→
merge→remove, self-cleaned). Still to do: live browser click-through of the picker
+ blank-terminal fix with a real `claude` session.

**Shared graphify server + unified agent proxy (2026-07-03).** Replaced the
per-agent stdio `uv run graphify.serve` spawning with a daemon-owned shared
HTTP backend pool. `GraphifyPool` (`src/kb/graphify-server.ts`) lazily starts one
graphify process per touched project and proxies all agent queries through
`POST /mcp/g/<token>/<projectId>` — the 32-hex token is stored in
`.baton/mcp-token` (mode 0600) and embedded in the generated MCP config URLs.
Backends bind `127.0.0.1` only, run `--stateless --json-response` (no session
affinity), and are reaped via SIGTERM after 15 min idle (60s poll). Daemon
SIGTERM/SIGINT fires `graphPool.shutdown()` so backends never outlive the daemon.
MCP config for Claude, Cursor, Gemini rewritten to `{type:'http', url}` form;
Codex intentionally stays on stdio (its TOML has no url support). Existing
setups migrate via `baton kb init` or Agents → Connect. Deliberate trade-off:
graph queries now require `baton serve` to be running — documented in
`docs/knowledge-graph.md`, `docs/mcp-tools.md`, `docs/architecture.md`,
`docs/troubleshooting.md`. Verified live against FAT_FOX (5-project hub, port
7079): 0 HTTP graphify backends before first query; `merged` query → 2 processes
(1 uv + 1 Python); `fatfox-api-server` query → 4 total (2 projects × 2 each);
wrong token → 403; SIGTERM daemon → 0 HTTP backends remain (12 pre-existing
old-style stdio processes untouched). Tests: `test/graphify-server.test.ts` (3)
+ `test/graphify-proxy.test.ts` (1) + `test/mcp-token.test.ts` (1). **266 tests
green**, backend build clean.

**Multi-agent coordination audit, P1–P12 (2026-07-05/06, session 9 — PR #5).** A
12-proposal audit (docs/research/2026-07-06-multi-agent-coordination-audit.md) shipped
one TDD'd phase per commit on `feat/worktree-orchestration`: **P1** gitRoot→worktree
signal attribution fix (silently broke coordination), **P2** SQLite-backed signals,
**P3** report-aware `check_files` ("already fixed" answers), **P4** MCP output
contracts (compact payloads, bounded lists), **P5** `report_progress` (agents share
live intent notes), **P6** lazy read-time signal reconciliation (dropped signals whose
path is no longer dirty in the worktree; untracked files aren't false-dropped),
**P7** orient hook + MCP tool (budgeted session-start brief), **P8** kb-init footprint
gitignored, **P9** declared task scope + overlap warning at creation, **P10** memory
journal + archive (nothing hard-deleted; `baton memory log`), **P11** merged-only
graphify in a hub by default (`projects.length > 1` guard keeps single-project state
intact), **P12** `baton doctor --docs` propose-only .md-sprawl scan (`src/kb/sprawl.ts`).

**Skills v2, S1–S6 (2026-07-08, session 10 — branch `feat/skills-v2`, off PR #5's
branch).** Research round first: Ponytail (github.com/DietrichGebert/ponytail, MIT)
cloned to `.refs/ponytail` and studied — single canonical SKILL.md, mode filtering,
restraint ladder, honest agentic benchmark (~54% less code, ~20% cheaper, ~27% faster,
100% safe). Then: **S1** bundled `bug-fix` skill v2 (Golden Rule 0: check the shared
tracker FIRST / record the fix to memory LAST — `save_memory` with `fixed-in:<sha>`;
guarded by an invariant test), **S2** new `lean-code` bundled skill (original-wording
adaptation of Ponytail's 7-rung ladder + safety carve-outs, MIT-attributed; ideas, not
text), **S3** install-a-skill-into-every-agent (`installSkillEverywhere`, new
`baton skills list|install|uninstall|import` CLI, `agent:"all"` API, "⚡ Add to all"
button), **S4** live who's-editing panel (Conflicts.tsx groups each busy file's holders
with their P5 intent note + freshness; web-only), **S5** workload-aware handoff
(`src/handoff/workload.ts` least-loaded pick + `GET /api/tasks/:slug/suggest-handoff`;
dialog preselects with reason + idle/N-active badges), **S6** bug recurrence
(`src/recurrence.ts` + `baton bugs "<symptom>"` — prior fixes from memory, a STALE fix
fact is itself the regression signal, suspect commits from history; zero new storage).
Deliberate non-builds (lean-code applied to ourselves): no AGENTS.md always-on skill
injection for codex/gemini (token-hostile), no SSE for the panel (5s poll is enough),
no upstream-Ponytail UI import (redundant with the bundled adaptation). **396 tests
green**; docs (README, skills, cli-reference, memory, session-handoff, dashboard)
updated this session.

## Pending / next 🔜

1. **Headless one-shot runs still aren't shown as "active" on the status board**
   (`claude -p` children are too short-lived for the `src/agents.ts` ps scan).
   Interactive tmux terminals DO show as active — the agent process persists with
   the worktree cwd, so the scan catches it (verified 2026-06-12). Worth wiring
   `runningHeadless()` into `collectStatus` for the one-shot case too.
2. **tmux test-environment caveat** (2026-06-12): a daemon launched inside a
   sandboxed wrapper (e.g. the IDE preview helper) can wedge the shared tmux server
   (orphaned control client stops draining → every tmux command on the machine
   hangs). Hardening added: control clients attach with `-d` (kick stale clients),
   all one-shot tmux calls have a 10s timeout, errors surface as clean 4xx/503.
   Normal usage — `baton serve` run from a real terminal — is unaffected (verified
   end-to-end). If tmux ever wedges: `pkill -f 'tmux -C attach' && rm -rf /tmp/tmux-$UID`.
3. **Visual pass** — confirmed in-browser 2026-06-12: Launch 3-way start mode (radio
   group, Preview badge clears on real modes), real claude TUI rendering in the Live
   Terminal tab via SSE, keystrokes from the browser moving the TUI selector, tmux
   session create/adopt/kill from the UI. Still pending a look when Chrome MCP is up:
   Handoff "suggested" chip (demo-verified earlier).
3. **Non-Claude token usage** — codex/gemini session formats aren't parsed yet
   (src/usage.ts is Claude-only); their sessions show no token data.
4. **Fleet broadcast** (Daintree-style: one prompt → N sessions at once) — researched,
   deferred by user choice this round.
5. **npm packaging** — `package.json` `files` only ships `dist/`; `web/dist` must be
   included (or copied into `dist/web`) before publishing the CLI to npm.
6. **Roadmap (MVP.md)** — M3 redaction-first secret stripping for safe export; M4 link
   sharing + permissions (hosted phase).

## Where things live

```
src/cli.ts            CLI registration (kb, pass/take/done, hooks, mcp, signals, blame…)
src/server.ts         daemon: /api/* + SSE /api/events + static dashboard serving
src/events.ts         transport-agnostic event bus (ring buffer for SSE replay)
src/watch.ts          per-worktree recursive fs watcher → file.edited events
src/poller.ts         daemon-side status differ (runs only while SSE clients exist)
src/signals.ts        live edit signals + checkFiles (the wait/coordinate layer)
src/reports.ts        completion reports (built at merge time)
src/mcp.ts            `baton mcp` stdio server (check_files, get_report, who_touched…)
src/skills/           skill catalog + install/import; bundled/<id>/ = file-backed multi-file skills (SKILL.md + references/)
src/agents/           agent registry (one entry per CLI) + roster + MCP connect
src/kb/               graphify wrapper, sub-project detection, kb state, MCP snippets
src/kb/codebasemd.ts  CODEBASE.md generation (tree, stack, god-nodes, staleness footer)
src/kb/transfer.ts    KB export/import/share (tar pack, re-anchor, committed kb/ dir)
src/routing.ts        task-type → agent routing (baton.config.json, keyword scoring)
src/usage.ts          real token usage from Claude session JSONLs (+ cost estimates)
src/spawn.ts          headless agent runs (claude -p / codex exec / gemini -p)
src/handoff/          Claude JSONL session parser + HANDOFF.md brief builder
web/src/lib/connections.ts   daemon connections (real project switcher)
web/src/hooks/useEvents.ts   SSE client hook
web/src/features/            one file per screen; KnowledgeGraph.tsx is the graph page
.refs/                reference open-source code (graphify etc.) — gitignored, learning only
```

**Demo mode is the showcase, not a bug**: default ON only on the Vite dev origin
(`:5173`); the daemon-served UI (`:7077`) is real by default. Real-mode changes must be
gated on `BatonAPI.demo` so the demo keeps working.
