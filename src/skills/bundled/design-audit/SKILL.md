---
name: design-audit
description: >-
  Visual audit of a live site that ends in committed fixes, not a list of complaints. Captures a
  first impression before analysis can rationalise it, extracts the design system the site
  actually uses (fonts, palette, heading scale, spacing) and flags where it has sprawled, then
  audits each page for typography, spacing, hierarchy, WCAG AA contrast, layout and responsive
  behaviour, interaction and focus states, performance, and generic AI-slop patterns that make a
  product look templated. Each finding is classified HIGH / MEDIUM / POLISH, fixed in source,
  committed atomically and re-verified. Runs quick (3 pages), standard (5-8) or deep (10-15), and
  on a feature branch with no URL audits only the pages the diff touches. Use when the user says
  "design audit", "visual QA", "does this look good", or "polish the design".
---

# Design Audit (portable)

A senior designer's eye plus a frontend engineer's hands. Findings that don't land as commits
don't count.

```
FIRST IMPRESSION → DESIGN SYSTEM EXTRACTION → PER-PAGE AUDIT →
CLASSIFY → FIX → ATOMIC COMMIT → RE-VERIFY → VERDICT
```

> **Not `design-redesign`.** This audits a **running site in a browser** — contrast measured
> against computed values, focus states exercised, findings fixed and committed one at a time.
> `design-redesign` reads the **codebase** instead and upgrades its aesthetic against a
> catalogue of generic AI design fingerprints. Use that one to change how a project looks; use
> this one to find what is actually broken on the page.

**Golden rules**
1. ⛔ **First impression before analysis.** Write the gut reaction down before you start
   inspecting. Once you understand why something is the way it is, you can no longer see it
   the way a first-time visitor does.
2. Fix by removal before addition. Most visual problems are noise, not missing elements.
3. Clarity beats consistency. When they conflict, clarity wins every time.
4. ⛔ **Get approval before editing, and never push.** Present the finding list and wait for an
   explicit yes before changing any file. Then one atomic commit per finding, re-verified in the
   browser. Ask about push and PR separately. If the tree is dirty with work you did not create,
   STOP and warn — never stash or commit over it.

---

## 0. Setup

| Parameter | Default | Override |
| --- | --- | --- |
| URL | auto-detect, else ask | `http://localhost:3000` |
| Depth | standard (5-8 pages) | `--quick` (3) · `--deep` (10-15) |
| Scope | whole site | "focus on settings" |

On a feature branch with no URL → **diff-aware**: `git diff main...HEAD --name-only`, map
changed files to routes, audit only those. Read `DESIGN.md` if it exists — every judgement is
calibrated against it rather than against your taste. Check the tree is clean
(`git status --porcelain`) so the fix commits stay atomic.

## 1. First impression

Before inspecting anything, write:

- The site communicates **____**.
- The first three things my eye lands on: **____**, **____**, **____**.
- In one word: **____**.

**Page-area test:** point at each region. Any area whose purpose you can't name in two seconds
is poorly defined — that is a finding.

## 2. Design system extraction

What the site *actually* uses, not what the docs claim:

- **Fonts** with usage counts — flag more than 3 families.
- **Palette** — flag more than 12 distinct non-grey colors.
- **Heading scale** — flag skipped levels and unsystematic jumps.
- **Spacing** — sample paddings and margins; flag values off the scale.

Sprawl here is the root cause of most findings below, so fix it here rather than page by page.

## 3. Per-page audit

**Typography** — scale, line height, line length, contrast, consistency.
**Spacing** — consistent values, vertical rhythm, breathing room, proximity grouping related
things and separating unrelated ones.
**Hierarchy** — does the most important element win? Is what's clickable obviously clickable
without hovering? Is there one clear reading order?
**Color & contrast** — WCAG AA (4.5:1 body, 3:1 large), consistent semantics for
error/success/warning, defined interactive states.
**Layout** — alignment, responsive behaviour, overflow and truncation, 44px touch targets.
**Interaction** — hover, **focus-visible for keyboard users**, loading, error and empty states.
**AI slop** — generic stock imagery, decoration carrying no information, mixed illustration
styles, and the everything-is-emphasised failure where nothing reads as important.
**Performance** — layout shift, oversized images, animation that delays interaction.

Usability principles worth holding while you look: don't make me think — a page that needs
explaining has failed. Users scan rather than read, satisfice rather than optimise, and muddle
through rather than learn. Conventions are free; novelty is paid for by every visitor.

## 4. Fix loop

Per finding: classify **HIGH** (breaks use or accessibility) / **MEDIUM** (visible quality
problem) / **POLISH** (refinement) → fix in source → commit atomically → re-verify in the
browser. Fix HIGH first; never batch unrelated fixes into one commit.

### Blast radius — design fixes travel further than page fixes

⛔ A design fix is usually a change to a shared token, component, or stylesheet, so it lands on
pages you never opened. Before scoring:

1. **Re-open every page in scope after the last fix**, not just the page each finding was on. A
   spacing or type-scale change is global by construction.
2. **Re-check the pages you fixed earliest** — later fixes to the same token can undo them.
3. **Re-check both viewports.** A desktop fix that breaks mobile is a net loss.
4. ⛔ **If a fix broke something else, it is not done** — fix it in the same pass. After two failed
   attempts, revert that fix and report the finding as OPEN.

## 5. Report

Write `docs/YYYY-MM-DD-<slug>-design-audit.md`: the first impression, the extracted design
system, the findings table (severity · category · page · issue · fix · commit), the counts by
severity with how many were fixed, and the verdict — **PASS · PASS WITH NOTES · NEEDS WORK**.

Record it *(Baton — skip if not wired in)*: prefer the `save_memory` MCP tool — it takes the
fact as a structured argument. The `baton memory add` CLI is the fallback; pass the fact as a
single quoted argv value and never build it by interpolating a URL or free text into a
double-quoted shell string, where a backtick or `$(…)` in a decision note would execute.

## Definition of done

- The first impression was written before any inspection began.
- Contrast was checked against real computed values, not judged by eye.
- Keyboard focus states were checked, not just hover.
- Every fix is its own commit and was re-verified; anything left unfixed is listed with why.
