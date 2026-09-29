# Spec D: Team UI redesign (Geist style). Handoff brief for Antigravity

- **Status:** draft for review
- **Date:** 2026-09-29
- **Parent:** [team v2 overview](2026-09-29-team-v2-overview-design.md), decision D4
- **Implementer:** Antigravity (UI only). Backend work is specs A–C, done separately.
- **Contracts from:** [A](2026-09-29-team-hub-core-design.md) · [B](2026-09-29-team-git-events-review-design.md) · [C](2026-09-29-team-skill-offers-design.md)

> **Antigravity: read this first.** Build everything against **demo mode** fixtures. The
> backend endpoints in specs A–C may not exist yet. Don't edit anything under `src/`
> (the daemon). Your scope is `web/` and `electron/notify.ts` wiring only. Read the
> repository root `CLAUDE.md` for conventions.

> **Revision 2 (2026-09-29). This overrides the sections below. Antigravity: apply these
> first.**
>
> 1. **Stack change:** migrate `web/` to Tailwind v4 (`@tailwindcss/vite`), shadcn/Radix,
>    `lucide-react` and `sonner`, matching Orca (`.refs/orca`, MIT).
>    - You may copy components from `.refs/orca/src/renderer/src/components/ui/`
>      (button, dialog, dropdown-menu, sheet, tabs, select, command, tooltip, badge, card,
>      input, popover, scroll-area, sonner). Add attribution to `NOTICE`.
>    - Map §3's tokens into Tailwind theme CSS variables. §6's hand-made component list is
>      replaced by these.
>    - Migrate screen by screen. Old inline-style screens keep working until they're
>      ported. Nothing breaks in demo mode at any point.
> 2. **Revamp the whole UI** in Orca's layout style: a dense left sidebar, a
>    workspace/project list, the main pane, and a right sheet for details. This covers
>    every screen, not only the team screens. Order: shell, Team workspace, Board/Inbox,
>    then the rest.
> 3. **The Team workspace is a separate top-level area.** Do not replace the pipeline
>    phases screen. It contains People, Team Board, Inbox, Workload and Team settings. It
>    reads the same tasks, filtered by `member`.
> 4. **Hub status chip becomes a Team sync chip:** `● Synced · 3/5 online · Admin offline
>    (last seen 12:00)`. States: synced, syncing, alone on the network, not in a team.
> 5. **Additions:**
>    - People rows show **job role** and **device model + label** ("Priya · UI · Mac
>      mini").
>    - Task detail gets **Attachments** (upload images, PDF or Markdown, drag and drop, with
>      previews).
>    - A **Workload** view: people × active, waiting and stuck counts, and a "Reassign"
>      dropdown (owner).
>    - Owner-only controls appear on **any owner device**, not only "the hub machine".
> 6. Demo fixtures must include the admin-offline scenario from the system design §8: the
>    admin shown offline, 3 online, a task delivered to a late joiner.

> **Revision 3 (2026-09-29, Team Sync v2 plus owner requests). Apply after Revision 2.**
>
> 1. **Desktop shell styled like Orca.** Use a dense left sidebar with these sections:
>    - Workspaces/Projects
>    - Team
>    - Board
>    - Inbox (with badge)
>    - Workload
>    - Skills
>    - Settings
>
>    Also:
>    - A top bar with the Team sync chip, a command palette (⌘K, `cmdk`) and the
>      **profile menu**.
>    - A right detail sheet.
>    - Tables with dense rows.
>    - The existing screens move into this shell.
> 2. **Profile section** (`#/profile`):
>    - Fields: name, job role, avatar colour, timezone, "my devices" (label, model,
>      last seen, revoke-own), "my projects" (resolved repos from project-map, with
>      "Locate repo…" for unmatched ones), and notification preferences (quiet hours,
>      and which device gets OS notifications).
>    - The profile menu also offers a simple-mode toggle.
> 3. **Priority UI:**
>    - Priority shows as a P0–P3 pill (P0 red, P1 amber, P2 neutral, P3 muted, **always
>      with text**) plus an **Urgent** toggle (a lightning icon plus the label).
>    - Sort order everywhere follows Team Sync §7.3.
>    - The effective priority shows as "P1 (was P2 · reminded 2×)".
> 4. **Acknowledge and remind:**
>    - Assigned tasks show an "Acknowledge" primary button to the assignee.
>    - Leads see "Unacknowledged · 3h" with a **Remind** button. It is disabled with a
>      countdown while rate-limited (1 per 30 minutes).
>    - Several reminders collapse into one "Reminded 3×" line.
> 5. **Compose task (Lead)** is split into two clearly labelled panels:
>    - **"Agent brief"** (structured: goal, in scope, out of scope, acceptance, skills).
>      Includes a live **"What the agent sees"** preview and the budget meter.
>    - **"Note to <name>"** (free text, human-only; the badge reads "Agents never see
>      this").
>
>    Also:
>    - Project picker using project keys. A multi-project task makes a **feature group**
>      with one child task per repo.
>    - Priority and Urgent.
>    - Attachments (drag and drop; images, PDF, Markdown).
>    - An assignee combobox showing availability ("online", "offline, last seen 12:00")
>      and repo inventory ("has web ✓, api ✗").
> 6. **Copy prompt** copies only "Work on Baton task T-xxxx (rev N). Call `my_tasks`…",
>    with a tooltip-free visible helper line saying what will be pasted.
> 7. **Simple mode** (default for the Designer role):
>    - One screen: "My tasks", as a list of cards.
>    - Each card has 4 big actions with pre-checks: **Acknowledge**, **Copy prompt**,
>      **Ready for review** and **Push now**.
>    - Pre-checks: repo located ✓, git auth ✓, branch pushed ✓. Each failing pre-check
>      shows a one-line fix-it.
>    - No diffs, no git words beyond "Push".
> 8. **Irreversible actions:** assign, review decisions, merge, Push now, accept skill,
>    and admit or revoke a device. They call `window.desktop.confirmAndSign(action)`,
>    which shows a native dialog in Electron main (Team Sync §12.2). The renderer
>    **never** calls these daemon routes directly. In demo mode, simulate the dialog with
>    a ConfirmDialog.
> 9. **Attachments:**
>    - Previews come **only** from the separate blob origin. Images go in `<img>`; PDFs in
>      a sandboxed iframe; Markdown renders with HTML disabled.
>    - SVG and HTML files show as a file chip with "Download", never inline.
> 10. **Conflicts:** a `needs-owner` task shows both sides side by side, with "Keep A" /
>     "Keep B" (Lead only).
> 11. **Digest:** after catch-up, show one "While you were away" card at the top of the
>     Inbox instead of N toasts.
> 12. **RBAC in the UI:**
>     - Hide the controls a role can't use, and don't show a disabled button for them.
>     - People → member detail shows roles per project as a matrix.
>     - Settings → Team shows custodians and recovery status.
> 13. **Demo fixtures** add: all roles, the heterogeneous repo setups from Team Sync §1,
>     an unmatched repo, a feature group spanning web and api, P0/urgent/reminded tasks,
>     `needs-owner`, "Lost claim", recovery mode, and simple mode.

## 1. The web app today (so you don't guess)

- **Stack:** React 19.2, Vite 8, TypeScript (strict). **No Tailwind, no shadcn, no icon
  library, no chart library.**
  - Styling is inline `style={{…}}` objects that read CSS variables from
    `web/src/styles/tokens.css`, plus global classes in `web/src/styles/base.css`
    (`card`, `tag`, `btn`, `btn-primary`, `btn-danger`, `mono`, `skeleton`, `nav-item`).
- **Theme:** `<html data-theme="dark|light">`, managed by `web/src/hooks/usePrefs.ts`
  (dark, light or system, plus a runtime accent chosen from `ACCENTS` in
  `web/src/lib/registry.tsx`).
- **Primitives:** `web/src/components/primitives.tsx` (StatusPill, EmptyState, ErrorState,
  SegmentedControl, Switch, Sheet, ConfirmDialog…). Icons: `web/src/components/Icon.tsx`
  (a custom SVG path map; add new paths there).
- **Shell:** `web/src/App.tsx`. The nav is the `NAV` array (:53-74). The route is plain
  state with a `switch` (:733-750). `react-router-dom` is installed but **unused**.
- **Data:**
  - `web/src/lib/api.ts` has the `BatonAPI` singleton. `BatonAPI.demo` is true by default
    on the Vite dev server.
  - Team fixtures are in `web/src/lib/demoTeam.ts`.
  - Screens poll with `usePoll`. SSE goes through `web/src/hooks/useEvents.ts`
    (fetch-based).
- **Toasts:** `web/src/lib/toast.ts` (`showToast`). There is no notification centre.
- **Current team screen:** `web/src/features/Team.tsx` (tabs: Members / Editing now /
  Teams / Share), `TeamsPanel.tsx`, `SignIn.tsx`.

## 2. Problems to fix (from the audit of the current Team screen)

1. Four peer tabs mix daily use (who's editing) with rare owner admin (Teams, Share).
   Members see two "Owner only" empty tabs.
2. Member rows have up to 5 equal-weight inline buttons. Remove sits next to Warn, and
   every row has its own team `<select>`.
3. Raw ids (`mem_…`, team ids) are shown everywhere. Essential meaning is hidden in
   hover-only `data-tip` tooltips.
4. Invite is a raw `npx baton join … --token baton_…` command in plain text, and the
   reissue card duplicates it. There's no role or expiry choice.
5. Online, offline and revoked members are mixed into one list, with no presence summary.
6. A single grey skeleton block. Action errors appear only in toasts.
7. Long prose disclaimers on three tabs.
8. No URL per tab or member, so notifications can't deep-link.
9. `inputStyle` is duplicated as one-off inline input styles instead of an Input or Select
   primitive.
10. Tasks can't show *who* (a person) is doing them, only which agent.

## 3. Design system: Geist-inspired, monochrome

These values are **ours** and inspired by Vercel's Geist. They are not Vercel's official
tokens. Apply them by **changing values in `tokens.css`**, keeping the existing variable
names so every screen restyles at once. Add the new status tokens listed below.

### 3.1 Fonts

- **Geist Sans** for the UI and **Geist Mono** for ids, paths, branches, SHAs, numbers in
  tables and keyboard hints.
- Self-host the font files from the `geist` npm package (SIL OFL) under
  `web/public/fonts/`, with `font-display: swap`.
- Remove the Inter and JetBrains Mono Google Fonts links from `web/index.html`.
- **Needs owner approval:** adding the `geist` package as a web devDependency (the font
  files only).

### 3.2 Colour

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-base` | `#0A0A0A` | `#FFFFFF` | app background |
| `--bg-surface-1` | `#111111` | `#FAFAFA` | cards, sidebar |
| `--bg-surface-2` | `#1A1A1A` | `#F2F2F2` | hover, inputs |
| `--border-subtle` | `#1F1F1F` | `#EDEDED` | dividers |
| `--border-default` | `#2E2E2E` | `#E0E0E0` | cards, inputs |
| `--border-strong` | `#454545` | `#C7C7C7` | focus-within, active |
| `--text-primary` | `#EDEDED` | `#171717` | body |
| `--text-secondary` | `#A1A1A1` | `#5E5E5E` | meta (≥ 4.5:1 on its bg) |
| `--text-tertiary` | `#7A7A7A` | `#737373` | timestamps only, never essential info |
| primary button | bg `#EDEDED`, text `#0A0A0A` | bg `#171717`, text `#FFFFFF` | the single main action per view |
| `--focus-ring` | `#3B82F6` 2px + 2px offset | same | every focusable element |

Status tokens. Each has `-fg`, `-bg` (about 12% alpha) and `-border` variants. **Status is
always colour plus an icon or text label, never colour alone.**

| Token | Hex | Meaning |
|---|---|---|
| `--st-online` | `#22C55E` | member online, task active |
| `--st-away` | `#F59E0B` | idle more than 5 min, amber-class action |
| `--st-offline` | `#737373` | offline |
| `--st-danger` | `#EF4444` | conflict, red-class action, revoked, hub unreachable |
| `--st-review` | `#A855F7` | review requested |
| `--st-ready` | `#3B82F6` | pushed with intent=ready, PR open |
| `--st-merged` | `#8B5CF6` | merged |

- The existing accent picker stays. The default accent becomes **"Mono"**: primary equals
  the text colour, as above.

### 3.3 Shape, space and motion

- **Radii:** 6px for controls, 8px for cards, 12px for sheets and dialogs. Replace the
  current 5–22px ladder values; the names stay the same.
- **Density:** a dashboard density with a 4px base grid.
  - Table rows are 40px; compact mode is 32px.
  - Sidebar items are 32px.
  - Minimum hit area is 32px on desktop and 44px at ≤ 768px width.
- **Type scale:** 12 (meta, badges), 13 (tables), 14 (body), 16 (section), 20 (screen
  title) and 24/32 (empty-state hero only). Line height is 1.5 for body and 1.2 for
  headings.
- **Borders over shadows:** use a 1px border on cards. Shadows appear only on floating
  layers (menus, dialogs, toasts).
- **Motion:** 150ms ease-out for hover and press, 200ms for sheets in and 150ms out. Honour
  `prefers-reduced-motion`. No scroll-reveal animations in the dashboard.

## 4. Information architecture

Replace the single "team" nav item with:

```
Sidebar
  Command Center
  Board            ← was "pipeline"; now shows people
  Inbox  (●3)      ← NEW notification centre
  People           ← was "team"
  …(existing items unchanged)
  Settings
      └ Team admin  ← owner-only: pairing, devices, project access, hub certificate, share
```

- **Deep links:** use hash routes via `react-router-dom` (already installed) with
  `HashRouter`. The routes you need are:
  - `#/people`
  - `#/people/:memberId`
  - `#/board?member=&project=`
  - `#/board/task/:taskId`
  - `#/inbox`
  - `#/inbox/:itemId`
  - `#/settings/team`
  - `#/settings/team/pair`

  Other screens can stay on state routing for now. Map `baton:route` values to hashes so
  there is one source of truth.
- **Hub status in the TopBar:** a chip showing `● Hub: Rakshan's MacBook · 4/5 online`.
  States are connected (green dot), reconnecting (amber, spinner), unreachable (red, with
  the text "working offline") and solo (hidden). Clicking it opens a popover with the hub
  name, fingerprint words, latency and the last event time.

## 5. Screens

### 5.1 People (`#/people`), for everyone

```
People                                              [Search ⌘F]   [Add teammate]*
● 4 online · 1 away · 2 offline      12 files being edited · 1 conflict ⚠
┌───────────────────────────────────────────────────────────────────────────────┐
│ Name            Status        Working on                 Projects   Last seen │
│ (R) Rakshan     ● Online      task-12 Admin API           all        now      │
│ (P) Priya       ● Online      task-14 Admin table UI      web        now   ⋯  │
│ (A) Arun        ◐ Away 12m    task-9  Push notifications  app        12m   ⋯  │
│ ─ Offline ─────────────────────────────────────────────────────────────────── │
│ (M) Meera       ○ Offline     —                           web        2d    ⋯  │
└───────────────────────────────────────────────────────────────────────────────┘
Editing now                                                  [Show all files]
 ⚠ src/admin/Table.tsx   Priya (ui/admin-table) + Rakshan (api/admin)  same file, different branches
   src/api/users.ts      Rakshan · 14m
```

- `*` Owner only, and only shown on the hub machine.
- Row click opens **Member detail** (`#/people/:id`) as a right-side Sheet.
- The `⋯` overflow menu holds Warn, Disconnect device… and Remove from team…. Remove is
  last, red, and behind a confirm dialog.
- Revoked members don't appear here; they're in Settings → Team admin → History.
- A member viewing this screen sees the same table with no admin actions.
- The "Editing now" section is the old claims tab, condensed to at most 5 rows plus
  "Show all".

### 5.2 Member detail (Sheet)

- **Header:** avatar, name, status, role badge and projects as chips.
- **Sections:**
  - Current task (link)
  - Recent activity: the last 10 events, from `git.pushed`, `task.*` and `review.*`
  - Devices: label, last used, fingerprint words and a revoke action
  - Warnings

### 5.3 Add teammate / Pairing (`#/settings/team/pair`), owner only

1. **Step 1:** the owner enters a name (required), chooses projects from a multi-select of
   workspace projects (**not** free text). The role is fixed to Member, with the helper
   text "Owner powers only work on the hub machine" (spec A §5). There is no role picker.
2. **Step 2:** shows the **QR code**, the address `192.168.1.20:7443`, the code `K7Q-4M2`,
   a 120 s countdown ring and a "Regenerate" button. Copy buttons confirm with a "Copied"
   state for 1.5 s.
3. **Step 3:** when `member.pair.requested` arrives, show a request card: "Priya's
   MacBook-Air wants to join", the fingerprint words in Geist Mono, and [Allow] (primary)
   and [Deny].
4. **Step 4:** a success state that links to "Assign a first task".

- **Member side** (`#/settings/team`, when not on a hub): [Scan QR] (camera, or paste the
  `baton://pair` link) or [Enter address + code]. Then show the fingerprint words with the
  line "Check these match the admin's screen" and [They match], then "Waiting for admin…"
  until Allow or Deny arrives.
- **Discovered hubs** (spec A §10) appear as a list, with the line "Found on your network,
  you'll still need the code".
- **QR generation:** add `qrcode-generator` (MIT, no dependencies) to `web/`. **This needs
  owner approval.** The daemon itself stays zero-dependency.
- **Never display a device token.** The old invite command card is removed from the UI.

### 5.4 Board (`#/board`), which replaces the Pipeline screen's task card

- The phase swimlanes stay. The **TaskCard** changes to:
  - title, then the person's avatar and name (large) with the agent glyph next to it
    (small)
  - state pill; intent badge `ready` or `track` once pushed
  - a review badge
  - scope chips (`inScope` count)
  - `⚠ out of scope edit` when present
- Filters: Person, Project and State. Filter values live in the URL query.
- **Task detail** (`#/board/task/:id`) is a Sheet with these sections:
  - **Brief:** goal, in scope, out of scope, acceptance checklist, references, skills
  - Assignment: person and agent, editable by the owner
  - Timeline: task, git and review events
  - Review panel (§5.6)
- **Assign** (owner): a combobox of people, filtered to those who have the task's project,
  with a warning and "Add project to Priya" otherwise. An agent is optional. There's also
  a brief editor with the 1,500-token budget meter from spec A §6.4, shown as a bar
  measuring characters divided by 4 against 6,000.

### 5.5 Inbox (`#/inbox`), new

- Tabs: All / Needs action / Git / Mentions, plus an unread count on the sidebar badge.
  Use `role="status"` with text such as "3 unread notifications", not a bare number.
- Each item shows an icon, a templated title (texts come from spec B §6, built locally
  and never taken from the network), a relative time and an unread dot.
- Items that need action show inline buttons:

| Item | Buttons |
|---|---|
| review.requested (admin) | Open review |
| review.decided changes (member) | Send to my agent, Open task |
| push.requested (member) | **Push now** (primary), View diff |
| skill offer (member) | Review offer |
| pair request (admin) | Allow, Deny |

- **Send to my agent** copies a prompt to the clipboard, then shows "Copied, paste it into
  your agent".
- **Push now** asks for confirmation: "Push branch ui/admin-table to origin?" It then shows
  progress, the result, and any error inline.
- Empty state: "You're all caught up".

### 5.6 Review panel (inside Task detail)

- **Header:** branch, SHA (mono), intent badge, a "Compare on GitHub" link when available,
  and the files changed (`--stat` list).
- Owner actions: [Approve] [Request changes] [Ask question]. The last two open a textarea
  with a visible label, and approving offers [Approve & ask to push].
- **Member view:** the comment thread, with admin comments shown as quoted text from the
  admin. The member can reply with text.

### 5.7 Skill offer (member) and Offer to team (owner)

- **Owner, Skills screen:** each skill row gets an [Offer to team] action. It opens a
  dialog to pick people or "everyone in project X". Show warnings from spec C §5 (over 500
  lines, and suggestions to use `disable-model-invocation` or `context: fork`) and any
  blocked frontmatter (`allowed-tools`, `hooks`, `model`) as errors with the reason.
- **Member, offer review:** a Sheet with:
  - skill name, version and "from Rakshan"
  - size
  - scan findings as a list with severity
  - a **diff** against the installed version (unified, monospace, ±lines coloured
    **and** prefixed with `+`/`−`)
  - agent checkboxes
  - [Accept] and [Decline]
  - a "Previous versions" list with Revert

### 5.8 Settings → Team admin (owner, hub machine)

Sections:
- **Devices:** a table of all devices across members, with revoke, last used and idle
  expiry.
- **Project access:** a matrix of person × project checkboxes.
- **Guard mode per member:** advise or enforce (spec B §8).
- **Hub certificate:** fingerprint words, created date, and [Rotate certificate…] with a
  warning that everyone must re-pair.
- **Network:** the address(es) and port, a discovery beacon on/off toggle, and the old
  "Share" tunnel helpers collapsed under "Advanced: remote access".
- **History:** a durable audit log from the event log, filterable. This replaces the old
  AuditStrip.

## 6. Shared components to add

Add these to `web/src/components/`. Each is typed and keyboard-accessible, and each has a
demo usage.

| Component | Notes |
|---|---|
| `Input`, `Textarea`, `Select`, `Combobox`, `MultiSelect` | visible label, helper text, error under the field; replace `inputStyle` duplicates |
| `Menu` (overflow `⋯`) | arrow keys, Esc, focus return, destructive item styled and last |
| `Tabs` (URL-synced) | replaces SegmentedControl for page-level tabs |
| `Avatar`, `PresenceDot`, `Facepile` | initials, colour from name hash, dot has an `aria-label` |
| `DataTable` | sticky header, row hover, keyboard row focus, empty/loading/error states, compact mode |
| `Banner` | info/warn/danger, used for "hub unreachable", "re-pair to enable encryption" |
| `QRCode` | wraps `qrcode-generator`, renders an SVG, has alt text giving the address and code |
| `Countdown` | ring plus seconds; announces "expired" via `role="status"` |
| `Kbd` | shortcut hints |
| `SkeletonRows(n)` | row-shaped placeholders that replace the single grey block |
| `DiffView` | unified diff, line numbers, `+`/`−` prefixes, wraps long lines |

## 7. Types and API contract

Add these to `web/src/types.ts`, mirroring specs A–C:

```ts
interface TeamMember { id: string; name: string; role: 'owner'|'member'; projects: string[]|'*';
  status: 'online'|'away'|'offline'; lastSeen?: string; currentTaskId?: string;
  devices: { id: string; label: string; lastUsedAt?: string; fingerprintWords?: string; revokedAt?: string }[] }
interface HubStatus { state: 'solo'|'connected'|'reconnecting'|'unreachable'; hubName?: string;
  fingerprintWords?: string; online?: number; total?: number; lastEventAt?: string }
interface TaskBrief { goal: string; inScope: string[]; outOfScope?: string[]; acceptance: string[];
  references?: string[]; skills?: string[] }
interface InboxItem { id: string; type: string; createdAt: string; read: boolean;
  taskId?: string; member?: string; project?: string; branch?: string; sha?: string;
  action?: 'open-review'|'send-to-agent'|'push-now'|'review-offer'|'pair-decision' }
interface PairingOffer { id: string; address: string; code: string; qrPayload: string; expiresAt: string }
interface PairRequest { offerId: string; deviceLabel: string; fingerprintWords: string }
interface SkillOffer { skillId: string; version: number; from: string; sizeBytes: number;
  findings: { severity: 'info'|'warn'|'high'; message: string }[]; diff?: string; installedVersion?: number }
```

- `LaneTask` gains `member?: string | null`, `brief?: TaskBrief | null`,
  `intent?: 'track'|'ready'` and `review?: 'requested'|'approved'|'changes'|'question'`.
- Add these to `BatonAPI`, each with a **demo implementation first**:
  - `getTeamMembers`, `getHubStatus`
  - `createPairingOffer`, `decidePairRequest`
  - `assignTask`, `transitionTask`
  - `getInbox`, `markInboxRead`
  - `decideReview`, `requestPush`, `pushNow`
  - `offerSkill`, `getSkillOffers`, `decideSkillOffer`

  Endpoint paths are in specs A §6.2 and B §7. In real mode, while an endpoint returns
  404, show the `ComingSoon` primitive, not an error.
- Add these event types to `useEvents.ts` `EVENT_TYPES`:
  - `task.assigned`
  - `git.pushed`, `git.default.advanced`
  - `pr.opened`, `pr.merged`
  - `review.requested`, `review.decided`
  - `push.requested`
  - `skill.offer.created`, `skill.offer.accepted`, `skill.offer.declined`
  - `member.pair.requested`, `member.pair.approved`, `member.pair.denied`

## 8. Demo fixtures (required, since demo mode is the showcase)

- **Extend `demoTeam.ts`:**
  - a 5-person team matching the People wireframe
  - a hub status in each of the 4 states (switchable from TweaksPanel)
  - 3 tasks with briefs (one per person), one in `review`, and one with an out-of-scope
    edit warning
  - an Inbox with 8 items covering every action type
  - an open pairing offer with a live countdown, and a pending pair request
  - a skill offer with a diff and 2 findings
- **Don't delete** `DEMO_TEAM`, `DEMO_TEAM_SOLO` or `DEMO_REACHABILITY`. Other screens may
  still use them, so extend them or add alongside.

## 9. Accessibility and quality checklist (the definition of done)

- [ ] Text contrast is at least 4.5:1 in both themes. Check `--text-secondary` on
  `--bg-surface-1`.
- [ ] Every interactive element has a visible `--focus-ring`, and the full flows work with
  keyboard only: pair, assign, review, push, accept offer.
- [ ] Icon-only buttons have `aria-label`s. There are no emoji icons; use SVG from
  `Icon.tsx`.
- [ ] Status is never shown by colour alone.
- [ ] Live counts use `role="status"` with a contextual sentence.
- [ ] `prefers-reduced-motion` is respected.
- [ ] No horizontal scroll at 375px. Below 768px, the tables collapse to cards.
- [ ] Loading, empty and error states exist for every list. Errors appear inline near what
  failed, not only as a toast.
- [ ] No raw ids in primary text (ids only in mono, secondary, copyable).
- [ ] Deep links work from Inbox items and from OS notifications (`electron/notify.ts`
  passes the hash route).
- [ ] `npm run build --prefix web` passes with strict TS. Demo mode works on the Vite dev
  server with the backend stopped.

## 10. Out of scope for this handoff

- The usage and token dashboard redesign (spec E, later)
- Mobile PWA (spec F)
- Restyling screens other than People, Board, Inbox, Settings → Team admin and the TopBar
  chip. Global token changes will restyle other screens automatically. Fix only obvious
  breakage there.
