# Stacks — preflight, verified commands, per-stack notes

Commands verified against official documentation. Where a fact could not be verified it is
marked ⚠ — confirm with `--help` before relying on it.

## Preflight

Check first; report **every** missing tool at once with the exact fix.

| Need | Required for | Minimum | Check | Install |
|---|---|---|---|---|
| git | everything | 2.28+ (2.54+ enables config-based hooks) | `git --version` | xcode-select / apt / git-scm.com |
| Node | Next.js, Vite, Nuxt, Nest, Express | **20.19+ or 22.12+** (Vite); **22+** (Nuxt) | `node --version` | nodejs.org LTS or nvm |
| Python | Django, FastAPI | **3.12+** (Django 6.x) | `python3 --version` | python.org or pyenv |
| gitleaks | the secret hook | any current | `gitleaks version` | `brew install gitleaks`, release binary, or `ghcr.io/gitleaks/gitleaks` |
| gh | push protection check | any | `gh auth status` | cli.github.com — optional |

A missing runtime blocks scaffolding. A missing **gitleaks does not block scaffolding**, but the
hook will refuse commits until it is installed, and the final report must say the project is not
yet protected.

---

## Next.js — verified

Docs version 16.3.0. `create-next-app` reference.

```bash
npx create-next-app@latest <name> \
  --typescript --app --src-dir --tailwind --eslint \
  --import-alias "@/*" --reset-preferences
```

**Never use `--yes`.** It means "use previous preferences or defaults", and those preferences are
stored per machine — the same command then produces different projects on different laptops.
Always pass flags explicitly and add `--reset-preferences`.

**Add `--disable-git` when a git repo already exists.** `create-next-app` runs `git init` by
default; inside an existing repo that creates a nested repository which silently swallows every
new file. (NestJS: `--skip-git`.)

Verified flags: `--ts`/`--typescript` (default) · `--js` · `--tailwind` (default) ·
`--eslint` | `--biome` | `--no-linter` · `--react-compiler` · `--app` · `--api` (route handlers
only) · `--src-dir` · `--turbopack` (default) | `--webpack` · `--import-alias` · `--empty` ·
`--use-npm`/`--use-pnpm`/`--use-yarn`/`--use-bun` · `--skip-install` · `--disable-git` ·
`--agents-md` (default) · `--reset-preferences` · `--yes`.

**`--agents-md` is on by default and generates `AGENTS.md` *and* `CLAUDE.md`.** Append your
structure rules to those files — never overwrite them.

Tailwind: v4 is the default. Only drop to v3 for broader browser support, per the official
"Tailwind CSS v3" guide (`npm install -D tailwindcss@^3 postcss autoprefixer && npx tailwindcss init -p`).

Structure delta to add after scaffolding (feature-modular):

```
src/features/<domain>/{ui,api,model}/   src/shared/{components,lib,types,config}/
```

## React + Vite — verified

```bash
npm create vite@latest <name> -- --template react-ts
```

Node **20.19+ or 22.12+**. Templates include `vanilla(-ts)`, `react(-ts)`, `react-compiler(-ts)`,
`vue(-ts)`, `preact`, `lit`, `svelte`, `solid`, `qwik`.

Vite ships no router, state, or lint config beyond basics — this is where the structure delta
matters most. Use `feature-modular`, or `feature-sliced` for a growing team app.

## Nuxt — verified

```bash
npm create nuxt@latest <name>
```

Node **22.x or newer**, even-numbered releases recommended. Dev server: `npm run dev -- -o`.

⚠ Nuxt's directory conventions (`app/` vs root-level `pages/`, `components/`) shift between
major versions — read the created project's structure before adding folders, and follow what the
scaffolder produced rather than assuming.

## NestJS — ⚠ partially verified

```bash
npx @nestjs/cli new <name> --strict --package-manager npm
```

Flags: `--skip-git` (`-g`), `--skip-install` (`-s`), `--package-manager` (`-p`: npm|yarn|pnpm),
`--strict`. `--strict` enables `strictNullChecks`, `noImplicitAny`, `strictBindCallApply`,
`forceConsistentCasingInFileNames`, `noFallthroughCasesInSwitch`.

⚠ These came from the nest-cli source and docs mirrors — `docs.nestjs.com` renders client-side
and could not be read directly. **Run `npx @nestjs/cli new --help` and confirm before relying on
any flag.** Always recommend `--strict`: it is the difference between TypeScript helping and
TypeScript decorating.

Nest generates `layered-mvc` and enforces modules already. Add one module per business area
(`nest g module billing`), never a single `core` module that grows forever.

## Django — verified

Django 6.1 requires **Python 3.12+**.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install django
django-admin startproject config .        # note the trailing dot
python manage.py startapp accounts
```

**Use the two-argument form** (`startproject config .`). The default single-argument form creates
the confusing `mysite/mysite/` double nesting that beginners never recover from. The outer
directory name is irrelevant to Django; the inner package name is what imports use.

Follow `cookiecutter-django` conventions for anything beyond the default:

```
config/settings/{base,local,production}.py     requirements/{base,local,production}.txt
```

One app per business area. Never one app called `core` holding everything.

## FastAPI — ⚠ no official scaffolder

FastAPI has **no** scaffolding CLI. Create the layout by hand.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install "fastapi[standard]" sqlalchemy alembic
```

Official docs layout (Bigger Applications): `app/main.py`, `app/dependencies.py`,
`app/routers/*.py`, `app/internal/`, with an `APIRouter` per module.

For anything with more than one domain, prefer the domain-module layout from the FastAPI
best-practices guide (Netflix Dispatch lineage) — it is `feature-modular`:

```
src/
  auth/    router.py schemas.py models.py service.py dependencies.py constants.py exceptions.py
  posts/   router.py schemas.py models.py service.py dependencies.py exceptions.py
  config.py database.py pagination.py main.py
tests/  alembic/  requirements/
```

Key practices to apply while scaffolding: async routes for I/O; never block the event loop;
split `BaseSettings` per module rather than one global config; set up the async test client from
the start; Ruff for lint+format; Alembic from the first migration.

**Because this layout is hand-written, it can drift from upstream.** Re-check the official docs
when this pack is next touched.

## Express — ⚠ no suitable scaffolder

`express-generator` is not deprecated but emits server-rendered, dated patterns — not a modern
API baseline. Create by hand.

```bash
npm init -y
npm install express
npm install -D typescript tsx @types/express @types/node vitest
npx tsc --init
```

Use the component structure from Node.js Best Practices — business components, plus `libraries/`
for cross-cutting concerns:

```
src/
  components/
    orders/    { orders.routes.ts, orders.service.ts, orders.model.ts, orders.test.ts }
    users/
  libraries/   logger/ authenticator/
  server.ts
```

Explicitly avoid top-level `controllers/ services/ models/` — Node.js Best Practices names it as
the anti-pattern that creates spaghetti dependencies.

---

## Adding a stack that is not listed

The security phases, the pattern ladder, verification, and the docs are all stack-independent.
To add Rails, Spring, Laravel, Flask, SvelteKit or anything else:

1. Add a row to the vocabulary map in `references/patterns.md`.
2. Add a section here with: the official scaffold command (or "none — hand-rolled, source: …"),
   the minimum runtime version, and the structure delta.
3. Add the derivation row in `references/interview.md`.

No change to `SKILL.md` is required. That is the design.
