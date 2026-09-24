# Transcript template

**Where.** `$council/<YYYY-MM-DD>-<slug>.md`, with `$council` resolved once by the "Council folder"
snippet in SKILL.md Phase 1 — never a path relative to your working directory. With Baton that is
`<root>/.baton/council/` in the hub store, shared by every worktree on this machine; other machines
and clones cannot see it. No Baton: the folder the user chose, or `$council` after the
`git check-ignore` check in Phase 1. The slug is 4–6 kebab-case words — count them: at least **4**
longer than two letters, because `Council decision` eats two of the memory fingerprint's six and a
shorter slug lets the recommendation's wording decide it, so the supersede breaks silently (slug
`fastify-vs-raw-node-http`, file `2026-09-17-fastify-vs-raw-node-http.md`). Name taken → `-2`, `-3`.

**When nothing can be written** — only two cases: writing is impossible (no writable location, the
sandbox refuses), or the user explicitly refuses files. "Don't bother with a transcript" is neither:
offer this document inline and say the record is session-only. Either way print it in the chat once
and say `Transcript: session-only — not written (<which case>)` in the verdict block — a session-only
record is still a record; a dropped one is not.

The transcript is the durable record and the run's ledger: a later session should understand the
decision, see who argued what, check whether an overturn condition fired and resume an interrupted
run — without the chat. Memory reaches places this file does not, so the memory fact must carry the
decision on its own. Never write secrets into it.

**Every section earns its lines.** The brief is written once, under `## Brief`, never restated per
phase; context is not re-introduced per seat; a heading adding nothing an earlier section says is
deleted, not scaffolded. Answers and reviews are verbatim and are the long part.

**Write it as the run goes**, not at the end:

| After | Write | Status |
|---|---|---|
| Phases 1–5 | header + brief · seats · answers and diversity · mapping (before dispatch) then reviews | `in progress` |
| Phase 6 | claim checks, tally, verdict | `advisory — not acted on` |
| Phase 7 | memory line | unchanged |
| User decides | status only | `approved: <what> on <date>` / `rejected: <reason>` |

---

```markdown
# Council: <decision, one line>

- **Date:** <YYYY-MM-DD>
- **Status:** in progress | advisory — not acted on | approved: <what> on <date> | rejected: <reason>
- **Tier:** quick | standard | deep
- **Run:** <N> seats (<n> subagent, <n> external, <n> inline) · review <k>/<k>|skipped · diversity ✓|re-seated|consensus
- **Degraded:** no | <what and why>
- **Prior verdict:** none | <path or memory id> — <what changed since>

## Question (as asked)

<the user's words>

## Brief

DECISION: ...
OPTIONS: ...
CONSTRAINTS: ...
STAKES: ...
GROUNDING:
- grep -n "function openDb" src/db.ts → 40:export function openDb(path: string): Db {
- <claim> [unverified]
OUT OF SCOPE: ...

Clarifying question asked: none | <question> → <answer>

## Seats

| # | Lens | Seat type | Model / provider | Tension with |
|---|---|---|---|---|
| 1 | Maintainer | subagent | host | Expansionist |
| 2 | Executor | external | cli · codex · <model> | First-principles |

## Answers

### Seat 1 — <lens>
<answer verbatim; the brief is not repeated here>

## Diversity check

<spread observed> · re-seated: none | <seat> <old lens → new lens>, result <...>

## Peer review

**Anonymization mapping** (shuffled): A = seat 3 · B = seat 1 · C = seat 4 · D = seat 2
Reviewers: fresh subagents R1..Rn | emulated, not independent (inline run — no Re-run cells)
**Citation slices** (disjoint, one per reviewer): R1 = claims 1-5 · R2 = 6-10 · R3 = 11-16
Each reviewer re-runs its whole slice; a slice over five is sampled (most load-bearing · last by
document order · reads as written from memory) and marked `sampled`.

### Reviewer R1
<review verbatim, including FRAMING and the FINAL RANKING block>
Tally note: none | thin (<n> rankings parsed) | emulated, not independent

## Claim checks

Checks are run in one batch per file, then transcribed while the output is on screen. The row holds
three texts, each labelled: **Claim** is the member's own quoted words, **Line as found** is the
output of **Checked with**, and **Re-run** is a second agent's output for the same citation. ⛔
**Checked with** is an anchoring search — `grep -n "<the quoted text>" <file>`, so the number comes
back from the tool; `sed -n '<n>p'` appears only to re-display a number grep just produced, never to
establish one. One literal term per command, no alternation or regex metacharacters, and **Line as
found** holds the command's complete output or is marked truncated with the hit count. All but the Claim are pasted, never recalled; either tool cell empty → Result is
`[unverified]`. ⛔ **The number in Line as found must equal the number in the Citation when the
Citation names a line** (`:29` beside `"31:…"` is a row contradicting itself): if it does not, the
citation is wrong even when the text matches — strike it and re-anchor on what the search returned.
An anchored Citation names no line, as worked row 3 shows; the search output supplies it, which is
why an anchor cannot go stale this way. Result has exactly three values — `kept`,
`struck — <reason>`, `[unverified] — <reason>`; the last never means "kept anyway": such a claim may
stay, down-weighted, not as evidence. This is the one table a reader stops checking behind, and the
**Re-run** cell holds the independent check beside
the row it checks — a reviewer's cross-check, or in quick tier the chairman's *self*-check — as
`<who>: "<output>" · match | MISMATCH`; `—` where the citation fell outside every slice, `sampled` in
the slice header when it ran over five. ⛔ **Only an agent that did not produce a row may fill its
Re-run cell**: an inline or single-agent run leaves the column empty and heads the table
*"self-checked — no second agent re-ran these"*. **A MISMATCH overrides the Result:** the row becomes
`struck — re-run disagrees` and the claim is false, however the first pass read it.

| Seat | Claim | Citation | Checked with | Line as found | Result | Re-run |
|---|---|---|---|---|---|---|
| 2 | "uploads are size-limited" | config/app.yml:13 *(placeholder file)* | `grep -n "max_upload" config/app.yml` | "12:max_upload_mb: 20" | struck — the rule is at 12, not the cited 13; the search, not the claim, gave the number | R1: "12:max_upload_mb: 20" · match |
| 1 | "the fallback branch" | src/server.ts:2494 | `grep -n "return serveStatic" src/server.ts` | "3426:  if (!path.startsWith('/api/')) return serveStatic(req, res, path, origin);" | struck — the claim's text is at 3426, not the cited 2494; the search gave the number | R1: "3426:  if (!path.startsWith('/api/')) return serveStatic(req, res, path, origin);" · match |
| 3 | "update() takes an options object" | update() in src/kb/graphify.ts | `grep -n "export async function update" src/kb/graphify.ts` | "159:  export async function update(root: string, opts: UpdateOpts) {" — recalled, not pasted: the defect this row models | ~~kept~~ struck — re-run disagrees | R2: "159:export async function update(path: string, opts: ExtractOptions = {}): Promise<void> {" · MISMATCH — the first pass's line was recalled; the real one has no indent and different parameters |
| 4 | "p95 is under 20 ms" | no file to open | — | — | [unverified] — down-weighted, never decisive | — |

## Tally

| Response | Seat | Ranks received | Average |
|---|---|---|---|
| B | 1 | 1, 2, 1 | 1.33 |

Excluded rankings: none | <reviewer — reason> · Re-requested: none | <reviewers>

## Verdict

<run header line>

### Framing
<neutral | the quoted lean>
### Positions
### Where the members agree
### Where they clash
### Blind spots
### Recommendation
<choice> — Confidence: high | medium | low — <reason>
### What would overturn it
- <checkable condition>
### First step
<one reversible action>

## Degradation notes

<every honesty-table row that applied, or "none">

## Memory

save_memory: <fact id> (advisory) — replaced by: <fact id> on <date> after <approved|rejected>
(`supersedes` set | old fact removed with `baton memory rm`) | not saved (<reason: no Baton | re-run
of a decided question, prior fact kept | re-run rejected, prior decision kept — a rejected re-run
saves nothing and never removes the prior decided fact>)
```

---

## Notes

- Answers and reviews are verbatim; do not tidy away weak reasoning — the record is only useful if
  it is honest. Everything that is not an answer, a review or a verdict is kept to a line or two.
- Quick tier: omit Peer review and Tally; Claim checks lists the citations the orchestrator opened,
  with the chairman's `RE-RUN CHECK` output in each row's **Re-run** cell (`chair:`) — unless the
  quick run is itself inline, where the chairman is the orchestrator, so the column stays empty and
  the table is headed *self-checked*. Either way it is a self-check; its absence, or "no repo access",
  is a degradation line.
