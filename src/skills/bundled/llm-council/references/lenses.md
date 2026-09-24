# Lens library

A lens is a way of weighing a decision, not a job title or a character to act out. Pick 3–5 whose
priorities genuinely conflict for the question in front of you. Two lenses that would reach the
same answer for the same reasons waste a seat.

Each entry: **stance** (what it optimizes for) · **always asks** (the question it never skips) ·
**pulls against** (its natural tension partner).

---

### Contrarian
- **Stance:** assumes the favoured option has a serious flaw and hunts for it.
- **Always asks:** "What is the most likely way this goes wrong, and how would we notice?"
- **Pulls against:** Expansionist.
- Not a pessimist for its own sake — its answer must name a concrete failure mode, not a mood.

### First-principles
- **Stance:** throws out the framing and derives the choice from the underlying goal.
- **Always asks:** "Which underlying goal does this serve, and is this choice even the one that
  goal requires?"
- **Pulls against:** Executor.
- Its best output is sometimes "both options solve the wrong problem."

### Expansionist
- **Stance:** looks for upside and second-order opportunity the others discount.
- **Always asks:** "If this works better than expected, what does it unlock — and which option
  leaves that door open?"
- **Pulls against:** Contrarian, Maintainer.

### Outsider
- **Stance:** judges only what is on the page, with none of the team's accumulated context.
- **Always asks:** "Would someone new to this project understand why we chose this, and would it
  seem reasonable?"
- **Pulls against:** Maintainer (insider knowledge) and any lens that leans on jargon.
- Surfaces the assumptions insiders stopped noticing and never wrote down.

### Executor
- **Stance:** cares about the path from here to done with the people and time actually available.
- **Always asks:** "What is the concrete first week of work, and what blocks it?"
- **Pulls against:** First-principles.

### Maintainer
- **Stance:** optimizes for the codebase two years from now — readability, ownership, upgrade pain.
- **Always asks:** "Who maintains this after the author moves on, and what does each option cost
  them every month?"
- **Pulls against:** Expansionist, Executor.

### Security
- **Stance:** treats every new surface, dependency, and data flow as attack surface until shown
  otherwise.
- **Always asks:** "What new trust boundary does this create, and what does an attacker gain if it
  fails?"
- **Pulls against:** Executor, User-advocate (friction vs safety).
- Often acts as a veto check rather than a preference — say so when it does.

### Operator / Cost
- **Stance:** thinks about running it: infra spend, on-call load, observability, failure recovery.
- **Always asks:** "What does this cost to run and to debug at 3 a.m., and how does that scale?"
- **Pulls against:** Expansionist, Performance (when speed costs money).

### User-advocate
- **Stance:** speaks for the person using the product or tool, not the people building it.
- **Always asks:** "What does the user feel or lose under each option — speed, clarity, trust,
  migration effort?"
- **Pulls against:** Maintainer, Security.

### Performance
- **Stance:** measures options by latency, memory, throughput, and how they behave under load.
- **Always asks:** "Where is the hot path, what are the numbers, and which option degrades
  gracefully?"
- **Pulls against:** Maintainer (clever-fast vs plain-readable), Executor.
- Must prefer measured numbers; a guessed benchmark is `[unverified]`.

### Reversibility
- **Stance:** values options that are cheap to undo and keeps the decision small.
- **Always asks:** "If we are wrong in three months, what does backing out cost under each option?"
- **Pulls against:** Expansionist, First-principles (bold rethinks are rarely reversible).

### Ecosystem
- **Stance:** weighs community health, standards, hiring, and how the wider world is moving.
- **Always asks:** "Which option are we still glad we chose when the libraries, docs, and people
  around it have moved on?"
- **Pulls against:** Outsider, Reversibility (betting on a trend vs staying put).

---

## Default seatings

Starting points — swap a lens when the question has an obvious angle these miss. Tier sizes:
quick takes the first 3, standard the first 4, deep all 5.

| Question type | Seats (in tier order) | Main tensions |
|---|---|---|
| **Architecture** (service boundaries, framework, sync vs async) | Maintainer · First-principles · Operator/Cost · Contrarian · Performance | long-term cost vs rethink; run cost vs failure hunting |
| **Library / dependency choice** | Maintainer · Security · Executor · Ecosystem · Contrarian | upgrade burden vs supply-chain risk vs speed to ship |
| **Refactor vs rewrite** | Reversibility · Executor · First-principles · Maintainer · User-advocate | incremental safety vs clean-slate premise; team time vs user disruption |
| **Product / strategy** | User-advocate · Expansionist · Contrarian · Executor · Outsider | upside vs failure mode; user value vs delivery reality |
| **Plan review** ("poke holes in this plan") | Contrarian · Executor · Outsider · Security · First-principles | what breaks vs what ships; insider plan vs fresh eyes |
| **Data model / storage** | Maintainer · Performance · Reversibility · Operator/Cost · Security | migration cost vs speed; lock-in vs flexibility |

## Picking well

- State each tension in one line before dispatch. If you cannot name what two seats disagree
  about, one of them is redundant.
- Include at least one lens that argues against the option the user seems to favour.
- Security belongs on any seat list where the decision adds a dependency, a network boundary,
  auth, or handles user data — even when it is not in the default row.
- For a diversity re-seat (Phase 4): keep the converged seat most central to the question type and
  replace every other converged seat with its "pulls against" partner, or Contrarian if that
  partner is already seated.
