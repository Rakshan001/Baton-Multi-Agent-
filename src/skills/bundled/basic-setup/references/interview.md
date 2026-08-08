# The interview

**One question per message. Recommendation is always option 1, always marked, always with a
reason.** A user who answers "1" every time must land a correct, professional project.

Never ask about technology. Ask about the project, and derive the technology.

| Ask this | Never ask this |
|---|---|
| "Will other people work on this?" | "Do you want a monorepo?" |
| "Does it need to remember things between visits?" | "Which ORM?" |
| "Will people log in?" | "NextAuth or Lucia?" |
| "Does it need to work on old browsers?" | "Tailwind v3 or v4?" |

## Q1 — What are you building?

```
What are you building?

  1. A website or web app people visit in a browser   ← most common
  2. An API or backend service other programs call
  3. Both — a site with its own backend
  4. Something else (tell me in your own words)
```

## Q2 — Language / ecosystem preference

Ask only if Q1 leaves it open. If the user has no opinion, recommend JavaScript/TypeScript for 1
and 3, and let Q1 + Q2 pick between Python and Node for 2.

```
Do you have a language preference?

  1. No preference — pick the standard one for me   ← RECOMMENDED
  2. JavaScript / TypeScript
  3. Python
```

## Q3 — Who works on it?

```
Will other people work on this project?

  1. Just me for now       ← RECOMMENDED: simplest layout, easy to grow later
  2. A small team (2-5)       feature folders so you don't collide
  3. A larger team            stricter boundaries between areas
```

## Q4 — Does it need to remember things?

```
Does it need to remember things between visits — users, posts, orders?

  1. Yes, it needs a database    ← RECOMMENDED if people log in or save anything
  2. No, it just shows content
  3. Not sure yet                 I'll leave room for one without setting it up
```

## Q5 — How sensitive is the data?

This is the question that escalates security. Ask it plainly.

```
Will it handle anything sensitive?

  1. Just normal app data          ← still gets full secret protection
  2. Payments or financial data       strict rules + CI enforcement required
  3. Health, ID, or personal records  strict rules + CI enforcement required
  4. Nothing real yet — learning      protection still installed; habits form now
```

## Q6 — Where will it run? (ask only if Q1 = 1 or 3)

```
Where will this run when it's finished?

  1. I don't know yet          ← RECOMMENDED: I'll keep every option open
  2. Vercel / Netlify             zero-config for Next.js
  3. My own server (Docker)       more control, you manage it
```

Ask **at most 6 questions.** If the user gives everything up front, skip to the summary.

---

# Derivation tables

## Answers → stack

| Q1 | Q2 | Stack |
|---|---|---|
| website/app | JS/TS or none | **Next.js** (App Router) |
| website/app | Python | **Django** |
| website/app, no backend needed, SPA | JS/TS | **React + Vite** |
| website/app, Vue preferred | JS/TS | **Nuxt** |
| API only | Python or none | **FastAPI** |
| API only | JS/TS | **NestJS** (team) / **Express** (solo) |
| both | JS/TS | **Next.js** (route handlers cover the API) |
| both | Python | **Django** (+ DRF) or **FastAPI** + separate frontend |

## Answers → structure pattern

| Signals | Pattern |
|---|---|
| solo + one domain + small | `flat` |
| Django / NestJS chosen | `layered-mvc` + feature folders inside |
| **anything else** | `feature-modular` ← the default |
| frontend + team + "will keep growing" | `feature-sliced` |
| team + 3+ domains + one deploy | `modular-monolith` |
| "rules must outlive the framework" | `clean-hexagonal` |
| user insists after the warning | `microservices` |

## Answers → database and data layer

| Q4 | Stack | Choice |
|---|---|---|
| yes | Next.js / Node | **Postgres + Prisma** — best errors and docs for a beginner |
| yes | Django | **Postgres + Django ORM** — built in, do not add another |
| yes | FastAPI | **Postgres + SQLAlchemy 2.0 + Alembic** — Alembic from day one, not later |
| yes | NestJS | **Postgres + Prisma** (or TypeORM if the team already uses it) |
| not sure | any | no ORM installed; `DATABASE_URL` reserved in `.env.example`, folder left ready |
| no | any | none — do not install a database "just in case" |

Always Postgres unless the user says otherwise: SQLite differs from production in ways that bite
beginners late, and "it worked locally" is the failure mode this skill exists to prevent.

## Answers → auth

| Situation | Choice |
|---|---|
| logins + Next.js | **Auth.js (NextAuth v5)** — the ecosystem default |
| logins + Django | **built-in `django.contrib.auth`** — never hand-roll |
| logins + FastAPI | **fastapi-users**, or OAuth2 password flow from the official docs |
| logins + NestJS | **`@nestjs/passport` + JWT** — the documented path |
| logins + external provider preferred | Clerk / Auth0 — fastest, costs money at scale |
| no logins | none — do not scaffold auth |

**Never write custom password hashing, session handling, or token signing.** Say so out loud if
the user proposes it; it is the highest-severity beginner mistake after leaking keys.

## Answers → testing

| Stack | Runner | Scaffold |
|---|---|---|
| Next.js / React / Vite / Nuxt | **Vitest** | one passing example test |
| NestJS | **Jest** | already generated by `nest new` |
| Express | **Vitest** | one passing example test |
| Django | **pytest + pytest-django** | one passing example test |
| FastAPI | **pytest + httpx AsyncClient** | async client configured from the start |

One real passing test, not a suite. Its job is to prove the runner works and give the next
person a template to copy.

## Answers → linting and formatting

| Stack | Choice |
|---|---|
| Next.js | ESLint (default) — Biome only if the user asks for speed |
| React / Vite / Nuxt / Express | ESLint + Prettier |
| NestJS | ESLint + Prettier (generated) |
| Django / FastAPI | **Ruff** (lint + format, replaces black + flake8 + isort) |

## Answers → security level

| Q5 | Level | What changes |
|---|---|---|
| 1 or 4 | **standard** | all four layers installed; CI advisory |
| 2 or 3 | **strict** | + CI required to merge, + branch protection recommended, + extra `.gitleaks.toml` rules for payment/PII-shaped tokens, + explicit note that this data has legal reporting duties if leaked |

Security is never *reduced*. Option 4 ("just learning") gets the same protection — habits formed
on a learning project are the habits taken to a real one.

## Answers → Tailwind version (Next.js/React/Nuxt)

Never ask "v3 or v4". Ask:

```
Does this need to work on older browsers (company laptops, older phones)?

  1. No, normal modern browsers   ← RECOMMENDED → Tailwind v4, the current default
  2. Yes, older browsers too         → Tailwind v3 (broader browser support)
```

---

## The confirmation summary

Show one block, every line with its reason, then stop and wait.

```
Here's what I'll set up — change any line, or say "go".

  Framework      Next.js 16 (App Router)     a web app with pages
  Language       TypeScript                  catches typos before they run
  Structure      feature-modular             auth + billing are separate areas
  Database       Postgres + Prisma           you need to save users
  Auth           Auth.js                     people will log in
  Styling        Tailwind v4                 current default
  Tests          Vitest + one example
  Secrets        hook + push protection + CI  payments data → strict
  Docs           STRUCTURE.md + AGENTS.md    so this stays clean

⛔ Nothing is written until you reply.
```
