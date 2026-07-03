---
name: memory-light
description: >-
  Keep working context lean across long or multi-session work so the model stays sharp and cheap.
  Recall what is already known before exploring, write durable facts to the file system or a
  memory store (not the chat) after learning them, externalize task state to files, and compact or
  hand off before context rot degrades recall. Treats the context window like RAM and the file
  system like disk. Use for long-horizon or multi-session tasks, agent handoffs, when context is
  filling up, or when the user mentions memory, context window, compaction, /compact, context rot,
  remembering across sessions, or "keep it lean". Pairs with token-efficient-coding.
---

# Memory-Light Context Discipline (portable)

The context window is finite and **degrades as it fills** — past a point, the model recalls less
of what's in it ("context rot"). Treat context like RAM and the file system like disk: keep only
high-signal tokens live, and push durable knowledge out to storage you can recall on demand.

```
RECALL FIRST → EXTERNALIZE STATE → SAVE DURABLE FACTS → KEEP CONTEXT HIGH-SIGNAL →
COMPACT / HAND OFF BEFORE THE CLIFF
```

**Golden rules**
1. **Recall before you explore.** Before reading the repo or re-deriving anything, check what's
   already written down (memory store, decision log, prior notes). Don't re-learn what's known.
2. **Write knowledge to storage, not the chat.** A fact dumped into the conversation is paid for
   on every later turn and dies when the session ends. Put durable facts in a file or memory store.
3. **Externalize task state.** Keep the plan, the checklist, and "what's left" in a file you
   update — not only in your head/context. State on disk survives compaction and handoff.
4. **Keep context high-signal.** Don't hoard whole files, long logs, or finished sub-task chatter.
   Reference `file:line`; drop tool output you no longer need.
5. **Save facts that are durable and verifiable; never secrets.** Record conventions, decisions,
   and gotchas — not transient state, and never keys/tokens/credentials.
6. **Anchor facts to evidence so they can go stale.** A fact tied to a file/commit can be invalidated
   when that code changes — far safer than a free-floating claim the model might trust forever.
7. **Compact or hand off before the cliff,** not after quality has already dropped.

> **Adapt to the project.** "The memory store" means whatever this repo uses — a memory tool, a
> `NOTES.md`/decision log, or task files. Items marked *(optional)* are skipped if absent.

---

## Workflow

### 1. Recall first
At the start of a task (and before any big exploration):
- Pull existing facts/notes for this area from the memory store or decision log.
- Read the compact repo map before reading source. Don't re-derive what's recorded.

### 2. Externalize task state to a file
- Keep a short living plan/checklist in a file (e.g. `NOTES.md` or a task file): objective,
  steps, what's done, what's next, open questions.
- Update it as you go. This is what lets a fresh session (or a cheaper agent) pick up cleanly.

### 3. Save durable facts after you learn them
Right after discovering something a future session would otherwise re-derive, record it. Good
facts (see `references/recall-save-patterns.md` for shape):
- a convention ("all DB access goes through `repo/*`, never raw SQL in handlers"),
- a decision + its reason ("SSE chosen over websockets — see BUILD.md"),
- a non-obvious gotcha ("the daemon must augment PATH or it can't find git in a GUI launch").

Bad facts: transient state ("currently on line 42"), anything unverifiable, and **never** secrets.

### 4. Keep the live context lean
- Reference files by `file:line`; don't paste large blocks back.
- Drop large tool outputs once you've extracted what you need.
- Don't re-read files already in context (see token-efficient-coding).

### 5. Compact or hand off before the cliff
- **Compact:** summarize decisions + remaining work, discard stale output, continue.
- **Hand off:** when a session is ending or moving to another agent, write a brief (objective,
  plan, files touched, git state, open questions) so the next session starts oriented, not blind.

---

## Memory checklist (copy into your reply)

```
- [ ] Recalled existing facts/notes before exploring or re-deriving
- [ ] Task state (plan + what's left) lives in a file, not only in context
- [ ] Durable facts written to the store/log — not dumped in the chat
- [ ] Facts are verifiable and anchored to evidence; NO secrets saved
- [ ] Live context kept high-signal (no hoarded files/logs, no re-reads)
- [ ] Compacted or handed off before context quality degraded
```

---

## Baton boost *(optional — only if Baton is wired into this repo)*

- **`recall_memory`** (Baton MCP) — keyword-ranked recall of shared, evidence-anchored facts;
  stale ones are withheld automatically, so you can't act on out-of-date assumptions.
- **`save_memory`** (Baton MCP) — save a fact with the files it describes; Baton anchors it to the
  commit + content hashes, rejects secrets, and supersedes near-duplicates. This is the durable
  store — use it instead of the chat.
- **`CODEBASE.md`** — the compact repo map; read it before source every session.
- **Session handoff** — `baton pass <task> --to <agent>` writes a `HANDOFF.md` brief (plan, files,
  git state, top memory facts, graph excerpt) so work continues cleanly on another (often cheaper)
  agent when an expensive one hits its limit.

---

## Anti-patterns

- Re-exploring a codebase from scratch each session instead of recalling what's recorded.
- Pasting whole files / long logs into the conversation to "remember" them.
- Keeping the plan only in context, so a compaction or handoff loses it.
- Saving transient state, unverifiable claims, or — worst — secrets as "memory".
- Pushing past context rot and noticing only after the model starts forgetting.

## Definition of done

- [ ] Started from recall, not a cold re-exploration.
- [ ] Durable knowledge and task state live in files/the memory store, not the chat.
- [ ] Saved facts are verifiable, evidence-anchored, secret-free.
- [ ] Context stayed lean; compaction/handoff happened before quality dropped.
