---
plan: handoff-pipeline
goal: Make every handoff reachable, and show them as an ordered pipeline so it is obvious which brief to paste next
requireReview: true
---

## Context for every task in this plan

Two separate problems, diagnosed in the code on 2026-09-05.

**1. Briefs past the third are unreachable.** `web/src/features/Handoff.tsx:81`
renders `briefs.slice(0, 3)`. Line 82 renders the remainder as
`…{n} more — \`baton resume\` lists all` — **static text, not a button, not a
scroll container, not an expander.** With 5 open handoffs, 2 have no route to
their Resume-prompt button anywhere in the dashboard. The only way to reach them
is to leave the UI and run a CLI command.

**2. Nothing carries order.** `BriefEntry` (`src/handoff/resume.ts:18-31`) has
`slug, kind, title, status, from, to, created, path, cwd, markdown, body` — and
no dependency or phase field.

The ordering information **already exists**: plans have phases, and task
contracts carry `dependsOn` (`src/handoff/brief.ts:178`). But it is formatted
into the brief's markdown as prose and never extracted into the structured entry
the API returns. The dashboard therefore cannot sort, group, or say what is next
— not because the data is missing, but because it stops at the boundary.

**The user's workflow this serves:** auto-dispatch is not being used. Briefs are
copied by hand into other agents, one at a time. So "which one do I paste next"
is the primary question the panel has to answer, and today it cannot.

**Handoff bodies are untrusted.** `src/handoff/untrusted.ts` and
`sanitizeUntrusted` exist because a brief can arrive by `git pull` from a branch
nobody reviewed. Any new surface that renders brief content inherits that rule.

## Phase 1 — Stop losing briefs, and start carrying order

### handoff-inbox-reachable @claude
**scope:** `web/src/features/Handoff.tsx`
**expects:** every open brief is reachable without leaving the dashboard; with 12 briefs all 12 Resume-prompt buttons can be clicked; the panel does not grow unbounded — it scrolls or expands; the count in the header equals the number of reachable rows; `npx tsc --noEmit` in web/ passes and `npm run build --prefix web` passes
**principles:** fix only the reachability bug in this task — ordering and pipeline visuals belong to phase 2, and mixing them makes the fix impossible to review; keep the panel's existing visual language, do not restyle it
**skills:** bug-fix, lean-code
**model:** sonnet

`briefs.slice(0, 3)` plus a static "…2 more" label is the whole defect. The
smallest honest fix is a scroll container with a max height, or a
"Show all" toggle — not a redesign.

Reproduce it first: five briefs open, count the clickable Resume buttons.

### handoff-order-fields
**scope:** `src/handoff/resume.ts`, `test/handoff-order.test.ts`
**expects:** `BriefEntry` gains `dependsOn: string[]` and `phase: string | null`, parsed from the brief's frontmatter and contract; both default to `[]` and `null` when absent so every existing brief still loads; a brief whose `dependsOn` names a slug that no longer exists still parses and reports the name; `ready` is true when no dependency is still open; a two-brief dependency cycle does not hang; `npx vitest run` passes with no test deleted
**principles:** parse only — do not change how briefs are written, and do not touch brief.ts in this task; unknown dependency names are data to report, never a thrown error, because a brief referencing a deleted task must still be readable
**skills:** test-driven-development
**model:** sonnet

Surface the ordering that already exists. The plan's phase and the contract's
`dependsOn` are currently formatted into markdown prose and lost; extract them
into the structured entry so the API carries them.

`ready` is the field the UI needs most: it is the difference between "paste this
next" and "this is blocked on something you have not finished".

## Phase 2 — Show the pipeline

### handoff-pipeline-ui @claude
**scope:** `web/src/features/Handoff.tsx`, `web/src/types.ts`
**expects:** briefs render grouped by phase in dependency order, with each group labelled; a brief whose dependencies are all done is visibly marked as the next one to copy; a blocked brief shows what it is waiting on and its copy button is de-emphasised, never hidden; the first ready brief is highlighted; empty and single-brief cases render without an empty pipeline frame; `npx tsc --noEmit` and `npm run build --prefix web` pass
**principles:** a blocked brief must remain copyable — the user may deliberately work out of order, and a UI that refuses is worse than one that warns; render brief titles as text, never as markdown or HTML, because brief content is untrusted; no animation that delays a click
**skills:** lean-code
**model:** sonnet

The panel becomes a pipeline: phase 1 → phase 2 → phase 3, each a labelled group
with its briefs inside, ordered by dependency.

The single question it must answer at a glance is **"which one do I paste
next?"** — one brief, clearly marked. Everything else on the panel is context
for that answer.

### handoff-order-docs
**scope:** `docs/handoff.md`
**expects:** documents the `phase` and `dependsOn` fields, how `ready` is derived, and how to write a brief that lands in the right place in the pipeline; states plainly that a blocked brief can still be picked up deliberately
**model:** sonnet

Write the section a person reads when their brief appears in the wrong group, or
appears blocked when they expected it to be ready. Explain where the phase comes
from and what makes a brief ready, so the answer is derivable rather than
mysterious.

## Phase 3 — Let the agent answer it too

### handoff-next-tool
**scope:** `src/mcp.ts`, `test/mcp-next-handoff.test.ts`
**expects:** a `next_handoff` MCP tool returning the single highest-priority ready brief with its resume prompt; returns the blocked list with reasons when nothing is ready; returns a clear empty result when there are no briefs at all; the response stays under 2k tokens and never includes more than one full brief body
**principles:** the brief body is untrusted input — return it as quoted data, never as instructions in Baton's voice, matching how dispatch briefs are already framed; no LLM call, the ranking is the same dependency ordering phase 1 computes
**skills:** test-driven-development
**model:** sonnet

Today the user asks an agent what to do next and the agent cannot tell. This
gives it the same answer the panel shows, so "what should I pick up?" works in
the terminal as well as in the browser.

### handoff-security-pass
**after:** handoff-pipeline-ui
**scope:** `test/handoff-untrusted-render.test.ts`
**expects:** a brief whose title contains HTML, a script tag, or markdown injection renders as literal text in the panel; a brief whose body contains an instruction addressed to an agent is quoted rather than presented as a directive in the `next_handoff` response; a brief with a very long single-line title cannot break the panel layout
**principles:** assert on rendered output, not on implementation details
**skills:** security-review
**model:** sonnet

Briefs arrive by `git pull` from branches nobody reviewed — that is exactly why
`src/handoff/untrusted.ts` exists. This plan adds two new surfaces that render
brief content, so it adds the tests that keep both honest.
