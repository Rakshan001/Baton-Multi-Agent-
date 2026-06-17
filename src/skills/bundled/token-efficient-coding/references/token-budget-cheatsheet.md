# Token-budget cheat sheet

Concrete recipes for spending the fewest tokens while staying correct. Load this only when you
need the exact command.

## Contents
- Rough costs (why this matters)
- Orient cheaply
- Locate before reading
- Read the minimum
- Inspect big files without loading them
- Compaction triggers

## Rough costs (why this matters)
- One medium source file read ≈ 1–3k tokens, and it is **re-sent on every later turn** in the
  session — five stray reads can silently add ~10k tokens to every subsequent request.
- A compact repo map is ~hundreds to ~2k tokens total. Prefer it over walking the tree.
- A skill's metadata costs ~dozens of tokens; its full body only loads when triggered — so
  reaching for the right skill is nearly free.

## Orient cheaply
```bash
cat CODEBASE.md README.md            # compact map first, if present
sed -n '1,40p' path/to/entrypoint    # just the top of an entry file
ls src                               # structure, not contents
```

## Locate before reading
```bash
rg -n "createUser|/api/users|USER_ROLE" src         # ripgrep: fast, line-numbered
grep -rn "functionName" src --include=*.ts          # if rg is unavailable
```
Then open a window around the hit instead of the whole file:
```bash
sed -n '120,180p' src/users/service.ts              # read lines 120–180 only
```
For "where is X defined and who calls it", a code-graph or language-server query beats grepping
the whole repo — it returns just the edges you asked for.

## Read the minimum
- Read the **function/region you will edit in full** — never edit unread code.
- Callers/neighbours: a `grep` hit with a few lines of context is usually enough to confirm a
  contract; only open them fully if you'll change them.

## Inspect big files without loading them
```bash
wc -l huge.log                       # size first
tail -n 100 huge.log                 # recent lines
grep -n "ERROR" huge.log | head      # just the matches
jq '.items[0]' big.json              # one element, not the whole array
```

## Compaction triggers
Compact (summarize + drop stale tool output) when any of these is true:
- The conversation is long and the model starts missing earlier details (context rot).
- Large tool outputs (full file dumps, long logs) are no longer needed.
- You're about to start a distinct sub-task — summarize the previous one first.

Preserve in the summary: decisions made, files/lines changed, open questions, the next step.
Anything that must outlive the session goes to a file or to memory, not the chat.
