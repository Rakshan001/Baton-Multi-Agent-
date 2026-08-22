# Changelog

Baton is in **early release**. The CLI, daemon API, and dashboard may still
change; `0.x` versions signal that breaking changes can land in a minor bump.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — install guidance, and one question that was never real

### Removed
- **The "dashboard, or headless over MCP?" question.** It read like a switch
  that turned machinery off, and it never was one: the answer reached exactly
  one `console.log` branch while the graph, the KB, the MCP servers, the git
  hooks, the skills and the agent wiring all ran either way — the headless
  branch's own next line invited you to run `baton serve` whenever you liked.
  The dashboard is a viewer, not a mode. Setup now states both facts and asks
  one fewer question.

### Added
- **Arrow-key prompts.** The wizard's questions are now checkbox and radio
  lists — `↑↓` to move, space to toggle, `a` for all, `n` for none, Enter to
  confirm — instead of asking you to type numbers and map "Cursor Agent" onto
  "2". Each option carries a short note beside it (`found on your PATH`,
  `one merged graph + one dashboard — recommended`), so the thing that explains
  the choice sits next to the choice.

  Built on `node:tty` raw mode and ANSI escapes rather than a prompts library:
  Baton ships five pure-JS dependencies and argues for itself partly on being
  small enough to audit. Where there is no terminal — CI, a pipe, `nohup` — the
  typed-number prompts still run, so nothing scripted changes.
- **Setup warns when `batonhq` is a dependency of the project it is setting
  up.** `npm i batonhq` is the reflex and it is the wrong move: npm reconciles
  the host project's whole dependency tree, so a repo with native modules
  recompiles them, and a `node-gyp` backtrace with `batonhq` in the command line
  reads like Baton's fault. The warning names the two ways that do work, and
  arrives during the scan — before anything is written.
- **A troubleshooting entry** for that exact failure signature, including the
  two usual causes: no prebuilt binary for your Node version, and project paths
  containing characters the generated Makefile does not quote (parentheses, for
  instance).

### Changed
- `--serve` and `--headless` on `baton setup` are **deprecated and ignored**.
  They existed only to skip the question above. They are still accepted, so
  nothing that passes them breaks.
- README and docs name the wrong command explicitly. Listing the right ones
  turned out not to be enough — the author of the tool still typed
  `npm i batonhq` out of habit.

## [0.1.0] — first published release

The first version installable from npm, as **`batonhq`** (the command is still
`baton`; `baton`, `baton-cli` and `create-baton` are unrelated packages by other
authors).

### Added
- **`npx batonhq setup`** — a first-run wizard that scans the folder before it
  asks anything, then covers one-repo-vs-hub, which agents to wire, the
  knowledge graph, bundled skills, and a global install.
  Every question has a recommended default; Enter takes it.
- `baton setup --agents <list>` to wire specific agents without the prompt.
- The published package ships the prebuilt dashboard, so `baton serve` works
  straight from a global install.
- npm provenance on release, and a CI job that installs the packed tarball into
  a clean container and sets up a repo with it.

### Fixed
- `baton --version` reported a hardcoded `0.0.1` instead of the version it was
  actually published as.
- `zod` was imported by the MCP server but never declared as a dependency; it
  resolved only through npm's hoisting of the MCP SDK's own copy, and would have
  failed under pnpm or Yarn PnP.
- Setting up without `graphify` printed an error, then "ready", then left no
  knowledge base. The install is now offered before anything is written, and a
  run without it says exactly what was skipped and what still works.
- Baton on Node < 24 failed deep inside `node:sqlite`. It now exits immediately
  with the version found, the version required, and how to upgrade.

## [Unreleased]

### Added
- Community health files: Code of Conduct, Contributing guide, Security policy,
  and citation metadata (`CITATION.cff`).
- Isolated git worktrees so agents don't clobber each other's files.
- Realtime dashboard over Server-Sent Events streaming who's editing what.
- Edit-signal coordination between agents.
- Code knowledge graph (graphify) for navigating a repo instead of grepping.
- Shared evidence-anchored memory carrying facts between sessions.
- Installable skills catalog.
- One-file session handoff via `HANDOFF.md`, including a cost estimate.
- Zero-dependency daemon (`baton serve`) built on raw `node:http`.
