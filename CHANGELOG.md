# Changelog

Baton is currently in **active development (pre-release)**. The CLI, daemon API,
and dashboard may change without notice, and no versioned release has been cut
yet. Once the first release lands, notable changes will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and once versioned this project will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
