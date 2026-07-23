---
name: code-review
description: >-
  Review a diff since a fixed point (commit, branch, tag, or merge-base) along three axes that are
  never merged — Standards (does the code follow this repo's documented conventions, plus a
  baseline of classic code smells?), Spec (does it implement what the originating issue, spec, or
  handoff brief asked for, with nothing missing and no scope creep?), and Security (does it
  introduce injection, authz, path-traversal, secret-leak, or SSRF risk?). Runs the axes as
  parallel sub-agents, adversarially verifies every finding before reporting it, reports them side
  by side without cross-axis ranking, and persists the result so findings survive the session. Use
  when reviewing a branch, a PR, work-in-progress changes, another agent's output, or when the
  user says review, code review, "review since X", "check my changes", "is this ready to merge",
  or asks for feedback on a diff. For verifying your OWN change before claiming done, use
  verify-before-done instead.
---

# Code Review (portable)

A change can follow every convention in the repo and still implement the wrong thing. It can do
exactly what was asked while breaking how this codebase writes code. It can pass both and still
add a path traversal. Those are **three different questions**, and a single blended verdict lets
one mask the others.

```
PIN THE FIXED POINT → FIND SPEC / STANDARDS / SECURITY SOURCES →
RUN THE AXES IN PARALLEL → REFUTE EVERY FINDING →
REPORT SIDE BY SIDE, NEVER MERGED → PERSIST + ROUTE
```

**Golden rules**
1. **Pin the fixed point first.** A bad ref or an empty diff must fail here — not inside three
   sub-agents that already burned their context.
2. **The axes never merge.** Separate headings. No combined score, no cross-axis ranking, no
   single "worst finding overall".
3. **Every finding cites its source.** A repo standard (file + rule), a named baseline smell with
   the hunk quoted, a quoted spec line, or a named vulnerability class with the sink. An uncited
   finding is an opinion — drop it.
4. **Every finding is refuted before it is reported.** An unverified finding costs the human more
   than it saves. See step 5.
5. **A documented repo standard always overrides the Standards baseline.** Where the repo endorses
   something the baseline would flag, suppress the smell.
6. **Baseline smells are judgement calls, never hard violations.** Label them ("possible Feature
   Envy"). Only a documented standard can be breached outright.
7. **No spec means no Spec axis.** Report "no spec available" — never invent requirements.
8. **A partial review must say so.** If the diff was too large to review whole, record what was
   covered. A silent partial review reads as a clean one.
9. **Skip what tooling already enforces.** Formatting the linter fixes is not review.

> **This is not verify-before-done.** That skill is the *author* checking their own work before
> claiming done (symbols exist, build/tests run, goal met). This skill is *reviewing a diff*
> against a fixed point. Use both, in that order: verify first, then review.

---

## Workflow

### 1. Pin the fixed point

Whatever the user named is the fixed point — a SHA, a branch, a tag, `main`, `HEAD~5`. If they
didn't name one, propose the merge-base with the default branch and confirm before proceeding.

```bash
git rev-parse <fixed-point>              # must resolve — fail here if not
git diff <fixed-point>...HEAD            # three-dot: compares against the merge-base
git log <fixed-point>..HEAD --oneline    # the commits under review
git rev-parse HEAD                       # record this — findings belong to THIS sha
```

Confirm the diff is non-empty. Check its size (`git diff --stat`): if it's too large for one
sub-agent context, split by file group and note the split — you'll record it as `partial`.

### 2. Find the spec (Spec axis input)

In order, stopping at the first hit:

1. Issue references in the commit messages (`#123`, `Closes #45`).
2. A path the user passed in.
3. A spec or plan file under `docs/`, `specs/`, or `.scratch/` matching the branch or feature.
4. **Baton:** the handoff brief for this task, the progress ledger, or the plan the work started
   from — see the Baton boost below.
5. Nothing found → ask. If the user says there is no spec, the Spec axis skips and says so.

### 3. Find the standards (Standards axis input)

Anything documenting how this repo writes code: `CONTRIBUTING.md`, `CODING_STANDARDS.md`,
`CLAUDE.md` / `AGENTS.md` conventions sections, an ADR folder.

On top of that, the Standards axis **always** carries the smell baseline in
`references/smell-baseline.md` — twelve classic smells that apply even in a repo documenting
nothing. The sub-agent has no other access to it, so paste it in full.

### 4. Find the security sources (Security axis input)

Any `SECURITY.md`, threat model, or security-posture doc, plus the repo's own hardened helpers
(the ones the codebase says to route through — an exec wrapper, a sanitizer, an auth guard).
Breaking one of those is a documented violation, not a heuristic.

On top of that, the Security axis always carries `references/security-baseline.md` — the
vulnerability classes to check any diff against. Paste it in full, same as the smells.

### 5. Run the axes in parallel

Send **one** message containing a sub-agent call per live axis, so they run concurrently and none
sees the others' reasoning. Each returns findings under 400 words.

**Standards** — give it the diff command, commit list, the standards files, and the full smell
baseline:

> Report, per file/hunk: (a) every place the diff breaks a documented standard — cite the file and
> the rule; (b) any baseline smell — name it and quote the hunk. Mark documented-standard breaches
> as hard violations and baseline smells as judgement calls; a documented repo standard overrides
> the baseline. Skip anything tooling enforces.

**Spec** — give it the diff command, commit list, and the spec path or contents:

> Report: (a) requirements the spec asked for that are missing or only partial; (b) behaviour in
> the diff nobody asked for (scope creep); (c) requirements that look implemented but where the
> implementation looks wrong. Quote the spec line for each finding.

**Security** — give it the diff command, commit list, the security docs, and the full security
baseline:

> Report only vulnerabilities this diff introduces or worsens — not pre-existing ones. For each:
> name the class, show the untrusted source and the sink it reaches, and say what an attacker
> gains. If the repo has a hardened helper for this and the diff bypasses it, that's a documented
> violation. Do not report defence-in-depth wishes as vulnerabilities.

Skip any axis whose input is missing, and record why.

### 6. Refute every finding before reporting it

A review's cost is paid by whoever triages it, and a plausible-but-wrong finding costs more than
it saves. Before anything reaches the report, take each finding and **try to kill it**:

- Re-read the actual hunk. Does the code really do what the finding claims?
- Is the "missing" requirement implemented somewhere else in the diff?
- Is the flagged input actually attacker-controlled, or already validated upstream?
- Does a documented repo standard endorse the thing being flagged?
- Is it pre-existing code the diff merely moved?

For anything non-obvious, spawn a fresh read-only sub-agent whose brief is to **refute**, not to
confirm — defaulting to "refuted" when uncertain. Drop what doesn't survive. Report the survivors
with their citation intact. This is the same ≥95% skeptic-corroborated gate the `bug-fix` skill
uses, applied to review findings.

### 7. Aggregate

Present each live axis under its own heading — `## Standards`, `## Spec`, `## Security` — verbatim
or lightly cleaned. **Do not merge or rerank.** Note any skipped axis and why, and any partial
coverage. Close with one line: findings per axis, and the worst issue *within* each axis. Do not
name a single winner across axes — that is exactly the reranking the separation prevents.

### 8. Route each finding to what happens next

A review that ends in prose gets ignored. Every surviving finding gets a route:

| Finding | Route | Why |
| --- | --- | --- |
| Standards violation or smell | **fix directly** | Mechanical; the fix is the finding. |
| Spec: requirement missing/partial | **implement** | It's unbuilt work, not a defect. |
| Spec: implemented but wrong | **`systematic-debugging`** | It's a bug. Root-cause it — patching from a review comment is the symptom-fixing that skill exists to forbid. |
| Security | **`bug-fix`** | Needs reproduction + blast radius, not a quick patch. |

### 9. Persist the review *(Baton — do not skip)*

Chat output dies with the session. Write the findings so any still open ride into the next agent's
handoff brief automatically (`baton take` / `baton resume`), and the daemon serves them at
`/api/reviews`:

```bash
baton review save <slug> <<'JSON'
{
  "fixedPoint": "main",
  "head": "<the sha from step 1>",
  "partial": "reviewed src/ only — 4,200-line diff split by directory",
  "skipped": [{ "axis": "spec", "why": "no spec found" }],
  "findings": [
    {
      "axis": "standards",
      "title": "Duplicated token-parsing logic",
      "file": "src/auth/session.ts",
      "line": 42,
      "source": "baseline: Duplicated Code",
      "detail": "same 9-line parse appears in middleware.ts:88",
      "hard": false,
      "route": "fix-directly"
    }
  ]
}
JSON
```

Then `baton review show <slug>` to confirm, and `baton review resolve <slug> <id>` as each is
handled — use the stable id shown next to each finding, not the positional index, since a
re-review reorders the list. Two behaviours worth knowing:

- Findings recorded against an older sha are flagged **stale** automatically — they may already be
  fixed.
- A re-review **keeps** anything you `--dismiss`ed (so you never re-triage the same noise) but
  **resets** anything marked fixed that the reviewer reports again — if it's still found, it isn't
  fixed, and the fresh report wins.
- Secrets quoted in a hunk are redacted before the record is written; the finding survives, the
  credential doesn't.

---

## Baton boost *(optional — only if Baton is wired into this repo)*

- **`baton review save/list/show/resolve`** — step 9. This is what makes a review durable rather
  than disposable; a `review.completed` event fires so the dashboard and other agents see it.
- **Spec source.** `baton resume` / the handoff brief carries what this task was asked to do, and
  the progress ledger records what was actually done. Either is a legitimate Spec-axis input when
  there's no issue tracker — often a better one, since it's what the working agent was told.
- **`who_touched` / `check_files`** (Baton MCP) — before reporting, check whether another session
  is live-editing files in this diff. A finding against a file someone is mid-edit in is likely
  already stale; say so rather than filing it.
- **`recall_memory`** — pull stored facts about the files under review. A fact that contradicts
  the diff is a strong Standards signal ("this module deliberately does X"). Facts are
  evidence-anchored, so a stale one is withheld rather than served as truth.
- **`query_graph`** — find callers of anything whose signature changed, so the Standards axis can
  see consumers the diff didn't touch.
- **`baton bugs "<symptom>"`** — if the diff claims to fix a bug, check whether that bug has been
  fixed before. A repeat fix in the same place is a root-cause finding, not a Standards one.

---

## Anti-patterns

- Reviewing "the branch" without pinning what it's being compared against.
- Merging the axes into one ranked list — the failure this skill exists to prevent.
- Reporting findings nobody tried to refute.
- Inventing spec requirements because no spec was found.
- Reporting formatting the linter already fixes, or pre-existing issues the diff merely moved.
- Filing baseline smells as hard violations, or flagging a smell the repo's own standards endorse.
- Listing defence-in-depth wishes as security vulnerabilities.
- Ending at chat output, so the findings die with the session.
- Reviewing your own change and calling it review — see verify-before-done for the author-side gate.

## Definition of done

- [ ] Fixed point resolved with `git rev-parse`; diff confirmed non-empty; HEAD sha recorded.
- [ ] Standards sources located; smell baseline passed to the sub-agent in full.
- [ ] Spec located, or its absence explicitly reported.
- [ ] Security sources located; security baseline passed to the sub-agent in full.
- [ ] Axes ran in parallel, in isolated contexts.
- [ ] Every reported finding survived an explicit attempt to refute it.
- [ ] Findings reported under separate headings, each citing a standard, a named smell, a quoted
      spec line, or a named vulnerability class.
- [ ] No cross-axis ranking or combined verdict; skipped axes and partial coverage stated.
- [ ] Each finding carries a route; the review is persisted with `baton review save`.

---

*The two-axis structure (Standards / Spec, never merged) and the smell baseline are adapted from
[mattpocock/skills](https://github.com/mattpocock/skills) `code-review` (MIT). The Security axis,
the refute-before-reporting gate, the routing table, the Baton boost, and the durable review record
are additions.*
