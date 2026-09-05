---
plan: context-cost
goal: Cut the context every agent session pays before it does any work, and start recording which skills are actually used
requireReview: true
---

## Context for every task in this plan

Measured in this repo on 2026-09-05, against the built `dist/`.

**1. The MCP tool list costs 2,668 tokens in every session, and we have been
policing the smaller half of it.**

A real `tools/list` handshake against `node dist/cli.js mcp` returns:

```
tools=19  wire_bytes=10672  descriptions=3160  schemas=5687
```

`test/mcp-help.test.ts` budgets the **descriptions** (3,160 chars, cap 3,200).
Nothing budgets the **input schemas**, which are larger — 5,687 chars of
`.describe()` text and JSON Schema scaffolding. The largest single tools are
`create_handoff` (1,148 bytes), `save_memory` (1,115) and `save_progress`
(1,005), and in each case the schema dominates, not the description.

This is paid on connect, by every agent, in every session, forever — before a
single useful token is exchanged.

**2. Listing skills reads 138 KB it throws away.**

`bundledSkills()` (`src/skills/catalog.ts:310`) reads every reference file's
contents to build a list that never uses them:

```
skills 34   load_ms 21   body bytes 537,221   reference bytes read and discarded 137,923
```

`SkillSummary` already excludes reference contents from the *response*. The
disk read was never removed.

**3. Nothing records that a skill was ever used.**

`src/skills/bookmarks.ts` is the only per-skill state, and it is a hand-pinned
list. There is no signal for which skills earn their place, which have gone
stale, or which to rank — in Baton or in BatonVault.

**Where this comes from**

Ideas taken from `hermes-agent` (MIT, Nous Research —
`tools/skill_usage.py`, `toolsets.py`, `tools/skill_ledger.py`). Its
*architecture* is explicitly not a model to follow: `cli.py` is 1 MB and
`hermes_state.py` is 667 KB. Take the algorithms, keep Baton's shape.

Attribution belongs in a comment on any file that borrows a design, per
`NOTICE`.

**Non-goals, stated so nobody adds them**

- **No trajectory/brief compression.** Measured briefs here run 2.2–7.0 KB. The
  problem hermes' compressor solves does not exist in this repo yet.
- **No auto-archiving or auto-pruning of skills.** This plan produces a report a
  human reads. Nothing moves or deletes a user's file.
- **No skill write-provenance.** It is the right guard for an actor that prunes
  autonomously; nothing here prunes, so building it now is speculative. Add it
  in the same change that first makes something auto-act.

**Overlap with the existing plan**

`baton/plans/skill-fetch.md` still owns `server-skill-etag`, `web-skill-list`,
`skill-fetch-docs` and all of phase 3. **No task here touches `src/server.ts`
skill routes or `web/`.** Do not merge the two plans; do not fix a skill-fetch
task from inside this one.

## Phase 1 — Cut the tax, and record what is used

### mcp-wire-budget
**scope:** `test/mcp-wire-budget.test.ts`
**expects:** a test performs a real initialize + `tools/list` against the built server and asserts the TOTAL serialized payload stays under a named budget; the assertion covers names, descriptions AND input schemas, so a schema-only regression fails it; the test FAILS LOUDLY if the server does not start or returns zero tools, rather than passing on an empty measurement; it reports the per-tool breakdown in the failure message so the offender is named; no network access and no dependency outside `dist/`; the whole test completes in under 20s; `npx vitest run` passes
**principles:** measure what the CLIENT receives, not what a source file contains — the existing description budget missed 5,687 bytes precisely because it measured the source; a budget test that can pass while measuring nothing is worse than no test, so absence of data must be a failure
**skills:** test-driven-development, lean-code
**model:** sonnet

Write the lock before the trim, so the trim has something to prove.

The number to record as the baseline is the one measured above: **10,672 bytes,
19 tools**. Set the budget at the measured value, not a round number — a budget
with slack in it is a budget that has already been spent.

### mcp-schema-trim
**after:** mcp-wire-budget
**scope:** `src/mcp.ts`, `src/mcp-pipeline.ts`, `src/mcp-help.ts`
**expects:** total `tools/list` payload drops by at least 20% against the baseline the previous task recorded; EVERY input field still has a non-empty `.describe()`; no tool loses a field and no field changes type or optionality; the behavioral trigger phrases asserted in `test/mcp-help.test.ts` all survive; `npx vitest run` passes with no test deleted or weakened; the live `tools/list` still returns 19 tools
**principles:** an undescribed field is worse than a verbose one — an agent that cannot tell what an argument means passes the wrong thing, and that costs more than the tokens saved; trim wording, never fields; do not change any tool's behaviour in this task
**skills:** lean-code, code-review
**model:** sonnet

Start with the three that dominate: `create_handoff`, `save_memory`,
`save_progress`. Their schemas carry sentence-length field descriptions where a
clause would do.

The test from the previous task is the arbiter. If a trim makes a field
ambiguous, keep the words and find the budget elsewhere — the point is cheaper
sessions, not shorter files.

### mcp-toolsets
**after:** mcp-schema-trim
**scope:** `src/mcp-toolsets.ts`, `test/mcp-toolsets.test.ts`
**expects:** named, composable tool groups resolve to a set of tool names; a group may include another group and a tool named twice appears once; a cycle between two groups terminates and is reported, never hangs; an UNKNOWN group name is refused loudly, naming the valid groups, and never resolves to the empty set; absent or empty configuration resolves to EVERY tool, so the default behaviour is unchanged; resolution is a pure function of the configuration with no filesystem or clock access; `npx vitest run` passes
**principles:** resolve from CONFIGURATION, never by inferring from mutable state — a client that caches `tools/list` at connect and ignores `notifications/tools/list_changed` would never see a tool that appeared later, so a tool set that depends on whether a handoff happens to exist is a tool set that silently differs per client; refusing an unknown name is mandatory, because resolving it to "no tools" would present as a broken Baton rather than a typo
**skills:** test-driven-development, lean-code
**model:** sonnet

The resolver only. Wiring it into `startMcpServer` is deliberately a separate
change: this task must be judgeable as a pure function, and the wiring carries a
compatibility question that deserves its own review.

Two groups are enough to prove the shape — `core` and `handoff`. Do not invent a
taxonomy nobody asked for.

### skill-usage-ledger
**scope:** `src/skills/usage.ts`, `test/skill-usage.test.ts`
**expects:** usage is appended as one JSON object per line, never read-modify-written, so two concurrent writers cannot lose each other's entry; `readUsage()` aggregates the file into per-skill counts and a last-used timestamp; a truncated or malformed final line is SKIPPED, not thrown — a crashed write must not make the whole file unreadable; a missing file reads as "no usage" rather than an error; a skill id of `__proto__`, `constructor` or `toString` cannot pollute the aggregate; the skill id is never joined into a filesystem path; an entry longer than a documented cap is refused so a hostile id cannot write an unbounded line; compaction triggers above a documented line count, is crash-safe via temp-file + rename, and loses no entry that existed before it started; every write is best-effort and returns rather than throwing; `npx vitest run` passes
**principles:** append-only, because the alternative is a read-modify-write and Baton is a MULTI-AGENT hub — the lost-update window is not theoretical here; telemetry is never a gate, so a failure to record must never fail the operation being recorded; store it alongside `bookmarks.ts` at `~/.baton/`, machine-wide, for the same reason bookmarks are machine-wide — a skill installed once is present in every project; sidecar file, never the skill's own frontmatter, so user-authored SKILL.md stays free of operational noise
**skills:** test-driven-development, security-review
**model:** sonnet

`src/skills/bookmarks.ts` is the precedent to follow for read-failure tolerance
and atomic writes — and the place to diverge: bookmarks stores an ARRAY of ids
and writes the whole file. Counters keyed by id in an object is the obvious
shape and the wrong one, on two counts: it reintroduces the lost update, and a
skill id is user-controlled text going in as an object key.

Skill ids reach us from imported skills and GitHub imports. Treat every id as
hostile string input.

### skill-usage-wire
**after:** skill-usage-ledger
**scope:** `src/skills/install.ts`, `src/skills/catalog.ts`
**expects:** installing, uninstalling and loading a skill body each record one usage entry; LISTING skills records nothing, so reading the catalog stays a pure read; a ledger failure never fails or slows the install — an install with an unwritable `~/.baton` still succeeds; `bundledSkills()` no longer reads reference-file CONTENTS to build a listing, and the 137,923 bytes measured above drop to zero for a list; installing a skill still writes byte-identical files to before; `npx vitest run` passes with no test deleted
**principles:** a list must never become a write — that is the bug `bookmarks.ts` documents avoiding, and it applies identically here; keep `catalog.ts` under 400 lines; do not change the installed output by a single byte
**skills:** lean-code, code-review
**model:** sonnet

Two changes that belong together because both live on the read path: start
recording real use, and stop paying for reads nobody wanted.

The reference-content read is the cheaper half to get wrong — `install` genuinely
needs those bytes. Route it through the on-demand loader rather than reverting
the listing.

### context-cost-docs
**after:** mcp-toolsets
**scope:** `docs/mcp-tools.md`
**expects:** documents the measured per-session cost of `tools/list` and what a new tool adds to it; documents tool sets, how one is selected, and that an unknown name is refused; states plainly that tool sets come from configuration and why they are not inferred from state; no claim of a saving that the budget test does not measure
**principles:** state measured numbers, never estimates — the next person to add a tool decides based on this page
**skills:** lean-code
**model:** sonnet

Write the page the next person reads before adding tool number 20.
