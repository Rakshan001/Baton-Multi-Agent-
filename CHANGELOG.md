# Changelog

Baton is in **early release**. The CLI, daemon API, and dashboard may still
change; `0.x` versions signal that breaking changes can land in a minor bump.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — first published release

The first version installable from npm, as **`batonhq`** (the command is still
`baton`; `baton`, `baton-cli` and `create-baton` are unrelated packages by other
authors).

### Added
- **`npx batonhq setup`** — a first-run wizard that scans the folder before it
  asks anything, then covers one-repo-vs-hub, which agents to wire, the
  knowledge graph, dashboard vs headless, bundled skills, and a global install.
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
