---
name: validate-idea
description: >-
  The "should this exist at all" gate, run before any code is written. Two modes picked from your
  goal — Startup mode asks six forcing questions (demand reality, status quo, desperate
  specificity, narrowest wedge, observation, future-fit) and pushes on every vague answer under
  explicit anti-sycophancy rules; Builder mode runs a lighter design-thinking diagnostic for side
  projects, hackathons, learning and open source. Then calibrates ambition with an explicit scope
  mode (EXPAND / SELECTIVE / HOLD / REDUCE), maps the current state against the 12-month ideal,
  and produces 2-3 costed implementation alternatives ending in a design doc and one concrete
  assignment. Use when the user says "office hours", "brainstorm this", "I have an idea", "is this
  worth building", "think bigger", or "help me think through this" — or whenever they describe
  something that does not exist yet. Produces the design doc that plan-review reviews.
---

# Validate the Idea (portable)

A product diagnostic, not a brainstorm. The job is to make sure the problem is understood
before any solution is proposed — and to make the user uncomfortable enough to find out
whether the problem is real.

⛔ **HARD GATE: produce a design doc, not code.** No scaffolding, no "quick prototype",
no implementation skill invoked from here.

```
CONTEXT → GOAL QUESTION (routes the mode) → DIAGNOSTIC (startup | builder) →
SCOPE MODE → ALTERNATIVES → DESIGN DOC → ONE ASSIGNMENT
```

---

## 0. Context *(Baton — skip if not wired in)*

Recall before exploring: `recall_memory` (MCP) or `baton memory`. Read `CLAUDE.md` /
`AGENTS.md`, skim `git log --oneline -20`, and list prior design docs:

```bash
ls -t docs/*-design*.md 2>/dev/null | head -5
```

If prior designs exist, name them. Re-deciding something already decided is the most common
waste in this skill.

## 1. The goal question

Ask it for real — the answer decides everything downstream:

> Before we dig in — what's your goal with this?
> **Startup** · **Internal project** · **Hackathon / demo** · **Open source / research** ·
> **Learning** · **Having fun**

Startup or internal → **Startup mode**. Everything else → **Builder mode**.

For startup mode also establish the stage: pre-product, has users, or has paying customers.

---

## 2A. Startup mode — the diagnostic

**Operating principles.** Specificity is the only currency: "enterprises in healthcare" is not
a customer. Interest is not demand — waitlists and "that's interesting" count for nothing;
behaviour and money count. The user's words beat the founder's pitch. The status quo, not a
competitor, is the real rival. Narrow beats wide, early.

**Anti-sycophancy rules — never say these:**

| Don't say | Say instead |
| --- | --- |
| "That's an interesting approach" | Take a position on whether it works |
| "There are many ways to think about this" | Pick one, and name what would change your mind |
| "You might want to consider…" | "This is wrong because…" / "This works because…" |
| "That could work" | Say whether it *will*, based on the evidence given |

Take a position on every answer, and challenge the *strongest* version of the claim, never a
strawman. Push once, then push again — the first answer is always the polished one.

**The six forcing questions.** Ask ONE AT A TIME. Route by stage — you rarely need all six:
pre-product → Q1-Q3 · has users → Q2, Q4, Q5 · paying customers → Q4-Q6 · pure infra → Q2, Q4.

1. **Demand reality** — "What's the strongest evidence someone would be genuinely *upset* if
   this vanished tomorrow?" Push until you hear behaviour, not sentiment. Red flags: waitlist
   counts, "people say it's interesting", investor enthusiasm.
2. **Status quo** — "Walk me through exactly what they do today — the spreadsheet, the Slack
   thread, the workaround." Red flag: "there's no solution today", which usually means the
   problem isn't painful enough to act on.
3. **Desperate specificity** — "Name one person, at one company, with a role, who'd be upset."
   Red flag: a persona instead of a person.
4. **Narrowest wedge** — "What's the smallest version someone pays for *this week*?" Red flag:
   "we need the full platform first."
5. **Observation** — "When did you last *watch* someone struggle with this — not a demo?" If
   never, that is assignment #1.
6. **Future-fit** — "It works, revenue grows — what breaks in 12 months?" Red flag: "nothing."

## 2B. Builder mode — the diagnostic

Enthusiasm is the asset here; focus it, don't dampen it. Scope is the enemy, shipping early is
the teacher, and if the goal is learning then learning velocity beats the artifact.

One sentence each: what are you building · who is it for (and "me" is a valid answer) · what's
the pain and the current workaround · minimum version vs the "wouldn't it be cool" version ·
timeline · stack.

---

## 3. Scope mode

Ambition is a decision, so make it explicitly. Present four and ask which:

1. **SCOPE EXPANSION** — propose the ambitious version; every expansion is opted into
   individually.
2. **SELECTIVE EXPANSION** — current scope is the baseline; show what else is possible and
   cherry-pick.
3. **HOLD SCOPE** — the scope is right; spend the rigor on making it bulletproof.
4. **SCOPE REDUCTION** — it's overbuilt; strip to what ships value.

Context-aware defaults: greenfield → EXPANSION · enhancement → SELECTIVE · bug fix or
refactor → HOLD · plan touching >15 files → suggest REDUCTION · user says "go big" →
EXPANSION, don't ask.

Then map the trajectory, because a plan that solves today and blocks next year is a bad plan:

```
CURRENT STATE  --->  THIS PLAN  --->  12-MONTH IDEAL
[what exists]        [the delta]      [where this should end up]
```

If expanding: present each expansion **individually** — add / defer / skip. A bundle of
expansions approved in one breath is not a decision.

## 4. Alternatives

Always 2-3, never one. One must be genuinely minimal, one must be the best long-term shape,
and they carry equal weight — do not default to minimal:

```
A: The Narrow Wedge   — includes / excludes / effort / risk / how we'd know it worked
B: The Balanced Build — …
C: The Full Vision    — …
RECOMMENDATION: <one> because <one line>.
```

Ask which to proceed with.

## 4b. Specificity gate — before the doc is written

⛔ The design doc becomes the thing everyone builds from, so a vague answer written down becomes a
vague answer with authority. Re-read your captured answers and send back any that fail:

| Answer looks like | Verdict |
| --- | --- |
| A category ("developers", "healthcare teams") | ✗ not a person — return to Q3 |
| A sentiment ("people love it", "great feedback") | ✗ not behaviour — return to Q1 |
| A number with no behaviour behind it ("500 signups") | ✗ interest, not demand — return to Q1 |
| "They have no solution today" | ✗ usually means no pain — return to Q2 |
| A roadmap ("first X, then Y, then Z") | ✗ the wedge is not narrow — return to Q4 |
| "We haven't watched anyone yet" | ✓ valid — this becomes the assignment |

⛔ **Write the answer you actually got, not the answer you wish you got.** If the founder never
produced a specific answer, the doc records that the question is open — an unanswered forcing
question is the single most valuable line in the document, and smoothing it over is the failure
this whole skill exists to prevent.

## 5. Design doc

Write `docs/YYYY-MM-DD-<slug>-design.md`: problem statement, target user (a person, not a
category), status quo, the diagnostic answers with what pushback produced, scope mode chosen,
the alternatives, the recommendation, and next steps as concrete actions rather than
strategies.

Record it *(Baton — skip if not wired in)*: prefer the `save_memory` MCP tool — it takes the
fact as a structured argument. The `baton memory add` CLI is the fallback; pass the fact as a
single quoted argv value and never build it by interpolating a URL or free text into a
double-quoted shell string, where a backtick or `$(…)` in a decision note would execute. Store the decision and its *reason* — a fact, not a diary entry.

## 6. Close with one assignment

End with exactly three things: **the assignment** (one concrete thing to do next — usually
"go watch someone struggle with this"), the design doc path, and the next skill —
normally `plan-review` to lock architecture.

## Anti-patterns

- Running this for a typo fix or a well-understood chore. It wants a problem worth diagnosing.
- Accepting the first answer to any forcing question.
- Producing alternatives that are the same plan at three sizes.
- Approving a batch of scope expansions in one question.
- Writing code "just to show what I mean".
