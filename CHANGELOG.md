# Changelog

All notable changes to Baton are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Community health files: Code of Conduct, Contributing guide, Security policy,
  and citation metadata (`CITATION.cff`).

## [0.0.1] - 2026-07-14

Initial public release.

### Added
- **Isolated git worktrees** — every task runs in its own worktree so agents
  don't clobber each other's files.
- **Realtime dashboard** over Server-Sent Events streaming who's editing what.
- **Edit-signal coordination** to warn when agents touch the same files.
- **Code knowledge graph** (graphify) for navigating a repo instead of grepping.
- **Shared evidence-anchored memory** carrying verified facts between sessions.
- **Installable skills** catalog.
- **One-file session handoff** via `HANDOFF.md`, including a cost estimate.
- **Zero-dependency daemon** (`baton serve`) built on raw `node:http`.

[Unreleased]: https://github.com/Rakshan001/Baton-Multi-Agent-/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/Rakshan001/Baton-Multi-Agent-/releases/tag/v0.0.1
