# Recall / save patterns

Load this when you need the shape of a good fact, or the recall/save flow.

## Contents
- What makes a good fact
- Fact template
- Good vs bad facts
- Recall-before-explore flow
- Externalized task-state template
- Why evidence-anchored memory beats free-text memory

## What makes a good fact
A fact is worth saving if a *future session would otherwise re-derive it* and it is:
- **durable** — true beyond this moment (a convention, decision, or gotcha), not transient state,
- **verifiable** — tied to specific files/symbols/commits, so it can be checked and invalidated,
- **secret-free** — never keys, tokens, passwords, or credentials.

## Fact template
```
<one-line claim>. Why: <the reason / what breaks without it>.
Files: <path(s) the claim is about>   How to apply: <what a future agent should do>.
```

## Good vs bad facts
Good:
- "All git calls go through `src/util/exec.ts` (shell-free, hardened); never shell out to git
  directly. Files: src/util/exec.ts."
- "Realtime is SSE, not socket.io — explicit decision; new event types go through the bus in
  src/events.ts first. Files: src/events.ts."

Bad:
- "Currently editing line 42 of server.ts." (transient)
- "The code is kind of messy." (unverifiable, no action)
- "API key is sk-..." (a secret — never save this)

## Recall-before-explore flow
```
1. New task in area X.
2. Recall facts about X (memory store / decision log).         ← cheap, do this first
3. Read the compact repo map (CODEBASE.md) for X.              ← cheap
4. Only then read source — and only the parts recall didn't already settle.
5. After solving: save any NEW durable fact you had to learn.
```

## Externalized task-state template
Keep this in a file (e.g. `NOTES.md`) and update it — it survives compaction and handoff:
```
# Task: <objective>
## Plan
- [x] step done
- [ ] step remaining
## Decisions
- chose X over Y because ...
## Open questions
- ...
## Files touched
- path — what/why
```

## Why evidence-anchored memory beats free-text memory
Per-message fact extraction (the naive approach) accumulates extraction errors and **factual
drift** — the store slowly fills with stale or wrong claims the model then trusts. Anchoring each
fact to a commit + file content-hash lets the system detect when the underlying code changed and
**withhold the now-stale fact**, which is the key anti-hallucination property. Prefer a memory
store that does this; if writing to a plain file, note the commit/date so staleness is visible.
