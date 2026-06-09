# Baton — Web Dashboard

Multi-agent mission control for [Baton](../README.md). A Vite + React + TypeScript
dashboard that reads the local `baton serve` JSON API and visualises every agent
session: a board ⇄ canvas of worktrees, merge-risk conflict graph, commit
provenance, activity, and history.

## Run it

```bash
# 1. start the Baton daemon in your git repo
baton serve            # → http://localhost:7077

# 2. start the dashboard (this folder)
npm install
npm run dev            # → http://localhost:5173
```

The dev server proxies `/api/*` to the daemon, so the app is same-origin (no CORS).
Point at a daemon elsewhere with `VITE_BATON_API=http://host:port npm run dev`, or
from the in-app **Settings → Connection** panel.

## What's real vs. preview

Everything visualised is backed by the API contract. Honest by design:

- **Real reads** — board/canvas, conflicts, history, agents, and the per-session
  detail sheet all come from `GET /api/status`, `/api/history`, `/api/tasks/:slug`,
  `/api/meta`.
- **New session** — the **New** button creates a real worktree + branch via
  `POST /api/tasks` (wraps `baton new`). You launch the agent in that worktree
  yourself; Baton doesn't spawn agent processes.
- **Progress** is an *estimate* derived from commit count (`ahead`), always labelled
  `est.` — never a fake %.
- **Merge / Remove** are gated behind the **write** toggle (Settings). Until their
  server endpoints land they run an optimistic UI + rollback flow locally and are
  clearly framed as read-only by default.
- **Token usage, live diff, handoff, agent-launch** are clearly marked **Preview** /
  **Coming soon** — Baton doesn't expose these from the API yet.

## Scripts

- `npm run dev` — dev server (port 5173)
- `npm run build` — typecheck + production build to `dist/`
- `npm run lint` — `tsc --noEmit`
- `npm test` — vitest

## Layout

```
src/
  styles/      tokens.css (themes) · base.css (globals + keyframes)
  types.ts     contract types mirrored from the CLI (src/board.ts, etc.)
  lib/         api (fetch client) · derive · format · registry · preview · toast
  hooks/       usePoll · usePrefs · useMediaQuery
  components/  Icon · primitives · SessionCard · CommandBar · Toast · BatonMark
  features/    CommandCenter · Board · Canvas · Activity · Conflicts · History ·
               Agents · Settings · Connect · Detail · Diff · Handoff · NewSession
  App.tsx      shell (TopBar · Sidebar · routing · overlays)
```
