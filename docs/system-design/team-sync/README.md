# System design: Team Sync v2 (local-first team collaboration, no single hub)

- **Status:** draft v2 for owner review
- **Date:** 2026-09-29
- **Supersedes:** v1 of this file (same day)
- **Diagrams:** [team-sync-architecture.drawio](team-sync-architecture.drawio), 7 pages
- **Review register** (every finding and where it is resolved): [REVIEW-2026-09-29.md](REVIEW-2026-09-29.md)
- **Addendum** covering protected branches (main and staging), team code rules, shared context (feature map, API contracts, notes) and the contribution/token dashboard: [GUARDRAILS-CONTEXT-DASHBOARD.md](GUARDRAILS-CONTEXT-DASHBOARD.md)
- **Research:** [../../research/2026-09-29-token-and-team-research.md](../../research/2026-09-29-token-and-team-research.md), plus the prior-art notes in §17

---

## 1. Requirements

**Team shape.** One owner and 3–5 developers.
- Devices: MacBook Air, MacBook Pro and 2 Mac minis.
- Each person uses their own agent (Claude Code, Cursor, Antigravity, OpenCode, Codex) in their own IDE. Baton never hosts their terminal.

**The setups are heterogeneous and all must work:**

| Person | Baton root they open | Repos |
|---|---|---|
| Owner (all-rounder) | one folder containing 5 repos | web, api, mobile, admin, infra |
| Dev A (backend) | a single repo folder | api |
| Dev B (web + backend) | a folder with 2 repos | web, api |
| Dev C (UI designer, non-coder) | a single repo folder | web |

**Required flows:**
- The owner or lead creates tasks with **priority**, an **urgent** flag, an **agent brief** and a **short human note**. Tasks can carry **attachments** and can be assigned to **online or offline** people.
- The assignee gets a notification and **acknowledges** it. If they don't, the owner can send **reminders**, and the reminder count raises the priority the agent sees.
- The agent reads the assigned tasks, in priority order, through MCP. The human gets a **Copy prompt** button.
- The member marks the task done, which sends it to review. Review can send it back for rework, which repeats until it's approved. Then comes push, then merge, then everyone is notified to pull.
- Workload is visible, and the owner can reassign.

**Every device is a coordinator:**
- The owner can plan, assign and leave. Members who arrive later get their tasks from any online peer.
- Devices come and go all day and restore cleanly the next morning.
- No internet is needed. Everything runs over the same Wi-Fi or a hotspot, with internet sync added later.
- An always-on Mac mini is optional.

**Security:**
- **RBAC per project.**
- Nothing received from another device can make a local agent or the OS do something irreversible without a local human confirmation that an agent cannot forge.

## 2. Prior art and why we build our own (summary of §17)

Nobody ships this combination. The nearest:
- **Docket** (MIT; coordination for AI coding agents) *dropped* P2P sync because "claims are advisory" across devices.
- **p2panda-auth** (Rust) is the closest access-control model.
- **SSB/Hypercore** use the same signed per-author feed model.
- **Keyhive** (Ink & Switch) is the reference for revocation and encryption, but it is alpha and says "DO NOT use in production".
- **Anytype** needs online consensus nodes to change ACLs, which is exactly what we must avoid.

**Decision:** keep our own small design, zero-dependency in the daemon, and borrow proven semantics:
- p2panda **strong removal**
- the Hypercore **fork counter**
- SSB **fork proofs**
- Meadowcap-style **project-scoped capabilities**
- HLC **clamping**
- Negentropy only if blob sets grow large

Docket's lesson is designed in: **claims are advisory, with a deterministic loser and a visible "lost claim" notice.**

## 3. Architecture at a glance

```
┌──────────────────────── one device ─────────────────────────┐
│ Electron main  ── holds the SIGNER (key in macOS Keychain)   │
│   │  native confirm dialogs for owner/irreversible actions   │
│   │  IPC capability (per-launch secret, memory only)          │
│   ▼                                                            │
│ baton daemon (zero-dep Node)                                   │
│   org.ts      membership + roles chain (folded FIRST)          │
│   feed.ts     append / verify / hash chain / fork proofs        │
│   fold.ts     pure deterministic state + authority rules       │
│   sync.ts     mTLS peer links, ordered resumable sync          │
│   discovery.ts opaque beacons + peers.json                     │
│   blobs.ts    content-addressed, served on a SEPARATE origin   │
│   projects.ts project keys ↔ local repos (project-map.json)    │
│   HTTP API    loopback; owner/irreversible routes need the IPC │
│               capability — loopback alone is not enough        │
│   MCP         my_tasks / take_task / ack / complete (templated)│
└──────────────────────────────────────────────────────────────┘
        ▲ mutual TLS (SPKI = admitted key), full mesh ≤ 10 devices
        ▼
   other devices (each identical; any subset online)
Code travels by git (GitHub/remote). Team Sync never replicates source code.
```

## 4. Identities

### 4.1 Devices

- Each install generates an **Ed25519 device key inside Electron main**. It is stored in the **macOS Keychain** as a *ThisDeviceOnly*, app-restricted item, and is never written to a file.
- The daemon asks main to sign through the IPC capability (§12.2). A same-user process that isn't the signed app can't read the key, including the member's own agent.
- `deviceId = base32(sha256(spki(pub)))[0..16]`.
- A new key is minted when the hardware UUID changes, whether from a restore to new hardware, a Migration Assistant copy or a cloned disk. **Keys never travel through backups:** `~/.baton/team` is excluded from Time Machine.
- The device model comes from `sysctl hw.model`, mapped to a human name such as "Mac mini (M4)". The device label defaults to the host name, and the user can edit it.

### 4.2 Members

- A member is a person with one or more devices.
- Profile: `name`, `jobRole` (Backend, Mobile, Web, UI/Design, All-rounder or custom), avatar initials and colour, and `timezone`.
- Profile events are signed by the member's own device. **Roles are not part of the profile**: they are granted separately (§5).

### 4.3 Projects: stable keys across different folder layouts

Today's project ids come from folder names (`src/kb/projects.ts:99-153`), so `api`, `acme-api` and `backend` would be three different projects. v2 fixes that:

- **Defining a project:** a custodian or lead writes `project.define {key, name, remotes[], rootCommits[], subpath?}`.
  - `key` is random, for example `prj_7f3a…`. **It is never a folder name.**
  - Adding a project to the team from the owner's hub root fills `remotes` and `rootCommits` automatically.
- **Normalising remotes:** lowercase the host; drop the scheme, credentials and `.git`. `git@github.com:acme/api.git` and `https://github.com/acme/api` become the same `github.com/acme/api`.
- **Resolving on each device:** every device scans its Baton roots, including hub roots with several repos, and builds `project-map.json: key → {gitToplevel, subpath}`. Match rules, in order:
  1. Any of the repo's remotes (not only `origin`) matches a remote in `remotes[]`. This also covers forks, which have an `upstream`.
  2. No remote, but the root commit matches. The human must confirm, because boilerplate repos share root commits.
  3. Otherwise the repo shows as "Unmatched: Locate repo…" and the human picks it.
- **Edge cases:**
  - The same repo cloned twice: the human picks the primary clone.
  - Baton's own worktrees (`.baton/wt/*`) are excluded, detected through `git rev-parse --git-common-dir`.
  - A repo moved or renamed on GitHub: `project.alias {key, remote}` adds the new remote.
  - A monorepo package: use `subpath`.
- **Inventory:** each device publishes `device.inventory {projectKeys[]}`. Leads then see **who actually has which repo**, instead of trusting a declared list. Assigning a task in a project the assignee's devices don't have shows "Priya has no clone of *api*", with the options **Assign anyway** (she'll be asked to clone) or **Pick someone else**.

## 5. RBAC

### 5.1 Roles

Roles are granted **per project** (`project key`, or `*` for all), except Custodian, which is team-wide.

| Role | Intended for | Scope |
|---|---|---|
| **Custodian** | team founder, security admin | team |
| **Lead** | owner, all-rounder, tech lead | per project |
| **Developer** | backend, web and mobile devs | per project |
| **Designer** | non-coders who work through agents | per project |
| **Viewer** | PM or stakeholder | per project |
| **Relay** | an always-on Mac mini | team; stores and forwards only |

- A person usually holds **Custodian plus Lead on `*`** (the owner), or Developer on one or two projects.
- **Custodians:** there must be **≥ 2 custodian devices**, or 1 plus a **paper recovery key** created at genesis.
- The unattended Mac mini is a **Relay by default, never a custodian.**

### 5.2 Permission matrix

| Capability | Custodian | Lead | Developer | Designer | Viewer | Relay |
|---|---|---|---|---|---|---|
| Admit or revoke devices, replace a device | ✔ | – | – | – | – | – |
| Grant or revoke Custodian | ✔ (quorum, §5.4) | – | – | – | – | – |
| Grant or revoke Lead, Developer, Designer or Viewer in a project | ✔ | ≤ Developer, own projects only | – | – | – | – |
| `project.define` / `project.alias` | ✔ | ✔ own projects | – | – | – | – |
| Create or edit tasks, priority, urgent, briefs | ✔ | ✔ | own subtasks only | – | – | – |
| Assign or reassign, remind | ✔ | ✔ | – | – | – | – |
| Acknowledge, take, move to active/blocked/paused/review | (as assignee) | (as assignee) | own tasks | own tasks | – | – |
| Review decisions, merge (confirmed in the UI) | ✔ | ✔ | – | – | – | – |
| Request push (`push.request`) | ✔ | ✔ | – | – | – | – |
| Attach files | ✔ | ✔ | own tasks | own tasks (images, PDF) | – | – |
| Comment (`text.add`) | ✔ | ✔ | threads they take part in | threads they take part in | – | – |
| Offer skills | ✔ | ✔ | – | – | – | – |
| Accept skills | ✔ | ✔ | ✔ | needs a Lead co-approval | – | – |
| Read a project's events and blobs | ✔ | ✔ | ✔ | ✔ | ✔ | ciphertext only (§13.3) |
| Set guard mode for a member | ✔ | ✔ | – | – | – | – |

- The **Designer** role forces `guardMode: enforce` (spec B §8). "Send to my agent" only works on comments signed by a Lead.

### 5.3 How authority is decided

- Every event carries `deps`, the hashes of the feed heads its author had seen (§6.1).
- **Authority is checked against the membership state as of the author's `deps`**, not as of the reader's "now". So every device reaches the same verdict.
- Membership events (the **org chain**) are folded **first**. On every connect they are also synced first.

### 5.4 Revocation and conflicts (strong removal)

- **Cutoff by feed position:** `device.revoke {device, cutoffSeq, cutoffHash}` voids every event from that device with `seq > cutoffSeq`, **whatever its lamport or deps**. It also voids everything those events authorised, transitively: devices admitted, roles granted.
  - A custodian can later issue `device.revoke.amend` to accept a removed member's pending legitimate work, event by event.
- **Mutual custodian revocation** (A revokes B while B revokes A, concurrently): **both apply.** If no custodian remains, the team enters **recovery mode**:
  - It becomes read-only for grants and admissions.
  - Work continues.
  - Only the **recovery key** can issue `recovery.restore {custodians[]}`.
  - This deliberately differs from p2panda, where the group freezes.
- **Custodian changes need a quorum** when ≥ 2 custodians exist. `owner.grant` and custodian revokes need **2 custodian signatures**, as `role.proposal` then `role.cosign`. The only other route is the recovery key.
- **Leads can't remove Leads or Custodians.** They grant and revoke only below their own level, in their own projects.
- **Rekey:** any removal from a project triggers `project.rekey` (§13.3).

## 6. Event model

### 6.1 Envelope

```ts
interface TeamEvent {
  v: 1;                  // schema version; fold requires v ≤ supported (else "update required")
  team: string;          // hash of genesis
  device: string;        // author device id; any peer may relay the event, so authorship is proven by sig against the admitted spki, not by who delivered it
  seq: number;           // 1.. per device, no gaps
  fork: number;          // Hypercore-style fork counter; 0 normally (see §9.4)
  prev: string | null;   // sha256 of previous event bytes in this feed
  deps: string[];        // hashes of feed heads the author had seen (≤ 32; other feeds' heads)
  lamport: number;       // MUST equal max(lamport of deps ∪ prev) + 1  — enforced; no self-chosen values
  ts: string;            // author wall clock, display only; clamped to receiver now+60s for display
  type: string;
  body: object;          // ≤ 16 KB; strings NFC, no duplicate keys
  sig: string;           // ed25519 over "baton/v1/event\0" + exact canonical bytes (RFC 8785 JCS) of all fields but sig
}
```

- **Lamport is derived, not chosen.** Backdating (setting a small lamport to sort before a revoke) and inflation (setting a huge one to win) are both impossible. Any event that breaks the rule, or has unknown `deps`, is held as pending until its deps arrive. After a bounded wait it is rejected.
- **Canonical bytes:** events are stored as the exact signed line. Hashes and signatures cover those bytes, so a relay can't re-encode an event.
- **Unknown `type` in a known `v`:** stored and relayed, ignored by the fold.
- **Higher `v`:** stored and relayed, and the UI shows "Update Baton to see N newer events".

### 6.2 Event catalogue

The org chain is marked ◆.

| Type | Body (summary) | Who may write it |
|---|---|---|
| ◆ `team.genesis` | `{name, custodianDevice, custodianPub, recoveryPub}` | the creator |
| ◆ `device.admit` | `{device, spki, member, label, model, sas}` | Custodian; `device == id(spki)` is checked |
| ◆ `device.revoke` / `.amend` | `{device, cutoffSeq, cutoffHash}` | Custodian, or the device itself |
| ◆ `role.grant` / `role.revoke` | `{member, project\|'*', role}` | per §5.2; custodian changes need a quorum |
| ◆ `role.proposal` / `role.cosign` | quorum wrapper | Custodian |
| ◆ `recovery.restore` | `{custodians[]}` | recovery key only |
| ◆ `project.define` / `project.alias` | §4.3 | Custodian, or Lead of that project |
| ◆ `project.rekey` | `{project, epoch, wraps{device: box}}` | Custodian, or Lead of that project |
| `member.profile` | `{name, jobRole, timezone}` | the member's own device |
| `device.inventory` | `{projectKeys[]}` | the device itself |
| `task.upsert` | **field patch** `{task, fields{title?, project?, group?, priority?, urgent?, brief?, noteRef?, phase?, dependsOn?}}` | Lead of the project (Developer for own subtasks) |
| `task.assign` | `{task, member, agent?}` | Lead |
| `task.ack` | `{task}` | any device of the assignee |
| `task.remind` | `{task}` | Lead (rate limit §7.4) |
| `task.take` / `task.move-device` | `{task, device}` | the assignee's device |
| `task.transition` | `{task, to, sha?, note?}` | the device holding the take (§7.2) |
| `review.decide` | `{task, decision, sha, textRef?}` | Lead; bound to `sha` |
| `push.request` | `{task, sha}` | Lead |
| `conflict.resolve` | `{task, pick}` | Lead |
| `attachment.add` / `.remove` | `{task, blob, name, kind, size}` | Lead, or the assignee (Designer: images and PDF only) |
| `text.add` | `{thread, textRef, blob}` | per §5.2 |
| `git.pushed` | `{project, remote, branch, sha, intent, filesBlob?}` | the device itself; only pushes the reflog confirms (§11.1) |
| `pr.state` | `{project, pr, state, headSha}` | any device with `gh`, deduplicated |
| `skill.offer` / `skill.decide` | spec C | Lead / the target member |
| `checkpoint` | `{vector, stateHash, lamport}` | Custodian or Lead |
| `fork.proof` | `{device, seq, eventA, eventB}` | anyone |

- **Free text** (brief notes, comments, the human note) is stored in **blobs** that events reference. That keeps events small, and the text is never folded into agent-visible state (§10).

## 7. Tasks

### 7.1 Where team tasks live

- Team tasks live **only in the folded team state**. There is no second writer.
- When a member **takes** a task, it is materialised into the matching Baton root's `tasks.json` with `origin:'team'`. That creates the worktree and branch, so the existing pipeline machinery works.
- Every later local change to a team task becomes **an event followed by a refold**. The local row is never edited directly.
- **Separate UI, same engine:** the Team workspace reads the fold, and the phases view keeps local plans. A team task created from a plan shows in both, labelled.

### 7.2 Lifecycle

```
            assign                ack               take            complete (→ review unless opted out)
 (unassigned) ──► assigned ──────────► acknowledged ─────► active ─────────────────► review
                    ▲  │ remind(×n)                          │ ▲ block/pause/resume     │
                    │  └─ reassign resets ack                ▼ │                         │ decide
                    │                                    blocked/paused      changes ◄───┤
                    │                                                  (rework → active) │
                    └────────────── reassign ───────────────────────────────── approved ◄┘
                                                                         push.request │
                                                        member "Push now" (local)     ▼
                                                                    pushed(ready) → merged → done
 side states: needs-owner (concurrent conflict, §7.6) · cancelled
```

- Add `assigned`, `acknowledged`, `paused`, `changes`, `approved`, `merged` and `needs-owner` to `TaskState`. `src/pipeline.ts:29` has none of these today.
- **"Mark done" means "request review"** unless the Lead opted the task out of review.

### 7.3 Priority

- Priority is **P0 (critical), P1 (high), P2 (normal, the default) or P3 (low)**, plus an **urgent** flag for "drop what you're doing".
- **Effective priority** = `P − min(unackedReminders, 2)`, capped at P0. Urgent always sorts first.
- `my_tasks` and the Team board sort by:
  1. the task this device currently holds
  2. urgent
  3. effective priority
  4. phase eligibility
  5. the assign's lamport
  6. task id

  This is deterministic across devices.
- **Changing a priority never pre-empts an agent mid-task.** The agent gets a templated nudge on its next Baton call: "A higher-priority task was assigned to you. Finish or hand back; ask your user."

### 7.4 Acknowledgement and reminders

- **Acknowledgement:** `task.ack` can come from **any** of the assignee's devices. It is idempotent, and the first one in fold order counts. It clears the "unacknowledged" badge on all their devices.
- **Reminders:**
  - Only Leads send them. The Lead's own device **rate-limits them to 1 per 30 minutes per task**. The fold also counts at most 2 toward effective priority, so a device that doesn't enforce the rate limit gains nothing.
  - Acknowledging resets the count.
  - Reminders on done or cancelled tasks are ignored.
- **When reminders arrive together** (for example after the member was offline), they collapse into one notification: "Reminded 3× by Rakshan".
- **"Unacknowledged for N hours"** timers use the **receiver's local time of receipt**, never the author's `ts`.

### 7.5 Tasks that span several repos (groups)

- A Lead authors a **feature** (`task.upsert {group}`), which becomes one **child task per project**. For example, "Admin table" becomes `web` and `api` children linked by `dependsOn`.
- The assign dialog checks each child against device inventory ("Dev C has no clone of *api*") and offers to split the assignment.
- Branches are named `baton/<member>/<slug>-<id6>`, one per child. `task id = <device>-<seq>` of its first upsert, so two Leads can never produce the same slug.

### 7.6 Claims, conflicts and multiple devices

- **Takes are advisory** (Docket's lesson).
  - A task in the open pool taken concurrently by two members: the lowest `(lamport, device)` wins. The loser gets a **"Lost claim"** notification, and its worktree stays so no work is lost.
  - Only the device holding the take can move the task forward. `task.move-device` hands it to the member's other Mac.
- **Concurrent conflicting edits** are events that are **causally unrelated** (neither is in the other's `deps` history). An example is a reassign in one partition while the assignee completes in another. These are **never resolved silently**. The task enters `needs-owner` and shows both sides, and the Lead writes `conflict.resolve`.
- **Per-field last-writer-wins** handles simple concurrent field edits, such as two Leads changing a title and a priority.
- **Stalls:** team tasks are **never auto-re-offered.** The UI shows "no signal since X", based on the assignee's last event.

### 7.7 Plans

- Plan files (`baton/plans/*.md`) are **authoring input only** for team tasks.
- **Publish to team** runs `applyPlan` against the fold and emits `task.upsert` events carrying `{planId, planHash}`, reusing the existing rule that done tasks are frozen.
- A device refuses a *local* `baton plan apply` of a `planId` that the team log already holds, with "published to team by Rakshan".
- The phase barrier (`lowestUnfinished`) is computed **over the fold**, so it doesn't open early on a member who can't see other members' tasks.

## 8. Sync protocol

### 8.1 Transport

- Mutual TLS 1.3 (`minVersion:'TLSv1.3'`) with **session resumption disabled**.
- Each side presents a self-signed cert whose **SPKI must equal the admitted `spki`** of a non-revoked device.
- **Server side:** the handshake allows any client cert (`requestCert:true, rejectUnauthorized:false` **only on the server listener**). The `secureConnection` handler then checks the client's SPKI against the org state **before reading a byte**, and closes the connection otherwise.
- **Client side:** `ca:[peerCert]` plus a `checkServerIdentity` that compares the SPKI. **Never `rejectUnauthorized:false` on the client**, because Node skips `checkServerIdentity` when verification fails.
- The HELLO `device` must equal the id derived from the cert.
- Authority is rechecked on every frame. A revoke that arrives mid-session closes that peer immediately.

### 8.2 Sync order on connect

It is resumable, using a `(device, seq)` cursor.

1. **HELLO** `{team, device, v, orgVector, vector, checkpoint?}`
2. **ORG:** the missing org-chain events first, then refold membership.
3. **CHECKPOINT:** if the peer is behind a signed checkpoint that it trusts, it may start from there (§13.2).
4. **EVENTS:** the missing feed ranges, most-recently-active projects first, in pages of ≤ 256 KB with an ack cursor. An interrupted transfer resumes from the cursor.
5. **LIVE:** gossip to all connected peers. Duplicates are dropped by `(device, seq)`.
6. **BLOBS:** fetched lazily. The serving peer checks that the requester's role can **read** the blob's project. Transfers are streamed, hashed and aborted beyond the declared size and the type cap.

### 8.3 Protection

- **Rollback:** never accept a lower `maxSeq` for a device. Pin the highest checkpoint seen.
- **Eclipse:** sync with **every** reachable peer (full mesh), and warn if two peers' vectors for a third device disagree after sync.
- **Ingest limits per feed:**
  - 1 event per second sustained (a burst of 200)
  - 50 MB of events per day
  - frame ≤ 1 MB, parsed only after the size check
  - JSON depth ≤ 16
  - A device over its quota is **quarantined**: stored but not folded until a Custodian releases it.
- **Blob caps:**
  - images: 10 MB and 40 MP
  - PDF: 25 MB
  - Markdown: 1 MB
  - skill bundles: 256 KB
  - Per-member daily quota.

## 9. Offline, reconnect and restore

| Situation | Behaviour |
|---|---|
| A device is offline for minutes to days | On reconnect, org first, then events. **One refold after the catch-up drains**, not per event. Catch-up events raise **one digest** ("While you were away: 2 tasks assigned, 1 review") instead of a notification storm |
| The owner is offline, 3 members are online, a late joiner arrives | Any peer relays the owner's signed events (see the diagram's scenario page). What needs a Lead (assign, review) waits; everything else proceeds |
| All Leads and Custodians are offline for days | Work, acknowledgements, pushes and transitions continue. Reviews queue. The UI shows "Waiting for a lead (offline since …)". A **delegated reviewer** role is an optional future addition |
| Two networks (split-brain) | Each side converges internally. When they meet, causally unrelated conflicts go to `needs-owner` (§7.6) and nothing is lost silently |
| Laptop restored from backup with an older feed | **At startup a device fetches its own feed from peers before appending.** If peers hold a higher `seq` for it, it adopts that head. If the key is new because the hardware changed (§4.1), it is treated as a new device, and the owner runs **Replace device** (revoke old with cutoff, admit new, move takes) |
| Truncated JSONL after a power loss | On load, verify the chain and drop the torn tail. Re-fetching from peers (above) prevents reusing a `seq` |
| A fork is detected (two events with the same `(device, seq)`) | Gossip a `fork.proof`. **Every peer truncates that feed to the common prefix and freezes it** (deterministic, whatever arrived first). A Custodian then revokes the device and admits a replacement. A legitimate restore increments `fork` via a Custodian-signed `device.admit` of the same member |
| Device lost or stolen | A Custodian revokes it with a cutoff at the last trusted seq, followed by a `project.rekey` for its projects. Its Keychain key is unusable without that user's login, and still gets revoked |
| Mixed app versions | Unknown types and newer `v` are stored and relayed. The UI shows "update required" |
| The member was removed while offline with unsynced work | Their events past the cutoff are void. The Custodian may `amend` to accept specific ones. Their worktrees stay local |

## 10. What agents see (MCP)

- `my_tasks` resolves **the agent's cwd → git remotes → project key**, then filters the fold to tasks assigned to this member in that project. It sorts per §7.3.
- It returns a **templated** contract: id, title, priority and urgent, the structured brief (goal, in scope, out of scope, acceptance, skills), attachment **file paths** (downloaded blobs in a task folder, images and PDFs only), the brief revision, state, and a `next` hint.
- Titles and brief fields are wrapped with `sanitizeUntrusted` and labelled as data.
- **Never included:** free-text notes, comments, device labels, or other members' names beyond a first name.
- New MCP tools: `ack_task`, and `request_review` (which aliases `complete_task` for team tasks). `take_task` for team tasks emits `task.take`.
- **The copy prompt carries no brief text:** "Work on Baton task **T-a1b2c3** (rev 4). Call `my_tasks` for the brief and follow it." A stale copy can't mislead the agent, and each `take` or `orient` compares revisions ("brief changed since rev 4").

## 11. Git integration

1. **Push detection:** watch `refs/remotes/**`, but emit `git.pushed` **only when the ref's reflog entry says `update by push`**. Fetches move the same refs and are ignored. The event carries the normalised remote, and the fold credits only pushes to the project's known remotes; anything else raises "Pushed to an unknown remote (fork?)".
2. **PR state:** any device with an authenticated `gh` polls every 60 s while online, and results are deduplicated by `(project, pr, state, headSha)`. Squash and rebase merges count as merged from the `gh` state. Offline, `git cherry`/patch-id is used against the default branch.
3. **Review is bound to a sha.** Any force-push or new head after approval makes the approval **stale**, and the Lead must re-approve.
4. **Merging:** only a Lead, through a native confirm dialog, runs `gh pr merge --match-head-commit <approvedSha>`. The UI warns when the default branch has no branch protection.
5. **Onboarding checks** run before first use: git identity, remote auth, and `gh auth status`. `exec.ts` has no TTY, so a credential prompt would hang. That matters for Dev C's first push.
6. **Guardrails:** detached HEAD blocks "Request review" and shows a fix-it. Unpushed work shows "Review (not pushed)" and upgrades automatically on the first push the reflog confirms.

## 12. Local security boundary (the member's own machine)

### 12.1 Loopback is not a trust boundary

- Any same-user process, including the member's own prompt-injected agent, can `curl 127.0.0.1:7077`. So:
  - **Team read routes** are loopback plus an Origin check (as today).
  - **Owner and irreversible actions** need the **IPC capability** (§12.2): assign, review, grant, admit, revoke, rekey, merge, Push now, accept a skill, and release a quarantine. MCP never reaches these routes, and plain loopback HTTP gets 403.

### 12.2 IPC capability

- Electron main creates a random 256-bit secret at each launch and keeps it in memory only.
- For an irreversible action:
  1. The renderer asks main.
  2. Main shows a **native** `dialog.showMessageBox` that states the exact action ("Merge PR #42 in *web* at a1b2c3?").
  3. On confirm, main **signs the event itself** (the key lives in main) and calls the daemon with the capability header.
- An agent can't forge the click, can't read the secret and can't read the key.

### 12.3 Electron hardening

- `sandbox: true` on the main window. Today it's `false` (`electron/main.ts:120`).
- A strict **CSP** on the launcher and dashboard: `default-src 'self'; script-src 'self'; object-src 'none'; frame-src 'none'` (the PDF viewer is the §12.4 exception).
- **`openExternal` allowlist:** `https:` and `mailto:` only, with a confirm dialog for hosts other than GitHub. It's called without validation today (`main.ts:158-168`, `:407`).
- The **`baton://pair` deep link** only pre-fills a confirmation screen showing the team name, the custodian and the SAS words. It never redeems automatically, and `h` must be an RFC 1918 or link-local address.

### 12.4 Serving attachments

- Blobs are served from a **separate origin**: a second loopback port with **no API**.
- Headers: `Content-Type` from a sniffed allowlist (png, jpeg, webp, gif, pdf, text/markdown as `text/plain`), `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, and `Content-Security-Policy: sandbox; default-src 'none'`.
- **SVG and HTML are never rendered inline.** They can be downloaded only.
- PDFs render in a sandboxed pdf.js iframe on the blob origin.
- Markdown renders with raw HTML **disabled**.
- Image dimensions are capped (decompression bombs).
- Attachment names are sanitised to `[\w .-]{1,80}` before touching disk.

### 12.5 Paths and ids

- Every id is checked with a regex before it touches `fs`: blob `^[0-9a-f]{64}$`, device `^[a-z2-7]{16}$`, skill `^[a-z0-9-]{1,64}$`.
- Files are opened with `O_NOFOLLOW`.
- `lstat` checks skill target directories for existing symlinks.

### 12.6 Text shown to humans

- **Comments** show the **signer's** name, with a Lead badge **only if the signer is a Lead at fold time**.
- **"Send to my agent"** is offered only on Lead-signed comments. Before copying, the text is scanned for URLs, `curl|sh`, base64 blobs and credential words, and a second confirmation is required.
- **Notifications** use local templates only. Peer-supplied labels are charset-limited, length-capped and rendered as quoted text. Deep links are built locally from ids that pass the regex checks.

### 12.7 Guard (enforce mode) is a guardrail, not a boundary

- Enforce mode denies:
  - force-push in every form (`-f`, `--force*`, `+refspec`)
  - pushes to the default branch (`HEAD:main`, `:main`)
  - `git config alias.*`
  - edits to `.claude/settings*.json`, `.git/hooks/**`, `.git/config` and `~/.baton/**`
  - `gh pr merge`, `gh api -X PUT …/merge`, `gh auth token` and `gh secret`
- The patterns are linear-time regexes, and commands over 4 KB are denied.
- **Documented plainly: the real control is server-side branch protection.**

### 12.8 Secrets in logs

- Redact `s=`/`token` query parameters and `--token` arguments.
- Never log `text.add` bodies or brief text.
- The SSE ring buffer carries event ids only, not free text.

## 13. Storage, compaction and encryption

### 13.1 Layout

```
~/.baton/team/<teamId>/            (excluded from Time Machine)
  feeds/<deviceId>.jsonl           exact signed lines
  pending/                         events waiting for deps
  blobs/<sha256>                   content-addressed
  project-map.json  peers.json  state.cache.json (rebuildable)
Keychain: baton.team.<teamId>.device (Ed25519), recovery key never stored (paper)
```

### 13.2 Checkpoints

- A Lead or Custodian periodically signs `checkpoint {vector, stateHash, lamport}`.
- Event **bodies** below a checkpoint older than 90 days can be pruned. Headers are kept, so the chains still verify.
- `git.pushed` file lists live in blobs with a 30-day time-to-live.
- Unreferenced blobs are garbage-collected.
- A new device can start from the latest checkpoint that a Custodian or Lead signed, plus the event tail.

### 13.3 Project confidentiality

- **v2 phase 1:** metadata (titles, priorities) is readable by everyone in the team. **Brief, note and comment blobs and attachments** are served only to devices whose members have a read role on that project.
- **Phase 2:** each project gets a symmetric key per epoch. Sensitive bodies are encrypted to it, and `project.rekey` wraps the key to each remaining device (X25519 derived from device keys). Removed members keep old ciphertext they already hold, which can't be avoided, but can't read new data. Relays store ciphertext only.

## 14. Notifications

- **Routing:** an OS notification goes only to the member's **most recently active device**, from presence. Other devices get Inbox items only.
- Acknowledging or reading clears the item on all of that member's devices.
- **Catch-up after offline** produces one digest.
- For the per-role matrix, see spec B §6, with "hub" read as "any device".

## 15. Invariants: property tests that must pass before shipping

1. The same set of events, in **any delivery order**, including forks, revokes and quota quarantines, gives an **identical fold**.
2. No event with `seq > cutoffSeq` takes effect, and neither does anything it authorised.
3. An event whose lamport isn't `max(deps ∪ prev)+1`, or whose deps are unknown, never takes effect.
4. Concurrent mutual custodian revocation leads to recovery mode, and never to an owner-less team that still accepts grants.
5. A fork proof leads every peer to the same truncated prefix.
6. `device.admit` with `device ≠ id(spki)` is ignored. A TLS peer's SPKI must equal the admitted one. **Switching the client to `rejectUnauthorized:false` makes a test fail.**
7. Ids that fail the regex never reach `fs`. Blob responses always come from the non-API origin with `nosniff`, a sandbox CSP and allowlisted types.
8. Owner and irreversible routes return 403 over plain loopback, including `curl` without the capability.
9. `openExternal` rejects every scheme except `https:` and `mailto:`.
10. MCP output never contains `text.add` text, notes or attachment names. This is a property test with injection strings.
11. The pairing SAS covers both public keys. A second redeem burns the offer.
12. Ingest quotas and size, depth and frame caps are enforced before JSON parsing.
13. Project resolution: every example setup in §1 resolves the same key for the same repo, including a fork and an SSH vs HTTPS remote.
14. `git fetch` never produces `git.pushed`.

## 16. Build phases (see the Baton plan `baton/plans/team-v2.md`)

| Phase | What ships |
|---|---|
| 0 | UI foundation: Tailwind v4, shadcn and lucide in `web/`; the new app shell; Electron hardening from §12.3 |
| 1 | Team workspace UI on demo fixtures (every state), in parallel with 2 |
| 2 | Core: project keys, envelope, feeds and fold (pure, with property tests), RBAC, lifecycle extensions |
| 3 | Sync: mTLS, ordered and resumable sync, discovery, pairing with SAS, the Keychain signer and IPC capability |
| 4 | Work loop: MCP (`my_tasks`, ack, priority), acknowledge and remind, attachments on a separate origin, git push detection, `gh` PR state, review and merge |
| 5 | Skill offers (spec C, revised), notifications and digests, simple mode |
| 6 | Checkpoints and compaction, per-project encryption, signed .dmg with Local Network keys |

## 17. Prior-art notes (sources in research)

| System | Take from it | Why not adopt it |
|---|---|---|
| Docket (MIT) | Claims across devices are advisory | Dropped P2P |
| SSB, PZP | Signed per-author feeds; fork = stop the feed; full replication blew up memory | Superseded |
| Hypercore/Autobase | Fork counter; possible future use in Electron | Heavy dependency tree, Bare runtime, experimental LAN discovery |
| p2panda-auth | Strong removal, graded permissions with conditions | Rust only |
| Keyhive/BeeKEM | Encrypt on removal, causal key management | Alpha, not for production |
| Willow/Meadowcap | Area-scoped capabilities, RBSR, Private Area Intersection | — |
| Anytype any-sync | (anti-pattern) ACL changes need online consensus nodes | — |
| Syncthing | Never trust introducers transitively (issue 8920) | — |
| Radicle | Delegate/threshold identity, i.e. the custodian quorum | — |
| LocalSend | Discovery + HTTPS protocol shape | — |
