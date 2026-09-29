# Spec A: Team hub core

- **Status:** draft for review
- **Date:** 2026-09-29
- **Parent:** [team v2 overview](2026-09-29-team-v2-overview-design.md)
- **Builds on:** `src/members.ts`, `src/access.ts`, `src/host-link.ts`, `src/federation.ts`, `src/pipeline-claims.ts`, `src/events.ts`, `src/workspace.ts`

> **Revision 2 (2026-09-29):** the topology changed to peer coordinators. See
> [Team Sync system design](../../system-design/team-sync/README.md).
>
> **Still valid:** §3.1 (self-signed certificate, `x509.ts`), the pinning rule in §3.3
> (`ca:[cert]`, never `rejectUnauthorized:false`), the §4 pairing UX (QR or code, 120 s,
> fingerprint words, owner Allow), the §6.1 and §6.4 task fields and brief, §8 per-member
> repo sets, and §10 discovery.
>
> **Revision 3 (Team Sync v2):**
> - The §4 pairing proof is replaced by a **SAS over both public keys**:
>   `H(custodianPub‖newDevicePub‖offerId‖nonceA‖nonceB)`, shown as 6 words on both
>   screens. All 6 must be compared.
> - The typed code is now **≥10 characters** (Crockford base32, 50+ bits).
> - A second redeem attempt burns the offer.
> - Admission is a Custodian-signed `device.admit`. Keys live in the Keychain, held by
>   Electron main (Team Sync §4.1, §12.2).
>
> **Superseded:**
> - §3.2–3.3 hub listener → mutual TLS peer sync. The HTTP API goes back to
>   loopback-only.
> - The end of §4 pairing (device token) → a `device.admit` event with the device's
>   public key.
> - §5 bearer device tokens → Ed25519 device keys, owner devices and `owner.grant`.
> - §6.2 hub endpoints → signed events (`task.assign`, `task.transition`) folded locally.
> - §6.5 offline queue → not needed, because every device has its own replica.
> - §7 durable hub log → per-device feeds.
> - §9 path redaction → mostly moot, since no remote HTTP callers remain. Keep the rule
>   for anything written into events.

## 1. Goal

Turn today's hub-and-spoke team mode into something a team can safely run on office
Wi-Fi:

- encrypted and pinned transport
- pairing in under a minute
- tasks assigned to a **person**
- member progress that flows back to the hub
- an event history that survives restarts

## 2. What stays

- `decideAccess` stays as the single authorization boundary: loopback is free, and remote
  callers need a token plus no terminals and no host paths.
- Token hashing stays: SHA-256 at rest, compared with `timingSafeEqual`.
- The presence and claim store and the overlap computation stay (`federation.ts`).
- Hub claim arbitration stays (`/api/pipeline/claim`).
- The workspace manifest and `baton join` stay.
- The Host allowlist and the Origin gate on mutating requests stay.
- No new runtime dependencies: `node:https`, `node:crypto`, `node:dgram` and
  `node:tls` only.

## 3. Transport: TLS with pinning (A1)

### 3.1 Certificate

- On the first `baton serve --team`, the hub creates an Ed25519 key pair and a
  **self-signed X.509 certificate** valid for 10 years.
- Node has no API to create certificates, so we add `src/util/x509.ts`: a minimal DER
  builder of about 150 lines. It covers the subject CN `baton-hub-<id>`, a SAN list of the
  LAN IPs plus the hostname, validity, and signing with `crypto.sign`. It is pure and gets
  unit tests: the output is parsed back with `new crypto.X509Certificate` and verified.
- Storage: `~/.baton/team/hub-key.pem` (mode 0600) and `hub-cert.pem`.
- `fingerprint = sha256(DER)` in hex. Humans see it as 6 words from a fixed 2048-word list
  (the "fingerprint words").
- Rotation: `baton team rotate-cert` makes a new certificate, after which every member
  must re-pair. This is deliberately rare.

### 3.2 Listener

- `baton serve --team` binds `https://0.0.0.0:<port>`. The default port is 7443, with 7077
  kept for loopback HTTP.
- The loopback HTTP listener stays on `127.0.0.1` for the local dashboard, Electron and
  MCP. The team listener is a **second server** that shares the same request handler.
  `decideAccess` sees `local=false` for every connection on it, including ones from
  127.0.0.1, so the team port never grants loopback trust.
- The daemon refuses `--team` when there are no members yet and pairing is closed (same
  rule as today's `--host`, server.ts:3649).

### 3.3 Who connects to the hub

**Only the member's daemon talks to the hub.** The member's browser or Electron UI talks
to its own local daemon over loopback, and that daemon proxies team calls. This removes
the "browser warns about a self-signed cert" problem and keeps the pinning logic in one
place:

- `src/team/hub-client.ts` wraps `https.request` with **`rejectUnauthorized: true`** and
  `ca: [pinnedCertPem]`, so the hub's self-signed cert is the only trust anchor. It also
  passes a `checkServerIdentity` that ignores the hostname (LAN IPs change with DHCP) and
  compares `sha256(peerCert.raw)` with the pinned fingerprint, failing closed on a
  mismatch.
- **Never use `rejectUnauthorized:false` on a normal connection.** Node calls
  `checkServerIdentity` only after chain verification has passed. With a self-signed cert
  and `rejectUnauthorized:false`, verification fails, the pin check is **skipped
  silently**, and the connection goes ahead unpinned.
- The **one** exception is the first contact during pairing (§4). It opens a raw
  `tls.connect({rejectUnauthorized:false})` only to read `getPeerCertificate().raw`. It
  computes the fingerprint and compares it with the QR's `fp`, or shows the words on the
  typed path. It sends **no secret or token** on that socket and closes it before any
  pinned request.
- Test: a hub presenting a different self-signed cert must fail in `hub-client` with
  `FINGERPRINT_MISMATCH`. The test has to fail if someone switches to
  `rejectUnauthorized:false`.
- `isValidHostUrl` (`host-link.ts:53`) refuses `http:` for any hub that isn't loopback.

## 4. Pairing (A2)

### 4.1 Flow

```
Admin (hub UI)                          Member (their Baton UI)
─────────────                           ───────────────────────
[Add teammate] name="Priya", projects=[web]
  → POST /api/team/pairing  (loopback, owner)
  ← offer {id, secret(128-bit), expiresAt=+120s}
  shows QR  +  "192.168.1.20:7443 · code K7Q-4M2"      scan QR  | type host+code
                                                        member daemon: TLS connect,
                                                        read cert, fp = sha256(raw)
                                                        POST /api/team/pair/redeem
                                                          {offerId, proof, device}
  hub verifies proof, marks offer "pending-confirm"
  admin sees: "Priya's MacBook-Air wants to join
               words: amber-river-otter-lamp-fig-noble  [Allow] [Deny]"
                                                        member sees the same 6 words
  [Allow] → device token minted, returned once          stores {url, fp, token} in
                                                        ~/.baton/team/hosts.json (0600)
```

### 4.2 Details

- **QR payload:** `baton://pair?v=1&h=<ip:port>&fp=<hex>&o=<offerId>&s=<secret-b64url>`.
  The QR carries the full fingerprint, so a man-in-the-middle during pairing fails the pin
  check.
- **Typed fallback:** a 6-character code taken from the secret (Crockford base32) plus
  host:port. The fingerprint isn't typed, so the member first trusts the certificate on
  first use, and **both screens show the 6 fingerprint words**. The admin's Allow click is
  the check. The typed path's UI requires "words match" to be confirmed on both sides.
- **proof** = `HMAC-SHA256(secret, fp ‖ offerId ‖ deviceName)`. It proves the redeemer
  knows the secret and is talking to the pinned certificate.
- **Offers:**
  - single use and 120 s TTL
  - at most 3 open at once
  - redeem is rate-limited to 10 per minute per source IP and 5 attempts per offer, after
    which the offer is burned
- **Deny, or no answer within 120 s:** the offer is burned and the member sees "Request
  declined".
- **Events:** `member.pair.requested`, `member.pair.approved` and `member.pair.denied` on
  the hub bus. The UI shows them (spec D).
- **Manual token paste** (today's flow) stays for CLI and headless use as
  `baton host set <url> --fp <hex> --token <t>`, but the UI no longer offers it.

## 5. Identity: members, devices, tokens (A3)

### 5.1 Data model

```ts
// src/members.ts — extended, still .baton/members.json
interface Member {
  id: string;             // unchanged
  name: string;
  role: 'owner' | 'member';
  projects: string[] | '*';   // NEW: workspace project ids this person works on
  devices: Device[];          // NEW: replaces the single tokenHash
  createdAt: string;
  revokedAt?: string;
}
interface Device {
  id: string;             // dev_<8hex>
  label: string;          // "Priya's MacBook-Air"
  tokenHash: string;      // sha256(token)
  fingerprintWords?: string; // what was shown at pairing, for audit
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
```

### 5.2 Rules

- **Migration:** the member's existing `tokenHash` becomes `devices[0]` with the label
  "legacy". `projects` defaults to `'*'`.
- **Idle expiry:** a device unused for 14 days (configurable with `team.deviceIdleDays`)
  stops validating. The member re-pairs, and the hub records the reason
  `idle-expired`.
- **Revocation:** revoking a device or member publishes `member.revoked`. The hub closes
  that device's open SSE streams immediately, since the stream registry tracks the device
  id.
- **Owner:** `requiresOwner` also requires `local`. An owner token used remotely gets a
  403 with "owner actions are only available on the hub machine".
- **Roster** (`GET /api/team/members`): device list, `lastUsedAt`, online state from
  presence, and projects. Tokens and hashes are never included.

## 6. Assigning work to a person (A4)

### 6.1 Task fields

`PipelineTask` gets two new fields, and the meaning of the existing `assignee` doesn't
change:

```ts
member?: string | null;   // NEW — member id; null/undefined = open pool
brief?: TaskBrief | null; // NEW — see 6.3
// existing: assignee?: string | null  — still an AGENT id (dispatch.ts:136, lifecycle.ts:86)
```

| member | assignee | Meaning |
|---|---|---|
| — | — | Open pool: any member, any agent |
| priya | — | Priya, with whatever agent she chooses |
| priya | antigravity | Priya, using Antigravity |
| — | codex | Any member, but it must be Codex (today's behaviour) |

### 6.2 Endpoints

All live on the hub. Members reach them through their own daemon's proxy
(`/api/team/*` → hub).

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/team/tasks/:id/assign` `{member, assignee?, brief?}` | owner (local) | Assign or reassign a task, which publishes `task.assigned` |
| `GET /api/team/tasks?member=me` | member | The member's queue plus the open pool, filtered to the member's `projects` |
| `POST /api/team/tasks/:id/take` | member | Wraps today's claim; checks `member` and `projects` |
| `POST /api/team/tasks/:id/transition` `{to, note?}` | assigned member | `to` is one of active, paused, blocked, review, done. The hub validates the transition against the lifecycle table and publishes it. **The hub is the only writer.** |

### 6.3 MCP changes

These are thin; the logic lives on the hub.

- `my_tasks`: when a host link exists, it calls `GET /api/team/tasks?member=me` and merges
  the result with local rows, labelling each with its source. It no longer reads local
  rows only (the STATUS.md gap).
- `take_task`, `report_progress`, `report_blocked` and `complete_task` forward to
  `/transition` when the task came from the hub.

### 6.4 Task brief

```ts
interface TaskBrief {
  goal: string;              // ≤ 600 chars
  inScope: string[];         // repo-relative paths/globs the member may change
  outOfScope?: string[];     // e.g. ["server/**", "prisma/**"]
  acceptance: string[];      // checks a non-coder can run ("open /admin, table shows 10 rows")
  references?: string[];     // repo-relative files, screenshots stored under baton/briefs/
  skills?: string[];         // skill ids the agent should use (offered via spec C)
}
```

- The brief is served to the agent as structured fields inside the untrusted envelope. It
  is data, not instructions to obey.
- The rendered brief is capped at 1,500 tokens. `orient` includes the member's active
  brief.
- `outOfScope` feeds the claim system. If a member edits an out-of-scope file, the member
  gets a warning signal and the admin gets `claim.conflict`.

### 6.5 Hub unreachable

- `take` and `transition` return `{reachable:false}` instead of throwing.
- The MCP tool answers: "Hub offline. Continue locally? Your progress will sync when the
  hub is back." If the human agrees, the local row is marked `unsynced:true`.
- On reconnect the member daemon replays queued transitions in order. The hub accepts a
  transition or rejects it; if a task was reassigned in the meantime, the hub wins and the
  member gets `task.sync.conflict`.

## 7. Durable event log (A4)

- Today's ring buffer (`events.ts`, `RING_SIZE=200`, in-memory `nextId`) stays for the
  local dashboard.
- **Team-scope events** are also appended to `~/.baton/team/<hubId>/events.jsonl` as
  `{seq, epoch, ts, event}`. Team scope means `member.*`, `claim.*`, `task.*`, `git.*`
  (spec B), `review.*` (spec B), `skill.offer.*` (spec C) and `team.changed`.
- `epoch` is a random id created with the log. `seq` is persisted, so it never resets.
- Rotation: at 20 MB or 30 days, keep the last 5,000 events. The first line of a new file
  is `{snapshot:true, ...}`.
- The SSE `id:` is `<epoch>.<seq>`. On reconnect:
  - With the same epoch, the hub replays everything after `seq`. If that point was rotated
    away, it sends `resync` with a snapshot.
  - With a different epoch, the hub sends `resync`, and the client refetches `/api/team/state`.
- Members keep a local copy of the stream (the last 1,000 events), so their UI works
  offline.

## 8. Per-member repo sets (A4)

- `Member.projects` limits task visibility, claims and git notifications (spec B) for that
  member.
- `baton join` clones only the projects the joining member has.
- Fix the assumption stated in the `teams.ts` header: "every member has a full clone of
  every repo".
- Assigning a task in a project the member doesn't have warns the admin and offers
  "add project to Priya".

## 9. Redacting paths for remote callers

- A response-shaping pass runs only for `local=false`:
  - Absolute paths such as `worktreePath` (server.ts:2571) and repo roots are rewritten to
    `<project>/<relative>`.
  - Home directories are removed.
- Tests: a snapshot test over every `GET` route used by `/api/team/*` must contain no `/`
  at the start of a path value.

## 10. LAN discovery (A5, phase 5)

- A `node:dgram` beacon sends every 5 s to broadcast `255.255.255.255:47077` and to
  multicast `239.255.70.77:47077`. It runs only while `--team` is on.
- The payload is ≤ 256 bytes of JSON: `{v:1, hub:"<name>", port, fp8:"<first 8 hex of fp>"}`.
- The member UI lists discovered hubs as hints. Selecting one still requires a QR code or
  a code (§4), so the beacon never grants trust.
- Parsing is bounded: payloads over 512 bytes are dropped, and at most 20 hubs are kept.
- **macOS:** electron-builder `mac.extendInfo` must include `NSLocalNetworkUsageDescription`
  and `NSBonjourServices: ["_baton._tcp"]`. Without them LAN traffic is silently denied.
  Do **not** request the multicast entitlement.
- **Fallback when discovery fails** (client isolation or blocked multicast): manual
  host:port. The UI explains: "Your network may block device discovery. Ask the admin for
  the address."

## 11. Tests

- **x509:** the builder's output round-trips through `crypto.X509Certificate`, has the
  expected SAN, and verifies with the key.
- **Pinning:** a hub with a different certificate is rejected, and the error names the
  fingerprint mismatch.
- **Pairing:**
  - an expired offer fails
  - replaying a used offer fails
  - a wrong proof fails
  - the 6th attempt burns the offer
  - Deny burns the offer
  - rate limits apply
- **Devices:**
  - the idle-expiry boundary
  - revoking a device closes its SSE stream within 1 s
  - an owner token used remotely gets a 403
- **Tasks:**
  - the assign, take and transition matrix
  - a non-assigned member's transition gets a 403
  - an out-of-projects task is hidden
  - offline, the queue replays; after reassignment the member gets a conflict
- **Event log:**
  - replay after a restart works
  - after rotation the member gets `resync`
  - an epoch change triggers `resync`
- **Redaction:** the route snapshot test.
- **Beacon:** an oversized payload is dropped, and a beacon never auto-pairs.
- **Demo fixtures:** every new UI state has fixtures (spec D).

## 12. Migration and compatibility

- The existing `baton serve --host 0.0.0.0` (plain HTTP) keeps working behind a warning
  banner for one release, then requires `--insecure-lan`.
- Existing members migrate to devices automatically (§5). Their hubs must re-pair once to
  pin the certificate. Until they do, the UI shows "Re-pair to enable encryption".
