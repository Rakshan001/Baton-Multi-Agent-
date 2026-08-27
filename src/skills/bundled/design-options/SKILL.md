---
name: design-options
description: >-
  Explore several genuinely different design directions side by side before committing to one.
  Gathers context along five dimensions (who, job-to-be-done, what already exists, how users
  arrive, edge cases), reads previously approved designs so generation is biased toward taste
  already demonstrated, then generates named concepts under an anti-convergence rule — any two
  variants that read as siblings get one regenerated in a deliberately different direction.
  Produces self-contained HTML mockups plus a side-by-side comparison board, collects
  approve/reject/iterate per variant for at most three rounds, and extracts design tokens from the
  winner. Use when the user says "show me design options", "explore design variants", "visual
  brainstorm", "I don't like how this looks", or describes a UI feature without having seen what
  it could look like. Pair with design-audit once it is built and running.
---

# Design Options (portable)

Options beat opinions. Generating three real directions costs minutes; discovering the wrong
direction after it ships costs weeks.

```
CONTEXT (5 dimensions) → TASTE MEMORY → CONCEPTS → VARIANTS → COMPARISON BOARD →
STRUCTURED FEEDBACK → ITERATE (max 3) → TOKENS
```

**Golden rules**
1. ⛔ **Anti-convergence.** Every variant must take a visibly different direction. If two look
   like siblings, regenerate one deliberately differently. Three shades of the same idea is
   one idea with extra steps.
2. Concepts in words before pixels — it is far cheaper to reject a sentence.
3. Feedback is per-variant and structured, never "which do you like".
4. Three iterations maximum. Past that, the problem is the brief, not the design.

---

## 0. Context — five dimensions

**Who** (persona, expertise) · **job to be done** · **what already exists** in the codebase ·
**how users arrive** at this screen · **edge cases** (long names, zero results, errors, mobile).

Auto-gather first, ask second — two rounds of questions maximum, then proceed with what you
have:

```bash
cat DESIGN.md 2>/dev/null | head -80 || echo "NO_DESIGN_MD"
ls src/ app/ components/ 2>/dev/null | head -30
```

## 1. Taste memory

Read designs this user already approved and extract what they chose — palette, type, density,
layout instincts:

```bash
find docs/designs -name "approved*" 2>/dev/null | head -10
```

Bias generation toward demonstrated taste. Taste that has been shown beats taste that has been
described.

## 2. Concepts before pixels

Name and describe each direction in one line before generating anything:

```
A) "<name>" — <one-line visual direction>
B) "<name>" — <a genuinely different one>
C) "<name>" — <different again>
```

Apply the anti-convergence rule here, while it is still free.

## 3. Variants and the comparison board

Generate each concept as a **self-contained HTML file with inline CSS** under
`docs/designs/<screen>/`, then a `comparison.html` that shows them in a grid with names and
descriptions. Self-contained matters: the board must open in a browser with no build step.

Populate them with realistic content and the edge cases from context — a design that only
works with a seven-character name is not a working design.

### Convergence check — before you show the board

⛔ Anti-convergence is a rule you must actually test, not one you can assert. Put the variants side
by side and answer honestly:

- Could you tell them apart in a **thumbnail**, with the text unreadable? If not, they differ in
  detail, not direction.
- Do any two share layout skeleton *and* type treatment *and* palette temperature? That is one
  direction rendered twice.
- Does each variant make a **different trade-off** you could name in a sentence — denser vs airier,
  editorial vs utilitarian, colour-led vs type-led?

Any pair failing this gets one of them regenerated before the user ever sees the board. Showing
three near-identical options wastes the only expensive thing here — the user's judgement.

## 4. Structured feedback

Present the board and ask per variant: **approve** · **reject** · **iterate** (with what to
change). Ask specifically about type, palette, layout, hierarchy, and overall feel — "which do
you like" produces an answer nobody can act on.

## 5. Iterate, then land

Approved → save it as `docs/designs/<screen>/approved.html`. Feedback given → regenerate
incorporating it. All rejected → new concepts, genuinely new directions. Three rounds maximum.

Extract the winner's design tokens — colors, type scale, spacing scale — and write
`docs/YYYY-MM-DD-<slug>-design-exploration.md` with the context, the variants and their fate,
the chosen direction and why, and the tokens.

Record it *(Baton — skip if not wired in)*: prefer the `save_memory` MCP tool — it takes the
fact as a structured argument. The `baton memory add` CLI is the fallback; pass the fact as a
single quoted argv value and never build it by interpolating a URL or free text into a
double-quoted shell string, where a backtick or `$(…)` in a decision note would execute.

## Anti-patterns

- Generating variants nobody will compare — this skill needs a feedback round to be worth it.
- Three variants that differ only in accent color.
- Mockups full of lorem ipsum, which hides every real layout problem.
- Skipping the tokens: an approved mockup nobody can rebuild from is a screenshot.
