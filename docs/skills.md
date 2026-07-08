# Skills

Skills are reusable agent playbooks — named markdown files (objective + steps) that an agent installs into its own config directory and invokes when a task matches. Baton ships a curated catalog, installs each into the format a given CLI understands, and lets you import your own from a path or URL.

## What a skill is

A skill is a markdown playbook with a `name`, a one-line `description` (the agent uses it to decide relevance), and a body of steps. Baton tracks two kinds:

- **Bundled** — shipped with Baton. File-backed skills live under [`src/skills/bundled/<id>/`](../src/skills/bundled) (a `SKILL.md` plus an optional `references/` folder of supporting files); a couple are short inline single-file skills.
- **Imported** — brought in from a local path or `http(s)` URL. These are stored at `<repo>/.baton/skills/<id>.md`, survive restarts, and appear in the catalog alongside bundled ones. Imported skills are single-file (references are a bundled-skill feature).

The catalog and rendering logic live in [`src/skills/catalog.ts`](../src/skills/catalog.ts) and [`src/skills/install.ts`](../src/skills/install.ts).

## Bundled skills

| ID | Name | What it does |
| --- | --- | --- |
| `bug-fix` | Bug fix | Flagship debugging pipeline (v2): **check the shared tracker first** (is it already fixed? is someone editing those files right now?), reproduce, audit blast radius, root-cause, get an approved plan, re-verify against regressions, write a report, auto-commit (never pushes), and **record the fix to shared memory last** — which is what powers `baton bugs` recurrence checks. |
| `lean-code` | Lean code | Restraint ladder against over-engineering: before writing code, ask — does it exist? is it in this repo? stdlib? platform? an installed dep? one line? — and only then write the minimum. Never simplifies validation, error handling, security, or accessibility. Adapted (ideas, not text) from [Ponytail](https://github.com/DietrichGebert/ponytail) (MIT), whose ladder measured ~54% less code, ~20% cheaper, ~27% faster, 100% safe on real agent sessions. |
| `token-efficient-coding` | Token-efficient coding | Keep token cost down — targeted reads, minimal diffs, working around context rot and compaction. |
| `traceable-changes` | Traceable changes | Atomic conventional commits in an isolated worktree, for a bisectable, blame-able history across multiple agents. |
| `memory-light` | Memory-light | Recall before exploring, externalize state, write durable facts, and hand off cleanly across sessions. |
| `verify-before-done` | Verify before done | Re-read the diff, check that symbols exist, run build/test/lint, and do an independent skeptic re-check before calling a task done. |
| `map-codebase` | Map this codebase | Build the graphify knowledge graph and `CODEBASE.md` so agents navigate a compact map instead of the whole repo. |
| `safe-refactor` | Safe refactor | Restructure without changing behaviour — worktrees, a green test baseline, and the graph to find every caller. |

`bug-fix`, `lean-code`, and the four efficiency & traceability skills (`token-efficient-coding`, `traceable-changes`, `memory-light`, `verify-before-done`) are file-backed under `src/skills/bundled/`; `map-codebase` and `safe-refactor` are inline.

## Install targets

Baton can write skills for two agent CLIs. Each gets the on-disk format it understands; writes are non-destructive and stay inside the repo.

| Agent | Where it installs | Format |
| --- | --- | --- |
| `claude` | `.claude/skills/<id>/SKILL.md` (+ `references/` alongside) | Claude Code skill — `name` + `description` frontmatter, then the playbook. |
| `cursor` | `.cursor/rules/<id>.mdc` (+ sibling `<id>/references/`) | Cursor project rule — `description` + `alwaysApply: false` frontmatter. |

The other agents (`codex`, `gemini`, `aider`, `opencode`) have no standard skill directory Baton can write, and installing for them returns an unsupported-agent error. (Deliberately: cramming a full playbook into their always-on instruction files would cost tokens on every turn — skills should load on demand.)

## Install into every agent at once

One command (or one click) writes a skill into **all** writable agents, each in its own format:

```bash
baton skills list                    # catalog + per-agent install state
baton skills install bug-fix         # → ALL writable agents (claude + cursor)
baton skills install bug-fix --agent claude   # just one
baton skills uninstall bug-fix
baton skills import <path|url>       # then install it like a bundled one
```

Over HTTP, `POST /api/skills/:id/install` with `{"agent":"all"}` returns a per-agent `results` array. In the dashboard Skills page, every skill card has an **⚡ Add to all** button.

Notes on rendering:

- **Multi-file skills** ship reference files (checklists, templates). Claude reads them from its own skill dir; for Cursor (single-file rules) they are copied next to the rule under `<id>/` and the rendered rule points at them.
- For **Claude**, a hand-authored `SKILL.md` is installed **byte-for-byte** when its on-disk `name` already matches the id (so a hand-tuned skill isn't reflowed); otherwise it is re-rendered.
- **Uninstalling** removes the whole `.claude/skills/<id>/` dir for Claude, or the `.mdc` rule plus its sibling `<id>/` references for Cursor.

## Importing a skill

Import a skill from a local file path or an `http(s)` URL. It is parsed, written to `<repo>/.baton/skills/<id>.md`, and then appears in the catalog and is installable like a bundled one.

Constraints and safety:

- **256KB cap** on the imported file (`MAX_IMPORT_BYTES`). The size is enforced while streaming the response — it aborts rather than buffering the whole body first.
- **SSRF-guarded** for URL imports — only `http(s)` is allowed, and private / loopback / link-local / reserved hosts are refused (including `localhost`, `127.0.0.0/8`, RFC1918 ranges, CGNAT `100.64.0.0/10`, IPv6 loopback/ULA/link-local, and cloud-metadata `169.254.169.254`). Redirects are followed manually and **re-validated on every hop** (max 4 redirects), with a 10s timeout.
- **Empty files** are rejected, and an imported id that **collides with a bundled skill** is refused (rename its frontmatter `name`).

The id is slugified from the frontmatter `name` (falling back to the filename or URL path segment), lowercased to `[a-z0-9-]`, and capped at 60 chars.

## Dashboard

The **Skills** page in the dashboard ([http://localhost:7077](http://localhost:7077) when running `baton serve`) lists the full catalog with each skill's name, description, tags, what it produces, and its per-agent install state. From there you can import a skill and install or uninstall it per agent — or hit **⚡ Add to all** to install into every agent at once. See [serve & dashboard](./dashboard.md) for starting the daemon.

## HTTP API

Skills are exposed over the daemon's JSON API. Reads work without `--write`; the mutating endpoints require `baton serve --write` and a loopback `Origin` header (the central anti-CSRF guard — see [security](./security.md)).

| Method | Endpoint | Purpose | Needs `--write` |
| --- | --- | --- | --- |
| `GET` | `/api/skills` | List the catalog with per-agent install state | No |
| `POST` | `/api/skills/import` | Import a skill from a path or URL | Yes |
| `POST` | `/api/skills/:id/install` | Install a skill for an agent | Yes |
| `DELETE` | `/api/skills/:id/install` | Uninstall a skill for an agent | Yes |

Example — list, then install `bug-fix` for Claude:

```bash
# read the catalog
curl -s http://localhost:7077/api/skills | jq '.[].id'

# install (write mode; loopback Origin required)
curl -s -X POST http://localhost:7077/api/skills/bug-fix/install \
  -H 'Origin: http://localhost:7077' \
  -H 'Content-Type: application/json' \
  -d '{"agent":"claude"}'
```

An install response reports where it wrote and how many reference files came along:

```json
{ "skill": "bug-fix", "agent": "claude", "rel": ".claude/skills/bug-fix/SKILL.md", "wrote": true, "references": 2 }
```

## Related

- [Knowledge base (graphify)](./knowledge-graph.md) — the code map skills like `map-codebase` build.
- [Memory](./memory.md) — durable, evidence-anchored facts that `memory-light` leans on.
- [Serve & dashboard](./dashboard.md) — run the daemon to use the Skills page and API.
- [README](../README.md) — project overview.
