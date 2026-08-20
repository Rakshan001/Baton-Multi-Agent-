# npm Distribution — Design

> Baton stops being a `git clone` and becomes `npx batonhq setup`.

**Status:** approved 2026-08-20. Implementation phases at the bottom.

## Problem

Installing Baton today means cloning the repo, installing two workspaces,
building both, installing a Python CLI, and running `npm link`
([docs/installation.md](../../installation.md)). That is a contributor's
workflow being used as a user's front door. Every step is a place to lose
someone who has not yet seen the product work.

The fix is an npm package that carries a prebuilt CLI *and* a prebuilt
dashboard, plus a first-run wizard that asks the few questions Baton cannot
infer and recommends an answer to each.

## Decisions

### The name is `batonhq`

`package.json` planned `baton-cli`. That name is **taken on npm** — v0.6.2,
by an unrelated author, described as *"Git-backed session handoff for Claude
Code"*. So is `baton` (squatted since 2022), `create-baton` (*"Set up Baton
AI orchestration protocol in any project"*), `baton-mcp`, `baton-dev`, and
`batonjs`.

`batonhq` is free as a bare name **and** as an org scope, so `@batonhq/*` is
reserved for anything later (an MCP-only package, a JS client). The product
is still called Baton and the binary is still `baton`; only the registry id
changes.

Two consequences the README must absorb: the Baton name is crowded on npm
with two adjacent AI tools, so the first paragraph has to make the
difference obvious, and the AGPL-3.0 licence will be auto-rejected by some
corporate dependency policies. Both are acceptable — neither is silent.

### Missing prerequisites degrade, they do not block

Baton needs Node ≥ 24 (hard: `node:sqlite` FTS5 backs memory ranking) and
the Python `graphifyy` CLI (knowledge graphs).

- **Node** is a hard floor and cannot be auto-fixed. `engines` only *warns*
  on a global install, so the real guard is a runtime check that prints
  which version was found, which is needed, and why.
- **graphify** is optional at setup time. Setup never blocks on it:
  worktrees, the dashboard, handoff, memory, and coordination all work
  without it; the knowledge graph is reported as off. The wizard offers to
  run `uv tool install graphifyy` and runs it only on an explicit yes.

No `postinstall` script, ever. Install scripts are a trust smell and they
break `npm i --ignore-scripts`.

### First release is cut from `main`

Packaging is orthogonal to the in-flight `feat/plan-dispatch` work. 0.1.0
ships from clean `main` so install-path bugs surface on real machines
immediately; plan-dispatch lands after as 0.2.0.

## Architecture

### One package, global CLI, npx as the on-ramp

`batonhq` ships prebuilt `dist/` and `web/dist/`, bin `baton`.
`npx batonhq setup` runs the wizard against an existing repo, and closes by
offering a global install so `baton` is on PATH for daily use.

Rejected: a `create-baton-app` / `batonhq` split. That split exists so
`create-*` can copy a template into an empty folder. Baton copies no
template — it wires up a repo that already exists — so the split would buy
two packages, two versions, and a sync problem for nothing.

### The entry point becomes a launcher

`src/cli.ts` today is 709 lines of commander wiring, and its first import is
`./util/quiet.js`. A Node-version guard placed the same way would be
correct *today* and fragile later: ES imports are hoisted, so the entire
module graph is parsed before the first statement runs, and any future
syntax or dependency the floor version cannot parse would preempt the guard
and replace a friendly message with a stack trace.

So `src/cli.ts` becomes a launcher: check the Node major, print and exit on
failure, otherwise `await import('./main.js')`. The 709 lines move to
`src/main.ts` unchanged.

The launcher's only static import is `src/util/node-preflight.ts`, a module
that imports nothing itself. That keeps the pre-check's module graph at two
trivially-parseable files while leaving the decision in a pure function the
tests can drive directly — inlining it in the launcher would make it
unreachable from a test, and duplicating it would let the two copies drift.

This must preserve two re-entry paths that use the entry file by path:

- [src/commands/guard.ts](../../../src/commands/guard.ts) respawns
  `process.execPath process.argv[1] snapshot …`
- [src/commands/new.ts](../../../src/commands/new.ts) and
  [src/commands/claim.ts](../../../src/commands/claim.ts) embed
  `process.argv[1]` in a git commit hook

Both keep working, because the launcher lives at the same `dist/cli.js`
path and does not rewrite `process.argv`. Ten E2E tests that spawn
`node dist/cli.js serve` are the regression net.

### Packaging

| Field | Now | Becomes |
|---|---|---|
| `name` | `baton-cli` (taken) | `batonhq` |
| `version` | `0.0.1` | `0.1.0` |
| `bin` | `baton → dist/cli.js` | unchanged |
| `files` | `dist, web/dist, README, LICENSE` | unchanged |
| `prepack` | — | builds **both** workspaces |
| `homepage`, `bugs` | — | added |

`npm run build` never builds `web/dist`, so a naive `npm publish` would ship
a CLI whose dashboard 404s. `prepack` (not `prepublishOnly`) closes it,
because `prepack` also runs for `npm pack` — which is what the packaging
test uses, so the test exercises the same path as a real publish.

`baton --version` currently hardcodes `0.0.1` in
[src/cli.ts](../../../src/cli.ts) while `src/version.ts` already reads
package.json. A published binary that misreports its own version makes
every bug report ambiguous, so the hardcoded string goes.

## The wizard

Built on `askChoice` ([src/commands/kb.ts](../../../src/commands/kb.ts)) —
numbered menu, a default, and a non-TTY fallback to that default. No
`inquirer`/`prompts` dependency; the zero-dependency daemon rule holds.

```
$ npx batonhq setup

  Baton — coordination hub for multiple AI coding agents

  Scanning ./my-app …
  ✓ git repo          ✓ node 24.4.0       ✗ graphify (knowledge graph)

1  This folder is one git repo. Set it up as a single project?     [Y/n]
     (3+ repos found → "one hub for all 3 (recommended)" vs "each separately")
2  Which agents do you use?                    [claude, cursor, codex, gemini]
3  Turn on the knowledge graph? needs `uv tool install graphifyy`   [Y/n]
4  How will agents use this?   1) Dashboard (recommended)  2) Headless/MCP
5  Install the bundled skills into your agents?                     [Y/n]
6  Install `baton` globally so you can run it anywhere?             [Y/n]

  ✓ Ready.  cd my-app && baton serve --write   →  http://localhost:7077
```

Steps 1 and 4 exist already via `classifyTarget()`. New: the preflight
banner, agent multi-select (today all four are connected unconditionally),
the graphify consent step, skills, and the global-install offer.

## Edge cases

The wizard is the first thing a stranger touches, so its failure modes are
the product's first impression.

| # | Case | Behaviour |
|---|---|---|
| E1 | Node < 24 | Friendly message naming found/required/why; exit 1. No stack trace. |
| E2 | `process.versions.node` absent or unparseable | Guard allows the run rather than blocking on its own uncertainty. |
| E3 | Non-TTY (CI, pipe, nohup) | Every prompt takes its default; never hangs waiting on stdin. |
| E4 | `--yes` | Takes every default that touches the project, and installs no software — `--yes` is what CI and Dockerfiles run. Skipped installs print as a command. |
| E5 | Ctrl-C mid-wizard | Exits without a stack trace, leaving no half-written config. |
| E6 | Garbage prompt input | Re-asks rather than accepting a wrong answer. |
| E7 | Multi-select input: `1,3`, `all`, `none`, empty, out-of-range | All parse; empty = default set; `none` = connect nothing. |
| E8 | No `uv`, no `pipx`, no `pip` | Graph step reports the gap with the install URL; setup continues. |
| E9 | graphify install fails (offline, proxy, wrong Python) | Reported, setup continues, graph marked off. |
| E10 | graphify already installed | Step is skipped silently, not re-asked. |
| E11 | Global install fails (EACCES on a root-owned prefix) | Prints the manual command instead of a raw npm error. |
| E12 | Already installed globally | Offer is skipped. |
| E13 | Run via `npx` vs an installed binary | Detected; the global-install offer only appears for npx. |
| E14 | Re-running setup on a configured repo | Idempotent — no duplicate config, no clobbered answers. |
| E15 | Target is not a git repo | Offers `git init`, since a bare folder is a normal starting point. |
| E16 | Windows paths / no POSIX shell | No shelling out to `sh`; all spawns go through `src/util/exec.ts`. |
| E17 | Tarball missing `web/dist` | Packaging test fails the build before publish. |
| E18 | Published version ≠ git tag | Release workflow refuses to publish. |

## Verification

The test that matters is not a unit test: `npm pack`, install the tarball
into a container holding only Node and git, run `baton setup --yes` on a
throwaway repo, and assert `.baton/` exists and `baton ls` runs. Every
"works on my machine" packaging failure — a missing `web/dist`, a path left
out of `files`, a devDependency imported at runtime — dies there. Without
it, the first report comes from a stranger.

## Phases

All phases are implemented; `[x]` marks what shipped in this branch.

- [x] **Phase 1 — Package identity.** `batonhq`, 0.1.0, `prepack` building
      both workspaces, `homepage`/`bugs`, `--version` reads package.json.
- [x] **Phase 2 — Node preflight guard.** `src/cli.ts` → `src/main.ts`;
      new launcher; E1, E2.
- [x] **Phase 3 — Tarball audit.** A test asserting `dist/`, `web/dist/`,
      and `dist/skills/bundled` are in the pack manifest; E17.
- [x] **Phase 4 — Wizard.** Preflight banner, agent multi-select, graphify
      consent, skills, global-install offer; E3–E16.
- [x] **Phase 5 — Release CI.** Publish on `v*` tag with provenance and a
      tag/version match check; E18.
- [x] **Phase 6 — Clean-container install smoke test.**
- [x] **Phase 7 — Docs.** README, installation, quickstart, CHANGELOG.

## What implementation changed about this design

Three things the design did not anticipate, found while building it:

**`kb init` refuses without graphify.** The design assumed "degrade, do not
block" was a property of the wizard. It was not: `kb init` sets an exit code and
writes nothing when graphify is missing, and setup called it *before* offering
the install, then printed "✓ ready" anyway. So the offer moved ahead of every
write, and a run without graphify now skips the knowledge base deliberately and
says which parts still work.

**`zod` was a phantom dependency.** `src/mcp.ts` and `src/mcp-pipeline.ts`
import it; nothing declared it. It resolved only because the MCP SDK depends on
it and npm hoists — so `baton mcp` would have died under pnpm or Yarn PnP. Now
declared, with a test that walks every import in `src/` so the next one cannot
sneak in.

**`--version` was hardcoded.** It read `0.0.1` from a string literal while
package.json moved independently.

Phase 3 also merged into the existing `test/packaging.test.ts` rather than
replacing it: that file already asked npm directly what the tarball contains,
and it documents why `web/.npmignore` exists (npm falls back to `web/.gitignore`,
which ignores `dist/`). The manifest assertions were added alongside it.
