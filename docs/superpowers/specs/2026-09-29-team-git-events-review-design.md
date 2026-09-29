# Spec B: git events, notifications and the review loop

- **Status:** draft for review
- **Date:** 2026-09-29
- **Parent:** [team v2 overview](2026-09-29-team-v2-overview-design.md)
- **Depends on:** [Spec A](2026-09-29-team-hub-core-design.md): device tokens, durable event log, `member` field, hub-owned transitions
- **Builds on:** `src/fetchable.ts`, `src/hooks-git.ts`, `src/commands/push.ts`, `src/mcp-nudge.ts`, `src/handoff/untrusted.ts`, `src/commands/guard.ts`, `electron/notify.ts`, `web/src/lib/toast.ts`

> **Revision 2 (2026-09-29):** read "hub" as "any device". Events in §2 are signed
> team-log events ([Team Sync](../../system-design/team-sync/README.md) §3.2), gossiped
> peer to peer.
> - `gh` polling (§4) runs on every **owner device** that has `gh` and is online. Results
>   are deduplicated by `(project, pr, state)`.
> - Review comments are `text.add` events, shown to humans only.
> - Bundles (§7.1) become content-addressed blobs.
> - Added: agents may run `gh pr create` on the member's side, and the owner may run
>   `gh pr merge` after a human confirmation in the UI.

## 1. Goal

When a teammate pushes, opens a PR or merges, everyone it affects knows within seconds.
Their agent learns about it without being able to be steered by it.

The admin ⇄ member loop runs through Baton, in this order: assign, work, review request,
changes or approval, push.

## 2. Events

All of these are team-scope events, so they are durable in spec A's event log.

| Event | Emitted by | Payload (structured; **no free text reaches agents**) |
|---|---|---|
| `git.pushed` | member daemon → hub | `{member, project, branch, sha, intent: 'track'\|'ready', files: string[≤200], taskId?}` |
| `git.default.advanced` | hub | `{project, from, to, files[≤500], via: 'pr'\|'push'\|'unknown', pr?: number}` |
| `pr.opened` / `pr.merged` / `pr.closed` | hub (online only) | `{project, number, branch, author, url}` |
| `review.requested` | hub, on transition to `review` | `{taskId, member, project, branch, sha}` |
| `review.decided` | hub (owner) | `{taskId, decision: 'approved'\|'changes'\|'question', commentId?}` |
| `push.requested` | hub (owner) | `{taskId, member, branch}` |
| `task.assigned` | hub (spec A) | `{taskId, member, assignee?}` |

- **Titles and bodies** (PR title, commit subject, admin comment) are stored separately:
  `GET /api/team/texts/:id`. They are sent **only to human UIs**, never in MCP or hook
  output.

## 3. Detecting pushes without the network

- A successful `git push` updates `refs/remotes/<remote>/<branch>` locally. The member
  daemon watches `.git/refs/remotes/**` and `.git/packed-refs` for every workspace project
  in the member's `projects`, using the existing watcher (`watch.ts`) with a 1 s debounce.
- When a remote-tracking ref changes, the daemon computes `files` with
  `git diff --name-only <old>..<new>` (through `src/util/exec.ts`) and POSTs
  `git.pushed` to the hub.
- This works whether the push came from `baton push`, the agent's own `git push` or the
  person's terminal. **No new git hook is needed.**
- **Intent:**
  - The default is `track`: a work-in-progress backup that isn't meant for merging.
  - It becomes `ready` when (a) the task moves to `review`, (b) the push used
    `baton push --ready`, or (c) the member clicks "Ready for review" in the UI.
  - Intent is stored per `(project, branch)` on the hub. The UI shows `track` pushes
    quietly and `ready` pushes prominently.

## 4. PRs and merges

- **Online:** the hub polls every 60 s, only while at least one member is connected. It
  uses `gh pr list --state all --json number,headRefName,state,mergedAt,author,url,title
  --limit 50`, run through `exec.ts` for each project that has a GitHub remote.
  - If `gh` is missing or not signed in, that project shows "PR tracking off (install gh)"
    and nothing fails.
  - GitLab and Forgejo are a plug-in point for later: webhooks into
    `POST /api/team/webhooks/:provider` with a shared secret. Not in the first build.
- **Offline or no provider:** the hub runs `git fetch` for each project at most once every
  60 s (reusing `fetchable.ts` throttling) and compares `origin/<default>`. When it moves,
  the hub emits `git.default.advanced` with `via:'unknown'`.
- **Relevance per member:** a member gets a notification about `git.default.advanced` or
  `pr.merged` only when:
  - the project is in their `projects`, **and**
  - either the changed files intersect their open claims or their active task's
    `inScope`, or their branch is behind by at least 1 commit.

  Otherwise it goes to their Inbox silently.

## 5. What agents are told (structured nudges)

- A nudge rides the existing answer channel (`mcp-nudge.ts` / `groundMovedNotice` in
  `mcp-pipeline.ts`). It is appended to the next Baton tool answer, with the same brakes:
  at most one per interval, and never on two answers in a row.
- **Claude Code:** the `UserPromptSubmit` hook (`baton guard --prompt`) can add the same
  template as `additionalContext`. It is off by default and turned on per member with
  `team.hookNudges`.
- **Templates are fixed, built only from structured fields, and wrapped in the untrusted
  envelope.** Example:

  ```
  [baton] web: main advanced 3 commits (PR #42 merged). 2 files you are working on changed:
  src/admin/Table.tsx, src/admin/api.ts. Stop and ask your user before pulling or rebasing.
  ```

  Paths are repo-relative, capped at 10, and passed through `sanitizeUntrusted`.
  Titles, bodies and comments are never included.
- **Agents never pull, rebase or push because of a nudge.** The template always ends with
  "ask your user". Enforcement is spec §8.

## 6. Human notifications

### 6.1 Planner

- The planner is pure: `web/src/lib/notifyPlan.ts`, with the logic shared with
  `electron/notify.ts`.
- Input: a team event plus the viewer (member id, projects, claims, role).
- Output: `{level: 'inbox'|'toast'|'os', title, body, deeplink}`.
- Text comes **from local templates only**, keyed by event type. A peer can't choose the
  words shown in an OS notification, which blocks "Admin: approve push now" spoofing.

| Event | Admin | Assigned member | Other members |
|---|---|---|---|
| `task.assigned` (to me) | — | os | — |
| `review.requested` | os | — | — |
| `review.decided` | — | os | — |
| `push.requested` | — | os | — |
| `git.pushed` intent=ready | toast | — | inbox |
| `git.pushed` intent=track | inbox | — | — |
| `pr.opened` | toast | inbox | inbox |
| `pr.merged` / `git.default.advanced` relevant to me | toast | os | os if relevant, else inbox |
| `claim.conflict` involving me | os | os | — |
| `member.pair.requested` | os | — | — |
| hub unreachable for more than 60 s | — | toast (once) | toast (once) |

### 6.2 Delivery rules

- OS notifications are suppressed while the Baton window is focused; they become a toast
  instead.
- Each deduplication key (`type + taskId|branch`) is limited to one notification per 5 s.
- Quiet hours are a per-user setting.
- The Inbox is stored on the member's side, in the local copy of the log (spec A §7). It
  has read/unread state and filters. Clicking an item deep-links to the task, PR or
  conflict (spec D).
- **Electron requirements:**
  - macOS: a signed build (unsigned builds get `failed`, and the UI falls back to toasts).
  - Windows: `app.setAppUserModelId`.
  - A click focuses the window and routes to the deep link.
  - **No action buttons in OS notifications.** Every action happens inside the app.

## 7. Review loop

```
Member agent  ──complete work──►  member UI [Request review]  (or MCP complete_task)
                                        │  transition → review {branch, sha}
                                        ▼
Hub: review.requested  ─────────►  Admin Inbox / Review panel
                                        │ admin reads diff (see 7.1)
             ┌──────────────────────────┼──────────────────────────┐
         [Approve]                [Request changes]           [Ask question]
             │                     comment → texts store       comment → texts store
             ▼                            ▼                          ▼
   [Approve & ask to push]      member Inbox shows comment   member Inbox shows question
             │                   [Send to my agent] = copy     member replies (text) → admin
             ▼                   into clipboard as a prompt
   push.requested → member UI: "Rakshan asked you to push task-12 (branch ui/admin-table)."
             │                   [Push now]  ← LOCAL click only
             ▼
   member daemon: git push <remote> <branch> (exec.ts, no --force, fixed args)
             │
             ▼
   git.pushed intent=ready → admin merges (GitHub PR, or locally) → pr.merged → everyone
```

### 7.1 Diffs

- **Online with GitHub:** the Review panel links to the GitHub compare view, and the hub
  shows `git diff --stat` after fetching the branch.
- **Offline:** the member's daemon can upload a **git bundle** of the task branch:
  - `POST /api/team/bundles` with a 50 MB cap, stored under `~/.baton/team/<hubId>/bundles/`.
  - The admin imports it with `git fetch <bundle> <branch>:review/<member>/<branch>`
    through `exec.ts`, into a `review/*` namespace only.
  - It's read-only: a bundle can never touch the admin's branches outside `review/*`.

### 7.2 Why comments never go straight to agents

- The admin's comment is free text from another machine. Delivering it to the agent would
  make the hub a remote control for four agents.
- Instead, the member reads it and clicks **Send to my agent**. That copies a prompt:
  "Your admin asked: <comment>. Please address it." The member pastes it, which makes it
  the member's own instruction.
- **Future work:** for agents with a supported input channel (ACP, or the Claude Code
  terminal), "Send" can type the prompt into the member's own session, but only after a
  local click.

### 7.3 Push approval

- `push.requested` only lights up a button. The push runs only when the member clicks it,
  in their local UI, on loopback.
- The hub can't trigger it, and an MCP answer can't trigger it either: nothing in the MCP
  surface can call push.

## 8. Guardrails for members

- `baton guard` today advises only and fails open (commands/guard.ts header). For members,
  add `team.guardMode: 'advise' | 'enforce'`. The admin sets it per member, and it is
  delivered in the member's hub config.
- In `enforce` mode, the PreToolUse hook also inspects `Bash` commands and edits:

| Class | Examples | Action for a member |
|---|---|---|
| Red | `git push --force*`, `git reset --hard`, `git clean -fd`, `rm -rf` outside the worktree, `git push` to the default branch, edits under `outOfScope` | **deny**, with the message "This needs your admin. Ask them in Baton." |
| Amber | `git pull`, `git rebase`, `git merge`, `npm install <new pkg>`, edits outside `inScope` | allow, with an advisory note to the agent, and the member's UI shows "check with admin" |
| Green | everything else | allow |

- Classification is deterministic. The regex tables live in `src/team/danger.ts`, a pure
  module with a unit test per row. There is no LLM.
- Failing open stays in place for errors and timeouts. Enforce denies only on a positive
  red match.
- Claude Code is covered first (PreToolUse). For Cursor and Antigravity, the equivalent
  hooks are best effort and documented as "advisory only" until they're verified.

## 9. Tests

- Push detection: moving a remote-tracking ref emits `git.pushed` with the right files.
  Local commits don't.
- Intent defaults to `track`, and each of the three routes sets `ready`.
- Relevance: file intersection with claims or `inScope` makes a notification; no overlap
  goes to the Inbox.
- Templates: every event type has a template. Injection strings (backticks, newlines,
  closing markers) in paths get escaped. Titles never appear in MCP output. This is a
  property test over the builder.
- Notify planner: the full matrix in §6, plus focused-window suppression and dedupe.
- Review loop: owner-only decisions. `push.requested` can't cause a push without a local
  POST from loopback.
- Bundles: the size cap applies, the import is limited to `review/*`, and bundles from
  revoked members are rejected.
- Danger classes: a table-driven test covers each red and amber rule, including tricky
  quoting (`git push -f`, `git push --force-with-lease`, `git -C x push -f`).
- The `gh` poller: when `gh` is missing, it degrades to a "tracking off" state.
