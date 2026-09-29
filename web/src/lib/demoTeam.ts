// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   Demo fixtures for the Team screen.

   Demo mode is the showcase and must keep working, so the fixture
   deliberately exercises every state the real screen can hit:
   an owner and two members, one of them offline, one revoked, a
   same-branch conflict, a cross-branch overlap (information, NOT a
   warning), a stale claim old enough for the clear-claim control to
   make sense, and a member carrying a warning the owner already sent.

   Times are relative to load so "held 3m" reads correctly whenever
   the demo is opened.
   ============================================================ */
import type {
  MemberRow, MemberClaim, ClaimOverlap, Team, TeamState, Reachability,
  TeamWorkspace, TeamPerson, TeamProject, TeamTask, InboxItem, AgentBrief, TeamAttachment,
} from "../types";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

/** Held long enough to look abandoned — the clear-claim control's reason to exist. */
export const DEMO_STALE_CLAIM_MIN = 47;

const claim = (
  memberId: string, memberName: string, relPath: string,
  opts: { branch?: string | null; agent?: string | null; projectId?: string | null; heldMin?: number } = {},
): MemberClaim => {
  const held = (opts.heldMin ?? 4) * MIN;
  return {
    projectId: opts.projectId ?? null,
    relPath,
    memberId,
    memberName,
    agent: opts.agent ?? "claude",
    branch: opts.branch ?? "main",
    openedAt: ago(held),
    // Refreshed recently even when opened long ago: the member is alive, the
    // claim is simply old. A claim whose holder went away disappears on TTL.
    refreshedAt: ago(20_000),
  };
};

export const DEMO_MEMBERS: MemberRow[] = [
  {
    id: "priya", name: "Priya Sharma", role: "owner", registered: true, team: "platform",
    createdAt: ago(38 * 24 * 60 * MIN),
    online: true, device: "mac-mini", sessions: 2,
    since: ago(3 * 60 * MIN), lastSeen: ago(12_000), claims: 3, warnings: [],
  },
  {
    id: "sam", name: "Sam Okafor", role: "member", registered: true, team: "platform",
    createdAt: ago(11 * 24 * 60 * MIN),
    online: true, device: "sam-laptop", sessions: 1,
    since: ago(52 * MIN), lastSeen: ago(9_000), claims: 2,
    warnings: [{
      id: "w1",
      message: "src/server.ts is mid-refactor on my side — please take the API tests instead.",
      from: "Priya Sharma",
      at: ago(6 * MIN),
    }],
  },
  {
    id: "jules", name: "Jules Vidal", role: "member", registered: true, team: "product",
    createdAt: ago(4 * 24 * 60 * MIN),
    // Offline: last seen well past the 90 s presence TTL. Their claims are
    // gone with them — presence is a view, not a record.
    online: false, device: null, sessions: 0,
    since: null, lastSeen: ago(2 * 24 * 60 * MIN), claims: 0, warnings: [],
  },
  {
    // No team, deliberately: the roster must render a "No team" group as well
    // as the named ones, or the grouping looks like it loses people.
    id: "ex-contractor", name: "Dana Roth", role: "member", registered: true, team: null,
    createdAt: ago(60 * 24 * 60 * MIN), revokedAt: ago(9 * 24 * 60 * MIN),
    online: false, device: null, sessions: 0,
    since: null, lastSeen: null, claims: 0, warnings: [],
  },
];

export const DEMO_CLAIMS: MemberClaim[] = [
  claim("priya", "Priya Sharma", "src/server.ts", { heldMin: 22 }),
  claim("priya", "Priya Sharma", "src/access.ts", { heldMin: 8 }),
  // Same file as Priya, same branch → a real conflict.
  claim("sam", "Sam Okafor", "src/server.ts", { heldMin: 5, agent: "cursor" }),
  // Same file, DIFFERENT branches → information, not a conflict. Held long
  // enough that the clear-claim control has a reason to exist.
  claim("sam", "Sam Okafor", "web/src/App.tsx", { heldMin: DEMO_STALE_CLAIM_MIN, branch: "feat/team-ui", agent: "cursor" }),
  claim("priya", "Priya Sharma", "web/src/App.tsx", { heldMin: 3, branch: "main" }),
];

export const DEMO_OVERLAPS: ClaimOverlap[] = [
  {
    projectId: null, relPath: "src/server.ts", sameBranch: true,
    holders: [
      { memberId: "priya", memberName: "Priya Sharma", agent: "claude", branch: "main", since: ago(22 * MIN) },
      { memberId: "sam", memberName: "Sam Okafor", agent: "cursor", branch: "main", since: ago(5 * MIN) },
    ],
  },
  {
    projectId: null, relPath: "web/src/App.tsx", sameBranch: false,
    holders: [
      { memberId: "sam", memberName: "Sam Okafor", agent: "cursor", branch: "feat/team-ui", since: ago(DEMO_STALE_CLAIM_MIN * MIN) },
      { memberId: "priya", memberName: "Priya Sharma", agent: "claude", branch: "main", since: ago(3 * MIN) },
    ],
  },
];

/*
 * Two teams and no project scope.
 *
 * The demo hub is a single repo, so every claim carries `projectId: null` and a
 * scope could not filter anything. Shipping a fixture whose "Scope: api, web"
 * badge visibly changed nothing would teach the showcase's own users the wrong
 * thing about what a scope does — so the fixture shows the grouping, which is
 * the feature, and leaves the scope unset, which is the truth.
 */
export const DEMO_TEAMS: Team[] = [
  { id: "platform", name: "Platform", projects: [], createdAt: ago(38 * 24 * 60 * MIN) },
  { id: "product", name: "Product", projects: [], createdAt: ago(12 * 24 * 60 * MIN) },
];

export const DEMO_TEAM: TeamState = {
  members: DEMO_MEMBERS,
  teams: DEMO_TEAMS,
  claims: DEMO_CLAIMS,
  overlaps: DEMO_OVERLAPS,
  ttlMs: 90_000,
  // The demo views as the owner — otherwise every control renders disabled and
  // the screen shows nothing of what it is for.
  viewer: { local: false, memberId: "priya", isOwner: true },
};

/** A hub nobody has joined yet — the empty state that points at the invite flow. */
export const DEMO_TEAM_SOLO: TeamState = {
  members: [], teams: [], claims: [], overlaps: [], ttlMs: 90_000,
  viewer: { local: true, memberId: null, isOwner: true },
};

/**
 * The Share panel, in the state that most needs showing: bound to the LAN and
 * working, but with neither tunnel tool installed — which is the common case and
 * the one where the panel has to be useful rather than just a pair of buttons.
 */
export const DEMO_REACHABILITY: Reachability = {
  bind: "0.0.0.0",
  loopbackOnly: false,
  port: 7077,
  allowedHosts: ["mac-mini.local"],
  urls: ["http://mac-mini.local:7077", "http://192.168.1.24:7077"],
  lanAddresses: ["192.168.1.24"],
  members: { active: 3, owners: 1 },
  blockers: [],
  notes: [],
  tools: [
    {
      id: "ssh", label: "SSH port-forward", needsBinary: false, installed: true,
      why: "Nothing to install, nothing exposed, no Baton credential needed — the SSH key is the auth. Best for your own devices, or anyone who already has shell access here.",
      steps: ["ssh -N -L 7077:localhost:7077 you@192.168.1.24"],
      then: "Then open http://localhost:7077 on the other machine — it reaches this daemon through the tunnel.",
    },
    {
      id: "tailscale", label: "Tailscale", needsBinary: true, installed: false,
      install: "https://tailscale.com/download",
      why: "A private network between your devices and your team. The daemon is reachable by its tailnet name and never touches the public internet.",
      steps: ["tailscale up", "baton serve --write --host 0.0.0.0 --allowed-host <your-tailnet-name>"],
      then: "Share the tailnet hostname with members. They need Tailscale on their machines too.",
    },
    {
      id: "cloudflared", label: "Cloudflare named tunnel", needsBinary: true, installed: false,
      install: "brew install cloudflared",
      why: "A stable public hostname for members outside your network. Use a NAMED tunnel with Cloudflare Access in front — never a quick tunnel, which publishes a random public URL with nothing guarding it.",
      steps: ["cloudflared tunnel login", "cloudflared tunnel create baton", "cloudflared tunnel route dns baton baton.<your-domain>", "cloudflared tunnel run --url http://localhost:7077 baton", "baton serve --write --allowed-host baton.<your-domain>"],
      then: "Put Cloudflare Access in front of the hostname, so a stolen member token is not the only thing between the internet and your knowledge base.",
    },
  ],
};

/* ============================================================
   Team workspace v2 fixtures (spec D Rev 3 item 13, Team Sync §1, §7).

   One team, six people, every role, and the four heterogeneous repo
   setups from Team Sync §1. The scenario is the admin-offline morning
   from the system design §8: Anika (custodian) went offline at 12:00,
   three members are online, and Arun, who joined late, received his
   task from Priya's Mac mini. It also carries: an unmatched repo, a
   root-commit match that needs confirming, a duplicate clone, a feature
   group spanning web and api, P0 / urgent / reminded tasks, a
   needs-owner conflict, a lost claim, a stale approval with a large
   deletion, an api project without server-side branch protection, and
   a designer who uses simple mode. Recovery mode is a toggle in the
   Team admin screen (demo only).

   Builders rather than constants: times are relative to load, and the
   demo store mutates its own copy.
   ============================================================ */

const HR = 60 * MIN;
const DAY = 24 * HR;

/** Today at hh:mm local, or yesterday when that is still in the future. */
function clock(h: number, m = 0): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() > Date.now()) d.setTime(d.getTime() - DAY);
  return d.toISOString();
}

export const DEMO_V2_VIEWER = "rakshan";

const PROJECTS: TeamProject[] = [
  { key: "prj_web", name: "web", remote: "github.com/acme/web", protectedBranches: ["main", "staging"], serverProtection: true },
  { key: "prj_api", name: "api", remote: "github.com/acme/api", protectedBranches: ["main", "staging"], serverProtection: false },
  { key: "prj_mobile", name: "mobile", remote: "github.com/acme/mobile", protectedBranches: ["main"], serverProtection: true },
  { key: "prj_admin", name: "admin", remote: "github.com/acme/admin", protectedBranches: ["main", "staging"], serverProtection: true },
  { key: "prj_infra", name: "infra", remote: "github.com/acme/infra", protectedBranches: ["main", "release/*"], serverProtection: true },
];

function people(): TeamPerson[] {
  return [
    {
      // Owner: one folder containing five repos (Team Sync §1, row 1).
      id: "rakshan", name: "Rakshan Shetty", jobRole: "All-rounder", avatarHue: 152, timezone: "Asia/Kolkata",
      custodian: true, roles: { "*": "lead" }, presence: "online",
      devices: [
        { id: "k3mfq7xa2bdl5n4c", label: "Rakshan's MacBook Pro", model: "MacBook Pro (M3)", online: true, thisDevice: true, fingerprintWords: "amber · harbor · lantern · quiet · meadow · falcon" },
        { id: "r7pz2cv4wq6hj3ta", label: "Studio Mac mini", model: "Mac mini (M4)", online: true, relay: true, fingerprintWords: "cedar · orbit · velvet · canyon · ripple · spruce" },
      ],
      root: { path: "~/code/acme", repos: [
        { path: "~/code/acme/web", projectKey: "prj_web", match: "remote" },
        { path: "~/code/acme/api", projectKey: "prj_api", match: "remote" },
        { path: "~/code/acme/mobile", projectKey: "prj_mobile", match: "remote" },
        { path: "~/code/acme/admin", projectKey: "prj_admin", match: "remote" },
        { path: "~/code/acme/infra", projectKey: "prj_infra", match: "remote" },
      ] },
    },
    {
      // Second custodian, lead on api. The "admin offline" of the scenario.
      id: "anika", name: "Anika Rao", jobRole: "Security admin", avatarHue: 280, timezone: "Asia/Kolkata",
      custodian: true, roles: { prj_api: "lead" }, presence: "offline", lastSeen: clock(12, 0),
      devices: [
        { id: "a2x9d4mf7kq3zp8w", label: "Anika's MacBook Air", model: "MacBook Air (M2)", online: false, lastSeen: clock(12, 0), fingerprintWords: "birch · signal · copper · willow · tundra · ember" },
      ],
      root: { path: "~/work/api", repos: [{ path: "~/work/api", projectKey: "prj_api", match: "remote" }] },
    },
    {
      // Web + backend: a folder with two repos, plus a stale second clone.
      id: "priya", name: "Priya Sharma", jobRole: "Web + backend", avatarHue: 20, timezone: "Asia/Kolkata",
      custodian: false, roles: { prj_web: "developer", prj_api: "developer", prj_admin: "developer" }, presence: "online",
      devices: [
        { id: "p5hq8m2zc6vd4xk7", label: "Priya's Mac mini", model: "Mac mini (M4)", online: true, fingerprintWords: "delta · pebble · saffron · glacier · noble · thistle" },
      ],
      root: { path: "~/dev/acme", repos: [
        { path: "~/dev/acme/web", projectKey: "prj_web", match: "remote" },
        { path: "~/dev/acme/api", projectKey: "prj_api", match: "remote" },
        { path: "~/dev/api-old", projectKey: "prj_api", match: "remote", duplicateOf: "~/dev/acme/api" },
      ] },
    },
    {
      // Backend: a single repo with no remote, matched by root commit, and
      // the late joiner whose task arrived through Priya's device.
      id: "arun", name: "Arun Kumar", jobRole: "Backend", avatarHue: 205, timezone: "Asia/Kolkata",
      custodian: false, roles: { prj_api: "developer", prj_admin: "developer" }, presence: "online", joinedLateAt: clock(10, 40),
      devices: [
        { id: "u4ne7bq2wm5xz9cs", label: "Arun's MacBook Air", model: "MacBook Air (M3)", online: true, fingerprintWords: "marble · coral · pilot · aspen · lyric · harvest" },
      ],
      root: { path: "~/src/api", repos: [{ path: "~/src/api", projectKey: "prj_api", match: "root-commit" }] },
    },
    {
      // UI designer (non-coder): simple mode by default, one unmatched repo.
      id: "meera", name: "Meera Iyer", jobRole: "UI/Design", avatarHue: 330, timezone: "Asia/Kolkata",
      custodian: false, roles: { prj_web: "designer" }, presence: "offline", lastSeen: new Date(Date.now() - 17 * HR).toISOString(),
      devices: [
        { id: "m8kd3vz6qp2hx5ra", label: "Meera's MacBook Air", model: "MacBook Air (M2)", online: false, lastSeen: new Date(Date.now() - 17 * HR).toISOString(), fingerprintWords: "poppy · summit · indigo · breeze · walnut · comet" },
      ],
      root: { path: "~/Designs", repos: [
        { path: "~/Designs/web", projectKey: "prj_web", match: "remote" },
        { path: "~/Designs/web-prototype", projectKey: null, match: "unmatched" },
      ] },
    },
    {
      id: "sam", name: "Sam Okafor", jobRole: "Product manager", avatarHue: 45, timezone: "Europe/London",
      custodian: false, roles: { "*": "viewer" }, presence: "offline", lastSeen: new Date(Date.now() - 2 * DAY).toISOString(),
      devices: [
        { id: "s6tw2kr9bn4mq7hd", label: "Sam's MacBook Pro", model: "MacBook Pro (M1)", online: false, lastSeen: new Date(Date.now() - 2 * DAY).toISOString(), fingerprintWords: "raven · tulip · mosaic · harbor · ginger · slate" },
      ],
      root: { path: "~/Projects", repos: [] },
    },
  ];
}

const brief = (goal: string, inScope: string[], acceptance: string[], extra: Partial<AgentBrief> = {}): AgentBrief => ({
  goal, inScope, outOfScope: [], acceptance, skills: [], ...extra,
});

const att = (id: string, name: string, kind: TeamAttachment["kind"], sizeBytes: number, more: Partial<TeamAttachment> = {}): TeamAttachment => ({
  id, name, kind, sizeBytes, ...more,
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function tasks(): TeamTask[] {
  return [
    {
      id: "T-0142", rev: 3, title: "Admin table: list and filter endpoint", project: "prj_api", group: "G-admin-table",
      state: "active", priority: 1, urgent: false, assignee: "arun",
      brief: brief("Serve paginated, filterable rows for the admin table.",
        ["GET /admin/users with cursor pagination", "Filters: role, status, created range"],
        ["Cursor pagination with a stable sort", "p95 under 120 ms on 50k rows", "Contract updated in openapi.yaml"],
        { outOfScope: ["Bulk actions", "CSV export"], skills: ["api-testing"] }),
      note: "Anika wants cursors, not offsets. Ping Priya once the contract is in so she can wire the table.", noteAuthor: "rakshan",
      attachments: [att("a1", "admin-filters.md", "markdown", 2_140, { previewText: "# Filters\n\n- role: owner | member\n- status: active | invited | suspended\n- created: from / to (ISO dates)" })],
      assignedAt: clock(9, 30), acknowledgedAt: clock(10, 42), reminders: [], lastSignalAt: iso(6 * MIN),
      events: [
        { at: clock(9, 30), kind: "assigned", actorId: "rakshan", targetId: "arun" },
        { at: clock(10, 40), kind: "delivered", targetId: "arun", viaDevice: "Priya's Mac mini" },
        { at: clock(10, 42), kind: "acknowledged", actorId: "arun" },
        { at: clock(10, 44), kind: "taken", actorId: "arun" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: true },
    },
    {
      id: "T-0143", rev: 4, title: "Admin table: table UI", project: "prj_web", group: "G-admin-table",
      state: "review", priority: 2, urgent: false, assignee: "priya",
      brief: brief("Build the admin users table on the new list endpoint.",
        ["Sortable columns, filters bar, empty and error states", "Replace LegacyTable"],
        ["Keyboard navigable rows", "Empty, loading and error states", "Unit tests for column formatters"],
        { outOfScope: ["Bulk actions"], skills: ["frontend-design", "verify-before-done"] }),
      note: "The mock is the source of truth for spacing. Keep the filters on one line at 1280.", noteAuthor: "rakshan",
      attachments: [
        att("a2", "admin-table-mock.png", "image", 412_000, { previewHue: 210 }),
        att("a3", "table-spec.pdf", "pdf", 188_000, { previewText: "Admin table spec · 3 pages" }),
      ],
      assignedAt: clock(9, 30), acknowledgedAt: clock(9, 34), reminders: [], lastSignalAt: iso(25 * MIN),
      review: {
        branch: "baton/priya/admin-table-ui-3f9a2c", sha: "9c1e4b7", intent: "ready",
        approvedSha: "5b20d11", commitsSinceApproval: 2,
        files: [
          { path: "src/admin/Table.tsx", added: 182, removed: 40 },
          { path: "src/admin/columns.ts", added: 12, removed: 88, removedPct: 64 },
          { path: "src/admin/LegacyTable.tsx", added: 0, removed: 311, deleted: true, removedPct: 100 },
          { path: "src/admin/Table.test.tsx", added: 96, removed: 0 },
        ],
        comments: [
          { id: "c1", authorId: "rakshan", text: "Looks good. Wire the empty state before merge.", at: iso(3 * HR), decision: "approved" },
          { id: "c2", authorId: "priya", text: "Added the empty state and a formatter test. <b>Not bold</b>, this is plain text.", at: iso(40 * MIN) },
        ],
      },
      events: [
        { at: clock(9, 30), kind: "assigned", actorId: "rakshan", targetId: "priya" },
        { at: clock(9, 34), kind: "acknowledged", actorId: "priya" },
        { at: iso(3.5 * HR), kind: "review.requested", actorId: "priya" },
        { at: iso(3 * HR), kind: "review.decided", actorId: "rakshan" },
        { at: iso(40 * MIN), kind: "pushed", actorId: "priya" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: true },
    },
    {
      id: "T-0150", rev: 2, title: "Checkout: coupon field loses focus", project: "prj_web",
      state: "assigned", priority: 2, urgent: false, assignee: "priya",
      brief: brief("Keep focus in the coupon field while the total recalculates.",
        ["CouponField re-render on price update"], ["Typing a coupon never loses focus", "Regression test"]),
      attachments: [], assignedAt: iso(3 * HR),
      reminders: [{ at: iso(55 * MIN), by: "rakshan" }, { at: iso(12 * MIN), by: "rakshan" }],
      events: [
        { at: iso(3 * HR), kind: "assigned", actorId: "rakshan", targetId: "priya" },
        { at: iso(55 * MIN), kind: "reminded", actorId: "rakshan" },
        { at: iso(12 * MIN), kind: "reminded", actorId: "rakshan" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: false },
    },
    {
      id: "T-0151", rev: 1, title: "Payments webhook returns 500", project: "prj_api",
      state: "acknowledged", priority: 0, urgent: true, assignee: "arun",
      brief: brief("Stop the Stripe webhook from failing on unknown event types.",
        ["Webhook handler", "Idempotency key storage"],
        ["Unknown events return 200 and are logged", "No duplicate charges on retry"], { skills: ["systematic-debugging"] }),
      note: "Customers are seeing double receipts. Drop the admin table work until this is out.", noteAuthor: "anika",
      // In a hurry, Arun opened the main checkout: the guardrails §1.4 banner case.
      onProtectedBranch: "main",
      attachments: [], assignedAt: clock(11, 20), acknowledgedAt: clock(11, 22), reminders: [],
      events: [
        { at: clock(11, 20), kind: "assigned", actorId: "anika", targetId: "arun" },
        { at: clock(11, 22), kind: "acknowledged", actorId: "arun" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: false },
    },
    {
      id: "T-0152", rev: 1, title: "Onboarding illustrations", project: "prj_web",
      state: "assigned", priority: 2, urgent: false, assignee: "meera",
      brief: brief("Replace the three onboarding placeholders with final illustrations.",
        ["public/onboarding/*.png", "Alt text for each image"], ["Images under 200 KB each", "Alt text describes the step"]),
      note: "Use the moodboard colours. Ask me before changing any copy.", noteAuthor: "rakshan",
      attachments: [
        att("a4", "moodboard.png", "image", 640_000, { previewHue: 330 }),
        att("a5", "onboarding-brief.pdf", "pdf", 96_000, { previewText: "Onboarding brief · 2 pages" }),
        att("a6", "copy.md", "markdown", 1_220, { previewText: "## Step 1\nConnect your repo.\n\n## Step 2\nInvite your team.\n\n<script>alert('never runs')</script>" }),
        att("a7", "logo.svg", "svg", 8_400),
        att("a8", "prototype-export.html", "html", 54_000),
      ],
      assignedAt: iso(20 * HR), reminders: [],
      events: [{ at: iso(20 * HR), kind: "assigned", actorId: "rakshan", targetId: "meera" }],
      prechecks: { repoLocated: true, gitAuth: false, branchPushed: false },
    },
    {
      id: "T-0155", rev: 5, title: "Audit log export", project: "prj_admin",
      state: "needs-owner", priority: 2, urgent: false, assignee: "priya",
      brief: brief("Export the audit log as CSV for a date range.", ["Export endpoint and button"], ["Streams, never buffers the whole log"]),
      attachments: [], assignedAt: iso(2 * DAY), acknowledgedAt: iso(2 * DAY), reminders: [],
      conflict: {
        a: { actorId: "rakshan", action: "reassign", targetId: "arun", at: clock(11, 50) },
        b: { actorId: "priya", action: "complete", at: clock(11, 52) },
      },
      events: [
        { at: iso(2 * DAY), kind: "assigned", actorId: "rakshan", targetId: "priya" },
        { at: clock(11, 50), kind: "reassigned", actorId: "rakshan", targetId: "arun" },
        { at: clock(11, 52), kind: "completed", actorId: "priya" },
        { at: clock(12, 5), kind: "conflict" },
      ],
    },
    {
      id: "T-0160", rev: 2, title: "Rate-limit login attempts", project: "prj_api",
      state: "active", priority: 1, urgent: false, assignee: "arun",
      brief: brief("Throttle failed logins per account and per IP.", ["Login handler", "Redis counters"], ["5 failures per 15 min per account", "Clear message, no user enumeration"]),
      attachments: [], assignedAt: iso(26 * HR), acknowledgedAt: iso(26 * HR), reminders: [], lastSignalAt: iso(5 * HR),
      lostClaim: { loserId: "priya", winnerId: "arun", worktree: "baton/priya/rate-limit-login-a1b2c3", at: iso(26 * HR) },
      events: [
        { at: iso(26 * HR), kind: "taken", actorId: "arun" },
        { at: iso(26 * HR), kind: "lost-claim", actorId: "priya", targetId: "arun" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: true },
    },
    {
      id: "T-0165", rev: 1, title: "Rotate staging TLS certificates", project: "prj_infra",
      state: "unassigned", priority: 3, urgent: false, assignee: null,
      brief: brief("Rotate the staging certificates before they expire.", ["infra/tls"], ["New certs deployed", "Old certs revoked"]),
      attachments: [], reminders: [], events: [{ at: iso(3 * DAY), kind: "created", actorId: "rakshan" }],
    },
    {
      id: "T-0171", rev: 3, title: "Order history endpoint", project: "prj_api",
      state: "changes", priority: 2, urgent: false, assignee: "arun",
      brief: brief("List a customer's orders, newest first.", ["GET /orders"], ["Cursor pagination", "Tests for empty history"]),
      attachments: [], assignedAt: iso(2 * DAY), acknowledgedAt: iso(2 * DAY), reminders: [],
      review: {
        branch: "baton/arun/order-history-77be01", sha: "e41a0c9", intent: "ready",
        files: [{ path: "src/orders/list.ts", added: 64, removed: 5 }, { path: "src/orders/list.test.ts", added: 30, removed: 0 }],
        comments: [{ id: "c3", authorId: "anika", text: "Paginate with cursors, not offsets. Same helper as the admin list.", at: clock(11, 40), decision: "changes" }],
      },
      events: [
        { at: iso(2 * DAY), kind: "assigned", actorId: "anika", targetId: "arun" },
        { at: clock(11, 10), kind: "review.requested", actorId: "arun" },
        { at: clock(11, 40), kind: "review.decided", actorId: "anika" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: true },
    },
    {
      id: "T-0132", rev: 2, title: "Settings: API keys page", project: "prj_web",
      state: "approved", priority: 2, urgent: false, assignee: "priya",
      brief: brief("Let owners create and revoke API keys.", ["Settings → API keys"], ["Key shown once", "Revoke asks for confirmation"]),
      attachments: [], assignedAt: iso(3 * DAY), acknowledgedAt: iso(3 * DAY), reminders: [],
      review: {
        branch: "baton/priya/api-keys-page-0d4f2e", sha: "71c0e2a", intent: "ready", approvedSha: "71c0e2a", commitsSinceApproval: 0,
        files: [{ path: "src/settings/ApiKeys.tsx", added: 140, removed: 0 }],
        comments: [{ id: "c4", authorId: "rakshan", text: "Approved. Push when ready.", at: iso(2 * HR), decision: "approved" }],
      },
      events: [
        { at: iso(3 * DAY), kind: "assigned", actorId: "rakshan", targetId: "priya" },
        { at: iso(2 * HR), kind: "review.decided", actorId: "rakshan" },
      ],
      prechecks: { repoLocated: true, gitAuth: true, branchPushed: false },
    },
    {
      id: "T-0130", rev: 3, title: "Settings: dark mode", project: "prj_web",
      state: "merged", priority: 2, urgent: false, assignee: "priya",
      brief: brief("Add a dark theme toggle to settings.", ["Theme tokens", "Settings toggle"], ["Follows system by default"]),
      attachments: [], assignedAt: iso(5 * DAY), acknowledgedAt: iso(5 * DAY), reminders: [],
      events: [{ at: iso(5 * DAY), kind: "assigned", actorId: "rakshan", targetId: "priya" }, { at: iso(16 * HR), kind: "merged", actorId: "rakshan" }],
    },
  ];
}

function inbox(): InboxItem[] {
  return [
    // Rakshan (owner, custodian)
    { id: "n-01", to: "rakshan", kind: "review.requested", at: iso(40 * MIN), read: false, taskId: "T-0143", actorId: "priya" },
    { id: "n-02", to: "rakshan", kind: "needs-owner", at: clock(12, 5), read: false, taskId: "T-0155" },
    { id: "n-03", to: "rakshan", kind: "pair.request", at: iso(8 * MIN), read: false, actorId: "sam", deviceLabel: "Sam's MacBook Air" },
    { id: "n-04", to: "rakshan", kind: "pr.merged", at: iso(16 * HR), read: true, taskId: "T-0130", actorId: "rakshan" },
    // Priya
    { id: "n-11", to: "priya", kind: "task.reminded", at: iso(12 * MIN), read: false, taskId: "T-0150", actorId: "rakshan", count: 2 },
    { id: "n-12", to: "priya", kind: "push.requested", at: iso(2 * HR), read: false, taskId: "T-0132", actorId: "rakshan" },
    { id: "n-13", to: "priya", kind: "lost-claim", at: iso(26 * HR), read: true, taskId: "T-0160", actorId: "arun" },
    // Arun (late joiner)
    { id: "n-21", to: "arun", kind: "task.assigned", at: clock(10, 40), read: true, taskId: "T-0142", actorId: "rakshan" },
    { id: "n-22", to: "arun", kind: "review.decided", at: clock(11, 40), read: false, taskId: "T-0171", actorId: "anika", decision: "changes" },
    { id: "n-23", to: "arun", kind: "skill.offer", at: iso(30 * MIN), read: false, actorId: "rakshan", skill: "api-testing" },
    { id: "n-24", to: "arun", kind: "task.assigned", at: clock(11, 20), read: true, taskId: "T-0151", actorId: "anika" },
    // Meera (designer)
    { id: "n-31", to: "meera", kind: "task.assigned", at: iso(20 * HR), read: false, taskId: "T-0152", actorId: "rakshan" },
    { id: "n-32", to: "meera", kind: "skill.offer", at: iso(19 * HR), read: false, actorId: "rakshan", skill: "design-taste" },
    // Sam (viewer)
    { id: "n-41", to: "sam", kind: "pr.merged", at: iso(16 * HR), read: false, taskId: "T-0130", actorId: "rakshan" },
  ];
}

export function buildDemoWorkspace(): TeamWorkspace {
  return {
    teamName: "Acme core",
    viewerId: DEMO_V2_VIEWER,
    people: people(),
    projects: PROJECTS.map((p) => ({ ...p, protectedBranches: [...p.protectedBranches] })),
    tasks: tasks(),
    groups: [{ id: "G-admin-table", title: "Admin table", taskIds: ["T-0142", "T-0143"] }],
    inbox: inbox(),
    digest: { since: iso(15 * HR), assigned: 3, reviews: 2, merged: 1, reminders: 2 },
    recovery: { mode: false, paperKey: true, paperKeyCreatedAt: iso(40 * DAY) },
  };
}
