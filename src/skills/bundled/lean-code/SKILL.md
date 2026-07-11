---
name: lean-code
description: >-
  Stop over-engineering (a.k.a. Ponytail / lazy-senior-dev mode / YAGNI). Before writing code,
  climb a restraint ladder — does this need to exist at all, does a helper already live in this
  repo, does the stdlib or the platform already do it, can it be one line — and build the
  smallest thing that actually works. Never simplify away validation, error handling, security,
  or accessibility. Use on ANY coding task (writing, refactoring, fixing, reviewing, choosing
  dependencies), and whenever the user says "lean code", "ponytail", "be lazy", "yagni",
  "do less", "simplest solution", or "shortest path", or complains about over-engineering,
  bloat, boilerplate, or unnecessary dependencies. Do NOT use for non-coding requests.
---

# Lean code — build the smallest thing that works

> The best code is the code you never write. Be a lazy senior developer: lazy means *efficient*,
> not careless. Reach for the shortest solution that fully solves the problem — and stop.

Over-engineering is the default failure mode of a coding agent: it invents a class, a config
system, and three abstraction layers for what a helper and one function would cover. This skill
is the reflex against that.

## Persistence

Once invoked, this stays active **every response** — no drift back to over-building as the
session gets long. Still active if unsure. Off only when the user says "stop lean code" /
"normal mode".

## Understand first, then climb

The ladder is a reflex, **not** a substitute for understanding. Read the task and the code it
touches, trace the real flow end to end, *then* climb. A small diff you don't understand is
laziness dressed up as efficiency — it isn't lean, it's a guess.

## The restraint ladder

Stop at the **first** rung that holds. Say in one line what you skipped and why.

1. **Does this need to exist at all?** Speculative need — a flag nobody asked for, a hook for a
   future that may never come → skip it (YAGNI). Name it and move on.
2. **Does it already exist in this repo?** A helper, util, type, or pattern a few files over →
   reuse it. Re-implementing what's already here is the most common slop. *With Baton: query the
   knowledge graph / `CODEBASE.md` before writing — that's what the map is for. Heed the graph's
   freshness warning: for files it flags as having uncommitted edits, re-read the file itself —
   a stale graph answer is how duplicate functions get born.*
3. **Does the standard library do it?** Use it. `stdlib` over a hand-rolled version.
4. **Does a native platform feature cover it?** `<input type="date">` over a picker library, CSS
   over JS, a DB constraint over app-level checks.
5. **Does an already-installed dependency solve it?** Use it. Never add a *new* dependency for
   what a few lines can do.
6. **Can it be one line?** Then it's one line.
7. **Only then:** write the minimum code that works — nothing built for a requirement you don't
   have yet.

**Bug fixes climb too:** fix the root cause in the shared function, not the one caller the ticket
names — the lazy fix (one guard in the shared path) is both the smaller diff and the correct one.
(For the full bug workflow, use the **bug-fix** skill; this skill keeps *its* diffs lean.)

## Rules

- **No unrequested abstractions:** no interface with one implementation, no factory for one
  product, no config option for a value that never changes.
- No boilerplate, no scaffolding "for later" — later can scaffold for itself.
- **Deletion over addition. Boring over clever** — clever is what someone decodes at 3am.
- Fewest files possible; the shortest working diff wins *once you understand the problem*.
- A deliberate shortcut with a known **ceiling** names the ceiling and the upgrade path in a
  comment: `// lean: global lock — switch to per-account locks if throughput matters`.
- Two equally short options? Take the one that's correct on edge cases — lazy means writing
  less code, not picking the flimsier algorithm.

## Output

Code first. Then at most three short lines — pattern: `[code] → skipped: [X], add when [Y]`.
If the explanation is longer than the code, delete the explanation: every paragraph defending
a simplification is complexity smuggled back in as prose. (Explanation the user explicitly
asked for is not debt — give it in full.)

## The restraint dial *(advisory)*

- **lite** — build what's asked, but name the leaner alternative in one line; the user picks.
- **full** *(default)* — the ladder enforced: shortest diff, shortest explanation, defer the rest.
- **ultra** — YAGNI extremist: ship the one-liner and challenge the rest of the requirement in
  the same breath. Deletion before addition.

## Never simplify these away

Lean is about *unnecessary* code, never *necessary* code. These are not optional and are never
golfed away:

- **Input validation at trust boundaries** (user input, network, file, env).
- **Error handling that prevents data loss** or silent corruption.
- **Security** — authn/z, escaping, secrets handling, injection defenses.
- **Accessibility basics** — labels, roles, keyboard paths, contrast.
- **Anything the task explicitly asked for.**

And: lean code without its check is unfinished. Non-trivial logic **leaves one runnable check
behind** — the smallest thing that fails if the logic breaks (an assert-based self-check or one
small test; no frameworks, no fixtures). Trivial one-liners need none.

## Example

> *"Add a cache for these API responses."*
>
> - **full:** `@lru_cache(maxsize=1000)` on the fetch function. Skipped the custom cache class —
>   add one only when `lru_cache` measurably falls short.
> - **ultra:** No cache until a profiler asks for one. When it does: `@lru_cache`. A hand-rolled
>   TTL cache class is a bug farm with a hit rate.

`references/ladder-examples.md` has more before/after pairs.

---

*Adapted from **Ponytail** (github.com/DietrichGebert/ponytail, MIT) — the "lazy senior
developer" restraint discipline — and tuned for Baton (reuse-before-write pairs with the
knowledge graph; keeps multi-agent diffs small and cheap).*
