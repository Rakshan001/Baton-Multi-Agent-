# Automatic failover (`baton failover`)

`baton pass` / `baton take` make a handoff explicit. `baton failover` automates
the trigger for headless runs: when the agent reports a provider limit, Baton
stops it, writes the same `HANDOFF.md` brief, and starts the next agent in a
chain you choose.

## Usage

```bash
baton failover fix-checkout --agents claude,codex,gemini
```

- `--agents` is required and ordered. The first entry runs first.
- `--max N` caps how many agents to try (default: the whole chain).
- `--pattern <regex>` adds a limit pattern (repeatable). Built-ins cover rate
  limit, usage limit, quota exceeded/exhausted, too many requests, 429,
  resource exhausted, and overloaded.

The command stays in the foreground and prints every launch and handoff. Ctrl+C
stops the current agent. It does not look for other work.

## What happens on a limit

1. The agent's output matches a limit pattern.
2. Baton sends SIGTERM to that agent (and its process group on POSIX).
3. `baton pass` checkpoints uncommitted work, writes `HANDOFF.md`, and records
   the handoff.
4. For a pipeline task, the claim moves to the next agent; a plain `baton new`
   task has no pipeline claim to move.
5. The next agent starts in the same worktree; `baton start` reads the fresh
   brief as its prompt.
6. Repeat until an agent finishes or the chain is exhausted.

If the chain is exhausted, the task is blocked with a reason naming the last
limit line. If an agent exits non-zero without a limit signal, nothing is handed
off: the task is blocked exactly like `baton start` would leave it.

## What it is not

- Not a quota predictor. It reacts to the agent's own limit message; it does not
  read plan percentages.
- Not a daemon. Nothing starts in the background or on a schedule.
- Not a replacement for `baton pass` / `take`. It calls the same pipeline.
- Not a launcher for every agent. Only headless print modes (Claude Code, Codex
  CLI, Gemini CLI by default); Cursor has no headless mode.
- Not a merge tool. The next agent commits in the worktree; merging stays
  explicit (`baton merge`).

## Requirements and limits

- The agents in `--agents` must be installed and on `PATH`; Baton refuses the run
  before starting anything if one is missing.
- A pipeline task must be queued or already held by the first agent. If another
  agent holds it, failover refuses rather than stealing it.
- Detection is heuristic. A line that merely mentions "rate limit" in a code
  explanation can trigger it; use `--pattern` and avoid agents that print source
  to stdout. The built-in patterns live in `src/failover.ts`.
- On Windows, stopping an agent does not kill its descendants (the existing
  `spawn.ts` limitation).
- No dedicated dashboard badge yet: the transition is published as the
  `agent.failover` event and appears in the normal handoff history.
- The chain tries each agent once. It does not wait for a `retry_after` to
  expire; if the first agent is briefly throttled and the second is ready, the
  second runs.
- Custom headless agents receive the task's declared scope as `BATON_SCOPE`
  (a JSON array), so a driver can edit only the task's files without re-reading
  `.baton/tasks.json`.

## Relation to hooks

`baton hooks install claude` writes a brief on `Stop` / `PreCompact`. That is a
last-resort capture when a session ends; it cannot start another agent. Claude
Code has no rate-limit hook event (the hooks installer says so explicitly), which
is why detection lives in the supervisor rather than a hook.

## Example output

```text
▶ fake-limited started on 'failover-demo' (next: fake-ok)
Error: 429 Too Many Requests
! fake-limited hit a provider limit: Error: 429 Too Many Requests
✗ fake-limited stopped
↷ handing 'failover-demo' from fake-limited to fake-ok
▶ fake-ok started on 'failover-demo' (last in chain)
✓ fake-ok finished 'failover-demo'
```

## Tests

`test/failover.test.ts` covers the matcher, the full handoff sequence, exhausted
chains, ordinary failures, `--max`, custom patterns, and refusal when the task is
held. The supervisor is dependency-injected, so the tests do not launch a model.
