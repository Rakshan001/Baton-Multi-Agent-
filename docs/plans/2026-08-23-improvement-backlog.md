# Baton improvement backlog — what other agents found, triaged

> **Plan B of two.** The sibling plan is
> [2026-08-23-baton-desktop.md](./2026-08-23-baton-desktop.md). They are
> independent; §0 names the one file both touch.

**What this is:** every outstanding improvement other agents have researched and
verified for this repo, collected in one place, sized, and ordered. Nothing here
is a new idea — it is a triage of work already proposed and left unfinished.

---

## §0 — Read this first

### Where these came from

| Source | What it holds |
|---|---|
| [`docs/research/2026-07-06-multi-agent-coordination-audit.md`](../research/2026-07-06-multi-agent-coordination-audit.md) | **12 proposals**, each adversarially verified. Tier 1/2/3 |
| [`docs/research/2026-07-11-memory-deep-research.md`](../research/2026-07-11-memory-deep-research.md) | Memory-system findings |
| [`docs/research/kb-token-and-storage.md`](../research/kb-token-and-storage.md) | Graph token + storage cost |
| [`docs/presence-layer-followups.md`](../presence-layer-followups.md) | Presence review findings — **marked uncommitted** |
| [`docs/superpowers/plans/`](../superpowers/plans/) | 5 plans: unified-search, shared-graphify-server, context-pack, site-dashboard-polish (done), hardening-bundle |

**Every audit proposal survived verification as *modify*, never *drop*** — and
the scoping corrections are the valuable part. They cut roughly a third of the
work. Read the audit's correction for an item before building it; the naive
version is bigger and worse.

### The one coordination point with Plan A

Plan A adds `electron/` and only **reads** `src/server.ts` and
`src/daemons.ts`. This plan **writes** them (B2, B5). **This plan owns those
files.** If both agents are live, Plan A rebases on this one.

### Order

**B1 → B2 → B3** first: one is a live correctness bug, one is a security
cleanup, one is a five-minute fix that unblocks measurement. Everything after is
ordered by value per day.

---

## B1 — The `gitRoot` → worktree bug 🔴

**Source:** audit P1, Tier 1 · **Size:** S · **Repo:** baton

The audit's single highest-ranked finding: coordination tools resolve to
`gitRoot` where they should resolve to the Baton root. In a worktree these
differ, so **coordination silently does nothing** — `check_files` reports no
conflicts because it is looking at the wrong tree, and an agent proceeds
believing it has the all-clear.

Silent wrongness is worse than an error. This is a correctness bug in the
feature the product exists for.

- Replace `gitRoot` with `resolveBatonRoot` on every coordination path.
- Inject agent identity env at launch so `resolveAgentId()` matches the assignee
  (the same defect class as dispatch's D3).

### Edge cases

| # | Case | Handling |
|---|---|---|
| B1-E1 | Main checkout — the two roots are equal | Must stay byte-identical. Existing tests are the contract |
| B1-E2 | Worktree whose parent repo has moved | Resolve through `--git-common-dir`; fall back with a named reason |
| B1-E3 | Nested worktrees | Innermost Baton root wins; assert with a test |
| B1-E4 | A caller genuinely wants the git root | Keep both helpers, name them so the difference is unmissable |

**Done when:** a test creates a worktree, edits a shared file from two
identities, and `check_files` reports the collision. It does not today.

---

## B2 — Dead auth branch in the enrollment route

**Source:** security review, 2026-08-23 · **Size:** XS · **Repo:** baton

[`src/server.ts:1905`](../../src/server.ts#L1905):

```ts
const memberId = access.allow ? access.member?.id ?? 'local' : 'local';
```

**Not exploitable today.** The global gate at `server.ts:852` returns 401/403
for any denied caller ~1,050 lines earlier, so the `: 'local'` branch is
unreachable — TypeScript has already narrowed `access` to `allow: true` by then,
which is the proof.

But it *reads* as though it handles the denied case. Move this route above the
gate, or add a route-level bypass, and it silently becomes an auth bypass that
hands enrollment data to anyone.

```ts
const memberId = access.member?.id ?? 'local';
```

Same behaviour, no trap. Add a test asserting an unauthenticated caller gets
401 from this path.

---

## B3 — Fix the flaky graphify tests

**Source:** observed 2026-08-23 · **Size:** S · **Repo:** baton

Three runs of unchanged code gave 11, then 6, then 5 failures. Every one was a
process-startup timeout — `graphify backend on :NNNNN did not become ready` —
and the machine was at **load average 46–89 on 10 cores**.

So they are load artifacts, not defects. But that is precisely the problem: a
suite that fails under load **cannot tell you whether the code is good**, and it
trains everyone to re-run until green, which is how a real regression ships.

- Make backend-ready waits deadline-based with a generous, explicit timeout, and
  fail with the elapsed time so a slow machine is distinguishable from a broken
  backend.
- Mark the graphify suites as serial, or gate them behind an env flag in CI.
- `guard.test.ts`'s `Symbol(timed out)` assertion needs the same treatment.

**Done when:** the suite passes on a loaded machine, or fails with a message
that names load as the cause.

---

## B4 — Graphify memory regression 🔴

**Source:** audit findings, July · **Size:** M · **Repo:** baton

Recorded as the **#1 audit finding**: graph builds grew from ~720 MB to ~1.8 GB
RSS. On the 16 GB laptops this product targets, that is the difference between a
background rebuild and a machine that swaps.

- Reproduce with a measurement, not a recollection — capture RSS across a build
  on a known repo and record the number here.
- Bisect to the change that moved it.
- Add a ceiling assertion so it cannot regress silently again.

### Edge cases

| # | Case | Handling |
|---|---|---|
| B4-E1 | Large monorepo legitimately needs more | The ceiling scales with file count, not a flat number |
| B4-E2 | Build OOMs mid-run | Fail with a clear reason and leave the previous graph intact — never a half-written one |
| B4-E3 | Concurrent builds across projects | Relevant to Plan A's D4. One shared backend, not N |

---

## B5 — Presence layer follow-ups: commit them

**Source:** [`presence-layer-followups.md`](../presence-layer-followups.md) ·
**Size:** S · **Repo:** baton

Six code-review findings were **fixed but left uncommitted** on 2026-07-15, with
582 tests passing. Fixes that exist only in a working tree are fixes that will
be lost.

The doc says to fold anything durable into `session-continuity-improvements.md`
and delete itself. Do that — a working doc that outlives its work becomes a
second source of truth.

---

## B6 — Output contracts on every MCP response

**Source:** audit P4, Tier 1 — *the only proposal rated `keep/keep`* · **Size:**
M · **Repo:** baton

The highest-confidence item in the audit, and the one with no scoping
correction. Serena-style contracts on every MCP response: compact JSON, hard
caps, scoped recall.

This is a **token-cost** feature. Every unbounded MCP response is paid for on
every call by every agent — the compounding cost of the product's own chattiness.

### Edge cases

| # | Case | Handling |
|---|---|---|
| B6-E1 | Response exceeds the cap | Truncate at a **semantic** boundary and say what was dropped, with how to get the rest |
| B6-E2 | Agent needs the full payload | An explicit escape hatch, never the default |
| B6-E3 | Caps break an existing consumer | Version the shape; the parity tests are the contract |

---

## B7 — Edit-time collision warning

**Source:** audit P2, Tier 1 · **Size:** M · **Repo:** baton

A PreToolUse hook that pushes a collision warning **at edit time** rather than
waiting for an agent to voluntarily call `check_files`.

The audit's finding B was blunt: *live edit awareness is pull-only and
voluntary.* An agent that never asks never learns. This inverts it.

**Advise-only to start** — the audit's correction, and it is right. A hook that
blocks edits on a false positive gets disabled within a day, and then you have
neither the warning nor the trust.

---

## B8 — One-command multi-agent setup

**Source:** audit P7, Tier 2 · **Size:** M · **Repo:** baton

`baton setup --agents claude,cursor,codex,gemini` writing every config, hook and
skill in one pass. Today one-command setup exists for Claude Code only (audit
finding E).

Directly relevant to Plan A: the desktop app's "add project" should call exactly
this path rather than growing a second setup implementation.

---

## B9 — Zero-footprint install

**Source:** audit P8, Tier 2 · **Size:** S · **Repo:** baton

Audit finding D: *Baton currently adds to the sprawl it wants to fix.* A
single-repo `kb init` leaves 5–6 untracked items in `git status`.

**Part 1 only** — gitignore the artifacts at `kb init`. The audit explicitly
scoped out the rest.

A tool that dirties `git status` on first run teaches users to ignore their own
diff. Cheap to fix, disproportionate to trust.

---

## B10 — Stale signals with no dashboard open

**Source:** audit P6, Tier 2 · **Size:** M · **Repo:** baton

Signals go stale when no dashboard tab is open. Fix by **lazy read-time
reconciliation, not a background poller** — the audit's correction, and it
matters: a poller burns battery on every machine to fix a problem only visible
on read.

---

## B11 — Merged-only graphify default

**Source:** audit P11, Tier 3 · **Size:** XS · **Repo:** baton

Hub graphify duplicates tokens across projects. The audit's correction reduced
this from a `query_kb` facade to **a one-line default change** to merged-only.

An XS item with real token savings — worth doing out of tier order, alongside B6.

---

## B12 — `baton doctor` markdown-sprawl scan

**Source:** audit P12, Tier 3 · **Size:** S · **Repo:** baton

**Piece 1 only** — a doctor check that flags `.md` sprawl. The audit dropped the
runtime litter-watch.

This repo is itself the evidence: `docs/` now holds plans, plans-local, research,
notes, superpowers/plans, superpowers/specs, and several working docs that
outlived their work. Dogfood the check here first.

---

## Not in this plan

- **Unified search**, **context pack**, **shared graphify server**, **hardening
  bundle** — all have their own plans in `docs/superpowers/plans/`. Check each
  for completion before starting; some are partly shipped.
- **Site dashboard polish** — marked done.
- Anything in `docs/notes/orcabaton_*` — superseded by Orcabaton's own `PLAN.md`.

---

## Suggested order

| Order | Item | Size | Why here |
|---|---|---|---|
| 1 | **B1** worktree bug | S | Silent correctness failure in the core feature |
| 2 | **B2** dead auth branch | XS | Minutes; removes a latent bypass |
| 3 | **B3** flaky tests | S | Until this lands, no other result is trustworthy |
| 4 | **B5** commit presence fixes | S | Work that already exists, at risk |
| 5 | **B4** memory regression | M | #1 audit finding; hits target hardware |
| 6 | **B6** + **B11** token contracts | M | Compounding cost on every call |
| 7 | **B9** zero-footprint | S | Cheap, disproportionate to trust |
| 8 | **B7** edit-time warning | M | Turns coordination from pull to push |
| 9 | **B8** multi-agent setup | M | Plan A's D2 wants it |
| 10 | **B10** stale signals | M | |
| 11 | **B12** doctor sprawl scan | S | |

**B1–B5 is roughly one week** and covers every correctness and safety item.
B6–B12 is the value tail and can be reordered freely.

---

## Verification

```bash
npm run build && npx vitest run          # after every item
npx vitest run test/worktree-coord.test.ts   # B1 — the test that fails today
npx vitest run test/enrollment-auth.test.ts  # B2
```

Each item lands its own commit on a feature branch, with the audit ID in the
message so it traces back to the research that justified it.
