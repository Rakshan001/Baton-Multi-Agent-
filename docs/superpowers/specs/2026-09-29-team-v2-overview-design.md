# Team v2: overview and roadmap

- **Status:** draft for review
- **Date:** 2026-09-29
- **Owner:** Rakshan
- **Supersedes the UX of:** team online mode (STATUS.md session 17)
- **Research:** [../../research/2026-09-29-token-and-team-research.md](../../research/2026-09-29-token-and-team-research.md)

## 0a. Revision 3 (2026-09-29): Team Sync v2 after 4 independent reviews

**Team Sync v2** ([README](../../system-design/team-sync/README.md)) is now the
authoritative design. It adds:
- RBAC: Custodian, Lead, Developer, Designer, Viewer, Relay, per project
- stable project keys across heterogeneous repo setups
- priority, acknowledgement and reminders
- feature groups spanning repos
- derived lamport and cutoff revocation
- the Keychain signer plus the IPC capability for irreversible actions
- a separate blob origin
- checkpoints

Every finding and its resolution is in the
[review register](../../system-design/team-sync/REVIEW-2026-09-29.md). The build plan is
`baton/plans/team-v2.md`.

## 0. Revision 2 (2026-09-29, owner review): these changes override the text below

1. **Topology:** D5 is replaced. There is **no single hub**. Every device is a coordinator
   and holds a signed replica of the team log. Design:
   [docs/system-design/team-sync/](../../system-design/team-sync/README.md), with draw.io
   diagrams. An always-on Mac mini is an *optional* extra peer. Invariant 1 ("only the hub
   writes") becomes "only an authorised device's signed event takes effect".
   Invariant 3 ("owner is loopback-only") becomes "owner = **owner devices**, granted in
   the log". There can be more than one, and the role can move to another device.
2. **UI stack:** move `web/` to **Tailwind v4 + shadcn/Radix + lucide + sonner** (Orca's
   stack). MIT components from `.refs/orca/src/renderer/src/components/ui/` may be copied
   with NOTICE credit. The whole UI is revamped, not only the team screens.
3. **Team workspace is its own screen**, separate from the pipeline phases view. It uses
   **the same task engine** (tasks carry `member`).
4. **Added scope:**
   - task **attachments** (images, PDF, Markdown; content-addressed blobs)
   - member **job role** (Backend, Mobile, Web, UI, All-rounder) and **device model**
     (`sysctl hw.model`, e.g. "Mac mini")
   - a **workload view** with owner reassignment from a dropdown
   - agents may run `gh pr create`, and the owner merges with `gh pr merge` after a human
     confirmation
5. **Distribution:** a signed macOS **.dmg** (Electron), released in phases. This needs an
   Apple Developer ID for notifications and Local Network permission. No npm release is
   planned for the team features.
6. **Day-1 target:** the new UI shell and Team workspace on demo data, plus the
   assign/take/transition core on the shared task engine. Security-critical pieces (mTLS,
   pairing, signing) follow on days 2–5 and are not rushed.
7. **Productivity claims:** no "X% faster" claims. Measure time per task, rework rate and
   conflicts instead.

## 1. Why

Baton's team mode works mechanically but fails as a product. A hub, bearer-token members,
presence, file claims and hub-arbitrated task claims all exist, but:

- Joining means copying and pasting a raw token, with no discovery and no QR.
- A task can only be assigned to an **agent**, not to a **person**.
- A member's progress (activate, pause, done) never reaches the hub. Members can't see the
  hub's task list.
- Nobody hears about a teammate's push, PR or merge.
- The admin can't hand their skills to a teammate's agent.
- There are no teammate notifications, and the UI is weak.

**Goal.** An admin who knows the project can run a team of 3–5 people, some with little
coding skill. Each person uses their own agent (Claude Code, Cursor, Antigravity,
OpenCode, Codex) on their own laptop. The admin assigns work, and every event lands on
one live board, with no account and no vendor cloud.

**Positioning:** *your agents, your subscriptions, your machines*. Competitors assign to
cloud agents: Conductor Cloud multiplayer, GitHub Agent HQ, Linear with Cursor, Devin.

## 2. Decisions (confirmed by the owner on 2026-09-29)

| # | Decision |
|---|---|
| D1 | Baton team features are the product priority. The token-economics work is deferred. |
| D2 | "Works without internet" means **coordination survives a WAN outage** on the same LAN or hotspot. Agents still need the internet to reach their models. No ad-hoc Wi-Fi mesh. |
| D3 | Skills reach members as **hub offers that the member accepts**: signed, Markdown-only, quarantined until accepted. Never auto-pushed. |
| D4 | The UI is rebuilt in a Vercel/Geist-inspired monochrome style. The UI spec is written to be handed to Antigravity. |
| D5 | Topology is **hub-and-spoke**. The admin's daemon is the hub and GitHub stays the source of truth for code. The hub never becomes the only copy of anything important. |
| D6 | Anything that comes from the hub and reaches an agent is **untrusted data**, never instructions. Irreversible actions such as push or a destructive git command need a **local human click**. |

## 3. Decomposition

Each part gets its own spec and plan, then gets built. They are ordered by dependency.

| Spec | Scope | Depends on |
|---|---|---|
| **A. Hub core** ([2026-09-29-team-hub-core-design.md](2026-09-29-team-hub-core-design.md)) | TLS and pinning, LAN discovery, QR and code pairing, per-device tokens with expiry, the member-assignment model, hub-owned task state, a durable event log, per-member repo sets, path redaction | — |
| **B. Git events and review loop** ([2026-09-29-team-git-events-review-design.md](2026-09-29-team-git-events-review-design.md)) | push with an intent flag, PR and merge awareness, teammate notifications (Electron and web), structured agent nudges, admin ⇄ member review requests, human-confirmed push | A |
| **C. Skill offers** ([2026-09-29-team-skill-offers-design.md](2026-09-29-team-skill-offers-design.md)) | signed Markdown-only skill bundles, offer and accept, quarantine, diff between versions | A |
| **D. Team UI redesign** ([2026-09-29-team-ui-redesign-design.md](2026-09-29-team-ui-redesign-design.md)) | Geist design system tokens, app shell, Team, Board, Inbox, Pairing and Member screens, demo fixtures | A and B contracts (can start from fixtures in parallel) |
| **E. Token economics** (later) | usage v2 with a heatmap, cache metrics and cost per merged task; slimming bundled skills; a budgeted task brief | — |
| **F. Mobile** (later) | a PWA paired by QR against the hub, reusing A's pairing | A, D |

## 4. Architecture

```
                 ┌──────────────── ADMIN LAPTOP = HUB ────────────────┐
  Phone (F) ─QR──┤ baton daemon  (node:https, self-signed, pinned)    │
                 │  tasks (member + agent + brief)   ← single writer  │
                 │  event log (durable JSONL, seq + epoch)            │
                 │  presence · file claims · overlaps        (exists) │
                 │  merged multi-repo KB (graphify)          (exists) │
                 │  skill catalog → signed offers                 (C) │
                 │  git watcher: branches / PRs / merges          (B) │
                 └──────┬──────────────────┬──────────────────┬───────┘
      UDP beacon (hint) │ HTTPS + pinned cert + device token │ SSE(seq) + POST
              ┌─────────┴───┐      ┌───────┴─────┐     ┌──────┴──────┐
              │ Dev A       │      │ Dev B (UI)  │     │ Dev C (app) │
              │ baton member│      │ web repo    │     │ mobile repo │
              │ any agent   │      │ only        │     │ only        │
              └─────────────┘      └─────────────┘     └─────────────┘
  Code transport: GitHub or any git remote when online.
  During a WAN outage members keep committing locally, and coordination keeps working.
```

### Invariants

1. **Only the hub writes team state** (tasks, assignments, state transitions, offers).
   Members request changes through hub endpoints and never sync files. This follows the
   operator split already in `src/operator.ts`.
2. **Every member → hub request needs TLS plus a device token.** Loopback on the hub
   machine stays credential-free, as today (`src/access.ts`).
3. **Owner actions are loopback-only.** Being the admin means sitting at the hub machine,
   so no remote caller can use owner powers.
4. **Nothing from the hub is executable on a member.** Skills are Markdown only. Agent
   nudges use fixed templates with structured fields. Free text from the admin goes to
   humans only.
5. **Degrade, don't block.** If the hub is unreachable, members keep working locally, the
   UI shows it as unreachable, and nothing hangs. The current fail-closed claim behaviour
   (`pipeline-claims.ts`) gets an explicit "work offline" override (spec A §6).

## 5. Security model (summary; details in each spec)

| Threat | Control | Spec |
|---|---|---|
| Sniffing and replay on office Wi-Fi | TLS with a certificate fingerprint pinned at pairing; per-device tokens; 14-day idle expiry | A |
| QR photographed or shoulder-surfed | One-time code valid for 120 s, burned on use; the admin confirms the device; rate-limited redeem | A |
| Rogue hub or beacon | The beacon is only a hint; trust comes only from the pinned fingerprint | A |
| Hub pushes code into member machines | Markdown-only skills, Ed25519-signed, quarantined, accepted by the member, shown as a diff | C |
| Prompt injection through hub text | Fixed templates with structured fields; the untrusted envelope (`src/handoff/untrusted.ts`) | B |
| Spoofed "push approved" | Push happens only after a local click in the member's UI | B |
| Path and identity leakage | Remote responses carry repo-relative paths only | A |
| Non-coders approving dangerous actions | Deterministic danger classes (red/amber/green); red needs the admin | B |

`docs/security.md` must be **rewritten**: it currently says "do not bind to a public
interface".

## 6. Roadmap

| Phase | Content | Exit criteria |
|---|---|---|
| 1 | A1–A4: TLS, pairing, device tokens, `member` field, hub-owned state, durable log | Four laptops pair by QR over TLS. The admin assigns to a person. The member's agent takes the task with `my_tasks` and completes it, and the hub board updates live. A hub restart loses nothing. |
| 2 | D (UI) in parallel from fixtures, then wired to real endpoints | The Team, Board, Inbox and Pairing screens ship in demo and real mode |
| 3 | B: git events, notifications, review loop | A push shows up on every peer within 5 s on LAN. PR and merge are visible online. The review request round-trip works. |
| 4 | C: skill offers | The admin offers `bug-fix`; the member sees the diff, accepts it, and it installs into their agent's skill dir |
| 5 | A5: UDP discovery, macOS entitlements, signed Electron builds | The hub appears automatically on an ordinary office LAN |
| later | E (tokens), F (mobile) | — |

## 7. Out of scope

- A true P2P or ad-hoc mesh
- CRDTs
- A git server on the hub (use GitHub; a LAN mirror can be revisited after phase 5)
- Proxying LLM traffic
- Cloud relay
- Multiple hubs in one team

## 8. Open questions

1. Can a member belong to more than one hub at once (for example two client projects)?
   The proposal is yes: `host.json` becomes a list, and the UI switches hubs as
   `connections.ts` already does.
2. Do non-coder members get a "simple mode" in the UI, with only My Tasks, Chat-to-agent
   and Done?
3. Should the team's usage be visible to everyone, or only to the admin? This only matters
   once spec E exists.
