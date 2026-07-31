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
import type { MemberRow, MemberClaim, ClaimOverlap, Team, TeamState, Reachability } from "../types";

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
