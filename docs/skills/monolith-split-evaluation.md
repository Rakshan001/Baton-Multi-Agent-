# `monolith-split` — design rationale, scorecard, and how to share it

The skill itself: [`src/skills/bundled/monolith-split/SKILL.md`](../../src/skills/bundled/monolith-split/SKILL.md)
— one self-contained file, 961 lines, no `references/` folder. That file **is** the shareable
artifact; there is no second copy to keep in sync.

---

## 1. Why this is a separate skill, not a mode of `stack-migration`

They look adjacent and they are not. The distinction is not cosmetic — it changes what can go
wrong, and therefore what the playbook has to check.

| | `stack-migration` | `monolith-split` |
|---|---|---|
| What happens to the source | **Dies.** It is replaced. | **Lives.** It keeps its stack and keeps serving. |
| The unit of work | Port a route/component to a new framework | Move a function across a **network boundary** |
| Deliverables at the end | One app, new stack | **Two** deployables, one contract, two deploys |
| The parity oracle | Fixtures recorded before the source is retired | The old path is **still running behind a flag** — parity is a live diff |
| Characteristic failure | A feature silently doesn't get ported | An endpoint silently **loses its authorization check** |
| Rollback | Revert the phase's commits | **Flip one env flag** — seconds, no redeploy |
| Can they run in parallel agents? | Yes, after the foundation phase | **No** — every checkpoint writes the same flag/proxy/contract files |

A split's whole risk profile comes from one line:

```
BEFORE:  page → getOrders()          ← function call. Typed. Atomic. Trusted. Instant.
AFTER:   page → HTTP → getOrders()   ← network boundary. Serialized. Fallible. PUBLIC. Slow.
```

A migration skill never has to reason about atomicity loss, cookie domains, raw webhook bodies, or
an endpoint becoming internet-reachable. Folding these into `stack-migration` would have made both
skills worse: the migration playbook would carry checks that never apply to it, and the split's
checks would read as optional extras rather than the point.

Both descriptions now carry a one-line pointer at each other, so a request like *"move my API out
of Next.js into NestJS"* routes to the right one instead of the first keyword match.

---

## 2. What it borrowed, and what it added

**From `bug-fix`:** the ≥95% skeptic-corroborated confidence gate, the explicit approval gate before
any edit, the rationalization table, bounded retries, auto-commit-never-push, and the auditable
definition of done.

**From `stack-migration`:** the committed ledger as the single source of truth, per-unit ticks so an
interruption resumes mid-phase, golden-master fixtures, source-drift detection, ask-before-install.

**From `basic-setup`:** the plain-language interview with a **(Recommended)** option on every
question, detect-then-confirm rather than assume, and a **proof drill** rather than an assumption.

**New to this skill — the parts neither reference could have:**

1. **The seam inventory (17 categories).** Endpoints are the easy half. Transactions, authorization
   inheritance, serialization drift, secrets, cache revalidation, webhook raw bodies, uploads,
   realtime, jobs, N+1-over-the-wire, error semantics, timeouts, observability, rate limits,
   tenancy scoping, deploy skew, and test doubles — each one a real production failure, each with a
   grep recipe.
2. **Differential parity.** Because the old code still runs behind a flag, parity is a machine
   check: same fixture, flag off vs flag on, **the diff must be empty**. A migration can only
   compare against a recording; a split can compare against the old system running *right now*.
3. **CP-0 as a provable no-op, plus a rollback drill.** The first checkpoint changes no behaviour —
   the app's own tests must pass unchanged — and then the undo is *exercised* (break the service,
   flip the flag, confirm health). Every later promise of "if it breaks, flip the flag" is worth
   exactly what that drill proved.
4. **Authorization as a first-class rule.** A function reachable only after a page guard becomes a
   public endpoint the moment it moves. Nothing fails — it just becomes exploitable. The gate
   requires a *real* 401 and a *real* 403 response, not a code reading.
5. **Reversible checkpoints.** Each one = a flag + a git tag + a written revert line. A checkpoint
   whose undo cannot be named is not a checkpoint.

---

## 3. Scorecard

Same rubric applied to v1 (first draft) and v2 (after the improvement pass below). Weights reflect
what actually determines whether a split succeeds.

| # | Criterion | Weight | v1 | v2 | What changed |
|---|---|---:|---:|---:|---|
| 1 | Trigger precision / routing | 8 | 9 | 9 | already had two-way disambiguation |
| 2 | Resumability | 10 | 8 | 9 | + brownfield detection (abandoned split attempts) |
| 3 | Inventory completeness | 10 | 7 | 9 | + deploy skew, + test doubles (15 → 17 seams) |
| 4 | Gate strength (approval + skeptic) | 12 | 8 | 9 | + HIGH RISK per-checkpoint go-ahead, + bounded retries |
| 5 | Domain hazard depth | 15 | 7 | 9 | + latency budget, deploy-order rule, vacuous-test-suite trap |
| 6 | Interview quality | 8 | 10 | 10 | 9 questions, recommended-marked, detect-first |
| 7 | Stack agnosticism | 7 | 9 | 9 | recommendation matrix + two vocabulary maps |
| 8 | Reversibility / proven safety net | 12 | 10 | 10 | flag + tag + revert line + drilled rollback |
| 9 | Code-quality / DRY gate | 5 | 7 | 8 | + test-double conversion |
| 10 | Git discipline | 5 | 9 | 9 | commit per checkpoint, never push |
| 11 | Rationalization defence | 4 | 8 | 9 | 11 → 17 red-flag rows |
| 12 | Definition of done | 4 | 8 | 9 | every new gate made auditable |
| | **Weighted total** | **100** | **83.0** | **91.5** | |

Nothing scores 10 unless the skill actually *enforces* it mechanically rather than instructing it.
That is why the gate criteria cap at 9: a playbook can require a skeptic run, but nothing stops a
careless agent from skipping it. The definition-of-done checklist and the red-flag table are the
mitigation, not a guarantee.

### The eight gaps the v1 score exposed, and the fixes

| Gap | Why it mattered | Fix in v2 |
|---|---|---|
| **A. Brownfield blindness** | Real repos often contain an abandoned half-split. v1 only looked for its own ledger, so it would build a second service beside a forgotten first. | Phase A step 2 — hunt for a stray service folder / second lockfile / unused service URL, then **stop and ask** whether to adopt, finish, or delete it. |
| **B. No risk gate** | v1 ordered risky work last but never *stopped* for it. Plan approval on day one is not consent to move billing on day nine. | Phase G step 2b — classify each checkpoint; **HIGH RISK** (money, auth issuance, permissions, irreversible effects, webhooks, no oracle) needs its own explicit go-ahead. |
| **C. Deploy skew** | Two deployables no longer ship atomically. A rename that is fine locally errors in production during the minutes between deploys. | New seam **D16** + phase I8 — contract changes must be **additive and safe in both orders**; service deploys first, rollback runs in reverse; a rename is three checkpoints. |
| **D. Vacuous test suites** | The app's tests mock the function that just moved. The mock still resolves, so the suite is green while testing a code path that no longer runs. | New seam **D17** + a boundary-gate line requiring every such mock to move to the boundary. |
| **E. No latency budget** | A split adds a hop to every call. "It got slower" arrives a month later with no baseline to argue against. | Phase E step 5 records a baseline and agrees a budget; phase I4 step 6 makes exceeding it a **parity failure**, not a later optimisation. |
| **F. Dev-loop rot** | If daily development becomes "three terminals in the right order", the team routes around the split and the workarounds break it. | Phase H1b — one command must still start everything with hot reload, or the replacement is agreed explicitly. |
| **G. Unbounded retries** | v1 would loop on a failing checkpoint indefinitely. Three failures is not bad luck. | Phase I5 — three failures means the **boundary is in the wrong place**; stop, leave the flag off, name the entanglement, and let the user choose to move the boundary or leave the unit in the app. |
| **H. Unstated non-features** | Silence reads as oversight. | New "Deliberately not in this skill" section: no parallel fan-out (checkpoints share the safety-net files), no physical database split (that is its own project), no N-way decomposition up front. |

---

## 4. Known limits — read before trusting it blindly

- **It is a playbook, not an enforcer.** Gates are instructions. The definition-of-done checklist is
  the audit trail; use it.
- **The skeptic gate needs a sub-agent.** In a harness that cannot spawn one, the honest degradation
  is a fresh session reviewing the diff cold — not skipping the gate.
- **~12k tokens per invocation.** The price of self-containment. Deliberate: a single file survives
  being emailed, pasted, or uploaded, which a folder does not.
- **Out of scope by design:** physical database separation, N-way decomposition in one pass, and
  parallel multi-agent execution.
- **The vocabulary map covers 11 stacks.** Anything else needs its *route / validation / guard /
  error-mapper / config* equivalents written into the ledger before starting.

---

## 5. Using and sharing it

**Already available in this repo** — `/monolith-split`, installed at `.claude/skills/` and
`.agents/skills/`, and registered in Baton's bundled catalog
([`src/skills/catalog.ts`](../../src/skills/catalog.ts)) so it ships with the package and appears on
the Skills screen.

**To hand it to someone else without cutting a release** — send them the single file
`src/skills/bundled/monolith-split/SKILL.md`. They install it by dropping it at:

```
<their-repo>/.claude/skills/monolith-split/SKILL.md     # Claude Code
<their-repo>/.agents/skills/monolith-split/SKILL.md     # other agents
```

Then invoke it with `/monolith-split`, or just describe the task — the description triggers on
"split this codebase", "separate the frontend and backend", "extract the backend", "move the API
out of Next.js", "pull this into its own service".

It needs nothing from Baton to run: no tracker, no knowledge graph, no MCP. Where a tracker is
present it uses it for resume and coordination; where one is absent the committed `SPLIT.md` ledger
is the source of truth on its own.
