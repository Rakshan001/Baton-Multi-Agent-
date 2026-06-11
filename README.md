# 🪄 Baton

**Plan on your expensive agent. Pass the baton to your cheap one.**

Baton is a tiny CLI + convention for **handing a unit of coding work from one AI agent to
another.** Do the expensive thinking on a powerful/included agent (e.g. Claude Code on a Max
plan) — research, plan, the exact diff, the remaining tasks — then pass a **curated,
execution-ready brief** to a cheaper agent (e.g. Cursor Auto / Copilot) that just *executes*.

> One file (`HANDOFF.md`). No server. No lock-in.

---

## Project docs

- **[STATUS.md](STATUS.md)** — what's built, what's pending, where things live (start here when resuming work)
- **[SETUP.md](SETUP.md)** — fresh-machine setup in ~10 minutes
- **[CLAUDE.md](CLAUDE.md)** — context auto-loaded by Claude Code (conventions + commands)

---

## Why

Developers increasingly run two or three AI coding tools and split work to save money/quota
(*"My usage on Cursor was \$1500–2000/month; the same on Claude Code is \$200"*). But switching
tools loses context, and existing handoff tools just dump raw session history.

Baton's one sharp idea: **do the thinking where it's powerful/included, do the bulk editing
where it's cheap** — by emitting a minimal, cheap-to-execute brief *with a token/cost estimate*
of running it.

## How it works

```
Claude Code (plan/think)                Cursor Auto / Copilot (edit cheap)
─────────────────────────               ──────────────────────────────────
baton pass   ─────────────▶  HANDOFF.md  ◀─────────────  baton take
(emit brief + cost estimate)            (read brief → execution prompt)
                                          …agent edits…
                                         baton done
```

## Quick start (planned API)

```bash
npx baton pass --to cursor      # emit HANDOFF.md from your current plan/diff/tasks
npx baton take --as cursor      # read it, print a tight execution prompt
npx baton done                  # mark complete
```

## Status

🚧 **Early / WIP.** See [`BUILD.md`](./BUILD.md) for the full design, the market wedge, the
`HANDOFF.md` format, the CLI surface, and the build milestones.

## Not to be confused with

- **Session-import tools** (e.g. `cli-continues`) — Baton emits a *curated, cheap-to-execute*
  brief with a cost estimate, not a raw history dump.
- **Concurrent multi-agent locking** — a different, larger problem (file locks so agents don't
  clobber each other). Baton is deliberately small and *sequential*.

## License

MIT © 2026 Rakshan Shetty
