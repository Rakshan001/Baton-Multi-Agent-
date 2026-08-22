# Changelog

Baton is in **early release**. The CLI, daemon API, and dashboard may still
change; `0.x` versions signal that breaking changes can land in a minor bump.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — Baton stops indexing Baton

### Fixed
- **The knowledge graph was eating its own output.** Running `baton setup` a
  second time on an unchanged repo took it from 1020 nodes and 82 communities to
  1910 and 179, then reported that the community set had drifted and backed up
  the curated graph. Nothing had been added to the codebase; the second pass was
  indexing `graphify-out/` and `.baton/` from the first.

  `.graphifyignore` is seeded by mirroring `.gitignore`, but `kb init` seeds it
  *before* it adds Baton's own entries to `.gitignore` — so on a fresh repo the
  mirror is copied from a file that does not yet mention either path, and
  `composeGraphifyIgnore` then declines to touch a managed file again, making the
  omission permanent. The managed block now names `graphify-out/` and `.baton/`
  itself, so it is correct regardless of what the mirror caught, and an existing
  `.graphifyignore` is upgraded in place on the next run rather than left stale.

  This never showed up in development because Baton's own `.gitignore` has listed
  both paths by hand since long before any of this existed. Only a repo that
  starts without them can hit it.

- **Two of the three MCP configs setup writes were left untracked.** `setup`
  writes `.mcp.json`, `.cursor/mcp.json` and `.agents/mcp_config.json` depending
  on which agents you pick, and the ignore block named only the first. A Claude
  user got a clean `git status` and a Cursor user did not. These files can also
  carry a Baton MCP token — `baton kb mcp --agent cursor` prints a snippet
  containing `/mcp/g/<token>/` and tells you to paste it into `.cursor/mcp.json`
  — so ignoring one of the three for that reason and not the others was half a
  rule. All three are ignored now.

- **A nested `.baton/` stayed untracked in a monorepo.** `.baton/*` contains a
  slash, which anchors it to the repo root, so in a repo whose sub-projects each
  got their own `.baton/` only the top one was ignored. The entries are `**/`
  prefixed now. `.baton/agents.json` remains committable, as documented.

### Added
- **Setup says when its own files are already tracked.** Adding a line to
  `.gitignore` does nothing to a file git is already tracking, so a repo set up
  before the managed block existed kept committing `.baton/kb.json` on every
  commit while setup printed `✓ .gitignore updated` directly above it. It now
  lists what is affected and hands over the `git rm --cached` line — which spares
  `.baton/agents.json` — rather than running it. Untracking files across
  somebody's repo uninvited is not a setup step.

## [0.1.2] — a machine with nothing on it

### Added
- **Setup can bootstrap `uv`.** Previously a machine with neither `uv` nor
  `pipx` got a hint and no knowledge graph — which is exactly what a clean
  laptop is. Setup now offers to install `uv` through Homebrew (or winget on
  Windows) and then graphify: two commands, both argv arrays against a package
  manager. uv brings its own Python, so nothing else has to be installed.

  Where there is **no** package manager, setup prints
  `curl -LsSf https://astral.sh/uv/install.sh | sh` rather than running it. That
  is the same rule that already makes Baton refuse bare `pip`, one level down: a
  package manager is a signed artefact and an argv array, while the official
  installer is a script downloaded at runtime and piped into a shell. A tool
  people install to coordinate agents over their source code should not do that
  on their behalf.

### Fixed
- **The arrow-key prompts broke every prompt after the first.** `for await (… of
  stdin) { … break }` calls the iterator's `return()`, which *destroys* the
  stream. stdin is a process-wide singleton, so the first picker to finish took
  stdin with it. A multi-repo setup died on its second question with
  `error: The operation was aborted`, and the skills and global-install
  questions — both of which come after a picker — silently never appeared, which
  is why `baton` was missing from PATH after an `npx` setup. Now iterated with
  `destroyOnReturn: false`.

  The same fix removed an explicit `resume()`: it put the stream in flowing
  mode before the iterator attached, where data with no listener is discarded.
  The async iterator owns flow control.
- **Holding a key down did nothing.** One read can carry several keystrokes, and
  `decodeKey` understands one — so a burst like three arrow-downs decoded to a
  single `ignore` and the list sat still. Chunks are now split into keys first,
  escape sequences kept whole.
- **An installed Cursor was reported as not installed.** Presence was probed by
  looking for the agent's binary, and Cursor's is `cursor-agent` — a separate
  terminal CLI. Anyone using the Cursor *editor* was told Cursor was missing
  while it sat open in front of them, and the same held for a Codex or Gemini
  config without the CLI. Wiring an agent writes an MCP entry and needs no
  binary at all, so the probe was answering a different question than the one on
  screen. It now also looks for the agent's own config directory and reports
  which it found (`claude on your PATH`, `config found in ~/.cursor`).
- **The multi-repo list was unreadable when two repos shared a name.** It
  printed `basename(path)`, so a real project scanned as five repos of which
  two pairs looked identical — at different depths, with nothing on screen
  saying so. That is the list you read to decide whether to merge them all into
  one knowledge graph. Colliding names now show their path relative to the
  scanned root; everything else stays short.
- **The skills step could fail silently.** An unreadable catalog hit a bare
  `catch { return; }` — no message, no exit code, and setup still finished with
  a tick while twelve skills were quietly missing. It now says what failed and
  names `baton skills list`. Same green-over-half-done failure the
  knowledge-graph step had before 0.1.0.

### Changed
- `installHint` leads with `uv` instead of bare `pip install graphifyy`.
  Recommending by hand the one route Baton itself refuses to take — pip installs
  into whichever Python leads PATH, often the system one — was bad advice.

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
- **Pick which repos join a hub.** A folder of several repos offered "all of
  them, or each on its own", and neither is the usual shape — five repos are
  commonly three that belong together and two that do not. The repos are now a
  checkbox list with everything ticked, so Enter still means what it did.
  Unchecked repos are left completely alone, and setup says which ones and how
  to add them later, because unticking something should not quietly cause work
  to happen to it.
- **Pick which skills to install.** Twelve bundled skills were all-or-nothing.
  Same list, all ticked; Enter installs the lot exactly as before.
- **Setup can bootstrap `uv`.** The wizard's questions are now checkbox and radio
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
