---
plan: agent-visibility
goal: Show every plan and its approval state in the dashboard, and count tokens for every agent rather than only Claude
requireReview: true
---

## Context for every task in this plan

Two blind spots, both verified in the code on 2026-09-05.

**1. A plan is invisible until it is applied.** `src/pipeline-view.ts:154`
builds the plan list from the tasks themselves:

```ts
const planIds = [...new Set(tasks.map((t) => t.planId).filter(Boolean))].sort();
```

A plan file that exists in `baton/plans/` but has never been `plan apply`-ed has
no tasks, so it appears **nowhere** in the dashboard. `baton/plans/` currently
holds four plans; the pipeline screen can show at most the applied ones.

The consequence is worse than a missing list. The whole safety model rests on a
human running `plan approve`, recorded against the plan's exact bytes
(`src/plan-trust.ts` — `planDigest`, `trustVerdict`, `loadTrust`). **The one
checkpoint the design depends on is the one thing the UI cannot display.**
Everything needed already exists as pure functions; nothing composes them.

**2. Token counting is Claude-only, and the file says so.** `src/usage.ts`
parses Claude Code's session JSONLs into real input/output/cache tokens and an
estimated cost, mapped back to baton tasks, served at `GET /api/usage`. Its
header records the borrowing — *"Schema/approach adapted from Orca's
claude-usage fetcher (MIT) — concept only, no code vendored"* — and its limit:
`agent: 'claude'` is hardcoded and *"codex/gemini session formats are different
and deferred"*.

For a hub whose purpose is running several agents at once, a spend figure that
silently covers one of them is not incomplete, it is **misleading**.

**What is actually parseable — checked on this machine, not assumed:**

| Agent | Location | Verdict |
|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | already parsed |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | **parseable** — `session_meta` carries `cwd` and `model_provider`; entries carry `input_tokens`, `cached_input_tokens`, `output_tokens`, `total_token_usage` |
| Antigravity / Gemini | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | **partial** — a sparse `tokenCount` only; no input/output split, so no cost basis |
| Cursor | `~/.cursor/agents` | empty here; nothing found to parse |

Codex is a real task. Antigravity is a "report what exists and say what is
missing" task. Cursor is out of scope until there is a file to read.

**Non-goals:** no approve or apply buttons in the dashboard — the plan screen is
read-only in this plan, because moving the human checkpoint behind a click is
the one change that would weaken the thing being made visible; no estimated
token counts where a real one is unavailable, because a made-up number in a
spend table is worse than a blank.

## Phase 1 — Make the checkpoint visible

### plan-inventory
**scope:** `src/plans/inventory.ts`, `test/plan-inventory.test.ts`
**expects:** lists every plan file in `baton/plans/` with its id, goal, task count, whether it parses, whether it is applied, and its trust verdict from `src/plan-trust.ts`; a plan whose file changed after approval reports the approval as void rather than valid; a plan that fails to parse is LISTED with its issues, never omitted; a plan id that is not a single safe path segment is refused and never used to build a path; a directory with no plans returns an empty list, not an error; an unreadable individual file does not abort the whole listing; results are ordered deterministically; `npx vitest run` passes
**principles:** compose the existing `parsePlan`, `validatePlan` and `trustVerdict` — do not reimplement any judgement they already make, or the screen and the CLI will eventually disagree about whether a plan is approved; a plan id reaches this code from a filename and from HTTP, so treat it as hostile input, exactly as `src/server.ts:1567` already warns for the plan-markdown route
**skills:** test-driven-development, security-review
**model:** sonnet

An unparseable plan is the single most important row on this screen: it is the
one someone needs to fix, and dropping it because it did not parse would hide
precisely the plan that needs attention.

### plan-inventory-api
**after:** plan-inventory
**scope:** `src/server.ts`, `test/plan-inventory-api.test.ts`
**expects:** an endpoint returns the inventory; it is read-only and available in read-only mode, because seeing what awaits approval must not require write access; plan goals and issue text are transported as data and the response never inlines full plan markdown; an id that escapes the plans directory is rejected with 400; `npx vitest run` passes
**principles:** raw `node:http`, no new dependency; a GET must have no side effect — this endpoint reads plan files and a trust store and writes neither
**skills:** lean-code, security-review
**model:** sonnet

The pipeline endpoint keeps deriving applied plans from tasks. This adds the
plans that exist on disk. Keep them distinguishable in the response — "on disk"
and "running" are different states and merging them loses the distinction the
screen is for.

### plan-inventory-ui
**after:** plan-inventory-api
**scope:** `web/src/features/Pipeline.tsx`, `web/src/lib/api.ts`, `web/src/types.ts`
**expects:** every plan on disk is listed with its state — parses / applied / approved / approval void because the file changed; an unapproved plan shows the exact command that approves it rather than a button; plan text renders as plain text, never as markdown or HTML; a plan that fails validation shows its issues; the screen renders correctly with zero plans and with twenty; demo mode shows the states with fixtures and calls no daemon; `npx tsc --noEmit` and `npm run build --prefix web` pass
**principles:** read-only by design — show the command, do not run it, because approval is recorded against bytes a person is supposed to have read and a button invites approving without reading; plan files can arrive by `git pull` from a branch nobody reviewed, so their text is untrusted and is never rendered as markup
**skills:** lean-code, security-review
**model:** sonnet

The screen answers one question: what is waiting for me? An approved, applied,
running plan needs one line. A plan whose approval was voided by an edit needs
to be impossible to miss.

## Phase 2 — Count every agent, or say you cannot

### usage-agent-shape
**scope:** `src/usage.ts`, `test/usage-shape.test.ts`
**expects:** `SessionUsage.agent` becomes an open agent id rather than the literal `'claude'`, and totals can be grouped by agent; every existing field and the current `GET /api/usage` shape keep working for Claude sessions; an agent with no parseable sessions contributes nothing rather than a zero row that reads as "spent nothing"; cost stays `null` rather than `0` when the model is unknown, and callers can tell the two apart; `npx vitest run` passes with no test deleted
**principles:** absent data and zero must be distinguishable everywhere — a blank says "not measured", a zero says "measured, spent nothing", and conflating them is how a spend table starts lying; do not change Claude's numbers in this task
**skills:** test-driven-development, lean-code
**model:** sonnet

Widen the type before adding a second parser, so the second parser has somewhere
correct to land.

### usage-codex
**after:** usage-agent-shape
**scope:** `src/usage/codex.ts`, `test/usage-codex.test.ts`
**expects:** parses `~/.codex/sessions/**/rollout-*.jsonl` into the same `SessionUsage` shape; maps a session to a baton task via the `cwd` in its `session_meta`, matching how Claude sessions are mapped today; reads `input_tokens`, `cached_input_tokens` and `output_tokens`, and does not double-count when a running total such as `total_token_usage` also appears; a truncated final line is skipped rather than throwing; a missing sessions directory yields no sessions and no error; a session whose `cwd` matches no task is attributed to the repo rather than dropped; files are streamed, not read whole, because a long session is large; `npx vitest run` passes
**principles:** stream with `createReadStream` + `readline` exactly as the Claude parser does — a usage query must not load a multi-megabyte transcript into memory; never invent a token count, and never infer one from character length; test against a committed fixture, not against the developer's own `~/.codex`, so the test means the same thing on another machine
**skills:** test-driven-development, lean-code
**model:** sonnet

Codex is the one other agent whose logs carry a real input/output/cache
breakdown. Double counting is the specific bug to watch for: the rollout files
carry both per-call figures and a running total.

### usage-antigravity
**after:** usage-agent-shape
**scope:** `src/usage/antigravity.ts`, `test/usage-antigravity.test.ts`
**expects:** reads `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` and reports whatever token data is present; where only a bare `tokenCount` exists, it is reported as a total with input, output and cost left ABSENT rather than guessed; a transcript with no token data yields a session with no numbers rather than zeros; a missing directory yields nothing and no error; the module states in its header exactly which fields this format does and does not provide; `npx vitest run` passes
**principles:** report the gap rather than filling it — an estimated cost sitting beside two measured ones is the failure this whole plan exists to fix; if the format turns out to carry nothing usable, say so in the header and return nothing, and treat that as the task succeeding
**skills:** test-driven-development, lean-code
**model:** sonnet

Investigated on this machine: `tokenCount` appears, but sparsely and without an
input/output split. This task's honest outcome may be "partial data, clearly
labelled" — that is a result, not a failure.

### usage-by-agent-ui
**after:** usage-codex, usage-antigravity
**scope:** `web/src/features/Activity.tsx`, `web/src/lib/api.ts`, `web/src/types.ts`
**expects:** spend is broken down per agent and per task; an agent whose data is partial is labelled as such next to its number, and an agent with no readable sessions says so rather than showing zero; numbers use tabular figures and align; the screen renders with one agent and with five; demo mode shows a multi-agent breakdown with fixtures; `npx tsc --noEmit` and `npm run build --prefix web` pass
**principles:** never render a missing measurement as `0` or `$0.00`; label partial data at the number, not in a footnote nobody reads
**skills:** lean-code
**model:** sonnet

The screen answers "where did the money go?" — per agent, per task. Today it can
only answer it for Claude, while presenting the total as if it covered the hub.

### agent-visibility-docs
**after:** plan-inventory-api, usage-agent-shape
**scope:** `docs/dashboard.md`
**expects:** documents the plan inventory and each state a plan can be in, including approval voided by an edit; documents which agents' token usage can be read, from where, and which fields each format does not provide; states that the plan screen is read-only and why
**principles:** name the unreadable agents explicitly — someone comparing Baton's total against their provider bill needs to know what is missing from it
**skills:** lean-code
**model:** sonnet

Write the page someone opens when the dashboard's spend does not match their
bill, and the page someone opens when their plan is not on the plan screen.
