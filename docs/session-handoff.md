# Session handoff

Baton's core flow: plan on your expensive agent, then **pass the baton** to a
cheaper one. This page covers `baton pass` → `HANDOFF.md` → `baton take` →
`baton done`, what goes into the brief, how Baton auto-routes the receiving
agent, the Claude Code hooks that generate briefs automatically, and the
dashboard Handoff dialog.

## The flow at a glance

```
baton pass [--to <agent>]   →  writes HANDOFF.md in the worktree
baton take                  →  prints the execution prompt, status → in-progress
baton done                  →  status → done, ready for baton merge
```

A handoff brief is a curated `HANDOFF.md` written at the root of the task's
worktree. It is **not** a raw transcript dump — it is a token-budgeted pack of
objective, plan, git state, the files the previous agent touched, a code-graph
excerpt, and relevant project memory, so the next agent can continue without
replaying the whole session.

Implementation: [`src/commands/pass.ts`](../src/commands/pass.ts),
[`src/handoff/brief.ts`](../src/handoff/brief.ts),
[`src/commands/take.ts`](../src/commands/take.ts).

## 1. Pass the baton

Run `baton pass` from inside a task worktree, or pass the slug explicitly:

```bash
baton pass                       # resolves the task from your cwd
baton pass fix-auth --to codex   # explicit slug + target agent
```

| Flag | Meaning |
|------|---------|
| `[slug]` | Task to hand off. Omit it to resolve the task from the current worktree. |
| `--to <agent>` | Receiving agent: `cursor`, `codex`, `gemini`, or `any`. Omit (or `auto`) to route automatically. |
| `--model <m>` | Suggested model for the receiving CLI. Advisory only — written into the brief frontmatter; Baton can't enforce it. |
| `--note <text>` | A free-text note from the handing-off side, shown near the top of the brief. |
| `--from <agent>` | The agent handing off. Defaults to `claude`. |
| `--no-commit-pending` | Skip the auto-checkpoint commit of uncommitted work (committed by default). |
| `--auto` | Quiet hook mode (see [Automatic briefs](#4-automatic-briefs-claude-hooks)). No-op outside a worktree; skips if a fresh brief already exists. |

Before building the brief, `baton pass` **checkpoints uncommitted work** by
default (`git add -A` + a `chore: checkpoint before handoff` commit) so the next
agent starts from a real commit. Disable with `--no-commit-pending`.

Example output:

```
✓ handoff brief ready → /repo/.baton/wt/fix-auth/HANDOFF.md
  routed → codex · matched 'bug', 'fix' · override with --to <agent>
  to: codex · session ≈ 84,300 tokens (≈ $0.25 to replay raw)

  Next agent picks it up with:
    cd /repo/.baton/wt/fix-auth && baton take
```

## 2. What the brief contains

[`buildBrief`](../src/handoff/brief.ts) assembles `HANDOFF.md` from git ground
truth plus optional enrichments. Sections (each included only when it has
content):

| Section | Source |
|---------|--------|
| **Frontmatter** | `baton`, `from`, `to`, `model`, `status`, `created`, `repo`, `branch`, `est_tokens`, `est_cost_usd`. |
| **Objective** | The task description, plus your `--note` if given. |
| **Where to work** | `cd` into the worktree, the branch and its base, a reminder to `baton merge` later. |
| **State of the work** | `git diff --stat` committed-vs-base, and an uncommitted-changes stat if any. |
| **Plan** | Open and completed todos extracted from the Claude Code session transcript (when present). |
| **Files the previous agent edited** | Pulled from the session transcript. |
| **Last notes / commands** | The previous agent's last notes and up to the last 8 commands it ran. |
| **Codebase map (graph excerpt)** | A ~1500-token graphify graph excerpt scoped to the task — only when the [knowledge base](./knowledge-graph.md) is initialized. |
| **Project memory** | Up to 6 evidence-checked facts relevant to the task; stale facts (changed anchors) are withheld. See [memory](./memory.md). |
| **Before you finish / Do NOT** | Guardrails: run tests, mark `baton done`, stay inside the worktree, don't rewrite base-branch history, don't re-plan. |

If no Claude Code session transcript is found for the worktree, the brief notes
that and falls back to git context alone.

### Cost estimate

The frontmatter carries `est_tokens` (the previous session's estimated size) and
`est_cost_usd`, a rough cost of replaying that much context on a metered,
Sonnet-class API (≈ $3 per million input tokens). It frames the saving: the next
agent reads a compact brief instead of re-ingesting the whole session.

## 3. Auto-routing by task type

If you omit `--to` (or pass `--to auto`), Baton picks the receiving agent from
deterministic rules in `baton.config.json` — **no LLM call**. Routing scores the
task by keyword rules first, then by severity → tier when no rule hits, and
walks a fallback chain so an uninstalled first choice is skipped rather than
failing. See [`src/routing.ts`](../src/routing.ts) and the
[agent routing](./agent-routing.md).

The `pass` output explains *why* a target was chosen:

| `source` | Reason printed |
|----------|----------------|
| `rule` | `matched '<keywords>'` |
| `severity` | `severity N/100 → <tier> tier` |
| `single` | `single-agent mode` |
| _default_ | `default route` |

Agents in the chain whose CLI isn't installed are reported as
`skipped (CLI not installed): …`. In `manual` routing mode the pick is only a
suggestion — Baton tells you to choose with `--to`. Low-confidence picks are
flagged so you can double-check. Override any routing decision with `--to`.

## 4. Automatic briefs (Claude hooks)

Generate a brief automatically when a Claude Code session ends or is about to
compact:

```bash
baton hooks install claude            # user-wide (~/.claude/settings.json)
baton hooks install claude --project  # this workspace (.claude/settings.json at the baton root)
```

This wires Claude Code's **Stop** and **PreCompact** hooks to run
`baton pass --auto`. Honest limitation (from
[`src/commands/hooks.ts`](../src/commands/hooks.ts)): Claude Code exposes no
"rate-limited" hook event, so Stop + PreCompact are the closest proxies for "this
session is winding down." `baton pass` is always available manually.

`--auto` is safe to install user-wide: it never fails the host agent, and
debounces — if a brief was written less than 10 minutes ago, it won't churn it.
Only `claude` hooks are supported.

### Sessions with no task

Most sessions run at the repo root rather than inside `.baton/wt/<slug>`, and
those have no task to write a `HANDOFF.md` for. They get a **derived session
brief** instead, at `.baton/handoffs/<session>.md` — the same place
[`baton resume`](#6-resume) and the dashboard already read from
([`src/handoff/auto-session.ts`](../src/handoff/auto-session.ts)):

| Section | Derived from |
| --- | --- |
| Done | commits that landed since the previous brief — or, on a session's **first** brief, only those from the last 12 hours, since there is no previous brief to diff against and an unbounded log would claim commits that predate the session |
| Pending | the dirty tree (Baton's own `.baton/` artifacts excluded) |
| Next step | the obvious continuation, stated plainly |

Two things it deliberately does **not** do. It records no **decisions or
gotchas** — that field is the "why", which lives only in the agent's head, and a
hook that invented one would put fabricated reasoning into the brief. And
because decisions are what feed memory, an automatic brief **writes no memory
facts**; to record those, use the `create_handoff` MCP tool, where an agent
authors the text and vouches for it.

It stays silent whenever there is nothing honest to say: a clean tree with no
new commits, a hub root that is not a git repo, or a state identical to the last
brief. Two agents working in one root get separate briefs, keyed by the session
id from the hook payload, so neither can clobber the other.

Derived briefs carry `derived: true` in their frontmatter, and **only those are
pruned** (to the newest 20). A brief you wrote through `create_handoff` carries
decisions that exist nowhere else and is never deleted automatically.

## 5. Take the brief

The receiving agent picks up the brief with `baton take`:

```bash
cd /repo/.baton/wt/fix-auth
baton take              # or: baton take fix-auth
```

`baton take` ([`src/commands/take.ts`](../src/commands/take.ts)) validates the
brief (must have `baton: 1` frontmatter, must not already be `done`), flips its
status to **in-progress**, and prints the execution prompt — the brief body
between two rules — ready to paste or pipe into the receiving agent:

```
────────────────────────────────────────────────────────
# Handoff: fix auth token refresh
## Objective
...
────────────────────────────────────────────────────────
(brief: /repo/.baton/wt/fix-auth/HANDOFF.md · status → in-progress)
```

## 6. Mark it done

Closing a brief is part of the work, not paperwork after it. Until a brief is
closed it stays in the pickup list forever, and a list full of shipped work is
a list nobody reads.

For a **task** brief, from the worktree:

```bash
baton done             # or: baton done fix-auth
```

This sets the brief status to **done**. Baton then points you at the merge:

```
✓ fix-auth marked done — merge with: baton merge fix-auth
```

See [worktrees](./quickstart.md) for `baton merge` (squash + archive by default).

For a **session** brief — or from inside any agent — call the
[`resolve_handoff`](./mcp-tools.md) MCP tool with the slug and a note. The note
is appended to the brief under a `## Completed` heading rather than replacing
it: the brief records what was *asked*, the note records what *happened*, and a
reviewer needs both. Resolving twice replaces the report instead of stacking a
second one, so an agent retrying after a dropped connection cannot corrupt the
record.

A good note is written for the reviewer: what shipped, how you know (the tests
you ran), what you did **not** do, and what is now unblocked.

The dashboard's handoff panel has a **Done** button per brief when the daemon
runs with `--write`; it posts to `POST /api/handoffs/:slug/resolve` and takes
the same path.

## 7. The pipeline: which brief comes next

With several briefs open, "which do I paste next?" is the only question that
matters. Baton answers it the same way in both places — the dashboard panel and
the `next_handoff` MCP tool read one ordering, computed by the daemon, so they
cannot disagree.

Two fields drive it, both read from the brief's frontmatter:

| Field | Meaning |
|---|---|
| `dependsOn` | Slugs this brief waits on. A dependency that is **not open** counts as satisfied — the usual reason it has no brief is that the work finished |
| `phase` | The plan phase the brief came from. An explicit phase outranks anything inferred from dependencies |

From those, briefs are assigned a **step**: step 1 is everything you can start
now, step 2 is everything that only waits on step 1, and so on. Briefs sharing a
step have nothing between them — hand them to **different agents at the same
time**. The panel labels these "N in parallel"; `next_handoff` returns them as
`alsoReady`.

A brief is **ready** when no open brief blocks it. The first ready brief is
marked `NEXT`. Everything else on the panel is context for that one answer.

**A blocked brief is still copyable.** It is dimmed and shows what it waits on,
but the button works — you may deliberately work out of order, and a UI that
refuses is worse than one that warns.

If every remaining brief is blocked, they are waiting on each other in a cycle.
Baton says so rather than hanging: close one with `resolve_handoff`, or pick one
up deliberately.

## Dashboard Handoff dialog

The dashboard ([`baton serve`](./cli-reference.md)) offers the same flow from the
Command Center. Open the **Hand off session** dialog on a task to:

- Pick the receiving agent. The suggestion is **workload-aware**: the daemon
  combines the routing rules with each agent's live load (how many actively
  churning tasks it already owns, via `GET /api/tasks/:slug/suggest-handoff`)
  and preselects the **least-loaded available** agent — steering off a busy
  routing pick with an explained reason. Each option is badged `idle` /
  `N active`. (In `manual` mode it's shown as a "suggested" chip but never
  auto-picked.)
- See what transfers: the branch, commit count, and isolated worktree.
- Optionally commit pending changes first (agents only see committed work).
- Add a note for the next agent.

Confirming posts to `POST /api/tasks/:slug/handoff`, which runs the same
`passTask` pipeline server-side. The action is **write-gated** — the daemon must
run with `baton serve --write`, and the request needs a loopback `Origin`
(Baton's anti-CSRF guard). On success the dialog shows the brief path and the
`cd … && baton take <slug>` command for the next agent.

## Related

- [Worktrees](./quickstart.md) — `baton new`, isolated worktrees, `baton merge`.
- [Agent routing](./agent-routing.md) — how `baton.config.json` rules pick an agent.
- [CLI reference](./cli-reference.md) — all commands and flags.
- [../README.md](../README.md) — project overview.
