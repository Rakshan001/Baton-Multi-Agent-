# Prior art & reusable open-source codebases

> Catalog of existing OSS projects relevant to Baton and its companion ideas (session export,
> usage tracking, dashboards, multi-agent coordination). Use this to **reuse/fork existing code**
> instead of reinventing it. Compiled from web research (2025-2026).
>
> ⚠️ **License check before copying code:** most are MIT/Apache, but verify each repo's LICENSE
> before pulling source into Baton. Forking or depending via package manager is safest.

---

## 0. The data formats any of this must parse (foundation)

- **Claude Code transcripts:** one JSONL file per session at
  `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. Each line = a message event
  (user / assistant / tool_use / tool_result) with token usage, model, timestamps, cwd. Read-only.
- **Cursor chats:** SQLite **`state.vscdb`**.
  - Global: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
  - Per-workspace: `…/workspaceStorage/<hash>/state.vscdb` (+ `workspace.json` maps hash → project)
  - Chat lives in table **`cursorDiskKV`**: keys `composerData:<id>` (a session) and
    `bubbleId:<composerId>:<bubbleId>` (messages: text, tool calls, diffs, thinking).
- **Codex / Gemini CLI:** also file-based logs; `ccusage` already abstracts several of these.

---

## 1. Session history extractors / exporters  ← Baton's `export` wedge

| Project | URL | Lang | What it does | Reuse |
|---|---|---|---|---|
| claude-conversation-extractor | https://github.com/ZeroSumQuant/claude-conversation-extractor | Python | `~/.claude/projects` JSONL → clean MD/JSON/HTML, search, "detailed mode" | **Closest to the core need** — fork/port its JSONL parser |
| claude-code-log | https://github.com/daaain/claude-code-log | Python | JSONL → HTML/Markdown, TUI browser, token tracking, date filters | Parser + export reference |
| ccexport | https://github.com/marcheiligers/ccexport | Ruby | Claude Code → GitHub-flavored Markdown w/ tool/bash formatting | Formatting reference |
| S2thend/cursor-history | https://github.com/S2thend/cursor-history | TS | Browse/search/export/backup Cursor `state.vscdb` chats (CLI + lib) | **Cursor parser** — reuse as dep/reference |
| saharmor/cursor-view | https://github.com/saharmor/cursor-view | Py/JS | Web UI to browse/search/export Cursor chats | Cursor parser + UI |
| somogyijanos/cursor-chat-export | https://github.com/somogyijanos/cursor-chat-export | Python | Cursor SQLite → Markdown | ⚠️ **archived (Jun 2025)** — reference only |

**Gap = Baton's wedge:** all of these dump the *full verbatim transcript incl. tool noise*. None
produce a **condensed, paste-ready knowledge pack** (decisions, code that matters, open threads)
sized for ChatGPT/Gemini, and none unify Claude JSONL + Cursor SQLite in one export.

## 2. Usage / cost / limit trackers

| Project | URL | Stars | Lang | Notes |
|---|---|---|---|---|
| **ccusage** | https://github.com/ryoppippi/ccusage | ~15.7k | Rust (was TS) | **The standard.** daily/weekly/session + 5h-window; multi-agent (Claude/Codex/Gemini). Embed or shell out. |
| Claude-Code-Usage-Monitor | https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor | ~8.2k | Python | Real-time TUI, burn-rate ML, plan detection |
| ccseva | https://github.com/Iamshankhadeep/ccseva | ~0.7k | TS/Electron/React | macOS menu-bar usage app, charts — good desktop GUI shell |
| ClaudeBar | https://github.com/tddworks/ClaudeBar | — | Swift | Menu-bar quotas for Claude/Codex/Gemini/Copilot (multi-agent ref) |
| phuryn/claude-usage | https://github.com/phuryn/claude-usage | — | — | Local dashboard: tokens, cost, Pro/Max progress, session history |

→ **Don't build a usage engine. Reuse `ccusage`.**

## 3. Session viewers / dashboards / running-agents UI

| Project | URL | Stars | Lang | Notes |
|---|---|---|---|---|
| **siteboon/claudecodeui** | https://github.com/siteboon/claudecodeui | ~9.8k | JS/React | Web+mobile UI to **manage/run** Claude Code, Cursor CLI, Codex, Gemini; chat, shell, file/git. **Strongest dashboard base.** |
| d-kimuson/claude-code-viewer | https://github.com/d-kimuson/claude-code-viewer | ~1.2k | TS | Web viewer of JSONL sessions; search, resume, git diffs |
| hoangsonww/Claude-Code-Agent-Monitor | https://github.com/hoangsonww/Claude-Code-Agent-Monitor | — | Node/React/WS | Live dashboard: sessions, subagents, Kanban, macOS app — nearest all-in-one |

→ For a UI / "see running agents" → **fork/contribute to `claudecodeui`**, don't start fresh.

## 4. Handoff / session-continuity tools  ← Baton's direct competitors

| Project | URL | Stars | Notes |
|---|---|---|---|
| cli-continues | https://github.com/yigitkonur/cli-continues | ~1.2k | Resume a session in another tool (16 tools, 240 paths); carries history + file changes. **The incumbent** for generic handoff. |
| context-mode | https://github.com/mksglu/context-mode | ~16.6k | Context-window optimization across 15 platforms |
| Continuous-Claude-v3 | https://github.com/parcadei/Continuous-Claude-v3 | ~3.8k | Ledgers + handoffs, Claude-only |
| claude-handoff | https://github.com/willseltzer/claude-handoff | ~0.1k | Claude session handoff skill |

**Baton's differentiation vs these:** not a raw history dump — a *curated, cheap-to-execute brief
with a token/cost estimate*, framed around **quota/cost arbitrage** (plan on the expensive agent,
execute on the cheap one). That framing is absent from all of the above.

## 5. Multi-agent coordination / locking  ← the *other* (bigger) idea: see `../agentlock/`

| Project | URL | Notes |
|---|---|---|
| mcp_agent_mail | https://github.com/Dicklesworthstone/mcp_agent_mail | ~1.9k. FastMCP: agent identities, inboxes, **advisory file leases + TTL**. Best fork base for an *enforced* locker. |
| madebyaris/agent-orchestration | https://github.com/madebyaris/agent-orchestration | MCP: lock_acquire/release, shared memory, heartbeat |
| Beads | https://github.com/steveyegge/beads | Dolt-backed issue/dependency graph; collision-free IDs |
| mcp-beads-village | https://github.com/LNS2905/mcp-beads-village | Beads + agent mail (task coord + file locking + mail) |
| GNAP | https://github.com/farol-team/gnap | Git-native, zero-server task board (todo→doing→done via commits) |
| GitAgent Protocol | https://github.com/open-gitagent/gitagent-protocol | Version-controlled agent identity/rules standard |

→ This is a separate project (locking ≠ handoff). Design lives in `../agentlock/DESIGN.md`.

## 6. Worktree-based parallel-agent runners (isolation approach)

Conductor (Claude+Codex, Mac), **Sculptor** (Imbue — containers), Crystal→Nimbalyst (OSS),
**claude-squad** (agent-agnostic: Claude/Gemini/Codex/Aider), uzi, Vibe Kanban, Superset,
Backlog.md (markdown+git task board w/ MCP). Use these if you want each agent in its own
worktree/container rather than coordinating one shared tree.

## 7. Standards & enforcement primitives to build on

- **AGENTS.md** — cross-tool instructions standard (Cursor/Gemini/Codex read natively; Claude
  Code needs a `CLAUDE.md` symlink/import). https://agents.md
- **Pre-write blocking hooks** (the enforcement layer for any locker):
  - Claude Code `PreToolUse` → deny via `{"hookSpecificOutput":{"permissionDecision":"deny",...}}` or exit 2
  - Cursor `preToolUse` (v1.7+) → `{"permission":"deny",...}`
  - Gemini CLI `BeforeTool` → `{"decision":"deny","reason":"..."}`
- **MCP** — Cursor, Claude Code, Gemini are all MCP clients → a custom MCP server is the
  cross-agent "shared service." (`@modelcontextprotocol/sdk`)
- **Spec-driven dev** — GitHub Spec Kit, Kiro: spec→plan→tasks→impl markdown as de-facto handoff.

---

## Reuse plan mapped to Baton features

| Baton feature | Reuse from | Build new |
|---|---|---|
| `pass` / `take` / `HANDOFF.md` | (convention; ride AGENTS.md / spec-kit) | the curated-brief format + renderer |
| `estimate` (token/cost) | `ccusage` (pricing/usage reference) | the from→to cost-delta on a brief |
| `export` (session → context pack) | claude-conversation-extractor (Claude JSONL parser) + S2thend/cursor-history (Cursor SQLite parser) | **the summarize-to-paste-ready-pack step** ← the wedge |
| dashboard / running agents (optional/companion) | claudecodeui + ccusage | thin glue only — or just contribute upstream |

**Bottom line:** reuse `ccusage` (usage), the two history parsers (export), and `claudecodeui`
(dashboard, if wanted). Baton's *original* code = the curated handoff brief, the cost estimate,
and the session→context-pack summarizer. Everything else is assembly.
