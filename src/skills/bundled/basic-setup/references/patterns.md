# Structure patterns — the ladder

Four independent industry references (Feature-Sliced Design, bulletproof-react, the FastAPI
best-practices guide, and Node.js Best Practices) converge on the same two laws. Everything in
this file is an application of them.

```
LAW 1  A folder is a BUSINESS THING (auth, billing, orders),
       not a TECHNICAL THING (controllers, services, models).

LAW 2  Imports flow ONE direction:   shared → features → app
       Features NEVER import from each other.
```

Node.js Best Practices names `controllers/ services/ models/` as *the* anti-pattern by name: it
"creates spaghetti dependencies" because every business change touches every folder.

## The ladder — recommend the LOWEST rung that fits

Complexity is a cost the user pays forever. Climb only when there is a reason to.

| Rung | Pattern | Recommend when | Do NOT use when |
|---|---|---|---|
| 1 | `flat` | solo, one domain, under ~10 source files | 2+ people, or a second domain appears |
| 2 | `layered-mvc` | the framework already imposes it (Django, Rails, Nest) | a JS frontend — use rung 3 or 4 |
| 3 | `feature-modular` | **the default for most projects** | truly single-domain toy |
| 4 | `feature-sliced` | frontend, team, UI that keeps growing | backend services |
| 5 | `clean-hexagonal` | business rules must outlive the framework/DB | plain CRUD |
| 6 | `modular-monolith` | team, several domains, still one deploy | solo project |
| 7 | `microservices` | separate teams **and** separate deploy cycles, already proven | greenfield — effectively always |

### Choosing from interview answers

```
one domain + solo + small                        → 1  flat
Django / Rails / NestJS (framework-imposed)      → 2  layered-mvc  (+ feature folders inside)
anything else, default                           → 3  feature-modular
frontend + team + "app will keep growing"        → 4  feature-sliced
"rules must survive a DB/framework change"       → 5  clean-hexagonal
team + 3+ domains + one deployment               → 6  modular-monolith
user explicitly demands microservices            → 7  ONLY after the conversation below
```

### The microservices conversation (required before rung 7)

Never scaffold microservices for a greenfield project just because the user asked. Say this:

> Microservices split one deployment into many. That buys independent scaling and independent
> team deploys — and it costs you network calls between things that used to be function calls,
> distributed debugging, and data consistency across services. Almost every successful
> microservices system started as a monolith that was split *after* the boundaries were proven.
>
> A modular monolith (rung 6) gives you the same clean boundaries, in one deployable. When a
> module genuinely needs its own scaling or its own team, you lift that folder out — the
> structure is already correct for it.
>
> Start at rung 6? [1. Yes, recommended] [2. No, I need microservices — here's why: ___]

If they still choose 7, proceed without further argument and note the decision in `STRUCTURE.md`.

---

## 1. flat

Solo, one thing, small. Real and legitimate — do not over-build a script.

```
src/
  index.ts          entry point
  lib/              helpers you reuse
  routes/ or pages/ whatever the framework needs
tests/
```

**Upgrade to rung 3 when:** a second person joins, or you catch yourself prefixing filenames
(`auth-utils.ts`, `billing-utils.ts`) — that prefix is a folder asking to exist.

## 2. layered-mvc

The framework already dictates it. Don't fight it — but add feature grouping *inside*.

```
Django                              NestJS
  config/settings/{base,local,       src/
    production}.py                     auth/    → controller, service, module, dto
  apps/                                billing/ → controller, service, module, dto
    accounts/  models, views,          common/  → guards, filters, pipes
      urls, services, tests          main.ts
    billing/
  manage.py
```

The trap: a single app called `core` or `main` that grows to hold everything. One app per
business area. `cookiecutter-django` is the reference layout — `config/settings/` split by
environment, `requirements/{base,local,production}.txt`.

**Upgrade to rung 6 when:** apps import each other's internals freely.

## 3. feature-modular — the default

Each feature owns its full vertical slice. Sources: Node.js Best Practices (components +
`libraries/`), FastAPI best practices (Netflix Dispatch lineage), bulletproof-react.

```
src/
  features/
    auth/        ui/ api/ model/ lib/    ← everything auth needs, together
    billing/     ui/ api/ model/ lib/
  shared/        components/ lib/ types/ config/
  app/           entry, routing, providers
tests/
```

Backend (FastAPI form, per the best-practices guide):

```
src/
  auth/     router.py schemas.py models.py service.py dependencies.py exceptions.py
  posts/    router.py schemas.py models.py service.py dependencies.py exceptions.py
  config.py database.py main.py
```

**Rules:** no cross-feature imports — compose at the app layer. No barrel files (`index.ts`
re-exports) — bulletproof-react documents that they break Vite tree-shaking.

## 4. feature-sliced (FSD)

The formal frontend standard — [feature-sliced.design](https://feature-sliced.design). Layers,
then slices (business domains), then segments (technical purpose).

```
src/
  app/        entrypoint, routing, providers, global styles
  pages/      full pages
  widgets/    large self-contained UI blocks
  features/   reusable product features
  entities/   business objects (user, product)
  shared/     project-agnostic reusable code
```

Layers top→bottom: `app · pages · widgets · features · entities · shared`
(`processes` is deprecated — do not create it).

**The import rule:** a layer may import only from layers **strictly below** it. Slices on the
same layer may **not** import each other. Segments inside a slice are `ui/ api/ model/ lib/ config/`.

Framework-agnostic — no restriction on language, UI framework, or state manager.

## 5. clean-hexagonal (ports & adapters)

Business logic in the centre, framework and database at the edges, talking through interfaces.

```
src/
  domain/         entities + business rules — imports NOTHING framework-related
  application/    use cases, orchestration
  ports/          interfaces the domain needs (UserRepository, PaymentGateway)
  adapters/
    inbound/      http controllers, cli, queue consumers
    outbound/     postgres, stripe, s3 — implement the ports
```

**The test that proves it:** you can swap Postgres for MongoDB, or HTTP for a CLI, touching only
`adapters/`. If a change to the database forces an edit in `domain/`, the boundary is wrong.

Cost: more indirection. Worth it when business rules are complex and long-lived; overkill for CRUD.

## 6. modular-monolith

Microservices' boundaries, one deployment. The honest answer for most teams.

```
src/
  modules/
    auth/       api/ domain/ infra/   + a PUBLIC interface file
    billing/    api/ domain/ infra/
    orders/     api/ domain/ infra/
  shared/       cross-cutting only: logging, config, errors
  main.ts       wires the modules together
```

**The one rule that makes it work:** a module may only be reached through its public interface
file. Never import `modules/billing/domain/*` from `modules/orders/`. Enforce with lint import
rules if the team is large.

**Upgrade to rung 7 when:** a specific module provably needs its own scaling or deploy cadence.
Then lift that folder out — it is already shaped like a service.

## 7. microservices

Only after the conversation above.

```
services/
  auth-service/     its own src/, Dockerfile, package/pyproject, tests, CI
  billing-service/
libs/ or packages/
  contracts/        shared API types/schemas — the ONLY shared code
  observability/
infra/              compose / k8s / terraform
```

**Rules:** services never share a database. Services never import each other's source — only
`contracts/`. Every service is independently deployable and independently runnable locally.

---

## Vocabulary map — the same pattern, per stack

This is what lets the skill support any framework. The pattern is universal; only the words change.

| Universal | Next.js / React | FastAPI | Django | NestJS | Express |
|---|---|---|---|---|---|
| entry | `app/` | `main.py` | `config/urls.py` | `main.ts` | `server.ts` |
| route / api | `app/api/*/route.ts` | `router.py` | `views.py` + `urls.py` | `*.controller.ts` | `*.routes.ts` |
| business logic | feature `api/`, `lib/` | `service.py` | `services.py` | `*.service.ts` | `*.service.ts` |
| data shape | `types/` | `schemas.py`, `models.py` | `models.py` | `*.entity.ts`, dto | `*.model.ts` |
| shared | `src/shared`, `src/components` | `src/config.py`, `database.py` | `core/` | `common/` | `lib/` |
| tests | `__tests__/`, `*.test.ts` | `tests/` | `tests.py` | `*.spec.ts` | `*.test.ts` |

**To support a framework not listed:** add a row. The laws, the ladder, and every security phase
are unchanged — that is the whole point of the design.
