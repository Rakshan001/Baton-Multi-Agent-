---
name: token-efficient-coding
description: >-
  Work token-efficiently in ANY codebase: navigate a repo map or code graph instead of reading
  whole files, read the smallest high-signal slice (symbol lookup / grep / head) before editing,
  make minimal surgical diffs, batch independent tool calls, and never re-read a file already in
  context. Cuts wasted tokens and dollar cost on every read and edit without lowering quality.
  Use whenever the user mentions saving tokens, cutting cost or context, slow/expensive sessions,
  large files, "don't read the whole repo", or before exploring or editing a big or unfamiliar
  codebase. Pairs with the memory-light skill (cross-session context) and verify-before-done.
---

# Token-Efficient Coding (portable)

Spend tokens like money. The goal is the **smallest set of high-signal tokens that still gets
the change right** — never read or re-send what you don't need, never skimp on what you do.

```
ORIENT (map, not repo) → LOCATE (symbol/grep) → READ THE MINIMUM → EDIT MINIMALLY →
DON'T RE-READ → COMPACT WHEN LONG
```

**Golden rules**
1. **Orient from a map, not the whole repo.** A repo map / code graph / `head` of key files
   costs hundreds of tokens; reading the tree wholesale costs hundreds of thousands.
2. **Locate before you read.** Find the exact symbol/line with `grep -n` / `rg` / a graph query,
   then open only the relevant window — not the whole file.
3. **Read the minimum, once.** Reading a file appends it to context and it is re-sent on every
   later turn. A file already in context is already known — do **not** read it again.
4. **Edit minimally.** Smallest diff that fixes the root cause. No opportunistic rewrites, no
   reformatting untouched lines — they bloat the diff and the review.
5. **Batch independent work.** Issue independent reads/greps/edits in one step instead of a slow
   serial round-trip each.
6. **Compact before the cliff.** Long context degrades recall ("context rot"). Summarize and
   drop stale tool output before it hurts quality.
7. **Quality is non-negotiable.** Saving tokens never means guessing. If you haven't read the
   code a change touches, read it — being cheap about *correctness* costs far more later.

> **Adapt to the project.** Wherever this says "the map", "the graph", or "the test command",
> use this repo's real tooling. Anything marked *(optional)* is skipped if it isn't there.

---

## Workflow

### 1. Orient — from the cheapest artifact first
Read, in order of cost, only until you know where to look:
- A repo map (`CODEBASE.md`, `README`, an architecture doc) — the compact picture.
- A code/dependency graph query for the symbol or area *(optional)*.
- `head`/`grep` on a couple of entry files.

Stop as soon as you can name the file(s) and function(s) the task touches. See
`references/token-budget-cheatsheet.md` for the exact commands.

### 2. Locate — pinpoint before opening
```bash
rg -n "functionName|ClassName|/api/route|FIELD_NAME" <src dirs>   # find the line
```
Use the line number to read a focused window, not the whole file. For a symbol's definition and
callers, prefer a graph/LSP query over grepping the entire tree.

### 3. Read the minimum (but read what you'll edit IN FULL)
- Read the **function/region you will change in full** — never edit code you haven't read.
- For everything else (callers, neighbours), a targeted window or `grep` hit is enough.
- Large data/log/generated files: `head`, `tail`, `grep`, `wc -l` — never load them whole.

### 4. Edit minimally
- Change only what the root cause requires. Match surrounding style.
- Reuse existing helpers (DRY) instead of pasting new code — search first.
- Avoid adding avoidable/duplicate API or DB calls, N+1 queries, or work in hot paths.

### 5. Don't re-read; don't re-explain
- A file you already opened this session is in context — reference it, don't re-read it.
- Don't restate large blocks back to the user; point to `file:line`.

### 6. Compact when the session gets long
- Summarize decisions made + what's left; drop verbose tool output you no longer need.
- For anything that must survive a fresh session, write it to a file or to memory — not the
  chat (see the **memory-light** skill).

---

## Token-spend checklist (copy into your reply)

```
- [ ] Oriented from a map/graph, not a full-repo read
- [ ] Located the exact symbol (grep/graph) before opening files
- [ ] Read every region I'm editing IN FULL; read nothing whole I didn't need
- [ ] Did NOT re-read any file already in context
- [ ] Diff is minimal — only root-cause lines, no reformatting, reuses existing helpers
- [ ] Batched independent reads/edits
- [ ] Compacted / externalized state if the session got long
```

---

## Baton boost *(optional — only if Baton is wired into this repo)*

- **`CODEBASE.md`** — the <~2k-token repo map Baton generates. Read it first every session.
  Reading it vs reading the repo is ~300× cheaper on this kind of codebase.
- **`query_graph`** (graphify MCP) — ask for a symbol's definition + callers and get a
  budget-bounded excerpt instead of grepping the whole tree.
- **`recall_memory`** (Baton MCP) — pull already-known facts before exploring, so you don't
  re-derive (and re-read) what another session already figured out.
- **`baton usage`** / the dashboard's "Tokens used" card — measure the savings.

---

## Anti-patterns

- Reading whole directories or files "to be safe" — orient from the map, then target.
- Re-reading a file you opened earlier in the same session.
- Reformatting or refactoring untouched code inside a focused change.
- Pasting large file contents into the conversation when a `file:line` reference suffices.
- Guessing at code you didn't read to save a read — false economy; correctness costs more.

## Definition of done

- [ ] Reached the answer/edit via targeted reads, not bulk reads.
- [ ] Every edited region was read in full; nothing unnecessary was loaded whole.
- [ ] No file re-read; diff is minimal and reuses existing code.
- [ ] Context kept lean (compacted/externalized if long) — quality never traded for tokens.
