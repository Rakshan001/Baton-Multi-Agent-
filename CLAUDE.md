# Baton — agent context

Baton is a centralized knowledge base + coordination hub for multiple AI coding
agents working on one repo via isolated git worktrees: code knowledge graphs
(graphify), realtime dashboard (SSE), edit-signal coordination, and session
handoff between agents.

> This file is for hacking on Baton's own source. If you were instead asked to
> **install Baton onto someone else's project**, use [AGENTS.md](AGENTS.md).

**Start here:**
- [STATUS.md](STATUS.md) — what is built, what is pending, where things live. Keep it updated at the end of each session.
- [SETUP.md](SETUP.md) — environment setup + commands.
- [BUILD.md](BUILD.md) / [MVP.md](MVP.md) — product vision and scope decisions.

## Conventions (do not break)

- **Daemon stays zero-dependency**: `src/server.ts` is raw `node:http`. No express/fastify.
- **Realtime is SSE, not socket.io** — by explicit decision. All live events flow through the bus in `src/events.ts`; new event types go there first.
- **Demo mode is the showcase and must keep working.** It defaults ON only on the Vite dev origin. Gate real-mode behavior on `BatonAPI.demo` (web/src/lib/api.ts); never delete demo fixtures that screens still use.
- **Git calls go through `src/util/exec.ts`** (hardened, shell-free). Don't shell out to git directly.
- Strict TypeScript in both workspaces (root + `web/`, two separate `package.json`s, no monorepo tool).
- `.refs/` holds reference open-source code for learning — never import from it, never ship it.

## Commands

```bash
npm run build && npx vitest run        # backend build + 34 tests
npm run build --prefix web             # dashboard build (served by baton serve)
node dist/cli.js serve --write         # daemon + dashboard on :7077
npm run dev --prefix web               # UI dev server :5173 (demo defaults ON)
```
