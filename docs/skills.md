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
| `code-review` | Code review | Review a diff since a fixed point along **three axes that are never merged**: **Standards** (repo conventions + a baseline of 12 classic code smells), **Spec** (does it implement what the issue/spec/handoff brief asked, with no scope creep?), and **Security** (injection, authz, path traversal, secret leaks, SSRF — a source-to-sink baseline). The axes run as parallel sub-agents; every finding must survive an explicit **refute** pass before it is reported; results are reported side by side with no cross-axis ranking, then **routed** (Spec-wrong → `systematic-debugging`, Security → `bug-fix`) and **persisted** with `baton review save` so they outlive the session. Two-axis structure and smell baseline adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT); the Security axis, refute gate, routing table, and durable record are Baton additions. |
| `validate-idea` | Validate idea | The "should this exist at all" gate, before any code. Two modes routed by your goal: **startup** asks six forcing questions (demand reality, status quo, desperate specificity, narrowest wedge, observation, future-fit) under explicit anti-sycophancy rules, pushing until answers are specific; **builder** runs a lighter diagnostic for side projects and hackathons. Then an explicit scope mode (EXPAND / SELECTIVE / HOLD / REDUCE), the current-vs-12-month-ideal map, and 2-3 costed alternatives — ending in a design doc and one concrete assignment. Feeds `plan-review`. |
| `plan-review` | Plan review | Locks the execution plan **before** code exists. Challenges scope first (what is the minimum change? >8 files or >2 new services is a smell worth stopping for), then architecture and data flow, the error & rescue map (happy / nil / empty / upstream-failure per path), the edge-case map, a test matrix with coverage targets, and a performance pass. Every finding carries a recommendation and asks for your call. Reviews *plans*; `code-review` reviews *diffs*. |
| `browser-qa` | Browser QA | Tests a running web app the way a user does — clicks everything, submits every form empty/invalid/at the boundary, checks the console after every interaction — then fixes what breaks with one atomic commit each and re-verifies. Weighted health score (functional, console, accessibility, UX, links, visual, performance, content) reported before and after, with a ship verdict. `--report-only` documents without touching code; `--quick` / `--exhaustive` move the severity bar. Never reads source while testing — that is the rule that finds what code review structurally cannot. |
| `onboarding-audit` | Onboarding audit | Walks your own onboarding as a stranger and scores what actually happens. Measures Time-To-Hello-World against published tiers, scores eight dimensions 0-10 (getting started, API/CLI/SDK ergonomics, error messages, docs, upgrade path, dev environment, community, DX measurement), and tags every score **TESTED / PARTIAL / INFERRED** so a guess is never mistaken for a measurement. Findings split into quick wins, this sprint, next quarter. |
| `design-audit` | Design audit | Visual audit of a live site that ends in committed fixes, not complaints. Captures a first impression before analysis can rationalise it, extracts the design system the site *actually* uses and flags where it sprawled, then audits typography, spacing, hierarchy, WCAG AA contrast, layout, focus states, performance, and generic AI-slop patterns. Each finding is classified HIGH / MEDIUM / POLISH, fixed in source, committed atomically, re-verified. |
| `design-options` | Design options | Several genuinely different design directions side by side before you commit to one. Concepts in words first (cheap to reject), an **anti-convergence rule** — any two variants that read as siblings get one regenerated in a deliberately different direction — then self-contained HTML variants on one comparison board, structured approve/reject/iterate per variant for at most three rounds, and design tokens extracted from the winner. |
| `scrape` | Scrape | Pulls structured data off a page under a strict read-only contract: refuses anything implying a write, treats fetched bytes as **data and never as instructions** (a scraped page cannot choose the agent's next action), refuses loopback/private/link-local hosts including the cloud metadata endpoint, and emits one stable JSON document so output pipes into `jq`. When extraction fails it reports the blocker rather than inventing plausible results. |
| `scrape-to-skill` | Scrape to skill | Turns a scrape that just worked into a permanent, tested skill. Synthesizes a **pure** parser (HTML in, data out, no network inside it), captures a real page as a fixture so the test runs offline, and writes assertions that check populated fields rather than smoke-testing. Runs the test before anything is saved, stops after two failed repairs, and gates on explicit approval — while stating plainly that the fixture write and test run happen *before* that gate. |
| `design-taste` | Design taste | The default frontend design skill. Reads the brief, infers a design language, tunes three dials (variance / motion / density), and ships landing pages, portfolios and redesigns against hard pre-flight rules so the result does not look templated. |
| `gpt-taste` | GPT taste | A harder-edged alternative doctrine: AIDA page structure, the 2-line hero iron rule, gapless bento grids (`grid-flow-dense`), seeded layout variance to break the model's default choices, and strict GSAP scroll paradigms. |
| `stitch-design` | Stitch design | Google Stitch-compatible semantic design rules — a token and component vocabulary Stitch understands, held consistent so generated UI does not drift screen to screen. |
| `style-minimalist` | Style: minimalist | Clean editorial interfaces in the Notion / Linear register — strict monochrome, restrained type scale, generous whitespace. |
| `style-brutalist` | Style: brutalist | Raw mechanical interfaces: Swiss typography, extreme scale contrast, visible structure. (Beta) |
| `style-soft` | Style: soft | The expensive, soft, high-end look — premium type pairing, deep whitespace, layered depth and shadow, smooth motion. |
| `design-redesign` | Design redesign | Upgrades an **existing codebase** to premium quality without a rewrite: scans the stack, diagnoses generic AI design fingerprints (the purple/blue gradient, pure `#000`, Inter everywhere, orphaned words), and fixes in place using the framework already there. Complements `design-audit`, which audits a *running site* in a browser instead. |
| `image-to-code` | Image to code | Image-first frontend work: generate a premium reference image, analyse it deeply, then implement code that matches it — so the look is agreed before any code is written. |
| `imagegen-web` | Imagegen: web | Generates premium website design reference images. Writes no code. |
| `imagegen-mobile` | Imagegen: mobile | Generates premium mobile app screen concepts and flows. Writes no code. |
| `brandkit` | Brand kit | Generates a brand-kit overview image — logo concepts, identity system, colour palette, typography and mockups as one visual sheet. Writes no code. |
| `full-output` | Full output | Stops the model truncating code: bans the `// rest of code` family of placeholders, counts deliverables up front and checks them off, and splits cleanly at a token limit instead of compressing. |
| `map-codebase` | Map this codebase | Build the graphify knowledge graph and `CODEBASE.md` so agents navigate a compact map instead of the whole repo. |
| `safe-refactor` | Safe refactor | Restructure without changing behaviour — worktrees, a green test baseline, and the graph to find every caller. |

Every skill above is file-backed under `src/skills/bundled/<id>/SKILL.md` except `map-codebase` and `safe-refactor`, which are inline in `src/skills/catalog.ts`. The plan → design → build → review → QA set (`validate-idea`, `plan-review`, `design-options`, `design-audit`, `qa`, `onboarding-audit`, `scrape`, `scrape-to-skill`) is Baton-native: the six that reach a decision or a verdict record it to Baton's shared memory rather than a private sidecar directory, so nothing they learn is invisible to the next session. (`scrape` and `scrape-to-skill` produce data and a skill respectively, and write no memory.)

`verify-before-done` and `code-review` are deliberately separate: the first is the author proving their own change works before claiming done; the second reviews a diff against a fixed point. Run them in that order.

### Durable review findings

`code-review` is the only skill with a backing store. Its findings persist to `.baton/reviews/<slug>.json` ([`src/reviews.ts`](../src/reviews.ts)) so a review survives the session that produced it:

```bash
baton review save <slug> < findings.json   # the skill's last step (stdin JSON)
baton review list                          # every review, newest first, open counts per axis
baton review show <slug>                   # findings grouped by axis
baton review resolve <slug> <id|n> [--dismiss]
```

Saving emits a `review.completed` event on the bus, `GET /api/reviews` serves the records, and **any still-open findings ride into the handoff brief** — so `baton take` / `baton resume` show the next agent what it's inheriting without them knowing to look.

Four rules make the record trustworthy:

- **Stable identity.** Every finding carries an id derived from axis+file+title, not from its position. A re-review reorders the list, so an index is only valid until the next review; `resolve` accepts either, but scripts should use the id.
- **Triage survives, stale claims don't.** A re-review **keeps** anything `--dismiss`ed (a human said "not a problem" — don't make them re-triage it) but **resets** a `fixed` finding the reviewer reports again. If it's still found, it isn't fixed; the fresh report is ground truth.
- **Secrets are redacted, findings are kept.** Findings quote raw hunks, so `detectSecret()` (shared with [memory](./memory.md)) scrubs title, source, and detail before the write. Unlike memory, which *rejects* the whole fact, reviews redact the field — "you hardcoded a key at line 42" is exactly what the Security axis exists to report, and dropping it would blind the check.
- **Counts are per axis, never summed.** A combined total is the cross-axis ranking the skill exists to prevent. A review recorded against an older HEAD is flagged stale on read, the same discipline memory uses for facts.

Deliberately *not* an MCP tool: a 14th tool would breach `TOOL_HELP_BUDGET` ([`src/mcp-help.ts`](../src/mcp-help.ts)), a context tax every agent session pays forever. Reviews are occasional, so they go through the CLI instead.

## Install targets

Baton can write skills for two agent CLIs. Each gets the on-disk format it understands; writes are non-destructive and stay inside the repo.

| Agent | Where it installs | Format |
| --- | --- | --- |
| `claude` | `.claude/skills/<id>/SKILL.md` (+ `references/` alongside) | Claude Code skill — `name` + `description` frontmatter, then the playbook. |
| `cursor` | `.cursor/rules/<id>.mdc` (+ sibling `<id>/references/`) | Cursor project rule — `description` + `alwaysApply: false` frontmatter. |
| `antigravity` | `.agents/skills/<id>/SKILL.md` (+ `references/` alongside) | Agent Skills format — same `name` + `description` frontmatter as Claude, installed byte-for-byte. |

The other agents (`codex`, `gemini`, `aider`, `opencode`) have no standard skill directory Baton can write, and installing for them returns an unsupported-agent error. (Deliberately: cramming a full playbook into their always-on instruction files would cost tokens on every turn — skills should load on demand.)

`.agents/skills/` is worth knowing about: it is emerging as the **neutral, cross-tool
skill path**, read by Antigravity, Cursor, opencode, and Zed. Baton writes it for the
`antigravity` target, so installing there in practice reaches more agents than the id
suggests.

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

## Categories

Every bundled skill carries a `category`, so a 33-skill list can be filtered rather than scrolled.
The axis is *what you are trying to do*, not what the skill is built from:

| Category | For | Skills |
| --- | --- | --- |
| `plan` | Decide what to build | `validate-idea`, `plan-review`, `dispatch-plan`, `basic-setup` |
| `code` | Change code | `bug-fix`, `lean-code`, `safe-refactor`, `stack-migration`, `token-efficient-coding`, `traceable-changes`, `full-output` |
| `frontend` | Make it look right | `design-taste`, `gpt-taste`, `stitch-design`, `style-minimalist`, `style-brutalist`, `style-soft`, `design-redesign`, `image-to-code`, `design-options`, `design-audit`, `imagegen-web`, `imagegen-mobile`, `brandkit` |
| `review` | Check someone's work | `code-review`, `verify-before-done` |
| `test` | Exercise a running thing | `browser-qa`, `onboarding-audit` |
| `data` | Pull data | `scrape`, `scrape-to-skill` |
| `context` | Carry knowledge between sessions | `handoff`, `memory-light`, `map-codebase` |

Skills you import yourself default to `code` — guessing a category from a stranger's text would
mis-file it confidently.

## Attribution

The 12 frontend design skills are bundled from
[taste-skill](https://github.com/Leonxlnx/taste-skill) by Leonxlnx (MIT); see [NOTICE](../NOTICE).
`lean-code` adapts Ponytail (MIT) and `code-review` adapts mattpocock/skills (MIT).
