# Baton — build kickoff

> **Open this file in a fresh session to build the project. It is the single source of truth
> for what Baton is, why it exists, and the next step to implement.**

**Baton** — *Plan on your expensive agent. Pass the baton to your cheap one.*

A tiny open-source CLI + convention for **handing a unit of coding work from one AI agent to
another.** The first agent (e.g. Claude Code, on a Max plan) does the expensive thinking —
research, plan, the exact diff to make, the remaining tasks — then writes a **curated,
execution-ready handoff brief**. The second agent (e.g. Cursor Auto / Copilot, on cheap tokens)
picks it up and just *executes*. Sequential turn-taking, not concurrent editing.

---

## Why this exists (the wedge — read before building)

Market research verdict: the **generic** "sync my session across tools" idea is already taken —
[`cli-continues`](https://github.com/yigitkonur/cli-continues) (1.2k★) does mechanical session
import across 16 tools; AGENTS.md + spec/plan files cover "shared state" for most people.
**Do NOT build another generic context-transfer tool — you'll lose to the incumbent.**

The **open wedge nobody owns is cost/quota arbitrage.** Real, quoted developer behavior:
- *"My usage on Cursor was $1500-2000/month. The same usage on Claude Code is $200/month."*
- *"I switched to Cursor Pro ($20) + Claude Max ($200)."*
- Devs lose ~100-200 min/week re-establishing context when switching tools.

So Baton's single, sharp value prop = **"Do the thinking where it's powerful/included; do the
bulk editing where it's cheap."** Every feature must serve that. The differentiator vs
`cli-continues`: not a raw history dump — a **minimal, curated, cheap-to-execute brief** (plan +
target diff + remaining tasks + a token/cost estimate of executing it).

Honest expectation: this is a **weekend OSS / GitHub-stars project**, niche (solo devs, indie
hackers on tight AI budgets), not a business. Build it for usefulness + portfolio, not revenue.

## Goals / non-goals

**Goals**
- One command in agent A to **emit a handoff brief** from its current plan/diff/tasks.
- One command in agent B to **pick up** the brief and start executing, with crisp instructions.
- Brief is a **plain `HANDOFF.md`** (human-readable, git-friendly, interoperable with AGENTS.md /
  spec-kit) — not a proprietary format, not MCP plumbing.
- Include a **token/cost estimate** of executing the brief (the arbitrage hook).
- Dead simple: `npx baton ...`, no daemon, no server.

**Non-goals**
- Concurrent multi-agent editing / file locking (that's a *different*, bigger project — see the
  sibling `agentlock/DESIGN.md`; keep Baton small).
- Full session/history transfer (cli-continues already does that).
- A hosted service.

## How it works (flow)

```
Claude Code (expensive, included in Max)        Cursor Auto / Copilot (cheap tokens)
────────────────────────────────────────        ────────────────────────────────────
1. plan / research / decide the diff
2. `baton pass`  ───────────────────────────▶   writes HANDOFF.md (plan + diff + tasks + cost)
                                                3. `baton take`  ◀── reads HANDOFF.md, prints
                                                   an execution prompt for Cursor to run
                                                4. Cursor executes the edits
                                                5. `baton done` → marks brief complete
```

## The HANDOFF.md format (the heart of the product)

```markdown
---
baton: 1
from: claude-code
to: cursor
status: ready            # ready | in-progress | done
created: <ISO ts>
repo: <name>
branch: <branch>
est_tokens: 18000        # estimate to EXECUTE this brief (the arbitrage signal)
est_cost_usd: 0.05
---

## Objective
<one paragraph: what the next agent must accomplish>

## Context the executor needs
- key files: `src/...:L..`, ...
- conventions / gotchas (or "see AGENTS.md")

## Plan / exact changes
1. In `path` — <change, from→to>
2. ...

## Remaining tasks (checklist)
- [ ] ...
- [ ] ...

## Verification
- how to confirm it works (command / behavioral steps)

## Do NOT
- scope guardrails so the cheap executor doesn't wander
```

## CLI surface (MVP)

```
baton pass [--from claude-code] [--to cursor] [--plan <file>] [--diff]
    # emit HANDOFF.md from the current plan/diff/tasks. If a plan file (e.g. Claude plan-mode
    # output) exists, ingest it; else interactive/flags. Computes est_tokens/est_cost.

baton take [--as cursor]
    # read HANDOFF.md, set status=in-progress, print a tight execution prompt to paste/feed
    # into the executing agent.

baton done            # mark status=done (optionally append a result note)
baton status          # show current brief + status
baton estimate        # just print token/cost estimate of executing the current brief
```

No server. State = the `HANDOFF.md` file in the repo (+ optional `.baton/history/`).

## Optional agent integration (nice-to-have, after MVP)
- **Claude Code**: a `Stop`/`SessionEnd` hook (or a `/baton` slash command/skill) that runs
  `baton pass` automatically when a plan is approved.
- **Cursor**: a rule / `preToolUse` hook or just a README instruction: "run `baton take` first."
- Keep these optional — the CLI + convention must work with zero integration.

## Token/cost estimate (the arbitrage feature — make it good)
- Estimate execution tokens from the brief: count target files' sizes + diff size + a fixed
  overhead; map to $ via a small per-model price table (Claude/Cursor Auto/GPT). Show
  "execute here ≈ $X" so the user sees the saving. This is the line that makes Baton *Baton*.

## Tech choices
- **Node 20 + TypeScript**, `commander` (CLI), `gray-matter` (HANDOFF.md frontmatter),
  `execa` (git diff/branch), a tiny tokenizer (`gpt-tokenizer` or char/4 heuristic) for
  estimates. Ship via `npx baton`. MIT license.

## Repo layout
```
baton/
  package.json  tsconfig.json  README.md  BUILD.md  LICENSE(MIT)
  src/
    cli.ts          # commander entry: pass | take | done | status | estimate
    handoff.ts      # read/write/validate HANDOFF.md (gray-matter)
    estimate.ts     # token + cost estimation + price table
    git.ts          # branch, diff helpers (execa)
    prompts.ts      # render the "execution prompt" for `take`
  test/             # handoff round-trip, estimate, status transitions
  examples/HANDOFF.example.md
```

## Milestones
- **M0** — `baton pass` + `baton take` + `HANDOFF.md` read/write round-trip. The core loop.
- **M1** — token/cost `estimate` baked into `pass` and `take` (the wedge).
- **M2** — `status`/`done` + `.baton/history/` audit trail.
- **M3** — optional Claude Code skill/hook + Cursor rule for one-command UX.
- **M4** — polish: README with the arbitrage pitch, examples, demo gif; publish to npm.

## Positioning (README headline)
> "Baton hands your coding work from one AI agent to another. Plan on your powerful/included
> agent; pass a curated, execution-ready brief — with a cost estimate — to your cheap one.
> One file (`HANDOFF.md`), no server."

## Competitors to stay differentiated from
- `cli-continues` (1.2k★) — generic session import. Baton = curated *cheap-to-execute* brief +
  cost estimate, not a history dump.
- `mcp_agent_mail` — concurrent coordination/locking (different problem; see `agentlock/`).
- AGENTS.md / spec-kit / plan-mode files — Baton *rides* these (interoperable), doesn't replace.

## First step when you open this in a new session
1. `npm init -y` in this folder, add TypeScript + commander + gray-matter + execa + tsx.
2. Implement `src/handoff.ts` (the HANDOFF.md schema + read/write) and `src/cli.ts` with
   `pass` and `take` (M0). Write a round-trip test.
3. Then add `estimate.ts` (M1) — that's what makes it Baton, not a generic handoff.

## Open questions
- Default executor target — Cursor first, or generic?
- Should `pass` auto-run `git diff` to capture the intended change, or only describe it?
- Price table: hardcode + let users override in `~/.baton/prices.json`?
- Name availability: confirm npm `baton` (fallback: `baton-cli`, `agent-baton`, `@you/baton`).
