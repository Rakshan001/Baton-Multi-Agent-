---
plan: team-v2
goal: Team v2 — local-first team collaboration (Team Sync v2) with RBAC, priority/ack/remind, and a full Orca-style UI revamp
requireReview: true
---

<!--
Design sources (read before taking a task):
  docs/system-design/team-sync/README.md            Team Sync v2 (authoritative)
  docs/system-design/team-sync/REVIEW-2026-09-29.md findings register (S-*/E-* ids)
  docs/superpowers/specs/2026-09-29-team-ui-redesign-design.md  (Revisions 2+3 first)
  docs/superpowers/specs/2026-09-29-team-git-events-review-design.md
  docs/superpowers/specs/2026-09-29-team-skill-offers-design.md

  baton plan check team-v2
  baton plan apply team-v2
  baton plan approve team-v2        # human only
  baton dispatch team-v2 --dry-run  # human only

Each task: own worktree + branch, commit per logical change, push only when the
human approves. Daemon (src/) stays zero-dependency; web/ may add the deps named
in its task. Demo mode must keep working after every task.
-->

## Phase 1 — Foundations + UI (UI chain runs in parallel with the backend core)

### ui-foundation @antigravity
**scope:** `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/index.html`, `web/src/styles/**`, `web/src/components/ui/**`, `web/public/fonts/**`, `NOTICE`
**expects:** Tailwind v4 via @tailwindcss/vite, shadcn/Radix primitives, lucide-react, sonner, cmdk installed in web/ only; Geist Sans/Mono self-hosted; tokens from spec D §3 mapped to Tailwind theme CSS variables for dark and light; primitives copied from .refs/orca/src/renderer/src/components/ui with NOTICE attribution; existing screens still render unchanged; npm run build --prefix web passes
**principles:** no daemon (src/) changes; keep existing CSS variable names working during migration; no emoji icons
**skills:** ui-ux-pro-max, traceable-changes, verify-before-done

Set up the new UI stack and design tokens that every later UI task builds on.

### electron-hardening
**scope:** `electron/main.ts`, `electron/nav-guard.ts`, `electron/preload.ts`, `electron/ui/index.html`, `test/electron-*.test.ts`
**expects:** main window sandbox true; strict CSP on launcher UI; shell.openExternal only for https: and mailto: via one validated helper used by all three call sites; tests cover rejected schemes (file:, smb:, custom); desktop build passes
**principles:** fixes S-H4 from the review register; no behavior change for allowed links
**skills:** traceable-changes, verify-before-done

Close the Electron gaps found in review before any team content reaches the UI.

### team-events
**scope:** `src/team/canonical.ts`, `src/team/envelope.ts`, `src/team/feed.ts`, `test/team-envelope.test.ts`, `test/team-feed.test.ts`
**expects:** RFC 8785 canonical bytes with NFC and duplicate-key rejection; envelope v1 per Team Sync §6.1 with domain-separated Ed25519 signatures; lamport must equal max(deps ∪ prev)+1 else event pending/rejected; per-feed append with hash chain, torn-tail recovery, fork detection producing fork.proof; id regexes enforced before fs; vitest green
**principles:** zero dependencies (node:crypto only); pure where possible; exact signed line bytes are what is stored and hashed
**skills:** traceable-changes, verify-before-done

The signed event log each device owns.

### project-keys
**scope:** `src/team/projects.ts`, `test/team-projects.test.ts`
**expects:** remote normalization (ssh/https/credentials/.git) to one form; resolution order any-remote then root-commit (flagged needs-confirm) then unmatched; excludes .baton/wt worktrees via git-common-dir; handles duplicate clones, forks via upstream, monorepo subpath; all four setups in Team Sync §1 resolve the same key for the same repo (invariant 13); git calls through src/util/exec.ts
**principles:** fixes E-1; never derive ids from folder names
**skills:** traceable-changes, verify-before-done

Stable project identity across heterogeneous repo layouts.

### lifecycle-priority
**scope:** `src/pipeline.ts`, `src/lifecycle.ts`, `test/lifecycle*.test.ts`, `test/pipeline*.test.ts`
**expects:** TaskState adds assigned, acknowledged, paused, changes, approved, merged, needs-owner; task fields priority P0-P3, urgent, member, brief, briefRev, origin; nextFor sorts per Team Sync §7.3 deterministically; existing solo pipeline tests still pass unchanged
**principles:** fixes E-4; solo (non-team) behavior must not change
**skills:** traceable-changes, verify-before-done

Extend the shared task engine for team states and priority.

### team-fold
**after:** team-events
**scope:** `src/team/fold.ts`, `src/team/rbac.ts`, `src/team/types.ts`, `test/team-fold.test.ts`, `test/team-rbac.test.ts`
**expects:** org chain folded first; authority at author's deps; roles Custodian/Lead/Developer/Designer/Viewer/Relay per Team Sync §5.2; strong removal via cutoffSeq voiding transitive grants; mutual custodian revoke enters recovery mode; custodian quorum; per-field LWW task patches; ack/remind/effective priority per §7.3-7.4; causally concurrent conflicts produce needs-owner; property tests for invariants 1-5 (any delivery order ⇒ identical fold, including forks and revokes)
**principles:** fold is pure and deterministic; wall-clock ts never affects state
**skills:** traceable-changes, verify-before-done

The deterministic state machine, including RBAC.

### ui-shell @antigravity
**after:** ui-foundation
**scope:** `web/src/App.tsx`, `web/src/shell/**`, `web/src/lib/routes.ts`, `web/src/features/Settings.tsx`
**expects:** Orca-style shell per spec D Rev 2-3: dense sidebar (Workspaces, Team, Board, Inbox, Workload, Skills, Settings), top bar with Team sync chip, cmdk palette, profile menu, right detail sheet; HashRouter deep links from spec D §4; existing screens reachable inside the new shell; demo mode works with the backend stopped; accessibility checklist spec D §9 passes for the shell
**principles:** no daemon changes; hide controls a role cannot use
**skills:** ui-ux-pro-max, verify-before-done

The new application frame.

### team-ui @antigravity
**after:** ui-shell
**scope:** `web/src/features/team/**`, `web/src/lib/demoTeam.ts`, `web/src/lib/teamApi.ts`, `web/src/types.ts`, `web/src/hooks/useEvents.ts`
**expects:** People, member detail with role matrix, Team Board, Task detail (split Agent brief / Note compose with agent preview, attachments, priority/urgent, ack/remind, review panel, needs-owner view, lost-claim), Inbox with digest, Workload with reassign, Profile, Simple mode, pairing screens with SAS words — all on demo fixtures listed in spec D Rev 3 item 13; irreversible actions go through a confirmAndSign stub (ConfirmDialog in demo); copy prompt copies only task id + rev
**principles:** never render peer free text as HTML; status never by color alone
**skills:** ui-ux-pro-max, verify-before-done

The whole Team workspace, built against fixtures.

## Phase 2 — Sync and trust

### keychain-signer
**scope:** `electron/signer.ts`, `electron/capability.ts`, `electron/main.ts`, `electron/preload.ts`, `test/electron-signer.test.ts`
**expects:** Ed25519 device key generated and stored in macOS Keychain (ThisDeviceOnly, app-restricted), never on disk; per-launch 256-bit IPC capability in memory; confirmAndSign(action) shows a native dialog stating the exact action then signs; hardware-UUID change mints a new key; ~/.baton/team excluded from Time Machine
**principles:** fixes S-C2 and S-C3; the daemon never sees the private key
**skills:** traceable-changes, verify-before-done

Move signing and irreversible confirmation into Electron main.

### team-api
**after:** keychain-signer
**scope:** `src/server.ts`, `src/endpoints/team.ts`, `src/access.ts`, `test/team-api.test.ts`
**expects:** team read routes loopback plus Origin; owner/irreversible routes return 403 without the IPC capability header, including curl over loopback (invariant 8); fold diffs published on the events bus as task.* / member.* / review.* events without free text
**principles:** loopback is not a trust boundary for irreversible actions
**skills:** traceable-changes, verify-before-done

Daemon endpoints for the Team workspace.

### peer-sync
**after:** team-fold
**scope:** `src/team/sync.ts`, `src/team/tls.ts`, `src/util/x509.ts`, `test/team-sync.test.ts`
**expects:** mutual TLS 1.3, no resumption, SPKI equals admitted key, client never rejectUnauthorized:false (test fails if switched); ordered resumable sync ORG→CHECKPOINT→EVENTS→LIVE→BLOBS with (device,seq) cursor; rollback and quota protections per §8.3; single refold after catch-up; end-to-end test with 4 daemons reproducing the admin-offline scenario §8 ends with identical folds
**principles:** zero dependencies; nothing parsed before size checks
**skills:** traceable-changes, verify-before-done

Peer-to-peer replication between devices.

### discovery-pairing
**after:** peer-sync
**scope:** `src/team/discovery.ts`, `src/team/pairing.ts`, `test/team-discovery.test.ts`, `test/team-pairing.test.ts`
**expects:** opaque HMAC beacons on :47077, bounded parsing, dial only admitted devices; pairing offers 120 s single-use, ≥10-char code, SAS over both public keys shown as 6 words, second redeem burns offer, custodian-signed device.admit; baton://pair only pre-fills a confirm screen and accepts RFC1918/link-local hosts
**principles:** beacons never grant trust
**skills:** traceable-changes, verify-before-done

Finding peers and admitting new devices.

## Phase 3 — Work loop

### mcp-team-tools
**scope:** `src/mcp-pipeline.ts`, `src/team/mcp.ts`, `test/team-mcp.test.ts`
**expects:** my_tasks resolves cwd→remote→project key and sorts per §7.3; ack_task and request_review tools; take_task emits task.take and materializes the row with origin team; brief-rev change notice; property test that MCP output never contains notes, comments or attachment names (invariant 10)
**principles:** agent-facing text is templated and wrapped with sanitizeUntrusted
**skills:** traceable-changes, verify-before-done

What agents see and do.

### blobs-attachments
**scope:** `src/team/blobs.ts`, `src/team/blob-server.ts`, `test/team-blobs.test.ts`
**expects:** content-addressed store with streaming hash and size caps per type; separate loopback origin with no API; sniffed allowlist types, nosniff, Content-Disposition attachment, sandbox CSP; SVG/HTML never inline; role-checked serving to peers; invariant 7 tests
**principles:** fixes S-C4 and S-H1
**skills:** traceable-changes, verify-before-done

Attachments that cannot become XSS.

### git-events
**scope:** `src/team/git-events.ts`, `src/team/gh.ts`, `test/team-git-events.test.ts`
**expects:** git.pushed only when reflog says update by push (fetch never triggers, invariant 14); unknown remote flagged; gh PR state polling deduped by (project, pr, state, headSha); squash/rebase merges detected; review approval bound to sha and marked stale on new head; merge via gh pr merge --match-head-commit only through the capability
**principles:** all git through src/util/exec.ts; no TTY prompts
**skills:** traceable-changes, verify-before-done

Push, PR and merge awareness.

## Phase 4 — Delivery to people

### skill-offers
**scope:** `src/team/skill-offers.ts`, `src/skills/install.ts`, `test/team-skill-offers.test.ts`
**expects:** per spec C Revision 2: Lead/Custodian-signed offers at deps, blob bundles, Markdown-only content rules including rejected frontmatter (allowed-tools, hooks, model) and dynamic-context, skillId regex and symlink checks, accept via capability, Designer co-sign, install into worktree with .git/info/exclude
**principles:** nothing installs before explicit accept
**skills:** traceable-changes, verify-before-done

Hand skills to teammates safely.

### notifications
**scope:** `electron/notify.ts`, `electron/notify-team.ts`, `test/notify*.test.ts`
**expects:** planner per spec B §6 with templates only; OS notification only on member's most-recently-active device; catch-up digest; focused-window suppression; dedupe 5 s; click deep-links via validated hash routes
**principles:** peer labels escaped and length-capped
**skills:** traceable-changes, verify-before-done

Desktop notifications for team events.

### team-ui-live @antigravity
**after:** team-api, mcp-team-tools
**scope:** `web/src/features/team/**`, `web/src/lib/teamApi.ts`
**expects:** Team workspace wired to real endpoints with demo fallback preserved; confirmAndSign calls window.desktop; loading/empty/error states verified against a live 2-daemon setup
**principles:** demo mode keeps working
**skills:** ui-ux-pro-max, verify-before-done

Connect the Team workspace to the real daemon.

## Phase 5 — Durability and release

### checkpoints
**scope:** `src/team/checkpoint.ts`, `test/team-checkpoint.test.ts`
**expects:** signed checkpoints, body pruning older than 90 days with headers kept, git file-list TTL, blob GC, bootstrap from checkpoint plus tail with verified stateHash
**skills:** traceable-changes, verify-before-done

Keep storage bounded.

### mac-release
**scope:** `config/electron-builder.cjs`, `build/entitlements.mac.plist`, `scripts/notarize.mjs`
**expects:** signed and notarized dmg (arm64, x64) when an Apple Developer ID is configured; NSLocalNetworkUsageDescription and NSBonjourServices set; no multicast entitlement; unsigned local builds still work
**principles:** no secrets committed; signing identity from environment
**skills:** traceable-changes

Ship the desktop app.
