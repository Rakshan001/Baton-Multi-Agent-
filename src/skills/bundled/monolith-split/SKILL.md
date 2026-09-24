---
name: monolith-split
description: >-
  Split ONE codebase into a frontend app + one or more separately-deployable backend services
  (e.g. a Next.js monolith → Next.js + NestJS, Next.js + Node/Express/Fastify, Django → Django +
  FastAPI, Rails → Rails + Go) WITHOUT the running app ever breaking. Unlike a stack migration,
  the source app KEEPS RUNNING and keeps its stack — what actually changes is that an in-process
  function call becomes a NETWORK BOUNDARY, which is where every real breakage lives: auth and
  cookies, CORS, JSON serialization drift (Date/Decimal/BigInt/undefined), lost transaction
  atomicity, endpoints that silently lose their authorization check, webhook raw-body signature
  verification, cache revalidation, secrets that must move out of the client bundle, and N+1
  round-trips where a loop used to be. INTERVIEWS the user in plain language with a RECOMMENDED
  option marked on every question — target service stack, monorepo vs two repos, contract source
  of truth, auth model, deployment topology, database ownership — detecting and proposing a fit
  (NestJS / Fastify / Express / FastAPI / Go / Spring) but never assuming; a non-expert can answer
  "1" every time and still land an industry-standard split. Enumerates every SEAM (not just
  endpoints), records a GOLDEN MASTER of real behavior BEFORE anything moves, then works in
  ordered REVERSIBLE CHECKPOINTS — each one a git tag + an env flag + a strangler proxy that keeps
  the ORIGINAL URL working, so any checkpoint reverts in seconds by flipping a flag. Verifies
  parity DIFFERENTIALLY (same fixture, flag off vs flag on) and requires ≥95% skeptic-corroborated
  confidence per checkpoint. Persists the plan, per-unit status, flags, tags and confidence to a
  committed SPLIT.md ledger so a session killed by a usage limit RESUMES at the exact unit days
  later. Commits per checkpoint but NEVER pushes without permission. Use whenever the user says
  "split this codebase", "/monolith-split", "separate the frontend and backend", "extract the
  backend", "move the API out of Next.js", "split Next.js into Next.js and NestJS", "decouple",
  "pull this into its own service", or wants one app to become two deployables. NOT for replacing
  one stack with another (the source app dies) — that is the stack-migration skill.
---

# Monolith Split Skill (portable, checkpointed, reversible)

Split one codebase into an app + extracted service(s) **without the running app ever breaking**.

This is **not** a rewrite and **not** a migration. The app keeps its stack and keeps serving
traffic. The only thing that fundamentally changes is this:

```
BEFORE:  page → getOrders()            ← a function call. Typed. Atomic. Trusted. Instant.
AFTER:   page → HTTP → getOrders()     ← a network boundary. Serialized. Fallible. PUBLIC. Slow.
```

Everything this skill does exists because of that one line. The order is non-negotiable:

```
LEDGER/TRACKER CHECK (is a split already in progress? which checkpoint? resume it) →
INTERVIEW (plain language, RECOMMENDED marked: what moves, target stack, repo layout,
           contract, auth, topology, DB ownership) →
DISCOVER & CLASSIFY (map the codebase; every unit = STAYS / MOVES / SHARED) →
SEAM INVENTORY (every unit AND every boundary hazard: txn, authz, serialization, secrets,
                cache, webhooks, uploads, jobs, N+1) →
GOLDEN MASTER (record real behavior of everything that moves — BEFORE it moves) →
TOPOLOGY + LIBRARY PROPOSAL → ⛔ ASK BEFORE INSTALL ⛔ →
CHECKPOINT PLAN (ordered, each one shippable AND revertable) → write SPLIT.md →
⛔ APPROVE PLAN ⛔ →
CP-0: scaffold + contract + proxy layer + CI  →  PROVE IT IS A NO-OP  →  ROLLBACK DRILL →
┌─ FOR EACH CHECKPOINT (one at a time) ─────────────────────────────────────────┐
│ RE-READ ledger → MOVE this checkpoint's units one by one (proxy keeps the      │
│ ORIGINAL URL alive) → BOUNDARY GATE (authz · txn · serialization · secrets ·   │
│ N+1 · errors · timeouts) → DIFFERENTIAL PARITY (same fixture, flag OFF vs      │
│ flag ON, diff must be empty) → ⛔ CONFIDENCE ≥95% (skeptic-corroborated) ⛔     │
│   <95% → flip the flag OFF (app is instantly healthy again) → fix → re-verify  │
│ → FLAG ON → SMOKE THE ORIGINAL APP → git TAG + COMMIT → tick the ledger        │
└───────────────────────────────────────────────────────────────────────────────┘
→ CUTOVER (clients point at the service directly) → DELETE the proxies + flags →
  REVOKE the app's direct DB access → FINAL SWEEP + full-parity re-run
```

**Golden rules**

0. **RESUMABLE FIRST, RECORD LAST — at UNIT granularity.** Before anything, read `SPLIT.md` at the
   repo root and shared memory to see whether a split is underway and **which units are done** —
   not just which checkpoint. Continue from the first un-moved unit; **never restart**. Tick each
   unit in the ledger **as it lands** and commit incrementally, so an interruption after unit 10 of
   20 resumes at unit 11. `SPLIT.md` is the **single source of truth** for status.
1. ⛔ **THE APP NEVER BREAKS — THAT IS THE WHOLE POINT.** Every checkpoint ends with the original
   app fully working. A unit is only "moved" once the **original URL still serves the same
   response**. If anything is wrong, the recovery is not a debugging session — it is **flipping one
   env flag off**, which restores the in-process path in seconds. Design every step so that flip
   exists.
2. **NOTHING MOVES BEFORE ITS BEHAVIOR IS RECORDED.** Capture the golden master (real
   request→response fixtures, real function input→output) while the monolith still runs. You cannot
   prove parity against a memory.
3. **INVENTORY SEAMS, NOT JUST ENDPOINTS.** An endpoint list is the easy half. The breakage is in
   the seams: transactions, authorization, serialization, secrets, cache invalidation, webhooks,
   uploads, jobs, and call-loops. Enumerate those explicitly or they ship broken.
4. **THE FIRST CHECKPOINT CHANGES NO BEHAVIOR.** CP-0 scaffolds the service, the shared contract,
   the proxy layer and CI — and the app's existing tests must pass **unchanged**. Then **drill the
   rollback** (flip a flag, confirm health) so the safety net is proven, not assumed.
5. ⛔ **EVERY EXTRACTED ENDPOINT RE-AUTHENTICATES AND RE-AUTHORIZES.** A function that was only
   reachable after a page guard becomes an internet-reachable endpoint the moment it moves.
   "The app already checked it" is **not a check**. This is the single most dangerous class of bug
   a split introduces, because nothing fails — it just becomes exploitable.
6. ⛔ **A TRANSACTION MOVES WHOLE OR NOT AT ALL.** Two writes that were atomic in one process are
   not atomic across two HTTP calls. Never split a transaction across the boundary; move the entire
   unit of work into one service endpoint, or leave it where it is.
7. **PARITY IS DIFFERENTIAL, NOT EYEBALLED.** Because the old code still exists behind the flag,
   parity is mechanical: replay the same fixture with the flag **off** and **on**, and diff. An
   empty diff is parity. "It renders" is not.
8. **ONE CHECKPOINT = ONE FLAG = ONE TAG = ONE REVERT LINE.** Every checkpoint records exactly how
   to undo it (flip the flag / `git revert <sha>` / `git reset --hard <tag>`). A checkpoint you
   cannot name the undo for is not a checkpoint.
9. **ASK, DON'T GUESS.** Ambiguous business rule, unclear auth semantics, undocumented behavior →
   **STOP and ask**. Never invent behavior to close a gap. And ⛔ **never install a dependency
   without approval.**
10. **NO NEW N+1 ACROSS THE WIRE.** A loop that called a function 50 times becomes 50 HTTP
    round-trips. Every loop over a moved call must become a batch endpoint before the checkpoint
    passes.
11. **SECRETS MOVE, THEY DO NOT COPY.** A credential used by moved code belongs to the service and
    must be *removed* from the app — and nothing that was client-public (`NEXT_PUBLIC_*` and
    friends) may move server-side without checking who reads it.
12. **COMMIT PER CHECKPOINT (auto), NEVER PUSH WITHOUT PERMISSION.** Ask about push AND PR (and the
    base branch) together, explicitly.
13. **THE INTERVIEW IS PLAIN LANGUAGE, WITH A RECOMMENDED ANSWER.** Never ask "REST or gRPC?"
    without explaining the trade in one line and marking one option **(Recommended)**. Someone who
    has never split a codebase must be able to answer "1" to every question and still land a
    structure an experienced engineer would sign off.

> **Adapt to the project.** This skill is stack-agnostic. Wherever it says "endpoint", "the ORM",
> "the test command", "the flag", or "the proxy", substitute this project's real equivalent — see
> the **Vocabulary map** near the end. Anything marked *(optional)* is skipped if the project lacks
> it; never invent infrastructure that isn't there.

---

## Phase A — Resume check: is a split already in progress? ⛔ DO THIS FIRST ⛔

*Why first: a split is long, multi-session work that usage limits interrupt. Restarting a half-done
split is the most expensive possible mistake — and double-moving a unit corrupts the ledger's
meaning.*

1. **Read the ledger.** Open `SPLIT.md` at the repo root (Appendix A is the template). It tells
   you: what is being extracted and why, the answers to the interview, the checkpoint plan with
   each checkpoint's **status / flag / tag / confidence**, and the **per-unit ticks**. The first
   checkpoint that is not `done` is where you continue.
2. **Is the repo already partly split — with no ledger?** Before assuming a clean start, look for
   an abandoned or half-finished attempt: a second `package.json` / `go.mod` / service folder, a
   `docker-compose` with two app services, an unused `apps/api`, an env var pointing at a service
   URL, a client wrapper nobody calls, or a branch named like a split. If you find one, **STOP and
   surface it** — ask whether to adopt it as CP-0, finish it, or delete it and start clean. Silently
   building a second service beside a forgotten first one is the most expensive way to start.
3. **Ask shared memory** *(if a tracker such as baton is present)* — recall this split's decisions
   and gotchas; check live edit signals so you are not colliding with another session.
4. **Trust the code over the ledger.** Verify that units marked done actually exist in the service
   and that their flags are on. If ledger and code disagree, fix the ledger and say so — never move
   a unit twice.
5. **Check the flag state, not just the file state.** A unit can be *built* but *flagged off*
   (someone rolled it back). `moved + flag on + parity green` is the only definition of done. List
   the current flag values before you continue.
6. **Check for source drift.** The ledger records the **source commit SHA** the inventory was taken
   at. `git log <sha>..HEAD -- <moving paths>`: if anyone changed the monolith's moving code during
   the split, re-open the inventory for those units and add them to the right checkpoint —
   otherwise a feature added last week silently never moves, and the parity gate (checking a stale
   inventory) cannot catch it.
7. **Decision:**
   - Ledger exists with unfinished work → **resume at the first un-moved unit** (jump to Phase I).
   - Ledger exists, all checkpoints `done`, cutover not done → go to Phase J.
   - All done → run the final sweep (Phase K) and stop.
   - No ledger → fresh split → continue to Phase B.

---

## Phase B — The interview (plain language · RECOMMENDED marked · never assume)

*Why: a split hard-codes decisions that are painful to reverse — where the code lives, who owns the
database, how auth crosses the wire. Getting them from the user takes ten minutes; getting them
wrong costs the rest of the project. But the user may not know the vocabulary, so **every question
carries a recommendation and a one-line reason**.*

**How to ask:** one question at a time, in the user's language, with options numbered and the
recommended one marked. In Claude Code use `AskUserQuestion` (recommended option first). If the
user says *"you choose"* / *"whatever you recommend"* → **take the recommended answer, state it,
and record it in the ledger.** Never stall waiting for expertise the user doesn't have.

**Detect first, then confirm.** Read `package.json` / `requirements.txt` / `go.mod` / `Gemfile`,
the ORM config, the auth library, and the deploy config **before** asking, so every question is
pre-filled with what this repo actually is. Say what you detected: *"You're on Next.js 15 app
router with Prisma + NextAuth, deployed on Vercel — so I'd suggest X. Sound right?"*

### B1 — Why are you splitting? *(sets the scope; a wrong "why" splits too much)*
1. **Another client needs the same API** (mobile app, partner, second frontend) — *(common)*
2. **Backend and frontend need to scale or deploy independently**
3. **Separate teams / separate release cadence**
4. **Heavy or long-running work** (jobs, video, ML) is hurting the web app
5. **Something else** — ask them to describe it

⚠️ If the honest answer is *"it feels cleaner"* with no operational driver, **say so plainly**: a
split buys deployment independence at the cost of a network boundary, two deploys, CORS, and
distributed debugging. Offer the cheaper rung first — extract a well-bounded module *inside* the
same app (a `server/` layer with no framework imports) and split later, when a real driver appears.
That module boundary is 90% of the benefit at 10% of the risk, and it makes the eventual split
mechanical. **Recommend it, but if the user still wants the split, build the split** — record the
driver as "structural preference" in the ledger and continue.

### B2 — What moves, and what stays?
- **(Recommended) All server-side data access, business rules, auth issuance, jobs and third-party
  calls move; rendering, routing, layouts, components and client state stay.** This is the boundary
  that survives contact with reality: the app becomes a rendering + session layer, the service owns
  the data.
- **Only a named subsystem moves** (payments, reports, notifications) — everything else stays.
  Good when the driver is #4 (heavy work). Smaller, safer, faster.
- **Custom** — the user lists what moves.

Whatever they choose, restate it as an explicit **STAYS / MOVES / SHARED** rule and put it in the
ledger. It is the tiebreaker for every later decision.

### B3 — Which stack for the extracted service? *(detect → recommend → confirm)*
Never assume. Recommend from what the repo already is:

| What you detected | Recommend | Why (say this out loud) |
|---|---|---|
| TypeScript + an ORM + many endpoints + will grow | **NestJS** *(Recommended)* | Opinionated modules/DI/guards/pipes — structure survives a growing team; maps cleanly onto controllers ↔ your existing routes. |
| TypeScript + small/medium API + wants minimal | **Fastify** | Tiny, fast, schema-first validation; less ceremony than Nest. |
| TypeScript + team already knows it | **Express** | Boring, universally understood; you supply the structure. |
| Python app (Django/Flask) | **FastAPI** | Async, typed via pydantic, generates OpenAPI for free. |
| CPU-bound / high-throughput / streaming | **Go** | Cheap concurrency and memory; worth the language boundary only if the driver is real. |
| JVM shop | **Spring Boot** | Matches the existing operational skill set. |

Ask them to confirm or override, and pin the **major version** and language level. If they say
"whatever's standard" → take the recommendation. Record it.

### B4 — Where does the service live?
1. **(Recommended) Monorepo — `apps/web` + `apps/api` + `packages/contract`**, one lockfile, one CI.
   Shared types are a normal import, so the contract cannot drift. Atomic commits change both sides
   at once — which is exactly what a split needs during the transition.
2. **Same repo, plain subfolder** (`/server`) with its own lockfile — simplest, no workspace tool,
   but the contract must be copied or generated rather than imported.
3. **Two separate repos** — real independence, real cost: every contract change becomes a
   cross-repo PR dance. Recommend only when separate teams/permissions demand it (driver #3).

### B5 — What is the source of truth for the contract?
1. **(Recommended, TypeScript ↔ TypeScript) A shared `packages/contract`** — request/response types
   plus runtime schemas (e.g. zod). The service validates input with it; the app types responses
   with it. One definition, both sides, compile-time drift detection.
2. **(Recommended, cross-language) The service publishes OpenAPI; the app generates its client**
   from it in CI. Drift becomes a failing build instead of a runtime surprise.
3. **Hand-written types on both sides** — fastest today, guaranteed to drift. Only for a tiny,
   short-lived split.

### B6 — How does auth cross the boundary? *(the #1 breakage — ask carefully)*
State what you detected ("cookie session via NextAuth", "JWT in localStorage", "Django session
cookie"), then offer:
1. **(Recommended) The app keeps the browser session; the service trusts a short-lived signed
   token.** The browser still talks to the app's origin, the app mints a short-lived JWT (or
   forwards the verified user id signed with a shared secret) on each service call. The browser
   never holds a service credential, the cookie never changes domain, and there is no CORS.
2. **The service verifies the browser's session directly** (shared session store / shared JWT
   secret). Fewer hops, but both codebases now know the session format, and cookie `Domain` /
   `SameSite` / CORS credentials must all be right or logins break in production only.
3. **A dedicated identity provider** (Auth0/Clerk/Cognito/Keycloak) issues tokens both sides
   verify. Cleanest long-term, biggest change — recommend only if they were already moving that way.

⚠️ Whatever they pick, rule 5 stands: **the service authorizes every request itself.**

### B7 — Deployment topology?
1. **(Recommended) One public origin — the app proxies `/api/*` to the service on a private
   network.** No CORS, no cookie-domain problems, no preflight, and the service is not internet-
   exposed. Costs one hop.
2. **Two public origins** (`app.example.com` + `api.example.com`). Direct browser→service calls,
   but you now own CORS (`credentials`, allow-list, preflight caching) and cookie `Domain`, and the
   service is public — rule 5 becomes existential.
3. **Same host, path-routed by a reverse proxy / ingress** — equivalent to 1 with the routing moved
   into infrastructure. Good when the platform already has an ingress.

### B8 — Who owns the database?
1. **(Recommended) The service owns it exclusively. The app loses direct access at cutover.**
   One writer, one migration history, one place a constraint can be enforced. The transition period
   where both can write is finite and tracked in the ledger.
2. **Both read, only the service writes** — a pragmatic middle step; record an end date or it
   becomes permanent.
3. **Both read and write indefinitely** — ⛔ recommend against and say why: two migration histories
   racing on one schema is how a split corrupts data. If they insist, record it as an accepted risk
   with the specific tables at risk named.

### B9 — Rollout appetite?
1. **(Recommended) Per-unit flags — every moved endpoint can be flipped back individually.** Slower
   to set up, and it is the entire reason this skill can promise the app never breaks.
2. **Per-checkpoint flags** — one flag per checkpoint instead of per unit. Coarser blast radius,
   less bookkeeping. Acceptable for small splits.
3. **No flags, revert by git** — only for a pre-production app with no users. Say that plainly.

**Write every answer into `SPLIT.md` §Decisions before writing any code.** Later phases read them
instead of re-asking, and the next session inherits them.

---

## Phase C — Discover & classify (every unit is STAYS, MOVES, or SHARED)

*Why: "split the backend out" is unmeasurable. "These 84 data functions and 37 routes move, these
120 components stay, these 9 types are shared" is a checklist you can drive to 100%.*

1. **Read the map, not the whole repo.** Use the knowledge graph / repo map *(`CODEBASE.md`, a
   generated graph, or the project's own overview)* for structure, entry points and dependency
   edges. No map → build a cheap one from the router config, the ORM schema, and the entry files.
2. **Classify every server-side unit into exactly one bucket:**
   - **MOVES** — data access, business rules, external API calls, auth issuance, jobs, anything
     that touches a secret.
   - **STAYS** — rendering, routing, layouts, components, client state, presentation-only helpers.
   - **SHARED** — types, DTO schemas, validation rules, constants, pure utils used by both sides.
     These become the contract package (B5). Keep this set **small and dependency-free**: a shared
     package that imports the ORM is not shared, it is the service leaking into the app.
3. **Find every call site that crosses the future boundary.** For each MOVES unit, list every
   STAYS caller — these are exactly the places a proxy or a client call must appear, and the places
   an N+1 can hide. Grep the symbol *as a string* too, not just as a call: dynamic dispatch,
   `obj[name]()`, string route paths and response field names are invisible to a static graph.
4. **Flag the "accidentally shared" units** — a helper used by both a React component and a data
   function. It must either become genuinely shared (pure, no I/O) or be **duplicated
   deliberately**, once, with a comment saying why. Do not let the contract package become a dumping
   ground; that is how two services end up recoupled.
5. **Record the source commit SHA** (`git rev-parse HEAD`) in the ledger — the inventory is taken
   against this snapshot and Phase A step 5 drift-checks against it.

---

## Phase D — Seam inventory ⛔ THE PHASE THAT PREVENTS THE OUTAGES ⛔

*Why: endpoints are the visible half of a split. Everything below survives an in-process function
call and dies at a network boundary. Each row is a real, common production failure — enumerate them
now, per unit, or discover them one at a time in production.*

Go through **every** category. For each hit, record: the unit, the hazard, and the mitigation.

| # | Seam | What silently breaks | How to find it |
|---|---|---|---|
| D1 | **Transaction** | Two writes that were atomic become two HTTP calls; a failure between them leaves half-written data with no rollback. | Grep the ORM's transaction API (`$transaction`, `transaction(`, `atomic(`, `BEGIN`), plus any function doing 2+ writes. |
| D2 | **Authorization** | A function reachable only after a page guard becomes a public endpoint. Nothing fails — it becomes exploitable. | For every MOVES unit ask: *what proved the caller was allowed?* If the answer is "the page did", it has **no** check of its own. |
| D3 | **Serialization** | `Date`→string, `Decimal`/`BigInt`→string or precision loss, `Buffer`→base64 object, `undefined` keys vanish, `Map`/`Set`→`{}`, class instances→plain objects, circular refs throw. | Inspect each moving function's return type for non-JSON types; `JSON.parse(JSON.stringify(x))` and diff. |
| D4 | **Secrets / env** | The app keeps a credential it no longer needs (leak surface), or the service is missing one (runtime crash), or a client-public var is moved server-side and its browser reader breaks. | Grep every env read in moving code; cross-check against the app's env file and the client-public prefix. |
| D5 | **Cache / revalidation** | A mutation that moved used to trigger `revalidatePath` / `revalidateTag` / ISR / a cache purge in-process. From another service it cannot. | Grep the framework's revalidation and cache APIs inside moving code. |
| D6 | **Webhooks** | Signature verification needs the **raw** body. A proxy that parses and re-serializes JSON changes the bytes and **every signature fails**. Also: the provider's registered URL points at the old host. | Grep for signature verification (`constructEvent`, `verify`, `hmac`) and raw-body handling. |
| D7 | **Uploads / streaming** | Multipart bodies, size limits, and streams do not survive a naive JSON proxy; memory blows up on large files. | Grep for `FormData`, `multipart`, `stream`, `pipe`, upload SDKs, and body-size config. |
| D8 | **Realtime** | SSE / WebSocket connections held by the app's process; a proxy that buffers breaks them, and sticky sessions may be required. | Grep for `EventSource`, `WebSocket`, `socket.io`, `ReadableStream` responses. |
| D9 | **Jobs / cron** | Scheduled work defined by the app's platform (platform cron, queue worker) must be re-homed, and must not run in **both** places during the transition — that means double-charging, double-emailing. | Grep cron config, queue consumers, `setInterval` at module scope. |
| D10 | **N+1 over the wire** | A loop calling a moved function 50× becomes 50 round-trips: a 5 ms page becomes 2 s. | Grep for the moved symbol inside `for` / `map` / `Promise.all` / `await` in a loop. |
| D11 | **Error semantics** | The app used to catch a typed error and render a 404/403. Over HTTP it becomes a generic 500 unless the service maps it and the client re-throws it faithfully. | List each error type thrown by moving code and the status the app rendered for it. |
| D12 | **Timeouts / retries** | A function call could not hang forever; an HTTP call can. Retrying a non-idempotent POST double-charges. | Note every moved call's timeout budget and whether it is safe to retry. |
| D13 | **Observability** | Logs and traces used to share one process context. Split, a request becomes two unlinked traces and debugging gets much harder. | Note the log/trace setup; plan a correlation id header. |
| D14 | **Rate limiting / abuse** | Limits enforced at the app's edge no longer protect a directly-callable service. | List rate-limit / bot-protection middleware in front of moving routes. |
| D15 | **Multi-tenancy scoping** | An ORM middleware or request-scoped context that auto-scoped every query to the current tenant/org does not exist in the new process. Every moved query must carry the scope explicitly. | Grep for request-scoped ORM extensions, `AsyncLocalStorage`, row-level-security setup. |
| D16 | **Deploy skew** | Two deployables no longer ship atomically. Between the two deploys, an app expecting a new response shape talks to an old service (or the reverse) and errors in production only. | For each contract change ask: *is it safe in BOTH orders?* If not, it must be made additive first. |
| D17 | **Test doubles** | The app's tests mock the moved function. After the move that mock still resolves — so the suite stays green while testing a code path that no longer runs. A silently vacuous suite is worse than a failing one. | Grep the test suite for mocks/stubs/fixtures of every MOVES symbol. |

**Completeness gate:** Phase D is not done until **every** MOVES unit has been checked against
**all seventeen** rows and each hit has a named mitigation in the ledger. A seam you did not write
down is a seam you will meet in production. If a category genuinely does not apply, write "none"
next to it — an explicit none, never a silent skip.

---

## Phase E — Golden master: record the truth BEFORE anything moves

*Why: after the move, "is it the same?" must be answerable by a machine. The monolith is running
right now and is the only authority on its own behavior — capture it while you still can.*

1. **For every MOVES unit that is already an HTTP route:** record real request→response fixtures —
   method, path, headers that matter, sample inputs, exact response body + status. Save under
   `.split/golden/` and commit them.
   ```bash
   # one fixture per case, not just the happy path
   curl -s -X GET "$BASE/api/orders?status=open" -H "$AUTH" -D .split/golden/orders-open.headers \
        -o .split/golden/orders-open.json
   ```
2. **For every MOVES unit that is an internal function** (no URL yet): write a tiny characterization
   test that calls it with real inputs and snapshots the result. This is the only record of what it
   did before it became an endpoint.
3. **Capture the edge cases from Phase D, not just the happy path.** One fixture per enumerated
   case: unauthorized, forbidden, not-found, empty list, validation failure, pagination boundary,
   a row with a `Decimal`/`Date`/`null` field, a large payload. **Fixtures recorded from one benign
   record are vacuously green** — they pass while the edge case silently breaks, and they cap the
   maximum honest confidence of every later gate.
4. **For flows the user cares about most** (login, checkout, the main dashboard), script an
   end-to-end pass and record the network calls it makes. That call list is the smoke test each
   checkpoint must still satisfy.
5. **Record a latency baseline.** For each flow above, note how long it takes today (a rough p50/p95
   is enough). A split adds a hop to every call, and "it got slower" is the complaint that arrives
   a month later with no baseline to argue against. Agree a **budget** with the user now — e.g.
   *"no flow may get more than 30% slower"* — and write it in the ledger. Without a number, every
   later regression is a matter of opinion.
6. **No time or tooling for full capture?** Then record, per unit, the response shape and the key
   states in the ledger and **say so explicitly** — a documented gap, never a silent one. A unit
   with no oracle cannot pass the ≥95% gate on evidence; it passes only with the user's written
   acceptance.

---

## Phase F — Topology, contract & libraries (⛔ ask before install ⛔)

1. **Write down the target topology** from the B-answers: repo layout, service name and port, the
   internal URL the app uses server-side, the public URL (if any), how auth crosses, who owns the
   DB, and where env vars live. One short diagram or list. This is what CP-0 builds.
2. **Two base URLs, not one.** Server-side code in the app talks to the service over the internal
   network (`http://api:3001`); browser code — if it ever talks directly — uses the public URL.
   Conflating them is the classic "works locally, 502 in prod" bug. Name both in the ledger.
3. **Propose the target stack's standard libraries** for the concerns this service needs —
   validation, ORM/data access, auth guards, config, logging, testing, OpenAPI *(if B5 chose it)* —
   with exact install commands and a one-line reason each. Prefer whatever the repo already pins.
4. ⛔ **STOP — install nothing until the user approves the list.** Record the approved set in the
   ledger. A new library discovered later is fine — **propose it, get approval, add it to the
   ledger** — but never `install` silently.
5. **Decide the proxy mechanism** (this is what keeps the original URLs alive):
   - Existing HTTP route that moves → the old handler becomes a **thin pass-through**: forward
     method, path, query, headers *(including the raw body for D6 webhook routes)*, return the
     service's status and body unchanged.
   - Internal function that moves → the old function keeps its **exact signature** and becomes a
     client call. Every caller keeps compiling; nothing else in the app changes.
   In both cases the old implementation stays behind the flag until cutover.

---

## Phase G — Checkpoint plan + ⛔ APPROVAL GATE ⛔

*Why: the checkpoint plan is the backbone and the thing that makes the split resumable and
reversible. It is approved before any code is written.*

1. **Split the inventory into ordered checkpoints.** Each is a coherent, independently
   verifiable, independently revertable slice. Order by dependency and by risk — **lowest-risk,
   highest-confidence units first**, so the machinery is proven on something cheap before it is
   trusted with checkout. Payments, auth issuance, and anything in D1/D2/D6 go **late**, once the
   pipeline has earned trust.
2. **CP-0 is always the foundation** (Phase H) and is always first.
2b. ⛔ **Classify each checkpoint's risk, and stop on HIGH.** Mark a checkpoint **HIGH RISK** if any
   of these hold: it moves **money** (payments, billing, credits), **auth issuance** (login, tokens,
   password reset), **permissions or tenancy** (D2, D15), anything with an irreversible side effect
   (sending email/SMS, charging a card, deleting data), a **webhook** (D6), or a unit with **no
   golden master**. A HIGH RISK checkpoint is not forbidden — it is **not started silently**:
   present the units, the specific hazard, the mitigation and the revert line, and **wait for the
   user's explicit go-ahead** for that checkpoint specifically. Plan approval in step 6 covers the
   *shape* of the split; it does not pre-authorize the day you move billing.
3. **For each checkpoint record:** id (`CP-<n>-<slug>`), its exact units, its **flag key**, its
   **git tag**, its `depends-on`, its parity criteria, and its **revert line** (the literal command
   or flag flip that undoes it).
4. **Keep checkpoints small** — one work session each where possible. A checkpoint too big to
   finish is a checkpoint that gets interrupted half-applied.
5. **Write `SPLIT.md`** (Appendix A) at the repo root: decisions, inventory totals, seam table,
   checkpoint plan, flag table, contract index. Commit it.
6. ⛔ **Present the plan and STOP.** Do not move any code until the user explicitly approves. Show
   them: what moves, in what order, how long-ish, what the flags are, and how to undo any of it.

---

## Phase H — CP-0: the provable no-op, then the rollback drill

*Why: every later checkpoint's safety depends on machinery that does not exist yet. Build it first,
prove it changes nothing, and prove the undo works — before anything is at stake.*

**H1 — Build the foundation:**
- Scaffold the service in the approved stack + layout, with a `/health` endpoint and nothing else.
- Create the contract package / OpenAPI pipeline (B5).
- Add the **proxy layer** and the **flag reader** — a single module that answers
  `useService('<unit>')` from env, defaulting to **false** everywhere.
- Wire the service into local dev (compose file / dev script) and CI: both sides build, both test
  suites run, the contract typechecks against both.
- Add the correlation-id header (D13) and the service's auth verification middleware (B6 + rule 5),
  even though nothing uses them yet.

**H1b — Keep the dev loop to one command.** After CP-0 a developer must still start everything with
**one** command (`npm run dev` / `docker compose up`) and still get working hot-reload on both
sides. A split that turns the daily loop into "start three terminals in the right order" gets
worked around, and the workarounds are what break it. If the one-command loop is not achievable,
say so and agree the replacement with the user explicitly — do not let it degrade by accident.

**H2 — Prove it is a no-op:** the app's existing build, typecheck, lint and tests must pass
**unchanged**, and the golden-master fixtures must still replay green with every flag off. If any
of that moves, CP-0 is not done. Nothing has been extracted yet — a failure here is pure setup
error, and it is far cheaper to find now.

**H3 — Drill the rollback (do not skip — this is the proof, not a ceremony):**
1. Add one trivial throwaway unit behind a flag (e.g. `/health` proxied through the app).
2. Turn the flag **on**, confirm the app serves it through the service.
3. Deliberately break the service (stop it).
4. Turn the flag **off** → confirm the app is **immediately healthy again** with no redeploy.
5. Record in the ledger that the drill passed, and the exact commands used.

A rollback path that has never been exercised is a rollback path you are *assuming*. Every later
checkpoint's promise — "if it goes wrong, flip the flag" — is only worth what this drill proved.

**H4 — Tag and commit:** `git tag split/CP-0-foundation`, commit, tick the ledger.

---

## Phase I — The per-checkpoint loop (repeat, one checkpoint at a time)

> Run this whole loop for **one** checkpoint, take it to ≥95%, flag it on, tag it, commit — then
> move to the next. Never batch checkpoints.

### I1 — Re-sync and re-read
Re-read the ledger for this checkpoint's exact scope, its seam rows, and the contract index (so you
reuse existing DTOs/guards/clients rather than rebuilding them). Confirm the branch, and check live
edit signals *(if a tracker is present)*.

### I2 — Move the units, one at a time
For each unit, in order:
1. **Implement it in the service** in idiomatic target-stack code — controller/route + validation
   from the contract + the service's own **authentication and authorization** (rule 5) + tenant
   scoping (D15) + error mapping (D11).
2. **Turn the old code path into the proxy/client call**, keeping the **original URL and the
   original function signature** identical. No caller in the app changes.
3. **Leave the old implementation in place** behind the flag. Deleting it now removes the undo.
4. **Tick the unit in the ledger and commit** (`feat(split): CP-3 — move GET /api/orders`).
   Per-unit ticks are what make a mid-checkpoint interruption resume at unit 11, not unit 1.

### I3 — ⛔ Boundary gate (the checks that only exist because of the network) ⛔
Do not proceed until **every** line is true for **every** unit in this checkpoint:
- [ ] **Authorization** — the endpoint authenticates and authorizes on its own. Verified by an
      actual unauthenticated and a wrong-user request returning 401/403 (not by reading the code).
- [ ] **Transactions** — no unit of work is split across two calls (D1). Multi-write flows moved
      whole.
- [ ] **Serialization** — every non-JSON type (D3) is explicitly encoded and decoded; the client
      returns the same runtime types the old function did, or every caller was updated.
- [ ] **Secrets** — every credential the moved code needs is on the service; every one the app no
      longer needs is **removed** from the app's env and its example file; nothing client-public was
      moved without checking its browser readers (D4).
- [ ] **N+1** — no loop makes one request per iteration; loops became batch endpoints (D10).
- [ ] **Errors** — every error type maps to the status/shape the app used to return (D11).
- [ ] **Timeouts + retries** — every call has a timeout; retries only on idempotent verbs (D12).
- [ ] **Cache** — every revalidation the moved mutation used to trigger now happens (D5).
- [ ] **Raw body** — webhook and upload routes forward bytes unmodified (D6, D7).
- [ ] **Correlation id** — propagated app → service and logged on both sides (D13).
- [ ] **Test doubles** — every existing test that mocked a moved symbol now mocks the boundary
      (HTTP) instead, or exercises it for real. A suite that still stubs the old in-process function
      is green and vacuous (D17).
- [ ] **DRY** — reused the contract's existing DTOs, guards, and client helpers; no duplicated
      validation or error mapping. Same logic in 2+ places → extract it and index it.

### I4 — Differential parity (the mechanical check)
Because the old path still exists, parity is a diff, not a judgement:
1. Replay every golden-master fixture for this checkpoint's units with the flag **OFF** → record.
2. Replay the same fixtures with the flag **ON** → record.
3. **Diff. The diff must be empty** — same status, same body, same headers that matter. Any
   intentional difference must be written in the ledger with the user's agreement.
4. Replay the **edge-case** fixtures (Phase E step 3), not just the happy path.
5. Run both sides' build / typecheck / lint / tests. Then **launch the app and exercise the real
   flow** — observe it, don't just trust a green build.
6. **Check the latency budget** (Phase E step 5) for every flow this checkpoint touches. Over
   budget → it is a parity failure, not a "we'll optimize later": find the extra round-trips (D10)
   or the missing batch/cache now, while the flag is still flippable.
7. Re-run the **accumulated** fixtures from every prior checkpoint. This is cheap and it is how you
   catch a regression the new work introduced.

### I5 — ⛔ Confidence ≥95% gate (skeptic-corroborated · mandatory · non-waivable) ⛔
*Why an independent check: self-graded "looks done" is unreliable, and the two worst bugs a split
produces — a missing authorization check and a silently dropped field — both look fine from the
author's chair.*

0. **Fixture-adequacy pre-check.** Confirm the fixtures actually exercise each enumerated edge case
   for these units. Missing fixture → capture it (or record the gap) **before** scoring. A
   checkpoint whose fixtures only hit the happy path cannot score above them.
1. **Score your own confidence** that these units reproduce 100% of prior behavior with no new
   security, atomicity, or performance hole.
2. **Spawn an independent read-only skeptic** (fresh context; `Read`/`Grep`/read-only `Bash`, **no
   Edit/Write**). Give it: the original code, the diff, this checkpoint's units, the seam table and
   the fixtures. Instruct it to **re-derive the seams from the ORIGINAL code independently** and
   hunt specifically for:
   - an endpoint that **lost its authorization check** or trusts a caller-supplied user/tenant id
   - a **split transaction** or a lost atomicity guarantee
   - a **serialization drift** (`Date`, `Decimal`, `null` vs `undefined`, precision)
   - an **env var** left behind or a secret now readable where it should not be
   - a **webhook/upload** route whose body is no longer byte-identical
   - a **cache invalidation** that no longer fires
   - a **new N+1** or an unbounded/untimed call
   - a unit in the inventory that was quietly **not moved**
   It returns a **0–100 score** — defined as P(no missing unit · no dropped check · no broken
   contract) — plus the specific gaps.
3. **Final confidence = the LOWER of your score and the skeptic's.**
4. **Decision:**
   - **≥95%** → proceed to I6.
   - **<95%** → **flip the flag OFF first** (the app is instantly healthy while you work), fix the
     named gaps, re-run I3–I5.
   - **Cannot reach 95%** because behavior is genuinely ambiguous or undocumented → ⛔ **STOP and
     ask the user** the specific question. Never invent behavior to inflate a score.

⛔ A green build, a high self-score, and a manual click-through are **never** substitutes for the
skeptic. "Everything is green, the skeptic feels like ceremony" is the exact condition it exists
for — a green build usually means your *fixtures* miss the failing case.

⛔ **Bounded retries — three failures means the BOUNDARY is wrong, not the code.** If the same
checkpoint fails this gate three times, do **not** attempt a fourth. Three failures on one
checkpoint is the signature of a unit that should not have been split there: it is entangled with
code that stayed, it shares a transaction with something on the other side, or its authorization
depends on request context the service cannot see. **STOP, leave the flag off** (the app is
healthy and losing nothing), and take it to the user with the specific entanglement named and two
options: move the boundary (pull the entangled unit across too), or leave this unit in the app
permanently. A unit that stays is a legitimate outcome — a half-split unit behind a permanently-off
flag is not.

### I6 — Flag on, then smoke the real app
Turn the checkpoint's flags **on** in the working environment. Then exercise the app the way a user
does — the flows from Phase E step 4 — and confirm nothing changed. A checkpoint is not done because
its own tests pass; it is done because **the app still works with it on**.

### I7 — Tag, commit, record
1. `git tag split/CP-<n>-<slug>` at the verified commit — this is the "known-good" you can return to.
2. **Update `SPLIT.md`:** checkpoint `status: done`, its confidence, its flag now on, its tag, every
   unit ticked, new contract entries indexed, and the **revert line**. A `done` row **requires** a
   recorded skeptic score. Any unit marked deferred requires the user's explicit sign-off recorded
   in the ledger — a self-granted deferral counts as a **missing unit**.
3. **Write shared memory** *(if a tracker is present)* — the checkpoint, what moved, and any
   non-obvious gotcha (a contract quirk, a seam that needed an unusual mitigation).
4. **Commit automatically** (project's git author, only this checkpoint's files), Conventional
   Commits: `feat(split): extract <area> to <service>` with a body naming the units and the flag.
   Never `-m "wip"`.
5. ⛔ **Do NOT push.** Ask about push **and** PR together, including which base branch. Each happens
   only on an explicit yes.

### I8 — Deploy order, then loop
**Contract changes must be additive, and the service ships first.** Two deployables do not ship
atomically (D16), so every checkpoint must survive both orders of deployment:
- **Roll forward:** deploy the **service** first, then the app, then turn the flag on. The service
  must tolerate the *old* app's requests until the app catches up.
- **Roll back:** flag off first, then the app, then the service — the exact reverse.
- **Never make a breaking contract change in the same checkpoint that consumes it.** Add the new
  field/endpoint in one checkpoint, consume it in the next, remove the old one in a third. A
  rename is three checkpoints, not one — and that is cheaper than a five-minute production window
  where the two halves disagree.

Then go to I1 for the next checkpoint. Before starting it, confirm the previous checkpoint is still green
under the accumulated fixture suite.

---

## Phase J — Cutover: retire the scaffolding

*Why: the proxy + flags + duplicated implementation are transition machinery, not architecture.
Left in place they become permanent confusion — two code paths, one of them silently dead and
slowly rotting out of sync.*

Only start cutover when **every** checkpoint is `done`, flagged on, and has been running that way
long enough for the user to be comfortable. Do it as its own checkpoint, with its own gate:

1. **Point clients at the service directly** *(only if topology B7 option 2/3 was chosen)* — update
   the app's calls from the proxied path to the service URL, and configure CORS, cookie `Domain`
   and preflight caching. If option 1 was chosen, the proxy **is** the architecture — keep it, and
   skip to step 3.
2. **Delete the dead implementations** — the old in-process code behind each flag. Do this in one
   reviewable commit per area, not scattered.
3. **Delete the flags** and the flag-reader module. Remove them from every env file and deploy
   config.
4. ⛔ **Revoke the app's direct database access** (B8): remove the ORM client, the schema, the
   migration tooling and `DATABASE_URL` from the app. Until this happens the split is not real —
   the app can still write behind the service's back.
5. **Rotate any secret that lived in both places** during the transition. It was exposed to two
   deploy targets and two sets of logs; treat it as compromised by default.
6. **Move the operational surface**: cron/queue definitions to the service (D9, ensuring they are
   not running in both), re-point webhook URLs at the service (D6) and verify one real delivery per
   provider, move rate limiting to the service's edge (D14).
7. **Update the docs**: README, env examples, architecture notes, onboarding instructions, and the
   repo map/graph. A split that is undocumented is a split the next engineer will undo by accident.
8. **Run the full golden-master suite one final time** with the scaffolding gone, then tag
   `split/cutover-complete`.

⚠️ Cutover is the one irreversible step — after step 4 the flag flip no longer saves you. Treat it
as its own checkpoint with its own ≥95% skeptic gate, and **ask the user before starting it**.

---

## Phase K — Final sweep

When every checkpoint and the cutover are done:
- Re-run **every** golden-master fixture and every end-to-end flow against the split system.
- Confirm the **total** inventory from Phase C is fully accounted for: every MOVES unit moved,
  every STAYS unit untouched, every SHARED unit in the contract and nowhere else.
- Re-walk the **entire** Phase D seam table one final time across the whole system — this is where
  a hazard that was mitigated in one checkpoint and re-broken by a later one gets caught.
- A final independent skeptic reviews the complete diff against the full inventory and the seam
  table, with the same hunt list as I5.
- Confirm the two sides genuinely deploy independently: build and start each without the other
  present (the app should degrade honestly, not crash at import time).
- Update `SPLIT.md` to 100%, record the completion to shared memory, refresh the repo map.

---

## Deliberately not in this skill

Naming what this skill does **not** do, so its absence reads as a decision rather than an oversight:

- **Parallel fan-out across agents.** Checkpoints are deliberately **serial**. Unlike a migration's
  independent feature phases, every checkpoint here writes the same three things — the flag module,
  the proxy layer and the contract package — so two agents in parallel collide on the exact files
  the safety net is made of. The cost of a merge conflict in the rollback machinery is far higher
  than the time parallelism saves. Split the *work* across sessions by all means; do not split a
  checkpoint.
- **Splitting the database.** This skill changes who *owns* the database (B8), not where the data
  lives. Giving the service its own datastore is a data migration — dual writes, backfill,
  reconciliation, a cutover of its own — and is a separate project that should start only **after**
  this split is complete and stable. If the user asks for both at once, say plainly that doing them
  together means a failure can no longer be diagnosed to one cause, and recommend the order.
- **Decomposing into many services at once.** Extract one service, stabilize, then run this skill
  again for the next. An N-way decomposition planned up front is a guess about boundaries you have
  not tested; one extraction teaches you where the second one actually belongs.

---

## The autonomy contract — what "one shot" honestly means

After the plan is approved (Phase G), this skill runs **checkpoint to checkpoint without asking for
permission again**. It stops for exactly five things, and nothing else:

1. **A new dependency** — proposed, never installed silently (rule 9).
2. **Genuine ambiguity** — a business rule, an auth semantic, or an undocumented behavior that
   cannot be determined from the code or the golden master (rule 9).
3. **A parity gap it cannot close** — <95% after three honest attempts on the same checkpoint.
4. **Push or PR** — never automatic (rule 12).
5. **Cutover** (Phase J) — the one irreversible step.

Everything else — moving units, writing the service, wiring proxies, running gates, tagging,
committing, updating the ledger — happens unattended. If a checkpoint fails, the skill does **not**
stop and wait: it flips the flag off (the app is healthy), fixes the gap, and re-runs the gate.

That is the honest version of "one shot". A skill that promised to never stop would either guess at
ambiguity or install things you did not agree to — both of which break the app in ways a flag flip
cannot undo.

---

## Working with a shared tracker *(optional — when the project has one)*

This skill is portable and runs with nothing but git. When the repo has a coordination tracker
(this repo's is **baton**), use its primitives instead of the generic fallbacks — a split is long,
multi-session, often multi-agent work, which is exactly what a tracker is for.

| Skill step | Tracker command | Why |
|---|---|---|
| Fresh session onboarding (Phase A) | `baton orient` | Budgeted project brief so a resumed session reloads cheaply. |
| Understand the codebase (Phase C) | `baton kb rebuild` + query the graph | The map you inventory from; don't read the whole repo. |
| Isolate the work | `baton new "split: <checkpoint>"` | Branch + worktree per checkpoint, so parallel sessions never collide. |
| Multi-session coordination (I1) | `baton status` / `signals` / `check_files` | See who is editing what right now before you touch a shared file. |
| Hit a usage limit mid-checkpoint | `baton pass` | Packages the session into a pickup brief — done / pending / next unit. |
| Next session | `baton resume` | Continue at the exact next unit, days later. |
| Record decisions + gotchas (I7) | `baton memory` / `save_memory` | Pointers and traps; `SPLIT.md` stays the source of truth for status. |
| End of split | `baton doctor` / `clean --fix` | Reclaim the worktrees the checkpoints spent. |

**The pairing that matters:** per-unit ticks in `SPLIT.md` plus a session pickup brief mean the
split resumes **mid-checkpoint** with nothing lost. Without a tracker, the committed `SPLIT.md`
alone is the source of truth — that is enough, it is just less automatic.

---

## Vocabulary map — using this skill on any stack

Substitute your project's real names wherever the playbook uses the generic term.

| This skill says | Next.js | Nuxt / Vue | Django | Rails | Laravel |
|---|---|---|---|---|---|
| the app's server code | route handlers, server actions, server components | server routes, nitro handlers | views, DRF viewsets | controllers | controllers |
| the guard that proved authorization | `middleware.ts`, layout auth check | route middleware | decorators, permission classes | `before_action` | middleware |
| cache revalidation | `revalidatePath` / `revalidateTag` / ISR | `refreshNuxtData`, nitro cache | cache framework | `Rails.cache` | cache facade |
| client-public env prefix | `NEXT_PUBLIC_` | `NUXT_PUBLIC_` | (explicit context) | (explicit) | `VITE_` |
| the ORM | Prisma / Drizzle / TypeORM | same | Django ORM | ActiveRecord | Eloquent |

| This skill says | NestJS | Fastify / Express | FastAPI | Go | Spring Boot |
|---|---|---|---|---|---|
| service endpoint | controller + module | route handler | path operation | handler | `@RestController` |
| input validation | pipes + class-validator / zod | schema / zod | pydantic model | struct + validator | bean validation |
| the service's own authz | guards | middleware | dependencies | middleware | security filter |
| error mapping | exception filters | error handler | exception handlers | error middleware | `@ControllerAdvice` |

For any stack not listed: find its equivalent of *route*, *validation*, *guard*, *error mapper*, and
*config* before starting, and write them into the ledger's §Decisions.

---

## Red flags & rationalizations — STOP and return to the gates

**Violating the letter of these gates is violating the spirit of the split.** If you catch yourself
thinking any of these, stop and go back to the phase you are skipping.

| Rationalization | Reality |
|---|---|
| "The old code is dead anyway, let me delete it now" | It is the undo. It goes at cutover (Phase J), not before. |
| "The app already checks auth on that page" | The endpoint is now on the internet. It checks, or it is a vulnerability (rule 5). |
| "It's just two writes, they'll almost always both succeed" | "Almost always" is a data-corruption schedule. Move the transaction whole (rule 6). |
| "I'll capture fixtures after I move it" | After the move, the only authority on the old behavior is gone. Capture first (rule 2). |
| "Flags are overkill for this one" | The flag is why the app never breaks. It costs three lines. |
| "Build is green, skip the skeptic" | Green usually means your fixtures miss the failing case — that is exactly when the skeptic pays. |
| "It returns the same JSON, close enough" | `Date`, `Decimal`, `undefined` and `null` all look fine in a diff of a happy-path record. |
| "Let me move auth first, it's foundational" | Auth is the highest-risk area. It goes late, once the machinery is proven (Phase G step 1). |
| "I'll do the whole backend in one checkpoint" | Then an interruption loses all of it, and nothing is revertable in isolation. |
| "Both sides can write to the DB for now" | Two migration histories on one schema is how a split corrupts data (B8). |
| "The user is in a hurry, skip the interview" | The interview's answers are the decisions you would otherwise guess — and guess wrong once, permanently. |
| "It's a bit slower, we'll optimize later" | Without the recorded baseline and budget, "later" never gets an argument it can win (Phase E step 5). |
| "The app's tests still pass" | They may be mocking the function you just moved — green and testing nothing (D17). |
| "I'll just rename the field on both sides" | The two halves deploy minutes apart. A rename is add → consume → remove, across three checkpoints (D16). |
| "Third try will fix it" | Three failures on one checkpoint means the boundary is in the wrong place, not the code (I5). |
| "Billing is just another endpoint" | It moves money and it is irreversible. HIGH RISK checkpoints get their own go-ahead (Phase G step 2b). |

**Partner signals you are off-track:** "did you check it still works?" (you verified the service, not
the app) · "why is this slow now?" (an N+1 crossed the wire, D10) · "it works locally" (two base
URLs, Phase F step 2) · "who can call that?" (rule 5).

---

## Guardrails (always enforced)

- ⛔ **The app must be fully working at the end of every checkpoint** — verified by exercising the
  app, not by a green service test suite.
- ⛔ **Never move a unit without a recorded golden master** (fixture, characterization test, or a
  documented shape the user accepted).
- ⛔ **Never extract an endpoint that does not authenticate and authorize itself.** Inherited trust
  does not cross a network boundary.
- ⛔ **Never split a transaction across the boundary.**
- ⛔ **Never delete the old implementation before cutover** — it is the rollback.
- ⛔ **Never move a unit without a flag** *(unless the user explicitly chose B9 option 3)*, and never
  mark a checkpoint done without its tag, its revert line, and its skeptic score.
- ⛔ **Never install an unapproved dependency;** propose, get approval, record it.
- ⛔ **Never leave a secret in the app that only the service needs**, and never move a client-public
  var without checking its browser readers.
- ⛔ **Never start a HIGH RISK checkpoint** (money, auth issuance, permissions, irreversible side
  effects, webhooks, or no golden master) **without its own explicit go-ahead** — plan approval is
  not pre-authorization for the day you move billing.
- ⛔ **Never make a contract change that is unsafe in either deploy order.** Additive first: add,
  then consume, then remove — across separate checkpoints. The service deploys before the app; the
  rollback runs in reverse.
- ⛔ **Never attempt a fourth try at a failing checkpoint** — three failures means the boundary is
  wrong. Leave the flag off and take the entanglement to the user.
- ⛔ **Never leave a test mocking a symbol that moved** — a green suite that stubs the old
  in-process path is testing nothing.
- ⛔ **Never start cutover without asking** — it is the one irreversible phase.
- ⛔ **Never guess an ambiguous behavior** — ask the user.
- ⛔ **Commit per checkpoint automatically; never `git push`** without explicit permission (ask push
  + PR + base branch together).
- **Always resume from the ledger; never restart a split.**

---

## Definition of done

- [ ] Resume checked FIRST at unit level: `SPLIT.md` + shared memory read, continued from the first un-moved unit (never restarted), flag state confirmed, source drift checked against the recorded SHA; a pre-existing/abandoned split attempt surfaced rather than built beside.
- [ ] Interview completed in plain language with a recommended option on every question; every answer recorded in `SPLIT.md` §Decisions (target stack, repo layout, contract, auth, topology, DB ownership, rollout).
- [ ] Every server-side unit classified STAYS / MOVES / SHARED; every cross-boundary call site listed; contract set kept small and I/O-free.
- [ ] Seam inventory complete: all 17 categories checked against every MOVES unit, each hit given a named mitigation, each non-applicable category explicitly marked "none".
- [ ] Golden master captured BEFORE anything moved — happy path **and** every enumerated edge case; gaps documented, never silent; latency baseline recorded and a budget agreed with the user.
- [ ] Topology + two base URLs recorded; library set proposed and **approved before install**; proxy mechanism chosen.
- [ ] Checkpoint plan written to `SPLIT.md` (ids, units, flags, tags, depends-on, revert lines), riskiest areas ordered LAST, each checkpoint risk-classified, and **approved by the user** before any code moved; every HIGH RISK checkpoint additionally given its own explicit go-ahead when it started.
- [ ] CP-0 built and **proven a no-op** (app's own build/tests unchanged, fixtures green with all flags off); one-command dev loop still works; **rollback drill executed and recorded**.
- [ ] Each checkpoint: units moved one at a time behind the proxy with the original URL/signature preserved; old implementation left in place; ledger ticked per unit.
- [ ] Boundary gate passed per checkpoint — authorization (proven by real 401/403 requests), transactions whole, serialization, secrets, N+1, error mapping, timeouts/retries, cache, raw body, correlation id, test doubles converted to the boundary, DRY.
- [ ] Differential parity green: same fixtures with the flag OFF and ON produce an empty diff, edge cases included; latency budget met; accumulated prior fixtures re-run.
- [ ] **≥95% skeptic-corroborated** per checkpoint (independent, read-only, re-derived the seams from the original code); below 95% → flag off, fixed, re-verified; ambiguity → user asked; three failures on one checkpoint → STOPPED and the boundary re-litigated with the user, never a fourth attempt.
- [ ] Flags on, real app smoke-tested, `split/CP-<n>-<slug>` tagged, committed automatically (proper message, project author, only that checkpoint's files); every contract change additive and safe in both deploy orders.
- [ ] Push NOT automatic — push AND PR asked together, base branch user-confirmed.
- [ ] Cutover done only after explicit approval: proxies + flags + dead implementations deleted, app's direct DB access revoked, shared secrets rotated, cron/webhooks/rate limits re-homed and verified, docs + map updated.
- [ ] Final sweep: full fixture suite green, whole inventory accounted for, entire seam table re-walked, final skeptic clean, both sides proven to build and start independently.
- [ ] `SPLIT.md` accurate at 100%; completion recorded to shared memory.

---

## Appendix A — `SPLIT.md` ledger template

Copy this to the repo root at Phase G and keep it accurate. It is the resumable source of truth.

```markdown
# Split Ledger

> The single source of truth for this split. Any agent (or you, days later) reads this first.
> Status lives HERE; shared memory holds only pointers and gotchas. Commit every update.

## Decisions (from the interview — Phase B)
- **Driver:** <why we are splitting>
- **Moves / Stays:** <the rule>
- **Service stack:** <e.g. NestJS 10 + TypeScript>          **App stays:** <e.g. Next.js 15 app router>
- **Repo layout:** <monorepo apps/web + apps/api + packages/contract>
- **Contract source of truth:** <shared package | OpenAPI codegen | hand-written>
- **Auth across the boundary:** <app mints short-lived JWT; service verifies + authorizes>
- **Topology:** <one origin, app proxies /api/* to api:3001 on a private network>
- **Base URLs:** internal `<http://api:3001>` · public `<none | https://api.example.com>`
- **DB ownership:** <service owns; app access revoked at cutover>
- **Rollout:** <per-unit flags>
- **Latency budget:** <e.g. no flow may get more than 30% slower than the recorded baseline>
- **Source SHA (inventory taken at):** <sha>     **Started:** <date>   **Updated:** <date>

## Approved libraries (Phase F — add a row whenever a new one is approved)
| Concern | Library | Why |
|---|---|---|

## Inventory totals (Phase C)
- MOVES: **<N>** units   ·   STAYS: **<N>**   ·   SHARED (contract): **<N>**

## Seam register (Phase D — one row per hit; write "none" for a category with no hits)
| Seam | Unit | Hazard | Mitigation | Status |
|---|---|---|---|---|
| D1 transaction | `checkout()` | 3 writes must stay atomic | moved whole into POST /orders | done |
| D2 authorization | `getInvoice()` | only the page guarded it | service guard + owner check | done |

## Checkpoints
Status: `todo` / `in-progress` / `done`. `done` requires: parity green + skeptic score + tag + flag on.

`Risk`: HIGH if it moves money, auth issuance, permissions/tenancy, an irreversible side effect, a
webhook, or a unit with no golden master — a HIGH row needs its own go-ahead before it is started.

| # | Checkpoint | Units (tick per unit) | Flag | Tag | Risk | Status | Conf. | Revert line |
|---|---|---|---|---|---|---|---|---|
| 0 | foundation | `[ ]` scaffold `[ ]` contract `[ ]` proxy `[ ]` CI `[ ]` drill | — | `split/CP-0-foundation` | — | todo | — | `git reset --hard <pre-sha>` |
| 1 | read-only catalog | `[ ] GET /products` `[ ] GET /products/:id` | `SPLIT_CATALOG` | `split/CP-1-catalog` | low | todo | — | `SPLIT_CATALOG=off` |
| 2 | orders | … | `SPLIT_ORDERS` | … | low | todo | — | `SPLIT_ORDERS=off` |
| 5 | billing | … | `SPLIT_BILLING` | … | **HIGH** | todo | — | `SPLIT_BILLING=off` · go-ahead given <date> |

## Flags (current state)
| Flag | Meaning | Value now | Turned on at |
|---|---|---|---|

## Contract index (reuse before you build — DRY)
| Name | Kind | Path | Signature | Used by |
|---|---|---|---|---|

## Golden master
- Location: `.split/golden/`   ·   Fixtures: **<N>**   ·   Edge cases covered: **<list>**
- Latency baseline: <flow → p50/p95 before the split>
- Known gaps (accepted by the user): <list or none>

## Per-checkpoint log
### CP-<n> — <name>  (status, confidence: <N>%)
- Units moved · Seams mitigated · Deviations the user approved · Skeptic gaps found & fixed
- Open questions for the user
```

---

## Appendix B — Boundary parity checklist (run per checkpoint, at I3/I4)

```
CONTRACT
[ ] Same status code for every fixture, happy path and every edge case
[ ] Same response body, field for field (no dropped undefined, no renamed key)
[ ] Same headers that callers depend on (content-type, cache-control, set-cookie, location)
[ ] Non-JSON types survive: Date, Decimal/BigInt (precision!), Buffer, null vs undefined, Map/Set
[ ] Pagination, sorting and filtering behave identically at the boundaries (page 0, last page, empty)

SECURITY
[ ] Unauthenticated request → 401 (actually sent, not assumed)
[ ] Authenticated-but-wrong-user request → 403 (actually sent)
[ ] No caller-supplied user id / tenant id / role is trusted
[ ] Tenant scoping applied explicitly on every query
[ ] Service is not internet-exposed unless the topology intended it
[ ] No secret left in the app that only the service needs; none newly readable by the browser

CORRECTNESS UNDER FAILURE
[ ] Every call has a timeout; nothing can hang forever
[ ] Retries only on idempotent verbs; no double-charge / double-send path
[ ] Service down → the app degrades the way the user agreed (error page, not a blank crash)
[ ] Flag OFF restores the old path with no redeploy — verified, not assumed

PERFORMANCE
[ ] No loop makes one request per iteration (batch endpoint instead)
[ ] No data re-fetched that the caller already had
[ ] Payload sizes sane; no accidental full-table serialization

OPERATIONS
[ ] Correlation id propagated and logged on both sides
[ ] Cache revalidation that the moved mutation used to trigger still fires
[ ] Webhook and upload routes forward raw bytes unmodified
[ ] Cron/queue work runs in exactly ONE place, never both

DEPLOY SAFETY
[ ] Every contract change is additive — safe with the OLD app against the NEW service, and the reverse
[ ] Deploy order is service-first; rollback order is the reverse; both written in the ledger
[ ] No rename/removal in the same checkpoint that introduced its replacement

TESTS
[ ] Every test that mocked a moved symbol now mocks the boundary or exercises it for real
[ ] The service has its own tests for the units it gained (authz cases included)
[ ] Latency for each touched flow is within the agreed budget
```
