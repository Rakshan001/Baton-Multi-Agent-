# Team Sync v2, addendum: protected branches, shared context, contribution dashboard

- **Status:** draft for owner review
- **Date:** 2026-09-29
- **Extends:** [README.md](README.md) (Team Sync v2). All events here follow README §6: signed, deps-derived lamport, authority checked at the fold.
- **Plan tasks:** `branch-guard`, `team-rules`, `shared-context`, `usage-rollup`, `dashboard-ui` in `baton/plans/team-v2.md`

---

## 1. Protected branches: agents never touch main or staging

**Goal:** agents may hallucinate, delete code or rewrite history. `main` (production) and
`staging` (testing) must only change through a **branch → PR → review → merge** path, so
that every change can be reverted as one unit.

### 1.1 Policy (signed, per project)

```ts
// event: project.policy  — written by a Lead of the project (native confirm)
{
  project: 'prj_7f3a',
  protected: ['main', 'staging', 'release/*'],   // glob, matched case-insensitively on refs/heads/*
  requirePR: true,                 // no direct commits/pushes to protected, ever, by anyone via Baton
  requireReview: true,             // Lead approval (README §7) before merge
  mergeMethod: 'squash',           // one commit per task ⇒ one-click revert
  agentMayMerge: false,            // agents never run merges; a Lead merges via native confirm
  checks: ['npm test'],            // commands shown as the "definition of done" in briefs
  restorePoints: true              // tag before each merge: baton/restore/<project>/<date>-<pr>
}
```

- **Default for new projects:** `protected: ['main','staging']`, and every other field at
  the value shown above.

### 1.2 Four layers of enforcement

Each layer covers something the others miss.

| Layer | What it stops | Bypassable by |
|---|---|---|
| **L1: task worktrees** | Every Baton task runs in its own worktree on `baton/<member>/<slug>-<id6>`. Agents never start on a protected branch | a human who opens the main checkout |
| **L2: guard hook (PreToolUse)** | For agents: deny Edit/Write when the file's worktree has a protected branch checked out. Deny Bash for: `git commit` on a protected branch; `git push` of any refspec that resolves to a protected ref (`main`, `HEAD:main`, `refs/heads/main`, `+main`, `:main` (delete), `--all`, `--mirror`); `git push --no-verify`; `git update-ref refs/heads/<protected>`; `git branch -D/-f <protected>`; `git reset --hard` or `git checkout -- .` on a protected branch; `gh pr merge` (including `--admin`); `gh api` writes to `git/refs` or `.../merge`; `git config` for hooks or core.hooksPath | agents with unguarded tools, or a human. It is a guardrail |
| **L3: git hooks** (installed by Baton, idempotent, in `.git/hooks` or `core.hooksPath`) | `pre-commit`: refuse commits on a protected branch. `pre-push`: refuse pushes to protected refs, whoever runs git (IDE buttons, scripts) | `--no-verify`, which L2 denies for agents. Humans who bypass it are acting deliberately |
| **L4: server-side protection** (GitHub rulesets) | The only *real* boundary: PR required, 1 approval, status checks, no force-push, no deletion. A Lead turns it on with one click, **"Apply recommended protection"**, which runs `gh api` through the native confirm. Baton shows a red banner while a protected branch lacks server-side protection | repo admins |

- **Offline:** L1–L3 work without internet. L4 applies the next time anyone pushes to
  GitHub.

### 1.3 Revert and restore

- **Squash merge:** each task is one commit on `main`, and **Revert task** (Lead, native
  confirm) creates `baton/revert/<pr>` with `git revert <squash-sha>` and opens a PR. It
  never pushes to `main` directly.
- **Restore points:** before each merge, Baton creates a lightweight tag
  `baton/restore/<project>/<yyyymmdd>-pr<n>` on the protected branch. It is shown in the
  project timeline, and **Restore to here** is always a PR, never a force-push.
- **If an agent deleted a lot:** the task diff view flags deletions over 30% of any file,
  or any deleted file, *before* review, with the label "Large deletion: confirm
  intentional".

### 1.4 Edge cases

| Case | Handling |
|---|---|
| A human works directly in the main checkout on `main` | L2 still blocks agents there. The UI shows "You are on a protected branch: create a task branch", with one click to `baton new` |
| Branch names differ in case (`Main`) or are unicode lookalikes | Match refs case-insensitively after NFC normalisation; refuse creating a branch that collides with a protected pattern |
| A `release/*` glob protects a branch the member needs | Lead-editable policy; changes are signed events and visible in the audit log |
| The repo has no remote (local only) | L1–L3 apply; the L4 banner says "no remote" |
| An agent uses a script file or a language subprocess to push | L2 can't see inside scripts, so L3 (`pre-push`) catches it. If the hook is bypassed, L4 catches it |
| An agent edits `.git/hooks` or `core.hooksPath` | L2 denies. Baton re-verifies hook hashes on every task start and warns if they changed |
| Hotfix needed urgently on `main` | Same path, faster: `hotfix/*` branch → PR → Lead merges. There is no bypass switch in Baton |
| A policy changes while tasks are in flight | The fold applies the new policy immediately. Existing PRs are re-evaluated |

## 2. Team code rules

- `team.rules {project | '*', version, blobRef}`: Markdown rules written by a Lead. For
  example: "use the repository layer, never call fetch in components, cache with SWR,
  no new deps without asking".
- They are **offered and accepted like skills**, with the same validation (spec C
  Revision 2: Markdown only, size caps, a diff shown on update).
- **Install:** on accept, Baton writes a managed block into the task worktree's
  `AGENTS.md` and `CLAUDE.md`, between `<!-- baton:team-rules v7 -->` markers:
  - Cursor gets a rule with `alwaysApply: true` for rules (they're small, by policy
    ≤ 150 lines).
  - Antigravity gets `.agents/rules/`.
  - The managed block is excluded through `.git/info/exclude` when the files are untracked.
    When the repo already tracks `CLAUDE.md`, rules go into
    `.claude/rules/baton-team.md` instead, so tracked files are never modified.
- **Why "always-on" is OK here:** rules are short and stable, so they sit in the cached
  prefix. Long procedures belong in skills, which load on demand.

## 3. Shared context: one team brain, token-budgeted

### 3.1 What is shared

| Kind | Event | Produced by | Consumed by |
|---|---|---|---|
| **Feature map** (tree of what exists) | `context.featuremap {project, sha, blobRef}` | any device holding the repo, from graphify: top-level modules, routes and screens, entry points, community labels, ≤ 30 KB | agents via MCP `feature_map(project, path?)`, and the human "Project map" view |
| **API contract** (OpenAPI/Swagger) | `context.contract {project, sha, format, blobRef}` | the backend project's device, from a file path declared in `project.policy.contracts` (for example `api/openapi.yaml`) or a **loopback** dev-server URL | web and mobile agents via MCP `get_contract(project, {paths?, tags?})`, which returns only the requested operations and schemas |
| **Team notes** (decisions, gotchas, how-tos) | `context.note {project, kind, sha?, anchors[], blobRef}` | any Developer+ (and Baton's `save_memory` with `scope:'team'`) | `recall_memory` including team notes, which keep the stale-withholding rules of Baton memory |
| **"You need this repo"** | derived from task project vs `device.inventory` | fold | UI: "Clone github.com/acme/api", a one-click clone through the capability, into a folder the user picks. MCP: a templated hint |

### 3.2 Freshness and budget

- **Anchoring:** every context item is anchored to a commit `sha`. When the project's
  default branch has moved past it, the item is **stale**: served with a "stale since
  <sha>" marker and queued for refresh by any device holding that repo. This is existing
  Baton memory behaviour, extended to team items.
- **Token budget:** MCP answers are **slices**, never whole artefacts:
  - `feature_map` is capped at 1,500 tokens and filtered by path.
  - `get_contract` returns only the operations asked for, capped at 3,000 tokens, with a
    `next` cursor.
  - This is the token-efficiency rule from the research doc: serve the needed slice, never
    the file.

### 3.3 Security

- All shared context is **data** and reaches agents inside the untrusted envelope. A
  contract's `description` fields could carry injection text.
- **Before publishing,** secrets are scanned with the existing skill-scan and secret-scan
  code. Contracts often contain example tokens and internal hostnames. Findings block
  publishing until the author confirms redaction.
- **Contract URLs:** only loopback (`127.0.0.1`, `::1`) or a repo file. No LAN or internet
  fetches, to prevent SSRF.
- **Visibility follows project read roles** (README §13.3). A Designer on `web` sees the
  `api` contract only if granted Viewer on `api`. Leads can grant "contract-only" access,
  meaning Viewer scoped to `context.contract`.

## 4. Contribution and token dashboard

### 4.1 Data

- Each device parses its **own** agent logs (existing `src/usage.ts`: Claude, Codex,
  Antigravity).
- It publishes **daily aggregates only**: `usage.daily {date, project, agent,
  tokens{in,out,cacheRead,cacheWrite}, costUsd|null, sessions}`. There are no paths,
  prompts or session titles. Sessions outside team projects are dropped. Sharing is
  **opt-in per member**, and the Profile screen shows exactly what is sent.
- **Activity** is derived from the fold: tasks completed, reviews, pushes and merges per
  member per day.

### 4.2 UI (clean, minimal, Orca-inspired)

```
Dashboard                                             [7d] [30d] [90d] [1y]
┌────────────┬────────────┬────────────┬────────────┐
│ Tasks done │ Cost       │ Cache hit  │ Cost/task  │   ← 4 stat tiles, numbers large, labels small
│ 42  ▲12%   │ $38.20     │ 91%        │ $0.91      │
└────────────┴────────────┴────────────┴────────────┘
Contributions — Rakshan ▾ (or Team)
 Mon ▢▢▣▣▢▣▣▣▢ … 52 weeks, 5 intensity levels + legend "Less ▢▣▣▣▣ More"
 focus/hover a cell: "Sep 29 — 3 tasks, 2 reviews, 1.2M tokens"
Tokens & cost (stacked: input / output / cache read / cache write), daily
By member · By agent · By project   (tabs, dense table, sortable)
```

- **Accessibility:** the heatmap has a numeric legend and keyboard focus that reveals
  each cell's value, plus a **table fallback**. Colour is never the only signal: cells
  also have an aria-label.
- **Honest numbers** (from the research doc): show measured cache savings and
  **cost per merged task**. Never show "X× saved vs traditional coding".
- **No chart library required:** hand-built grid and bars, as Orca does, using the
  Tailwind theme.

## 5. Security and edge cases for this addendum

| ID | Risk | Control |
|---|---|---|
| G-1 | An agent bypasses branch protection with refspec tricks | L2 refspec resolution plus L3 hooks plus L4 server rules. Tests cover every form listed in §1.2 |
| G-2 | An agent disables hooks | L2 denies `.git/hooks` and `core.hooksPath` edits; hook hashes re-verified at task start |
| G-3 | A false sense of safety with no remote protection | A red banner until L4 is applied |
| G-4 | Revert of a merge that later changes depend on | The revert PR shows the conflicting later PRs; review decides |
| G-5 | A poisoned contract or feature map (injection) | Untrusted envelope, and slices only |
| G-6 | Secrets leak through a contract or notes | Scanned before publish; publishing blocked on findings |
| G-7 | SSRF through a contract URL | Loopback-only fetch |
| G-8 | Usage leaks private or other-client work | Aggregates only; team projects only; opt-in; preview of what is shared |
| G-9 | Stale context misleads agents | Sha anchoring plus stale markers plus a refresh queue |
| G-10 | Rules block edits tracked files | Tracked `CLAUDE.md` is never modified; `.claude/rules/` used instead |
| G-11 | Heatmap performance with 365 × N members | Aggregated per day in the fold; one SVG per member; lazy tabs |
| G-12 | Clock skew puts usage on the wrong day | Days are computed in the member's timezone from their own logs. They are display-only and never affect state |
