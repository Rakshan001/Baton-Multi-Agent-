---
plan: skill-fetch
goal: Cut the cost of fetching skills from ~82k tokens to under 2k, and let skills declare which other skills they work with
requireReview: true
---

## Context for every task in this plan

Measured on this repo, 2026-09-05:

- `src/skills/bundled/` holds **330 KB across 38 files** — roughly **82,000
  tokens** if a client reads all of it.
- `GET /api/skills` (`src/server.ts:2314`) calls `listSkillStatus`
  (`src/skills/install.ts:404`), which returns **`body: skill.body` for every
  skill**. One catalog fetch therefore ships every playbook in full.
- `bundledSkills()` (`src/skills/catalog.ts:355`) eagerly reads every `SKILL.md`
  **and every reference file** into memory just to produce a list.
- References are already returned as paths only (`r.rel`), not contents. That
  part is correct and must stay that way.
- `GET /api/skills/:id/file` (`src/server.ts:2443`) already exists as the
  single-skill fetch, so a metadata-first list has somewhere to point.

**The shape of the fix:** a list returns *descriptions and hashes*; a body is
fetched only when someone actually needs to read it, and never twice.

This is an optimisation of code that already works. Behaviour visible to a user
must not change: the dashboard still lists every skill, install still writes the
same bytes to disk.

## Phase 1 — The contract

### skill-summary-type
**scope:** `src/skills/summary.ts`, `test/skill-summary.test.ts`
**expects:** `SkillSummary` type exported with id, name, description, source, tags, contentSha256, byteSize, references (paths only), and NO body field; `summarize(def)` derives one from a `SkillDef`; sha256 is stable across calls and changes when the body changes; vitest passes
**principles:** new file only — do not edit catalog.ts or install.ts in this task; no new dependencies, use node:crypto
**model:** sonnet

Create the single type every other task in this plan depends on, in a new file
so the tasks that follow can run in parallel without touching each other.

`SkillSummary` is what a list endpoint returns. It carries everything needed to
*choose* a skill and nothing needed to *run* one. `contentSha256` is the hash of
the full skill — `SKILL.md` plus every reference file, path and body, sorted by
path — so a client can tell whether its cached copy is current.

## Phase 2 — Make the fetch cheap

### catalog-lazy-body
**after:** skill-summary-type
**scope:** `src/skills/catalog.ts`, `src/skills/install.ts`, `test/skills-catalog.test.ts`
**expects:** listing skills no longer reads reference-file contents from disk; `listSkillStatus` returns `SkillSummary[]` with no `body`; a new `loadSkillBody(id)` returns the full body and references on demand; existing install behaviour writes byte-identical files to before; `npx vitest run` passes with no test deleted
**principles:** byte-faithful `raw` behaviour must not change — a bundled skill whose frontmatter name matches its id still installs verbatim; keep the file under 400 lines
**model:** sonnet

`bundledSkills()` currently reads every reference file to build a list nobody
asked for bodies from. Split it: metadata for listing, bodies on demand.

The install path still needs full bodies — route it through `loadSkillBody` so
there is exactly one place that reads a body from disk.

### server-skill-etag
**after:** skill-summary-type
**scope:** `src/server.ts`, `test/server-skills-etag.test.ts`
**expects:** `GET /api/skills` sends an `ETag` derived from the summaries and returns `304` with an empty body when the client sends a matching `If-None-Match`; `GET /api/skills/:id/file` sends a per-skill `ETag` and honours `If-None-Match`; a 304 response has zero-length body; existing 200 responses keep their current JSON shape minus `body`
**principles:** raw node:http only, no express — the daemon stays zero-dependency; do not add caching headers that would let a stale skill install
**model:** sonnet

A client that already has the catalogue should pay nothing to confirm it is
current. This is the difference between 82k tokens per poll and zero.

### web-skill-list
**after:** skill-summary-type
**scope:** `web/src/**`
**expects:** the skills screen renders from summaries alone; a skill's body is fetched only when its detail view is opened; demo mode still works with no daemon running; `npm run build --prefix web` passes
**principles:** gate real-mode behaviour on `BatonAPI.demo`; never delete a demo fixture a screen still uses
**model:** sonnet

The dashboard is the client that fetches the catalogue most often. It currently
receives every playbook to render a list of names.

### skill-fetch-docs
**scope:** `docs/skills.md`
**expects:** documents the metadata-first contract, the ETag flow, and the measured before/after token cost; no stale reference to the list endpoint returning bodies
**model:** sonnet

Rewrite the fetching section of the skills documentation to describe the new
contract: a list returns descriptions and hashes, a body is fetched only when
someone opens it, and an unchanged catalogue costs a 304 rather than a payload.

State the measured numbers — 330 KB and roughly 82,000 tokens before, under 2,000
after — because the next person to add a field to the list response needs to know
what it costs.

## Phase 3 — Skills that know each other

### skill-graph-fields
**scope:** `src/skills/catalog.ts`, `test/skill-graph.test.ts`
**expects:** `requires` and `works-with` parsed from SKILL.md frontmatter into `SkillDef`; both default to empty arrays when absent; a cycle between two skills does not hang or crash the resolver; `resolveRequires(id)` returns the transitive set including the root exactly once; unknown names are reported, not thrown
**principles:** no version ranges and no dependency solver — a name means "the current version of that skill"; unknown names are a warning, never a hard failure, because a skill referencing a skill the user has not imported must still install
**model:** sonnet

Design in `../baton-vault/docs/features/skill-graph.md`. Two relations only.

`requires` means this skill's text points at another by name, so installing
without it leaves an instruction referring to nothing. `works-with` is a
suggestion and is never installed automatically.

### skill-mentions-check
**after:** skill-graph-fields
**scope:** `src/skills/lint.ts`, `test/skill-mentions.test.ts`
**expects:** given a skill body and the set of known skill ids, returns every id mentioned in the body that is absent from `requires`; does not flag a mention inside a fenced code block; does not flag the skill's own id; pure function with no filesystem or network access
**principles:** a regex over known ids — no LLM, no network, no heuristics beyond word-boundary matching
**model:** sonnet

Most authors will never declare `requires`. This finds the case that actually
matters — a skill telling an agent to follow a skill that is not installed —
which today fails silently and produces worse agent behaviour with no error.

### skill-suggest-mcp
**after:** skill-graph-fields
**scope:** `src/mcp.ts`, `test/mcp-suggest.test.ts`
**expects:** a `suggest_skills` MCP tool taking a task string and returning ranked summaries; ranking is attached-to-project, then missing `requires` of installed skills, then description text match, then declared `works-with`, then already-installed demoted to last; returns summaries only, never bodies; result capped at 5
**principles:** no LLM call and no embedding — ranking is text match plus joins over data Baton already holds; the tool response must stay under 1k tokens
**model:** sonnet

The payoff for the whole plan: an agent asks for what it needs and receives five
one-line descriptions instead of twelve full playbooks.
