# Step 0 result — handoff eval variance check

Ran against the brief in [TASK-handoff-eval.md](./TASK-handoff-eval.md).
**Verdict: GATE FAILED. Do not build the full eval.**

## What was chosen (per Step 0.1–0.2)

- **Repo:** `prettier/prettier` (public, MIT, clears the >500k-token FWD-11
  break-even — 1,370,882 tokens whole-repo, 345,029 in `src/` alone).
- **Task SHA:** `2bb67ce8cd326dbaccbdec97e7578985f6009a14` (parent of
  `cd54ccc72`, "Avoid corrupting empty Markdown link with title", #19487).
  4-line fix in `src/language-markdown/print/mdast.js`, graded by 5 existing
  snapshot tests. Not tuned for Baton: the failing test names the file, so a
  cold agent has a fair shot too.
- Neither was exercised end-to-end — the gate failed on a cheaper preliminary
  check first (see below), per the brief's own instruction to stop before
  building anything further.

## What was actually run

Not the literal Step 0 protocol (real repo, real task, kill mid-session,
resume via `baton take`, tokens-to-first-correct-edit). Before spending quota
on that, a cheaper proxy: the exact same trivial prompt ("reply with exactly
one word: PONG"), issued 5 times through fresh headless `claude -p` sessions,
Sonnet, task difficulty held at **zero** so any spread is pure measurement
noise, not signal.

| Run | Visible result | Output tokens | Cache read | Cache write | API-equiv cost |
|---|---|---|---|---|---|
| 1 | PONG | 5 | 29,093 | 7,494 | $0.054 |
| 2 | PONG | 171 | 29,093 | 8,111 | $0.060 |
| 3 | PONG | 5 | 29,093 | 7,563 | $0.054 |
| 4 | PONG | 5 | 36,656 | 0 | $0.011 |
| 5 | PONG | 5 | 37,204 | 0 | $0.011 |

Output tokens: **5–171, a 34x spread**, with byte-identical visible output —
the 171 came entirely from invisible thinking-token overhead. API-equivalent
cost: **5.4x spread** ($0.011–$0.060), independently driven by a cache-tier
split (`cache_write=0` = warm cache; `cache_write>0` = expired, ~5x pricier).

(Two earlier one-off probes on Opus, not part of the controlled set, showed
the same pattern: `input=2, output=7` vs `input=2, output=71` on near-identical
one-line prompts.)

## Why this generalizes to the real protocol, not just the proxy

Two independent, uncontrolled sources feed directly into the metric ("tokens
burned before first correct edit"):

1. **Invisible thinking-token variance.** Not tied to task difficulty — it
   showed up on a 1-word reply. A longer real task means more assistant
   turns, i.e. more opportunities for a blip, not fewer. No reason to expect
   it nets out.
2. **Cache-tier switching, structurally triggered by the protocol itself.**
   The split above tracks whether the ephemeral cache (~5 min TTL) was still
   warm. Step 0's own mechanic — kill a session, then resume it via
   `baton take` in a *new* `claude` process — is exactly the kind of gap that
   crosses that TTL. This doesn't sit beside the real test as background
   noise; it's baked into the mechanism being tested, and it hits every run
   in every arm identically, which is worse than random noise because it
   doesn't average out across repeated runs the way independent noise would.

Neither problem is fixed by picking a bigger or more realistic task. Both are
present at the point the metric is captured, regardless of what the agent is
doing.

## Verdict

Spread from mechanics alone (34x tokens, 5.4x cost) is far larger than any
plausible Baton-brief-vs-cold-start effect this eval set out to detect, and
the dominant confound (cache-tier reset) is triggered by the eval's own
kill/resume step. Per the brief: **a negative result here is a success — it
saves the build.** Stopping per the gate. The full 5-run real-task protocol
was not run; this is a deliberate scope decision, not an omission — running
it would very likely have reproduced the same noise at a much higher quota
cost, without changing the verdict.

## What would change this verdict

Not a bigger task or more runs at the same resolution — the confounds don't
average out with volume. What might: an eval design that either (a) measures
something other than raw token counts (e.g. wall-clock turns to first correct
edit, immune to thinking-token variance), or (b) forces cache state to be
identical across arms before each measurement (e.g. a fixed warm-up call
before every resume, so all runs pay the same cache-write tax). Worth a
brainstorming pass before any future attempt — not a quick patch to this run.

## Cost

Nothing charged — no `ANTHROPIC_API_KEY` was set; all runs authenticated via
the existing Claude Code OAuth session (Max plan), so this consumed quota
from the plan's rolling usage window, not a metered bill. Total across all
probes this session: ~$0.52 API-list-price-equivalent (a quota-usage measure,
not a charge).
