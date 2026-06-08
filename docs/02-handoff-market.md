# Research 02 — Agent handoff market (the Baton thesis)

**Question:** Is there a real market for a tool that hands coding work from one agent to another,
framed around cost/quota arbitrage (plan on the expensive agent, execute on the cheap one)?

## Demand — real, but mostly voiced as "I lose context when I switch tools"
- Cost/quota arbitrage is **confirmed behavior**. Quotes from the
  [Cursor forum](https://forum.cursor.com/t/cursor-200-vs-claude-max-cursor-usage-limits-and-trade-offs/148298):
  - *"My usage on Cursor was \$1500-2000/month. The same usage on Claude Code is \$200/month."*
  - *"I switched to Cursor Pro (\$20) + Claude Max (\$200)."*
- Context-loss pain when switching tools: devs report losing ~100–200 min/week re-establishing
  context across isolated tools ([dev.to/wilhurley](https://dev.to/wilhurley/...)).
- **Caveat:** demand is *inferred* from tool existence + arbitrage behavior, **not** from a
  counted volume of "I want a handoff tool" complaints. This was the weakest-evidenced dimension.

## Market sizing — niche, not broad
JetBrains Research (Jan 2026, n>10,000): Copilot 29%, Cursor 18%, Claude Code 18% — fragmented,
~70% of devs use 2–4 tools. Multi-tool usage is large, but Baton's *specific* pain =
**fragmentation ∩ budget pressure ∩ cross-tool context move** — a narrow slice already chased by 6+ tools.

## Competitors (the handoff/continuity space is crowded)
| Tool | Stars | What it does |
|---|---|---|
| [cli-continues](https://github.com/yigitkonur/cli-continues) | ~1.2k | **The incumbent.** Resume a session in another tool across 16 tools (240 paths); *summarizes* tool activity (not a raw dump); reads Claude **and Cursor** transcripts. |
| [CodeRabbit "Agent Handoff"](https://docs.coderabbit.ai/plan/agent-handoff) | (commercial, GA 2026-03) | Produces context-rich prompts for Claude Code/Cursor/Copilot; **explicitly pitches "use faster/cheaper models for execution"** — Baton's exact framing. |
| context-mode | ~16.6k | Context-window optimization across 15 platforms |
| Continuous-Claude-v3 | ~3.8k | Ledgers + handoffs, Claude-only |
| GitHub Spec Kit | (official) | spec→plan→tasks→implement markdown; 30 integrations, "switch agents, no lock-in" |

## The remaining gap (what's NOT covered)
1. A **quantified token/cost estimate** attached to a handoff brief (CodeRabbit gives only
   qualitative "match the model to the task"; cli-continues shows raw token counts but no cost
   comparison).
2. An **LLM-condensed-by-default** (vs verbatim/opt-in) cross-tool paste pack.

Both are **single features, not a standalone tool** — and best contributed to `cli-continues`.

## Obsolete assumptions discovered
- Cursor sessions now also live in **`~/.cursor/projects/*/agent-transcripts/` JSONL**, not just
  the SQLite `state.vscdb` — so "hard SQLite parsing" was never a moat.
- Cross-tool Claude↔Cursor handoff **already exists** (cli-continues).

→ Full decision in [../report/VERDICT.md](../report/VERDICT.md).
