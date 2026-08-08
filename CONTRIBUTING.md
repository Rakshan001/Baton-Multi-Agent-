# Contributing to Baton

Thanks for your interest in Baton! 🪄 Baton is a local coordination hub and
knowledge base for running multiple AI coding agents on one repository. This
guide covers how to set up, build, test, and propose changes.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with steps to reproduce, expected vs. actual
  behavior, and your OS / Node version.
- **Suggest a feature** — open an issue describing the problem you're solving
  before writing code, so we can align on the approach.
- **Send a pull request** — fix a bug, improve docs, or add a feature (ideally
  tied to an existing issue).
- **Improve docs** — corrections and clarifications to `README.md`, `docs/`, or
  the [landing site](https://baton-landing.vercel.app) are always welcome.

For anything security-related, do **not** open a public issue — see
[SECURITY.md](SECURITY.md).

## Development setup

Baton is two separate TypeScript workspaces (no monorepo tool): the root CLI +
daemon, and the `web/` dashboard, each with its own `package.json`.

Requirements: **Node.js ≥ 20**.

```bash
git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git
cd Baton-Multi-Agent-
npm install
npm install --prefix web
```

## Build, run, and test

```bash
# Backend build + tests
npm run build && npx vitest run

# Dashboard build (served by `baton serve`)
npm run build --prefix web

# Run the daemon + dashboard on :7077
node dist/cli.js serve --write

# UI dev server on :5173 (demo mode defaults ON)
npm run dev --prefix web
```

Please make sure `npm run build && npx vitest run` passes before opening a PR.

## Conventions (please don't break these)

These are load-bearing architectural decisions — see [CLAUDE.md](CLAUDE.md) for
the full context:

- **The daemon stays zero-dependency.** `src/server.ts` is raw `node:http` — no
  express / fastify.
- **Realtime is SSE, not socket.io** — by explicit decision. All live events
  flow through the bus in `src/events.ts`; new event types go there first.
- **Demo mode must keep working.** It is the showcase and defaults ON only on
  the Vite dev origin. Gate real-mode behavior on `BatonAPI.demo`
  (`web/src/lib/api.ts`); never delete demo fixtures that screens still use.
- **Git calls go through `src/util/exec.ts`** (hardened, shell-free). Don't
  shell out to git directly.
- **Strict TypeScript** in both workspaces.
- `.refs/` holds reference open-source code for learning — never import from it,
  never ship it.

## Pull request process

1. **Fork** the repo and create a branch from `main`. Use a descriptive branch
   name (e.g. `feat/who-is-editing-panel`, `fix/worktree-prune`).
2. **Make focused changes.** One logical change per PR is easier to review.
3. **Add or update tests** for any behavior change, and keep the build green.
4. **Update docs** (`README.md`, `docs/`, `STATUS.md`) when behavior changes.
5. **Write a clear PR description** — what changed, why, and how you verified it.
6. Open the PR against `main` and link any related issue.

Commit messages follow a light [Conventional Commits](https://www.conventionalcommits.org)
style, e.g. `feat(web): add who's-editing panel` or `fix(daemon): prune orphaned
worktrees`.

## License

Baton is **AGPL-3.0-or-later** (see [LICENSE](LICENSE)). By opening a pull
request you agree to two things:

1. **Your contribution is licensed under AGPL-3.0-or-later**, the same terms as
   the rest of the project.
2. **You grant Rakshan Shetty a perpetual, worldwide, irrevocable, royalty-free
   right to also license your contribution under other terms**, including a
   commercial license — while keeping every right to your own work yourself. You
   are not assigning copyright; you keep it.

Point 2 is unusual enough to deserve the reason. AGPL asks a company to open
its own source before it can build on Baton, and some cannot. The intent is to
be able to sell those companies an exemption without the project ever going
closed — Baton stays AGPL for everyone, permanently. That only works if one
person can license the whole codebase, which stops being true the moment a
contribution lands that they cannot relicense. Asking afterwards means tracking
down every past contributor and getting a yes from all of them; a single no, or
one unanswered email, and the option is gone forever. So it is asked up front,
or not at all.

If you would rather not grant point 2, say so in the PR — the contribution can
still be taken under plain AGPL, it just has to be a deliberate decision rather
than a surprise later.

Third-party attribution is tracked in [NOTICE](NOTICE) — if your change adapts
an external project, add it there. Note that AGPL-3.0 constrains what can be
adapted: MIT, BSD, ISC and Apache-2.0 sources are fine, but code under a
proprietary or non-commercial license is not, and neither is GPL-2.0-only.
