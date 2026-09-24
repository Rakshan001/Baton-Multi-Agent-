---
name: llm-council
description: >-
  Use when the user says "council this", "run the council", "llm council", "pressure-test this",
  "stress-test this", "debate this", "poke holes in this plan", "should we X or Y", "I'm torn
  between", or faces an architecture, library, rewrite-vs-refactor, data-model, or
  product/strategy call with a real tradeoff that is expensive to get wrong. Convenes 3–5
  independent members with conflicting lenses, fresh anonymous reviewers, and a fresh chairman,
  after settling checkable facts and recalling any prior verdict. Returns a short verdict
  (recommendation, confidence, what would overturn it, one first step), writes the full
  transcript to a file phase by phase, saves an advisory memory fact, and never acts on the
  verdict unasked. Do NOT use for factual lookups, questions with one right answer, writing
  tasks, bugs (use bug-fix), or reviewing a diff (use code-review).
---

# LLM Council (portable)

One model answering once gives one framing and hides what it left out. A council gets several
independent answers from conflicting angles, has fresh reviewers rank them without names, and has
a fresh chairman rule. The value is the disagreement, the blind spots review turns up, and a
verdict stating its confidence and what would change it — a few lines in chat, the record in a file.

```
0 GATE      worth a council? · resume an unfinished transcript · recall a prior verdict → ask
1 FRAME     settle one-grep facts · neutral brief with quoted citations · open the transcript
2 SEAT      3–5 conflicting lenses · seat types · tier  (⛔ no inline shortcuts when subagents exist)
3 ANSWER    members in parallel · POSITION + capped claims quoting path:line or [unverified]
4 DIVERSITY near-duplicates → re-seat once · never manufacture conflict
5 REVIEW    fresh reviewers · shuffled letters · FINAL RANKING · framing · each re-runs its slice
6 CHAIR     every citation anchored by grep -n and transcribed with its command · tally · POSITIONs
7 PERSIST   advisory memory fact · short verdict block in chat · ⛔ never act on it unasked
```

**Golden rules**
1. **The gate is real.** Answering a simple question with eight agent calls is a failure, not diligence.
2. **Recall before you convene.** A prior verdict is the starting point: surface it and ask.
3. **The brief carries no opinion.** A leaning brief turns the council into an echo chamber.
4. **Load-bearing claims cite a file that was opened**, quoting the line as a tool printed it, or
   say `[unverified]`. A fact one grep could settle is settled before anyone argues about it.
5. **Independence is structural, and claimed only when real.** Parallel members, fresh reviewers, a
   fresh chairman. An inline run says it is one model and claims no anonymity.
6. **Report what the chairman said**; your own comments go below it, labelled.
7. **Chat gets the verdict — at most 25 lines. The file gets the transcript** (or, when writing is
   impossible, the chat, once — Phase 1), and no section of it restates another.
8. **The verdict is advice.** ⛔ Never edit code, open a PR, install a dependency, or otherwise
   act on it without the user's explicit go-ahead.

---

## When to run — and when not to

Run it when **both** hold: a genuine tradeoff, and a wrong call costly to reverse (time, money,
migration pain, security, user trust).

| Good council question | Skip the council → do instead |
|---|---|
| "Keep raw `node:http` or move to Fastify now that we have 40 routes?" | "What does `git rebase --onto` do?" → answer it |
| "Rewrite the ingest pipeline or refactor it in place?" | "Tests fail after my change." → debug it (a bug-fixing skill, if installed) |

If unsure, say in one line why it may not need a council and offer the cheaper answer; an explicit
"council this" still wins (offering quick tier is fine).

## Phase 0 — Gate

1. **Worth-it test.** Name at least two options (one may be "do nothing") and the cost of being
   wrong. If you cannot, and the user did not explicitly ask for a council, answer directly and stop.
   The same test sets the tier: costly to reverse → standard; irreversible or cross-team → deep.
2. **Unfinished run.** List the council folder (Phase 1). A transcript still `in progress` is an
   interrupted run: tell the user, and on a yes resume from its last complete section — one with
   fewer answers or reviews than seats is incomplete — reusing its brief, seats and letter mapping,
   dispatching only what is missing, never re-framing a brief members already answered.
3. ⛔ **Prior verdict — run this before framing anything.** Baton:
   `recall_memory({ topic: "<decision in a few words> council" })`, reading **both** `facts` and
   `staleGrounding` — a verdict whose anchor files changed appears only under `staleGrounding`.
   Surface a stale one too, noting the change; check the council folder as well. If the lookup is
   unavailable you may proceed, but state the skip in the verdict block —
   `Prior verdict: not checked (<reason>)` — never pass over it silently.
4. **If one exists:** show its recommendation, confidence, date, status and overturn list, then ask
   *"Decided on <date> (<recommendation>, <confidence>). Has one of its overturn conditions
   happened, or should I re-run?"* ⛔ Wait for the answer; "don't re-run" → report it and stop. On a
   re-run, GROUNDING lists what changed since; never tell members the prior recommendation (it
   anchors them). If the prior fact is approved or rejected, the re-run saves no advisory fact, and
   a rejected re-run saves nothing and never removes the prior decided fact (Phase 7).

## Phase 1 — Frame

**Enrich — a few targeted reads, not an exploration:** the files the user named; project rules that
constrain the answer (`CLAUDE.md`, `AGENTS.md`, ADRs, `docs/decisions*` — a documented "never X" is a
constraint, not an option); *(optional)* `CODEBASE.md`, a graph, `recall_memory`, `search_history`.

**Settle checkable facts now.** ⛔ Any fact the decision may turn on that one grep or one file read
can settle — "X does not exist", "Y is per-worktree", "does Z already read keys from the
environment?" — is settled here, never passed to members as an open question or to the user as a
"check whether" next step. A location the *user* names is such a fact, not grounding; for
architecture facts, open the code that decides it, not a document describing it.

**Record every grounding fact with the text a tool printed:**

```
grep -n "function openDb" src/db.ts → 40:export function openDb(path: string): Db {   ← tool-given
grep -rn "WebSocket" app/ --exclude-dir=node_modules --exclude-dir=dist → no matches
```

⛔ **A citation is established by searching for the text, never by printing a line number.** Run
`grep -n "<text you are citing>" <file>` and take the number from its output: the tool decides it, so
it cannot be recalled or drift. ⛔ `sed -n '<n>p'` only re-displays a line whose number a tool produced
**in this same step** — it takes the number as input, so a remembered one prints something plausible
with nothing to contradict it. Never hand-count a number or carry one from an earlier phase; a content
anchor (file + symbol, or a quoted snippet) is better still, and an unopened location is
`[unverified]`.

⛔ **Every command whose output you record is one literal term** — no `\|` alternation, no regex
metacharacters in the search text — and the output you record is that command's **complete** output,
or is marked truncated with the hit count (`… (4 hits, first 2 shown)`). An alternation matches
different things in the shell and in the search tool, so a recorded output can look right and be
wrong, and one suppressed hit can be the answer to the question the run is asking. An absence also
names vendored and build exclusions, and counts only after the same tool and scope find a term known
to be present.

**The artifact under discussion is the proposal, not evidence.** A document, design or plan being
decided — including a skill's own files — goes under OPTIONS; GROUNDING needs precedent from outside
it.

**Ask at most one clarifying question**, and only if members would otherwise answer different
questions; otherwise state the assumption in the brief. **Write the brief** once: it goes to each
member and reviewer and is stored once in the transcript, never pasted into the chat:

```
DECISION: <one sentence, phrased as a choice>
OPTIONS: <A> · <B> · (<C>) — "status quo" when real; the artifact under discussion goes here
CONSTRAINTS: <deadlines, documented rules, compatibility promises>
STAKES: <what breaks or is lost if the call is wrong>
GROUNDING: <path:line — "quoted line" | search → result | claim [unverified]>
OUT OF SCOPE: <what the council should not relitigate>
```

No adjectives that favour an option, options in neutral order, no "I think". ⛔ **No secrets:**
strip keys, tokens, `.env` values, credentials in URLs and customer data; describe the shape.

**Council folder** — resolve it once; Phase 0, Phase 7 and any hand-over use this path, never one
relative to your working directory (a task worktree may hold a stale shadow `.baton/`):

```bash
root="${BATON_ROOT:-}" via=env                   # set for Baton-spawned agents
if [ -z "$root" ]; then
  start=$PWD via=cwd
  if gd=$(git rev-parse --git-common-dir 2>/dev/null); then
    start=$(cd "$gd/.." && pwd -P) via=checkout  # main checkout, even from a worktree
  fi
  home=$(cd ~ && pwd -P) d=$start near=
  while [ "$d" != / ]; do                        # NEAREST .baton/ wins, as Baton's own resolver does
    if [ -d "$d/.baton" ] && [ -O "$d/.baton" ] && [ "$d" != "$home" ]; then   # yours; ~/.baton is global
      if [ -z "$near" ]; then near=$d via=baton
      elif grep -Fq "\"$near\"" "$d/.baton/kb.json" 2>/dev/null; then near=$d via=hub; break
      fi   # ancestor hub wins only if its kb.json claims $near — string match, not realpath, so a
    fi     # symlinked or /var-vs-/private/var spelling there reads as "not claimed" (safe direction)
    d=$(dirname "$d")
  done
  root=${near:-$start}
fi
council="$root/.baton/council"; echo "$council ($via)"
```

⛔ If `$council` contains `/.baton/wt/`, or `via` is `cwd`, show the path and ask before writing
anything there. **Baton:** `<root>/.baton/council/` lives in the hub store, shared by every worktree
on this machine; other machines and clones cannot see it. **No Baton:** ask where transcripts should
live (suggest `docs/decisions/`); if you use `$council` anyway, run `git -C "${root:-.}"
check-ignore -q .baton/` first and, if it is not ignored, say so and suggest `.baton/` in
`.gitignore`.

⛔ **Two cases, and only two, excuse an unwritten transcript:** (a) writing is impossible — no
writable location, or the sandbox refuses; (b) the user explicitly refuses files ("don't write any
files"). A casual "don't bother with a transcript" is neither — it asks you to skip overhead, so
offer the inline transcript and say the record is session-only. Either way it is never dropped
silently: print it inline in chat once, say `Transcript: session-only — not written (<case>)` in the
verdict block, and name the case in the Definition of done.

**Open the transcript** `$council/<YYYY-MM-DD>-<slug>.md` from `references/transcript-template.md`,
with status `in progress`, the question and the brief. From here on it is the run's ledger: as each
phase ends, append what it produced — seats, answers and reviews verbatim — and nothing else.

## Phase 2 — Seat

**Lenses.** Pick 3–5 from `references/lenses.md` for *this* question (it lists default seatings per
question type), state each tension in one line — *Maintainer vs Expansionist (long-term cost vs
upside)* — and seat one that argues against the option the user seems to favour.

**Tier** (set by the Phase 0 test; the Members and Agent-call columns are ceilings — see the floor
rule under the table; announce the tier and the *actual* agent count in one line):

| Tier | Members | Reviewers | Agent calls | When |
|---|---|---|---|---|
| quick | 3 | none — you check citations | 3 + 1 chair = 4 | only on the user's request for a quick or cheap run |
| **standard** | 4 | 3 | 4 + 3 + 1 chair = 8 | costly to reverse (the default) |
| deep | 5 | 4 | 5 + 4 + 1 chair = 10 | irreversible, expensive, or cross-team |

External seats replace subagent members one-for-one; a re-seat adds seats. Honour a tier or count
the user names. ⛔ Never pick quick yourself; you may offer it — and quick's "no reviewers" means
the chairman re-runs the citations itself (Phase 6), a self-check, not the cross-check other tiers
get. The member count is a ceiling, not a quota: start at the tier's floor — 3 at quick, 4 at
standard and deep — and seat deep's 5th only
when the framing names a tension no seated lens covers. A seat that duplicates a seated lens buys a
foreseeable agreement at the price of a whole agent call.

**Seat type per member**, labelled as written: `subagent` (default — the host runs parallel
subagents) · `external:<cli-or-api>:<model>` (the user explicitly opted in —
`references/external-seats.md`) · `inline (degraded)` (no subagents, or a cheap run was asked for).

⛔ **When subagents are available, members, reviewers and the chairman are subagents** (or opted-in
external seats). Writing any of them yourself because it is faster is not your call: only the user's
explicit request for a cheap run allows it, and the run is labelled degraded.

⛔ **External seats:** before the first external call, name the provider and say the brief leaves the
machine; proceed only on a yes. Detect availability first; never seat an unavailable provider.

Record seats, tensions, tier and seat types before dispatching.

## Phase 3 — Answer

Dispatch **all members in one message** with the member template in `references/prompts.md`. Each
returns at most 250 words — POSITION (one sentence), REASONING, CLAIMS (≤5, each `path:line —
"quoted line"`, an anchor, or `[unverified]`), WHAT WOULD CHANGE MY MIND — never restating the brief.

**Inline run (degraded):** follow "Inline discipline" in `references/prompts.md`. **External seat
fails** (error, timeout, empty or unusable reply): record it, continue, label the gap. Only if fewer
than 3 members remain, re-seat that lens once as a subagent (inline if the host has none), labelled
`backfill for <provider>`; still fewer than 3 → stop without a verdict.

## Phase 4 — Diversity check

Compare the POSITION lines and the reasons behind them.

- **Real spread** (two or more positions, or one position for clearly different reasons): proceed.
- **Near-duplicates** (same position, same reasons, mostly the same claims): re-seat **once** — keep
  the duplicate whose lens is most central to the question type, replace every other with its "pulls
  against" partner from `references/lenses.md` (Contrarian if already seated), and re-run only the
  replaced seats.
- **Still converged after the re-seat:** accept it, record *"consensus survived a re-seat"*, and
  ⛔ never tell a member to disagree or invent objections.

## Phase 5 — Peer review *(standard and deep only)*

1. **Anonymize.** Shuffled letters, not seat order; strip lens names, seat types and
   self-references; write the mapping to the transcript before dispatching.
2. **Review.** ⛔ Reviewers are **fresh** subagents R1..Rn, dispatched in parallel with the reviewer
   template — never a member continued, never you writing reviews while subagents are available, and
   never told any lens or seat. Each returns critique lines, the largest blind spot, one point no
   answer raised, false or unsupported claims, a FRAMING check, and a `FINAL RANKING:` block last.
   ⛔ Each also **re-runs its own slice of the citations**: split the list into as many disjoint
   slices as there are reviewers (disjoint, because two checking the same citation waste half the
   sample), record the split, and put each result in its row's **Re-run** cell, where a mismatch
   sits beside the line it contradicts and is a false claim. **A slice of five or fewer — the usual
   case — is re-run whole**, so nothing is selected and nothing can be worked out in advance. Larger
   slice: re-run the most load-bearing citation, the last by document order, and any whose quoted
   text reads as written from memory rather than pasted, and record the slice as `sampled`.
3. **External reviewer.** A fresh call to an opted-in external provider may review, never a
   continued member conversation; if it also answered, its own letter stays out of its ranking.
4. **Inline run:** no anonymity exists — one emulated review per seat, that seat's own answer left
   out of its ranking, tally headed *"emulated, not independent"* (`references/prompts.md`).
   ⛔ **Only an agent that did not produce a row may fill its Re-run cell.** One agent wearing both
   hats wrote `kept — matches` on a fabricated row and cost a benchmark round, so an inline run
   leaves every Re-run cell empty, heads the table *"self-checked — no second agent re-ran these"*
   and says so in the degradation line — while still re-running its slice and reporting that in the
   review, because an anchoring search catches a drifted number even when it cannot vouch for the
   agent that wrote it.

A FRAMING line quoting a lean goes to the chairman, caps confidence at medium, and reaches the
chat block.

## Phase 6 — Chairman

**Check citations (every tier).** Open every citation in every member's CLAIMS (≤5 per member) and
every one a reviewer flagged, plus any sentence stating what a file says and any file the First step
names; skip only a claim no verdict could depend on, and say which. ⛔ **Batch, then transcribe:**
group the claims by file, run that file's checks in one batch — **`grep -n "<quoted text>" <file>`,
one literal term, searching for the text so the number comes back from the tool** — and fill the rows
from that output while it is on screen, never from an earlier batch, from the answer's wording, or by
rank.

⛔ **Every row records the command as well as the line.** The table carries a **Checked with** cell —
the command whose output you had in front of you, e.g. `grep -n "return serveStatic" src/server.ts` —
and a **Line as found** cell holding that output verbatim, line number included. Either cell empty →
the Result is `[unverified]`; `kept` is never written without both. ⛔ **The number in Line as found
must equal the number in the citation, when the citation names a line.** If it does not, the citation
is wrong even when the text matches: strike it and re-anchor on what the search returned. An anchored
citation (file + symbol) names no line — the search output supplies it, which is why an anchor cannot
go stale this way. This is the one grounding check needing no second agent and no judgement: the
number arrives inside the evidence, so a row can contradict itself in plain sight. Output not
matching the claim's quote is `struck` too, before the chairman sees it; an unopened architecture
claim stays `[unverified]`, never decisive. A **Re-run** cell reading `MISMATCH` overrides the Result
— the row becomes `struck — re-run disagrees`, however the first pass read it.

⛔ **Quick tier has no reviewer, so the chairman subagent runs the re-check** — the `{{if quick}}`
block of the chairman template: it re-runs every citation when there are five or fewer, otherwise the
most load-bearing, the last by document order and any that reads as written from memory, returning
command, output and match for each, which you put in that row's **Re-run** cell. It needs repo
access; without it say so (honesty table). A subagent chairman is a different agent from the members,
so its re-runs are evidence; ⛔ **if the quick run is itself inline, the chairman is you** — leave the
cells empty and head the table *"self-checked — no second agent re-ran these"*. Re-checking your own
table catches staleness, not fabrication, hence quick tier's medium cap.

**Tally.** Parse each `FINAL RANKING:` block into an average rank (lower is better): *"B 1.5 · D 2.0
· A 2.8 · C 3.7"*. Exclude and note a malformed block; if fewer than half parse, re-request those
reviews once, still unusable → no tally. Fewer than 3 parsed → "thin"; a tie stays a tie, for the
chairman to break on argument.

**Synthesize.** ⛔ The chairman is **one fresh subagent** given the chairman template (inline only
when the host has no subagents or the user asked for a cheap run, labelled degraded). It receives the
brief, the de-anonymized answers with strikes marked, the reviews, the claim checks and the tally,
and follows that template's rules — chief among them: **quote every seat's POSITION line verbatim
first**, and count agreement only from those quoted lines.

Its verdict is the template's sections and nothing more, at most 350 words after the quoted
positions, ending in checkable overturn conditions (a number, a test result, a requirement) and one
reversible **First step** — never "implement option B".

Confidence: **high** — convergence from different lenses, core claims verified, no live clash on a
load-bearing point. **medium** — a live clash remains or key claims are unverified. **low** — seats
split or evidence thin. Every honesty-table row marked ≤ medium caps it. The chairman also checks
the brief's framing, so quick and inline runs get a neutrality check, and its **Framing** line
reaches the chat block (Phase 7), not only the transcript.

Append the verdict verbatim; the transcript's status becomes `advisory — not acted on`.

## Phase 7 — Persist

1. **Memory (Baton).** `save_memory` with `type: "decision"`, the files the decision is about as
   `files`, and a fact under ~1000 characters that stands on its own — memory reaches machines and
   clones the transcript does not:
   *"Council decision <slug>: <recommendation> (<confidence>). Status: advisory, not yet approved.
   Council held <date>. Why: <reason>. Revisit if <overturn conditions>. Transcript (this machine
   only): <absolute council path>/<file>.md"*. Baton replaces a fact only when its fingerprint
   matches and the bodies are mostly the same, and the fingerprint is the first six words longer than
   two letters (`src/memory.ts:132-140`) — `Council` and `decision` take two. ⛔ **So count the slug's
   words longer than two letters before saving: fewer than 4** (`db-choice`, `fastify-or-node-http`,
   where `or` is dropped) and the sixth comes from the recommendation, so a later save worded
   differently fails to supersede. Lengthen the slug (`fastify-vs-raw-node-http`), rename the
   transcript file to match, then save.
   **Re-run of a decided question:** skip this save; the prior decided fact stays untouched (step 4).
2. **Tell the user — this block only**, at most 25 lines. No brief, answers, reviews or per-phase
   narration unless asked:

   ```
   Council · standard · 4 seats (4 subagent) · review 3/3 · diversity ✓ · degraded: no
   Positions: Maintainer → keep node:http · Contrarian → Fastify · Operator/Cost → keep node:http
   Framing: neutral | leaned — "<the words the chairman or a reviewer quoted>"
   Prior verdict: none | <memory id or path> — <what changed since> | not checked (<reason>)
   Recommendation: <chairman's words> — Confidence: medium (<chairman's reason>)
   Main clash: <one line>
   Overturn if: <condition> · <condition>
   First step: <chairman's first step>
   Transcript: <absolute $council path>/<file>.md | session-only — not written (<case a | case b>)
   Memory: <fact id> (advisory) | not saved (<reason>)
   ```

   Copy the recommendation, confidence and first step from the chairman verbatim; anything of yours
   goes below the block as `Orchestrator note:`, and an HTML page only if the user asks.
3. ⛔ **Stop.** Ask whether to act on the recommendation; start nothing, not even the first step,
   until the user says so.
4. **After the user decides:** set the transcript status (`approved: <what> on <date>` or
   `rejected: <reason>`). *(Baton)* `save_memory` again with the text before `Status:` unchanged and
   the new status; if the reply's `supersedes` is empty the old fact survived, so remove it with
   `baton memory rm <id>` or from the dashboard. **Re-run of a decided question:** rejected → a
   rejected re-run saves nothing and never removes the prior decided fact, and the rejection goes in
   the transcript only; approved → save the new recommendation under the same slug, removing the old
   fact only if `supersedes` is empty. Handing implementation to another agent: pass it the memory
   fact id and the absolute transcript path under `$council`.

---

## Degraded-run honesty

| Situation | Say in the header, transcript and chat block | Confidence |
|---|---|---|
| Any inline member, reviewer or chairman | "Inline: one model under several lenses — independence and anonymity are simulated." Re-run cells stay empty: "self-checked — no second agent re-ran these." | ≤ medium |
| Quick tier | "No peer review; citations checked by the orchestrator, re-checked only by the chairman — a thin sample", or, if the run is also inline, "self-checked — no second agent re-ran these". | ≤ medium |
| External seat failed | provider, reason, N−1 voices, any backfill seat | ≤ medium |
| A reviewer's or the chairman's FRAMING check quoted a lean | the quoted lean, on the `Framing:` line of the chat block too | ≤ medium |
| Nothing could be written (sandbox, or the user said no files) | "session-only — not written (<case a: writing impossible \| case b: user refused files>)"; transcript printed inline once | ≤ medium |
| No reviewer (or the quick-tier chairman) could re-run a citation — no repo access | "No citation was independently re-checked; the claim table is unchecked by anyone but its author." | ≤ medium |
| Rankings unusable | "No tally — reviews could not be ranked." | ≤ medium |
| Key claims `[unverified]` | "Treat the recommendation as a hypothesis." | ≤ medium |
| Consensus survived a re-seat | say so — it is a strong signal | unchanged |
| Fewer than 3 answers | no verdict; report what came back and stop | — |

---

## Red flags

Every row was observed in a blind benchmark of council skills on real repo decisions; the right
column is the fix it called for.

| What a run actually did | Do instead |
|---|---|
| A reviewer ranked "my own response, reviewed anonymously" first. | Inline has no anonymity. Each emulated review leaves its own seat out (Phase 5). |
| One model wrote all four seats, then reported a "unanimous" 4/4 tally. | Head it "emulated, not independent"; it is not a vote. |
| The chairman said "advisors independently discovered" a fact one model wrote. | Say "one model under several lenses". Independence is claimed only when real. |
| The chairman listed a seat as backing an option that seat argued against. | Quote every POSITION line first; count agreement only from the quotes. |
| "No API-key handling exists in this repo" — one grep found three places. | Settle absence claims in Frame, with the exact search recorded. |
| First step: "check whether the main process subscribes to SSE" — one grep answers it. | Run the grep during Frame; hand the user decisions, not lookups. |
| "Each worktree has its own `.baton/`" was called decisive; the code shares one hub store. | Open the code that decides where state lives; unopened stays `[unverified]`, never decisive. |
| A claim table said `src/server.ts:2494` was opened and "kept"; the code is at 3426, and that run's other numbers ran 2–6 lines out. It cost a benchmark round — grounding capped at 2/5. | Record the command and its output in the row; either cell empty → `[unverified]`, never "kept". Prefer file + symbol, which survives the drift. |
| A row recorded `sed -n '29p' src/skills/scan.ts` → `"const EXCERPT_MAX = 300;"`. Line 29 is blank; the constant is at 31. 24 of that run's 25 citations reproduced byte-for-byte, and this one row capped grounding at 2 — the re-run cell even read "kept — matches", written by the same agent. | Establish every citation with `grep -n "<text>" <file>`: the number comes back from the tool, so there is nothing to recall. `sed -n '<n>p'` only re-displays a number a tool just produced. |
| The status quo was taken from the very design doc being decided, so every seat re-derived it. | That doc is the proposal. Ground in how the rest of the repo already solves it. |
| `grep 'A\|B'` → "no matches", yet both terms were in the scope. | One literal term per search, and show the same search finds a known hit. |
| A row recorded `grep -n "requiresReview\|scan(" src/skills/install.ts` → "only one match, the import line". It returns four, and the suppressed `552:  if (requiresReview(skill.source)) {` is the chokepoint that answers the question that run shipped as its own first step. Another row recorded `grep -n "spawn\|exec(\|—for (const" src/kb/graphify.ts` beside two real `execa` lines; that command returns nothing at all (`exec(` does not match `execa(`). Grounding capped at 2. | One literal term per recorded command, no alternation, no regex metacharacters — and record the command's complete output, or mark it truncated with the hit count. A quoted line that is real but is not what the command printed is a fabricated row. |
| "The permission check lives in `src/skills/install.ts` around line 400, I checked it this morning." Opened: the code there reads the skill catalog — there is no permission check — and `grep -n "getuid" src/skills/install.ts` → no matches, while the same search for `requiresReview` in that file hits, so the absence holds: nothing on that path checks who owns the target. | A location the user names is a claim, not grounding. Open it in Frame, say what is actually there, and prove an absence with the search that found a known term too. Note this finding carries no line number of its own — the only number is inside the user's quote, where it belongs. |
| 964 lines of chat: full briefs, every seat's claims, "would persist" facts. | The verdict block in chat (≤25 lines); everything else in the transcript. |
| A 1,135-line transcript for four decisions — brief restated per phase, empty scaffolding headings — lost to a longer file that was tighter per point. | Length is earned per point, not per phase: write a section only when it carries new material. |

## Definition of done

- [ ] Gate passed; an unfinished transcript resumed if one existed; prior verdict recalled before
      framing and surfaced for the user to decide on a re-run — or its absence declared in the
      verdict block.
- [ ] One-grep facts settled in Frame; every grounding citation quotes the line a tool printed and
      every line number came from that same step; the artifact under discussion sits under OPTIONS.
- [ ] Brief neutral and secret-free; at most one clarifying question. 3–5 lenses with tensions
      stated; tier and seat types announced; external seats only after explicit opt-in; no inline
      seat, reviewer or chairman while subagents were available, unless the user asked for a cheap
      run.
- [ ] Members dispatched in parallel within the word cap; diversity checked, at most one re-seat.
- [ ] (standard/deep) Fresh reviewers, shuffled letters, disjoint citation slices, FRAMING line,
      parseable `FINAL RANKING:`.
- [ ] Every member claim (≤5 each) and every flagged citation checked in a per-file batch, each row
      carrying its "Checked with" command and that output, or marked `[unverified]`; every citation
      in the slice re-run by its reviewer (or, for a slice over five, the ruled picks, recorded as
      `sampled`) — by the chairman in quick tier; Re-run cells filled only by an agent that did not
      produce the row, and left empty and labelled self-checked in an inline run.
- [ ] Fresh chairman quoted every POSITION before synthesizing; verdict has confidence, overturn
      conditions and a reversible first step.
- [ ] Transcript written phase by phase under the resolved council folder, status set, no section
      restating another — or printed inline and declared session-only, naming which case applied
      (writing impossible, or the user refused files).
- [ ] Chat shows the ≤25-line verdict block, the chairman's words unchanged, framing included.
- [ ] Slug has ≥4 words longer than two letters (counted, not assumed).
- [ ] Memory fact saved as advisory (Baton) and replaced once the user decided (`supersedes` set, or
      the old fact removed) — or skipped: re-run of a decided question, where a rejected re-run
      saves nothing and never removes the prior decided fact.
- [ ] Nothing acted on without the user's go-ahead.

---

*Credits: the council method (independent answers → anonymous peer ranking → chairman) comes from
Andrej Karpathy's [llm-council](https://github.com/karpathy/llm-council). Methodology ideas — lenses
with built-in tensions, workspace enrichment, parallel advisors, shuffled anonymized review, verdict
sections with a single first step, a saved transcript and optional HTML report
([tenfoldmarc/llm-council-skill](https://github.com/tenfoldmarc/llm-council-skill)); question-adapted
stances, the `FINAL RANKING:` block with an average-rank tally, not forcing disagreement, and honesty
that inline role-play is one model ([Txnishkk93/llm-council](https://github.com/Txnishkk93/llm-council))
— were re-expressed in original wording; no text was copied from those two repositories. The
external model seats in `references/external-seats.md` are adapted from
[gcpdev/llm-council-skill](https://github.com/gcpdev/llm-council-skill), © 2026 Gustavo Publio, MIT
(full notice in Baton's source at `src/skills/bundled/llm-council/NOTICE` and at the upstream repo).
Prior-verdict recall, settled and quoted grounding, false-claim review, the diversity check, budget
tiers, confidence and overturn conditions, resumable transcripts and persistence are Baton additions.*
