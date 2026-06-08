# Research 03 — Session export / usage / dashboard OSS tools

**Question:** What OSS already exists to view sessions, track usage, and export chat history (the
"I chatted an hour, now move that context elsewhere" pain)? How is the data stored?

## Data storage (foundation for any such tool)
- **Claude Code:** one JSONL per session at `~/.claude/projects/<slug>/<uuid>.jsonl` (every
  message, tokens, model, timestamps, cwd). Read-only, easy to parse.
- **Cursor:** SQLite `state.vscdb` (table `cursorDiskKV`, keys `composerData:*` / `bubbleId:*`);
  global + per-workspace DBs. **Also** newer JSONL at `~/.cursor/projects/*/agent-transcripts/`.

## Usage / cost trackers
| Project | Stars | Notes |
|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) | ~15.7k | **The standard.** daily/weekly/session + 5h-window; multi-agent. Reuse, don't rebuild. |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | ~8.2k | Real-time TUI, burn-rate ML |
| [ccseva](https://github.com/Iamshankhadeep/ccseva) | ~0.7k | macOS menu-bar usage app (Electron/React) |

## Session viewers / dashboards / running-agents UI
| Project | Stars | Notes |
|---|---|---|
| [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | ~9.8k | Web+mobile UI to **manage/run** Claude Code, Cursor, Codex, Gemini. Strongest dashboard base. |
| [claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) | ~1.2k | Web viewer of JSONL sessions; search, resume, diffs |
| [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | — | Live dashboard: sessions, subagents, Kanban |

## History extractors / exporters
| Project | Notes |
|---|---|
| [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor) | JSONL → clean MD/JSON/HTML (Claude-only, verbatim) |
| [claude-code-log](https://github.com/daaain/claude-code-log) | JSONL → HTML/MD, TUI, token tracking |
| [cc2md](https://github.com/magarcia/cc2md) | JSONL → clean MD, folds tool calls into `<details>` (Claude-only) |
| [claude-code-exporter](https://open-vsx.org/extension/myoontyee/claude-code-exporter) | Claude + Codex + Cursor → MD; markets cross-tool paste (v0.8.16, May 2026) |
| [SpecStory](https://github.com/specstoryai/getspecstory) | Captures Claude + Cursor (verbatim by default; condense via opt-in skills); IDE ext closed-source |
| [S2thend/cursor-history](https://github.com/S2thend/cursor-history) · [cursor-view](https://github.com/saharmor/cursor-view) | Cursor `state.vscdb` → export |

## Finding
No single project does all of {dashboard + running agents + usage + condensed cross-tool export}
well — the space is fragmented into trackers / viewers / exporters. Most exporters dump
**verbatim** transcripts. The **condensed, cross-tool, paste-ready knowledge pack** is the only
sliver not done by default — but `cli-continues` (see doc 02) already does condensed cross-tool
packs, shrinking even that gap.

## Reuse recommendation
Don't rebuild: **`ccusage`** (usage), **`claudecodeui`** (dashboard/running agents), the existing
**parsers** (Claude JSONL + Cursor SQLite/JSONL). See [../PRIOR_ART.md](../PRIOR_ART.md) for the
full reuse mapping.
