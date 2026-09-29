// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Team Sync fold: a pure, deterministic function from a SET of signed event
 * lines to team state (docs/system-design/team-sync/README.md §5, §6, §7, §9).
 *
 * Determinism is by construction: input order is discarded, every event is
 * checked on its own merits (signature, derived lamport, deps), and effects are
 * applied in one total order — (lamport, device, seq, hash) — which extends
 * causal order because lamport is derived. Wall-clock `ts` never affects state.
 *
 * Pipeline:
 *  1. decode exact lines; drop other teams. The trust anchor is the genesis
 *     body whose hash IS the team id: it gives the first device key and the
 *     recovery key, whatever later happens to the genesis event.
 *  2. device keys: genesis, the custodians named in a recovery statement the
 *     recovery key signed, and — iteratively — the devices of EFFECTIVE
 *     `device.admit`s. A key nobody effectively admitted is never learned, so
 *     that device's events stay pending (`device:<id>`) and cost nothing.
 *  3. verify signatures; detect equivocation (two events at one (device, seq,
 *     fork), or a fork.proof) — the feed is void from that seq on. A higher
 *     `fork` counter at a held seq is a restored feed: it supersedes the lower
 *     branch from that seq instead of freezing the feed.
 *  4. causal check: prev/deps known and lamport = max(deps ∪ prev)+1, else
 *     pending (missing deps) or rejected; compute a vector clock per event.
 *  5. ORG CHAIN FIRST, authority judged against the org state of the author's
 *     causal past (§5.3), with strong removal (§5.4) — see `orgFixedPoint`.
 *  6. everything else (tasks, profiles, inventory), each checked against the
 *     org state at its own deps; tasks per §7 (LWW patches, lifecycle, claims,
 *     needs-owner on causally-unrelated conflicting moves).
 *
 * Zero dependencies. Nothing here touches the filesystem or the clock.
 */
import { canonicalize } from './canonical.js';
import {
  DEVICE_ID_RE,
  HASH_RE,
  MEMBER_ID_RE,
  PROJECT_KEY_RE,
  RECOVERY_DOMAIN,
  checkCausal,
  decodeEvent,
  deviceIdFromSpki,
  publicKeyFromSpki,
  sha256Hex,
  teamIdFromGenesis,
  verifyDetached,
  verifyEvent,
  verifyForkProof,
  type ForkProof,
  type TeamEvent,
} from './envelope.js';
import {
  canAdmit,
  canDefineProject,
  canLead,
  canWork,
  deviceRevokeVerdict,
  emptyOrg,
  grantVerdict,
  hasRole,
  inRecovery,
  isCustodian,
  isLiveDevice,
  liveCustodianDevices,
} from './rbac.js';
import {
  BRIEF_LIMITS,
  DEFAULT_PRIORITY_LEVEL,
  MAX_REMINDER_BOOST,
  ORG_TYPES,
  ROLES,
  TERMINAL_STATES,
  type ConflictSide,
  type EventNote,
  type MemberProfile,
  type OrgState,
  type PendingEvent,
  type PriorityLevel,
  type Role,
  type TaskLifecycle,
  type TeamBrief,
  type TeamState,
  type TeamTask,
  type TeamTaskState,
} from './types.js';

export interface FoldInput {
  /** The team id (sha256 of the canonical genesis body). */
  team: string;
  /** Exact signed lines, in any order, duplicates allowed. */
  lines: readonly string[];
  /** Fork proofs received out of band (e.g. from `Feed.ingest`). */
  forkProofs?: readonly ForkProof[];
}

interface Node {
  hash: string;
  ev: TeamEvent;
  /** device → highest (seq, hash) in this event's causal past (excluding itself). Set once causally valid. */
  vc: Map<string, { seq: number; hash: string }>;
  /** For devices with two events at one seq: exactly which of their events are in the causal past. */
  mseen?: Set<string>;
}

type Body = Record<string, unknown>;
type HB = (a: Node, b: Node) => boolean;

const TASK_TYPES = new Set([
  'member.profile',
  'device.inventory',
  'task.upsert',
  'task.assign',
  'task.ack',
  'task.remind',
  'task.take',
  'task.move-device',
  'task.transition',
  'review.decide',
  'push.request',
  'conflict.resolve',
]);

const STRUCTURAL = new Set([
  'task.assign',
  'task.take',
  'task.move-device',
  'task.transition',
  'review.decide',
  'conflict.resolve',
]);

const SHA_RE = /^[0-9a-f]{7,64}$/;
const TASK_ID_RE = /^[a-z2-7]{16}-[1-9][0-9]{0,15}$/;

// ── small validators ─────────────────────────────────────────────────────────

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isObj = (v: unknown): v is Body => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const strList = (v: unknown, maxLen: number, maxItem: number, re?: RegExp): v is string[] =>
  Array.isArray(v) && v.length <= maxLen && v.every((x) => str(x, maxItem) && (!re || re.test(x)));

function byOrder(a: Node, b: Node): number {
  return (
    a.ev.lamport - b.ev.lamport ||
    (a.ev.device < b.ev.device ? -1 : a.ev.device > b.ev.device ? 1 : 0) ||
    a.ev.seq - b.ev.seq ||
    (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  );
}

const byHashNote = (a: { hash: string }, b: { hash: string }) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

// ── project remotes (§4.3) ───────────────────────────────────────────────────
// A local, pure copy of `normalizeRemote` in projects.ts (which does git I/O and
// is not imported here): the fold must stay dependency-free and the two must
// agree, which test/team-security-fold.test.ts checks.

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
const NETWORK_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git']);
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/;

function normalizeRemoteUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s || s.length > 2048 || /[\s\p{Cc}]/u.test(s)) return null;
  let authority: string;
  let path: string;
  const m = URL_RE.exec(s);
  if (m) {
    if (!NETWORK_SCHEMES.has(m[1].toLowerCase())) return null;
    const rest = m[2];
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    const colon = s.indexOf(':');
    const slash = s.indexOf('/');
    if (colon <= 0 || (slash !== -1 && slash < colon)) return null;
    authority = s.slice(0, colon);
    path = s.slice(colon + 1);
    if (/^[A-Za-z]$/.test(authority)) return null;
  }
  // `evil.com#@github.com`: parsers disagree on where the host is. Never a project.
  if (/[#?\\%]/.test(authority)) return null;
  let host = authority.slice(authority.lastIndexOf('@') + 1);
  host = host.replace(/:\d*$/, '').toLowerCase();
  if (!HOST_RE.test(host)) return null;
  path = path.replace(/[?#].*$/, '');
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const segs = path.split('/');
  if (segs.length < 2 || segs.some((p) => !p || p === '.' || p === '..')) return null;
  return `${host}/${segs.join('/')}`;
}

/**
 * The canonical `host/owner/repo` a project definition stores for `r` — a clone
 * URL, or an already-canonical remote (so normalising is idempotent) — or null
 * when `r` doesn't identify a network repo.
 */
export function normalizeProjectRemote(r: unknown): string | null {
  const n = normalizeRemoteUrl(r);
  if (n !== null) return n;
  return typeof r === 'string' && normalizeRemoteUrl(`https://${r}`) === r ? r : null;
}

// ── org chain ────────────────────────────────────────────────────────────────

function ensureMember(S: OrgState, member: string) {
  return (S.members[member] ??= { roles: [], devices: [], profile: null });
}

function addDevice(S: OrgState, device: string, spki: string, member: string, label: string, model: string, by: string) {
  if (S.devices[device]) return;
  S.devices[device] = { member, spki, label, model, admittedBy: by, cutoffSeq: null, inventory: [] };
  const m = ensureMember(S, member);
  m.devices = [...m.devices, device].sort();
}

function setRole(S: OrgState, member: string, grant: string, on: boolean) {
  const m = ensureMember(S, member);
  const has = m.roles.includes(grant);
  if (on && !has) m.roles = [...m.roles, grant].sort();
  if (!on && has) m.roles = m.roles.filter((r) => r !== grant);
}

/** Hosts whose repo paths are case-insensitive: two projects may not claim `Acme/Api` and `acme/api` there. */
const CASELESS_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/** The key a remote is claimed under (stored remotes keep their case; see projects.ts). */
function claimKey(remote: string): string {
  return CASELESS_HOSTS.has(remote.slice(0, remote.indexOf('/'))) ? remote.toLowerCase() : remote;
}

const canonicalRemotes = (rs: readonly unknown[]): string[] =>
  [...new Set(rs.map(normalizeProjectRemote).filter((x): x is string => x !== null))].sort();

function applyOrg(S: OrgState, n: Node): void {
  const b = n.ev.body;
  switch (n.ev.type) {
    case 'team.genesis':
      S.genesis = n.hash;
      S.recoveryPub = b.recoveryPub as string;
      addDevice(S, n.ev.device, b.custodianPub as string, b.member as string, 'genesis', '', n.hash);
      setRole(S, b.member as string, '*:custodian', true);
      return;
    case 'device.admit':
      addDevice(S, b.device as string, b.spki as string, b.member as string, b.label as string, b.model as string, n.hash);
      return;
    case 'device.revoke': {
      // Liveness only; the fold's final view overwrites cutoffSeq with the clamped pin.
      const d = S.devices[b.device as string];
      const c = b.cutoffSeq as number;
      if (d) d.cutoffSeq = d.cutoffSeq === null ? c : Math.min(d.cutoffSeq, c);
      return;
    }
    case 'role.grant':
    case 'role.revoke':
      setRole(S, b.member as string, `${b.project}:${b.role}`, n.ev.type === 'role.grant');
      return;
    case 'role.proposal':
      S.proposals[n.hash] = {
        proposer: S.devices[n.ev.device].member,
        action: b.action as 'grant' | 'revoke',
        member: b.member as string,
        done: false,
      };
      return;
    case 'role.cosign': {
      const p = S.proposals[b.proposal as string];
      p.done = true;
      setRole(S, p.member, '*:custodian', p.action === 'grant');
      return;
    }
    case 'recovery.restore':
      // Epoch-once: in ANY state (every author's causal past and the final view),
      // a statement whose epoch is not above the last applied one is a no-op.
      // A replayed statement therefore can't re-grant what was changed since.
      if ((b.epoch as number) <= S.recoveryEpoch) return;
      {
        // The statement names THE custodians: everyone else loses the role, so a
        // restored team is not stuck behind a quorum of members with no live device.
        const listed = new Set((b.custodians as Body[]).map((c) => c.member as string));
        for (const m of Object.keys(S.members)) if (!listed.has(m)) setRole(S, m, '*:custodian', false);
      }
      for (const c of b.custodians as Body[]) {
        addDevice(S, c.device as string, c.spki as string, c.member as string, 'recovery', '', n.hash);
        setRole(S, c.member as string, '*:custodian', true);
      }
      S.recoveryEpoch = b.epoch as number;
      return;
    case 'project.define':
      S.projects[b.key as string] = {
        name: b.name as string,
        remotes: canonicalRemotes(b.remotes as string[]),
        rootCommits: [...new Set(b.rootCommits as string[])].sort(),
        subpath: (b.subpath as string | undefined) ?? null,
      };
      return;
    case 'project.alias': {
      const p = S.projects[b.key as string];
      p.remotes = canonicalRemotes([...p.remotes, b.remote as string]);
      return;
    }
    default:
      return; // device.revoke.amend (pinned), project.rekey (phase 2): no org-state effect
  }
}

/** The genesis body whose canonical hash is the team id: the team's trust anchor. */
interface Anchor {
  device: string;
  spki: string;
  recoveryPub: string;
}

function genesisAnchor(team: string, decoded: ReadonlyMap<string, TeamEvent>): Anchor | null {
  for (const ev of decoded.values()) {
    if (ev.type !== 'team.genesis' || teamIdFromGenesis(ev.body) !== team) continue;
    // Every genesis body with this hash is byte-identical, so the first one decides.
    const b = ev.body;
    if (!str(b.custodianDevice, 16) || !DEVICE_ID_RE.test(b.custodianDevice)) return null;
    if (!str(b.custodianPub, 200) || deviceIdFromSpki(b.custodianPub) !== b.custodianDevice || !publicKeyFromSpki(b.custodianPub)) return null;
    if (!str(b.recoveryPub, 200) || !publicKeyFromSpki(b.recoveryPub)) return null;
    return { device: b.custodianDevice, spki: b.custodianPub, recoveryPub: b.recoveryPub };
  }
  return null;
}

function validCustodianList(v: unknown): v is Body[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= 8 &&
    v.every(
      (c) =>
        isObj(c) &&
        str(c.device, 16) &&
        DEVICE_ID_RE.test(c.device) &&
        str(c.spki, 200) &&
        deviceIdFromSpki(c.spki) === c.device &&
        !!publicKeyFromSpki(c.spki) &&
        str(c.member, 64) &&
        MEMBER_ID_RE.test(c.member),
    )
  );
}

/**
 * The CONTENT hash of a recovery statement — sha256 of canonical
 * `{team, epoch, custodians}`, the signature excluded — when the recovery key
 * signed it, else null. Content, not signature or event bytes: those can be
 * re-spelled or re-wrapped by anyone, the content only by the key holder.
 */
function recoveryStatement(team: string, b: Body, recoveryPub: string): string | null {
  if (!Number.isSafeInteger(b.epoch) || (b.epoch as number) < 1) return null;
  if (!validCustodianList(b.custodians)) return null;
  const statement = { team, epoch: b.epoch, custodians: b.custodians };
  if (!verifyDetached(RECOVERY_DOMAIN, statement, b.recoverySig as string, recoveryPub)) return null;
  return sha256Hex(canonicalize(statement));
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * §5.4 tiebreak (security H4): the paper recovery key may act as the second
 * custodian vote on a removal, OUTSIDE recovery mode, so two custodians where
 * one key is stolen are not deadlocked. A `device.revoke` or custodian
 * `role.revoke` may carry `recovery: {nonce, sig}`, the key's signature over
 * `"baton/v1/recovery\0"` + canonical `{team, action, target, nonce}`
 * (target = the device, or the member). Returns the statement's content hash
 * (each statement takes effect at most once), or null when absent or invalid.
 */
function recoveryVote(team: string, ev: TeamEvent, recoveryPub: string | null): string | null {
  const b = ev.body;
  if (!recoveryPub || !isObj(b.recovery)) return null;
  let target: unknown;
  if (ev.type === 'device.revoke') target = b.device;
  else if (ev.type === 'role.revoke' && b.role === 'custodian' && b.project === '*') target = b.member;
  else return null;
  if (!str(target, 64)) return null;
  const { nonce, sig } = b.recovery;
  if (!str(nonce, 64) || !NONCE_RE.test(nonce)) return null;
  const statement = { team, action: ev.type, target, nonce };
  if (!verifyDetached(RECOVERY_DOMAIN, statement, sig as string, recoveryPub)) return null;
  return sha256Hex(canonicalize(statement));
}

/** §5.4 recovery mode as of S, counting a device with a proven fork as dead (it can never act again). */
function recoveryAt(S: OrgState, forked: ReadonlyMap<string, number>): boolean {
  return S.genesis !== null && liveCustodianDevices(S).every((d) => forked.has(d));
}

interface OrgCtx {
  team: string;
  verified: ReadonlyMap<string, Node>;
  hb: HB;
  recoveryPub: string | null;
  /** restore event hash → its recovery statement content hash (valid signature only). */
  statements: ReadonlyMap<string, string>;
  /** revoke event hash → its recovery-vote statement hash (valid signature only). */
  votes: ReadonlyMap<string, string>;
  /** device → seq of its proven fork. */
  forked: ReadonlyMap<string, number>;
  /** device.revoke hash → its structural mutual partners (§5.4). */
  partners: ReadonlyMap<string, readonly Node[]>;
}

interface AuthOut {
  mutualOnly: boolean;
  /** The recovery vote this event relies on for its quorum, if any. */
  vote: string | null;
}

/**
 * Reason the org event may not take effect in state S (its author's causal
 * past), or null. `out.mutualOnly` is set when the event is allowed ONLY as the
 * half of a concurrent mutual revoke (it would otherwise need a quorum).
 */
function authorizeOrg(S: OrgState, n: Node, ctx: OrgCtx, out: AuthOut): string | null {
  const { ev } = n;
  const b = ev.body;
  if (ev.type === 'team.genesis') {
    if (S.genesis !== null) return 'genesis-exists';
    if (ev.seq !== 1 || ev.deps.length || ev.fork !== 0) return 'genesis-not-root';
    if (teamIdFromGenesis(b) !== ctx.team) return 'genesis-team-mismatch';
    if (b.custodianDevice !== ev.device || !str(b.custodianPub, 200) || deviceIdFromSpki(b.custodianPub) !== ev.device || !publicKeyFromSpki(b.custodianPub)) {
      return 'genesis-device-mismatch';
    }
    if (!str(b.member, 64) || !MEMBER_ID_RE.test(b.member)) return 'invalid-body';
    if (!str(b.recoveryPub, 200) || !publicKeyFromSpki(b.recoveryPub)) return 'invalid-body';
    return null;
  }
  if (ev.type === 'recovery.restore') {
    if (!ctx.recoveryPub) return 'no-recovery-key';
    const stmt = ctx.statements.get(n.hash);
    if (!stmt) return validCustodianList(b.custodians) && Number.isSafeInteger(b.epoch) ? 'bad-recovery-signature' : 'invalid-body';
    if ((b.epoch as number) <= S.recoveryEpoch) return 'stale-epoch';
    // §5.4: only a team with no live custodian can be restored. (Competing statements
    // for one epoch are settled among the restores that pass this — orgFixedPoint.)
    if (!recoveryAt(S, ctx.forked)) return 'not-in-recovery';
    const listed = (b.custodians as Body[]).some((c) => c.device === ev.device);
    if (!listed && !isLiveDevice(S, ev.device)) return 'device-not-admitted';
    return null;
  }

  if (!isLiveDevice(S, ev.device)) return 'device-not-admitted';
  const member = S.devices[ev.device].member;

  switch (ev.type) {
    case 'device.admit': {
      if (!canAdmit(S, member)) return inRecovery(S) ? 'recovery-mode' : 'not-custodian';
      if (!str(b.device, 16) || !DEVICE_ID_RE.test(b.device)) return 'invalid-body';
      if (!str(b.spki, 200) || deviceIdFromSpki(b.spki) !== b.device || !publicKeyFromSpki(b.spki)) {
        return 'device-not-id-of-spki';
      }
      if (!str(b.member, 64) || !MEMBER_ID_RE.test(b.member)) return 'invalid-body';
      if (!str(b.label, 64) || !str(b.model, 64)) return 'invalid-body';
      if (S.devices[b.device]) return 'already-admitted';
      return null;
    }
    case 'device.revoke': {
      const target = b.device;
      if (!str(target, 16) || !S.devices[target]) return 'unknown-device';
      const verdict = deviceRevokeVerdict(S, ev.device, target);
      if (verdict === 'deny') return 'not-custodian';
      if (verdict === 'quorum') {
        // Another custodian's device: a custodian change. The recovery key may be the
        // second vote; otherwise only a concurrent mutual revoke skips the quorum, as
        // liveness removal (clamped). Key-backed revokes never pair (see runCore).
        const vote = ctx.votes.get(n.hash);
        if (vote) out.vote = vote;
        else if (ctx.partners.get(n.hash)?.length) out.mutualOnly = true;
        else return 'needs-quorum';
      }
      if (!nonNegInt(b.cutoffSeq)) return 'invalid-body';
      if (b.cutoffSeq === 0) return b.cutoffHash === null ? null : 'invalid-body';
      // The cutoff names a concrete event the revoker has seen, so it pins one history.
      const at = str(b.cutoffHash, 64) ? ctx.verified.get(b.cutoffHash) : undefined;
      if (!at || at.ev.device !== target || at.ev.seq !== b.cutoffSeq || !ctx.hb(at, n)) return 'cutoff-unseen';
      return null;
    }
    case 'device.revoke.amend': {
      if (!isCustodian(S, member)) return 'not-custodian';
      if (inRecovery(S)) return 'recovery-mode';
      if (!str(b.device, 16) || !S.devices[b.device]) return 'unknown-device';
      if (!strList(b.events, 256, 64, HASH_RE)) return 'invalid-body';
      for (const h of b.events) {
        const x = ctx.verified.get(h);
        if (!x || x.ev.device !== b.device || !ctx.hb(x, n)) return 'amend-unseen';
      }
      return null;
    }
    case 'role.grant':
    case 'role.revoke': {
      if (!str(b.member, 64) || !MEMBER_ID_RE.test(b.member)) return 'invalid-body';
      if (!(ROLES as readonly unknown[]).includes(b.role)) return 'invalid-body';
      if (b.project !== '*' && !(str(b.project, 40) && PROJECT_KEY_RE.test(b.project))) return 'invalid-body';
      const v = grantVerdict(S, member, ev.type === 'role.grant' ? 'grant' : 'revoke', b.member, b.project as string, b.role as Role);
      if (v === 'quorum') {
        const vote = ev.type === 'role.revoke' ? ctx.votes.get(n.hash) : undefined;
        if (!vote) return 'needs-quorum';
        out.vote = vote; // the recovery key is the second custodian vote
        return null;
      }
      return v === 'allow' ? null : inRecovery(S) ? 'recovery-mode' : 'not-authorised';
    }
    case 'role.proposal': {
      if (b.role !== 'custodian' || (b.action !== 'grant' && b.action !== 'revoke')) return 'invalid-body';
      if (!str(b.member, 64) || !S.members[b.member]) return 'unknown-member';
      return grantVerdict(S, member, b.action, b.member, '*', 'custodian') === 'deny' ? 'not-authorised' : null;
    }
    case 'role.cosign': {
      const p = str(b.proposal, 64) ? S.proposals[b.proposal] : undefined;
      if (!p) return 'unknown-proposal';
      if (p.done) return 'proposal-done';
      if (p.proposer === member) return 'same-member-cosign';
      if (!isCustodian(S, p.proposer)) return 'proposer-not-custodian';
      return grantVerdict(S, member, p.action, p.member, '*', 'custodian') === 'deny' ? 'not-authorised' : null;
    }
    case 'project.define': {
      if (!str(b.key, 40) || !PROJECT_KEY_RE.test(b.key)) return 'invalid-body';
      if (S.projects[b.key]) return 'project-exists';
      if (!canDefineProject(S, member, b.key)) return 'not-authorised';
      if (!str(b.name, 80) || !strList(b.remotes, 16, 200) || !strList(b.rootCommits, 16, 64, SHA_RE)) return 'invalid-body';
      if (b.remotes.some((r) => normalizeProjectRemote(r) === null)) return 'invalid-remote';
      if (b.subpath !== undefined && b.subpath !== null && !str(b.subpath, 200)) return 'invalid-body';
      return null;
    }
    case 'project.alias': {
      if (!str(b.key, 40) || !S.projects[b.key]) return 'unknown-project';
      if (!canDefineProject(S, member, b.key)) return 'not-authorised';
      if (!str(b.remote, 200)) return 'invalid-body';
      return normalizeProjectRemote(b.remote) === null ? 'invalid-remote' : null;
    }
    case 'project.rekey':
      return str(b.project, 40) && canDefineProject(S, member, b.project) ? null : 'not-authorised';
    default:
      return 'unknown-org-type';
  }
}

/**
 * Copy of an org state deep enough for `applyOrg`: it mutates device, member,
 * project and proposal records in place, and only ever replaces arrays.
 */
function cloneOrg(S: OrgState): OrgState {
  const copy = <T extends object>(r: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const k in r) out[k] = { ...r[k] };
    return out;
  };
  return {
    genesis: S.genesis,
    recoveryPub: S.recoveryPub,
    recoveryEpoch: S.recoveryEpoch,
    devices: copy(S.devices),
    members: copy(S.members),
    projects: copy(S.projects),
    proposals: copy(S.proposals),
  };
}

/**
 * Memoised org state of `n`'s causal past, restricted to the currently effective
 * org events. States are never mutated once cached; a miss whose past is a
 * cached past plus one event clones that state and applies the one event, so a
 * long admit chain costs O(n) per step instead of rebuilding from scratch.
 */
function stateAt(n: Node, eff: readonly Node[], cache: Map<string, OrgState>, hb: HB): OrgState {
  const idx: number[] = [];
  for (let i = 0; i < eff.length; i++) if (eff[i] !== n && hb(eff[i], n)) idx.push(i);
  const key = idx.join(',');
  let S = cache.get(key);
  if (!S) {
    const base = idx.length ? cache.get(idx.slice(0, -1).join(',')) : undefined;
    if (base) {
      S = cloneOrg(base);
      applyOrg(S, eff[idx[idx.length - 1]]);
    } else {
      S = emptyOrg();
      for (const i of idx) applyOrg(S, eff[i]);
    }
    cache.set(key, S);
  }
  return S;
}

interface OrgPass {
  eff: Node[];
  notes: EventNote[];
  voids: string[];
  /** Revokes that took effect only as a mutual half (they'd otherwise need a quorum). */
  mutualOnly: Set<string>;
}

/** One pass over the org chain in fold order, with a fixed voiding rule. */
function orgPass(orgCands: readonly Node[], isVoid: (n: Node) => boolean, banned: ReadonlyMap<string, string>, ctx: OrgCtx): OrgPass {
  const eff: Node[] = [];
  const notes: EventNote[] = [];
  const voids: string[] = [];
  const mutualOnly = new Set<string>();
  const cache = new Map<string, OrgState>();
  // Remote → project, over effective events in fold order: the first claim wins,
  // so two projects never both resolve to one repo (§4.3), even when concurrent.
  const claims = new Map<string, string>();
  const usedVotes = new Set<string>();
  for (const n of orgCands) {
    if (isVoid(n)) {
      voids.push(n.hash);
      continue;
    }
    const out: AuthOut = { mutualOnly: false, vote: null };
    const reason = authorizeOrg(stateAt(n, eff, cache, ctx.hb), n, ctx, out);
    if (reason) {
      notes.push({ hash: n.hash, reason });
      continue;
    }
    const ban = banned.get(n.hash);
    if (ban) {
      notes.push({ hash: n.hash, reason: ban });
      continue;
    }
    if (n.ev.type === 'project.define' || n.ev.type === 'project.alias') {
      const b = n.ev.body;
      const key = b.key as string;
      const rs = canonicalRemotes(n.ev.type === 'project.define' ? (b.remotes as string[]) : [b.remote]).map(claimKey);
      if (rs.some((r) => (claims.get(r) ?? key) !== key)) {
        notes.push({ hash: n.hash, reason: 'remote-claimed' });
        continue;
      }
      for (const r of rs) claims.set(r, key);
    }
    if (out.vote) {
      // Each recovery-key vote counts once, the first use in fold order.
      if (usedVotes.has(out.vote)) {
        notes.push({ hash: n.hash, reason: 'recovery-vote-used' });
        continue;
      }
      usedVotes.add(out.vote);
    }
    if (out.mutualOnly) mutualOnly.add(n.hash);
    eff.push(n);
  }
  return { eff, notes, voids, mutualOnly };
}

interface Voiding {
  isVoid: (n: Node) => boolean;
  /** The revokes whose pins void `n` (empty when it isn't void). */
  voiders: (n: Node) => Node[];
  /** device → effective cutoff (min over its pins). */
  cutoffs: Map<string, number>;
}

/**
 * The voiding rule implied by a set Σ of effective revokes and amends.
 *
 * A revoke's pin on its target is its `cutoffSeq`, clamped:
 *  - never below 1 for the genesis device, so the genesis event (and with it
 *    the team and its recovery key) is immune to revocation;
 *  - in a concurrent mutual pair, never below (seq of the opposing revoke − 1):
 *    a counter-revoke only removes liveness from that point on and can never
 *    void the other side's earlier history.
 * An event past a pin is void — except the revoke that made the pin (a device
 * revoking itself) and the partner half of a mutual pair, each exempt from that
 * one pin only — unless an effective amend names it.
 */
function voiding(sigma: ReadonlySet<string>, byHash: ReadonlyMap<string, Node>, partners: ReadonlyMap<string, readonly Node[]>, genesisDevice: string | null): Voiding {
  const pins = new Map<string, { cut: number; by: Node }[]>();
  const amended = new Set<string>();
  for (const h of sigma) {
    const r = byHash.get(h)!;
    const b = r.ev.body;
    if (r.ev.type === 'device.revoke.amend') {
      for (const x of b.events as string[]) amended.add(x);
      continue;
    }
    const target = b.device as string;
    let cut = b.cutoffSeq as number;
    if (target === genesisDevice) cut = Math.max(cut, 1);
    const ps = (partners.get(h) ?? []).filter((p) => sigma.has(p.hash));
    if (ps.length) cut = Math.max(cut, Math.min(...ps.map((p) => p.ev.seq)) - 1);
    const list = pins.get(target) ?? [];
    list.push({ cut, by: r });
    pins.set(target, list);
  }
  const cutoffs = new Map<string, number>();
  for (const [d, list] of pins) cutoffs.set(d, Math.min(...list.map((p) => p.cut)));
  const voiders = (n: Node): Node[] => {
    if (amended.has(n.hash)) return [];
    // A self-revoke is never voided by its own pin, nor a mutual half by its partner's.
    return (pins.get(n.ev.device) ?? [])
      .filter(({ cut, by }) => n.ev.seq > cut && by !== n && !partners.get(by.hash)?.includes(n))
      .map((p) => p.by);
  };
  return { isVoid: (n) => voiders(n).length > 0, voiders, cutoffs };
}

/**
 * Org chain with strong removal (§5.4), as a fixed point that always ends.
 *
 * Σ is the set of revokes and amends whose pins are in force. Each round runs
 * one pass with the voiding rule of Σ (pins recomputed from scratch — nothing is
 * sticky) and collects a DROP set:
 *  - members of Σ that are no longer effective (voided, or their authority went);
 *  - mutual-only revokes whose partner did not take effect;
 *  - effective restores that lose their epoch to a different statement (lowest
 *    content hash wins, among restores that are otherwise authorised).
 * Dropped events leave Σ. Each is BANNED (refused from then on) unless it was
 * voided only by pins of other dropped revokes — e.g. an honest revoke cut off
 * by a thief's revoke that is itself void: once the thief's pin goes, the honest
 * one takes effect again. If every dropped event is voided only from inside the
 * drop set (a cycle of revokes voiding each other), all are banned: none apply.
 * With no drops, new effective revokes/amends join Σ; with neither, Σ equals
 * the effective revokes/amends and we are done.
 *
 * Termination: every drop round bans at least one event, and a banned event is
 * refused by the pass so it never re-enters; so there are at most D = |revokes,
 * amends and restores| drop rounds. Between two drop rounds Σ only grows, so
 * there are at most |revokes and amends| + 1 add rounds. Bound: (D+1)·(R+1).
 * Every choice is a function of the event set and the fold order, so the result
 * is independent of delivery order.
 */
function orgFixedPoint(orgCands: readonly Node[], ctx: OrgCtx, genesisDevice: string | null) {
  const byHash = new Map(orgCands.map((n) => [n.hash, n]));
  const tracked = orgCands.filter((n) => n.ev.type === 'device.revoke' || n.ev.type === 'device.revoke.amend');
  const restores = orgCands.filter((n) => n.ev.type === 'recovery.restore');
  const sigma = new Set<string>();
  const banned = new Map<string, string>();
  const limit = (tracked.length + restores.length + 1) * (tracked.length + 1);
  for (let round = 0; ; round++) {
    const v = voiding(sigma, byHash, ctx.partners, genesisDevice);
    const pass = orgPass(orgCands, v.isVoid, banned, ctx);
    const effSet = new Set(pass.eff.map((n) => n.hash));
    const E = tracked.filter((n) => effSet.has(n.hash)).map((n) => n.hash);
    const drop: [string, string][] = [];
    for (const h of sigma) if (!effSet.has(h)) drop.push([h, 'revoke-superseded']);
    for (const h of pass.mutualOnly) {
      if (!(ctx.partners.get(h) ?? []).some((p) => effSet.has(p.hash))) drop.push([h, 'needs-quorum']);
    }
    const winner = new Map<number, string>();
    const live = restores.filter((r) => effSet.has(r.hash));
    for (const r of live) {
      const e = r.ev.body.epoch as number;
      const c = ctx.statements.get(r.hash)!;
      const cur = winner.get(e);
      if (cur === undefined || c < cur) winner.set(e, c);
    }
    for (const r of live) {
      if (ctx.statements.get(r.hash) !== winner.get(r.ev.body.epoch as number)) drop.push([r.hash, 'superseded-epoch']);
    }
    if (drop.length && round < limit) {
      const dropSet = new Set(drop.map(([h]) => h));
      let bannedAny = false;
      for (const [h, reason] of drop) {
        sigma.delete(h);
        const by = v.voiders(byHash.get(h)!);
        if (by.length && by.every((x) => dropSet.has(x.hash))) continue; // may come back once they go
        banned.set(h, reason);
        bannedAny = true;
      }
      if (!bannedAny) for (const [h, reason] of drop) banned.set(h, reason);
      continue;
    }
    const add = E.filter((h) => !sigma.has(h));
    if (!add.length || round >= limit) return { pass, voiding: v }; // round ≥ limit is unreachable (see above)
    for (const h of add) sigma.add(h);
  }
}

// ── key discovery ────────────────────────────────────────────────────────────

/**
 * Device keys, learned in ONE pass over the events in fold order, verifying
 * lazily: an event counts once its author's key is known, its signature holds
 * and its parents counted; an org event takes effect if authorised at its
 * causal past; an admit that takes effect teaches its device's key.
 *
 * "Admitted" means authorised when it was made. Later strong removal does not
 * un-learn a key: honest devices may already depend on that device's events,
 * and turning those into unverifiable deps would leave the honest events pending
 * forever. Strong removal voids the events instead (the main fold). A key that
 * no authorised admit vouches for — a self-admission, an admit by a
 * non-custodian — is never learned, so that device's events stay pending.
 *
 * An event authored before its key is known in fold order (it acted before its
 * own admission) is skipped; if a later admit teaches that key, the pass runs
 * again with the larger key set. Keys only grow, and a rerun happens only when a
 * skipped event's key became known, so this ends; a normal team needs one pass.
 */
function discoverKeys(
  team: string,
  decoded: ReadonlyMap<string, TeamEvent>,
  anchored: ReadonlyMap<string, string>,
  anchor: Anchor | null,
  statements: ReadonlyMap<string, string>,
): Map<string, string> {
  const keys = new Map(anchored);
  const order = [...decoded].map(([hash, ev]): Node => ({ hash, ev, vc: new Map() })).sort(byOrder);
  for (;;) {
    const ok = new Map<string, Node>();
    for (const n of order) n.vc = new Map();
    const hb: HB = (a, b) => a === b || (b.vc.get(a.ev.device)?.seq ?? 0) >= a.ev.seq;
    const meta = (h: string) => {
      const x = ok.get(h);
      return x ? { device: x.ev.device, seq: x.ev.seq, lamport: x.ev.lamport } : undefined;
    };
    const ctx: OrgCtx = {
      team,
      verified: ok,
      hb,
      recoveryPub: anchor?.recoveryPub ?? null,
      statements,
      votes: new Map(),
      forked: new Map(),
      partners: new Map(),
    };
    const eff: Node[] = [];
    const cache = new Map<string, OrgState>();
    const skipped = new Set<string>(); // devices with an event skipped for want of a key
    for (const n of order) {
      const spki = keys.get(n.ev.device);
      if (!spki) {
        skipped.add(n.ev.device);
        continue;
      }
      if (checkCausal(n.ev, meta).status !== 'ok' || !verifyEvent(n.ev, spki)) continue;
      for (const p of n.ev.prev ? [n.ev.prev, ...n.ev.deps] : n.ev.deps) {
        const pn = ok.get(p)!;
        for (const [d, x] of pn.vc) if ((n.vc.get(d)?.seq ?? 0) < x.seq) n.vc.set(d, x);
        if ((n.vc.get(pn.ev.device)?.seq ?? 0) < pn.ev.seq) n.vc.set(pn.ev.device, { seq: pn.ev.seq, hash: pn.hash });
      }
      ok.set(n.hash, n);
      if (n.ev.v > 1 || !ORG_TYPES.has(n.ev.type)) continue;
      if (n.ev.type === 'device.revoke' || n.ev.type === 'role.revoke') {
        const v = recoveryVote(team, n.ev, ctx.recoveryPub);
        if (v) (ctx.votes as Map<string, string>).set(n.hash, v);
      }
      if (authorizeOrg(stateAt(n, eff, cache, hb), n, ctx, { mutualOnly: false, vote: null })) continue;
      eff.push(n);
      if (n.ev.type === 'device.admit' && !keys.has(n.ev.body.device as string)) {
        keys.set(n.ev.body.device as string, n.ev.body.spki as string);
      }
    }
    if (![...skipped].some((d) => keys.has(d))) return keys;
  }
}

// ── core: keys → signatures → forks → causality → org ────────────────────────

interface Core {
  verified: Map<string, Node>;
  hb: HB;
  cands: Node[];
  effOrg: Node[];
  isVoid: (n: Node) => boolean;
  cutoffs: Map<string, number>;
  forkAt: Map<string, number>;
  pending: PendingEvent[];
  rejected: EventNote[];
  unauthorized: EventNote[];
  voided: Set<string>;
  newerVersion: number;
}

interface CoreInput {
  team: string;
  decoded: ReadonlyMap<string, TeamEvent>;
  keys: ReadonlyMap<string, string>;
  forkProofs: readonly unknown[];
  anchor: Anchor | null;
  statements: ReadonlyMap<string, string>;
}

function runCore(input: CoreInput): Core {
  const { team, decoded, keys } = input;
  const rejected: EventNote[] = [];
  const rejectedSeen = new Set<string>();
  const reject = (hash: string, reason: string) => {
    if (rejectedSeen.has(hash)) return;
    rejectedSeen.add(hash);
    rejected.push({ hash, reason });
  };
  const pending: PendingEvent[] = [];
  const voided = new Set<string>();
  let newerVersion = 0;

  // signatures
  const verified = new Map<string, Node>();
  const addVerified = (hash: string, ev: TeamEvent) => {
    if (!verified.has(hash)) verified.set(hash, { hash, ev, vc: new Map() });
  };
  for (const [hash, ev] of decoded) {
    const spki = keys.get(ev.device);
    if (!spki) pending.push({ hash, missing: [`device:${ev.device}`] });
    else if (!verifyEvent(ev, spki)) reject(hash, 'bad-signature');
    else addVerified(hash, ev);
  }

  // Forks: proofs (out of band or gossiped) plus any two events at one (device, seq),
  // whatever their `fork` counters (phase 1: see `sameSlot` in envelope.ts).
  const genesisDevice = input.anchor?.device ?? null;
  const forkAt = new Map<string, number>();
  const markFork = (device: string, seq: number) => {
    // The genesis event itself is immune: a fork of the genesis device truncates from
    // seq 2 (two genesis events carry the same body, so whichever sorts first is it).
    const at = device === genesisDevice ? Math.max(seq, 2) : seq;
    const cur = forkAt.get(device);
    if (cur === undefined || at < cur) forkAt.set(device, at);
  };
  const proofs: unknown[] = [...input.forkProofs];
  for (const n of verified.values()) if (n.ev.type === 'fork.proof') proofs.push(n.ev.body);
  for (const p of proofs) {
    if (!isObj(p) || !str(p.device, 16)) continue;
    const spki = keys.get(p.device);
    if (!spki || !verifyForkProof(p, spki, team)) continue;
    const a = decodeEvent(p.eventA as string);
    const b = decodeEvent(p.eventB as string);
    addVerified(a.hash, a.event);
    addVerified(b.hash, b.event);
  }
  const slots = new Map<string, Node[]>();
  for (const n of verified.values()) {
    const key = `${n.ev.device}:${n.ev.seq}`;
    const at = slots.get(key);
    if (at) at.push(n);
    else slots.set(key, [n]);
  }
  /** Devices with two or more events at some seq: hb must compare hashes there, not just seqs. */
  const multi = new Set<string>();
  for (const ns of slots.values()) {
    if (ns.length < 2) continue;
    multi.add(ns[0].ev.device);
    markFork(ns[0].ev.device, ns[0].ev.seq); // distinct hashes at one slot: equivocation
  }

  /**
   * a happened-before b (or is b). On a device with two events at one seq, a
   * (device, seq) clock can't tell the branches apart — b may have seen one, the
   * other, or both — so there each node carries the exact set of that device's
   * events in its causal past (`mseen`), and hb compares hashes.
   */
  const hb: HB = (a, b) => {
    if (a === b) return true;
    if (multi.has(a.ev.device)) return !!b.mseen?.has(a.hash);
    const top = b.vc.get(a.ev.device);
    return !!top && top.seq >= a.ev.seq;
  };
  const concurrent = (a: Node, b: Node) => !hb(a, b) && !hb(b, a);

  // causal validity, in lamport order (valid parents always have a smaller lamport)
  const sorted = [...verified.values()].sort(byOrder);
  const status = new Map<string, 'ok' | 'reject' | string[]>();
  const meta = (h: string) => {
    const n = verified.get(h);
    return n ? { device: n.ev.device, seq: n.ev.seq, lamport: n.ev.lamport } : undefined;
  };
  const ok: Node[] = [];
  for (const n of sorted) {
    const v = checkCausal(n.ev, meta);
    if (v.status === 'reject') {
      status.set(n.hash, 'reject');
      if (decoded.has(n.hash)) reject(n.hash, v.reason);
      continue;
    }
    if (v.status === 'pending') {
      status.set(n.hash, v.missing);
      continue;
    }
    const prevNode = n.ev.prev ? verified.get(n.ev.prev) : undefined;
    if (prevNode && prevNode.ev.fork > n.ev.fork) {
      status.set(n.hash, 'reject');
      if (decoded.has(n.hash)) reject(n.hash, 'fork-counter-decreased');
      continue;
    }
    const parents = n.ev.prev ? [n.ev.prev, ...n.ev.deps] : n.ev.deps;
    let missing: string[] = [];
    let bad = false;
    for (const p of parents) {
      const st = status.get(p);
      if (st === 'reject') bad = true;
      else if (Array.isArray(st)) missing = missing.concat(st);
    }
    if (bad) {
      status.set(n.hash, 'reject');
      if (decoded.has(n.hash)) reject(n.hash, 'parent-rejected');
      continue;
    }
    if (missing.length) {
      status.set(n.hash, [...new Set(missing)].sort());
      continue;
    }
    status.set(n.hash, 'ok');
    const bump = (d: string, seq: number, hash: string) => {
      const cur = n.vc.get(d);
      if (!cur || cur.seq < seq || (cur.seq === seq && hash < cur.hash)) n.vc.set(d, { seq, hash });
    };
    for (const p of parents) {
      const pn = verified.get(p)!;
      for (const [d, x] of pn.vc) bump(d, x.seq, x.hash);
      bump(pn.ev.device, pn.ev.seq, pn.hash);
      if (pn.mseen || multi.has(pn.ev.device)) {
        n.mseen ??= new Set();
        for (const h of pn.mseen ?? []) n.mseen.add(h);
        if (multi.has(pn.ev.device)) n.mseen.add(pn.hash);
      }
    }
    ok.push(n);
  }
  // Lines known only from inside a fork proof were never delivered: they inform causality, not the report.
  for (const [hash, st] of status) if (Array.isArray(st) && decoded.has(hash)) pending.push({ hash, missing: st });

  // Candidates: causally valid, this version, not past a fork. The genesis device's
  // seq 1 is the genesis event and nothing else (a second branch there must not
  // slip an admit in below every cutoff).
  const cands: Node[] = [];
  for (const n of ok) {
    const f = forkAt.get(n.ev.device);
    const notGenesis = n.ev.device === genesisDevice && n.ev.seq === 1 && n.ev.type !== 'team.genesis';
    if ((f !== undefined && n.ev.seq >= f) || notGenesis) {
      voided.add(n.hash);
      continue;
    }
    if (n.ev.v > 1) {
      newerVersion++;
      continue;
    }
    if (decoded.has(n.hash)) cands.push(n); // fork-proof-only lines never count as delivered
  }

  const votes = new Map<string, string>();
  for (const n of cands) {
    const v = recoveryVote(team, n.ev, input.anchor?.recoveryPub ?? null);
    if (v) votes.set(n.hash, v);
  }

  // Structural mutual pairs: x revokes y's device while y's device revokes x's, concurrently.
  // A revoke the recovery key backs is a quorum decision, never half of a mutual pair.
  const revokes = cands.filter((n) => n.ev.type === 'device.revoke');
  const partners = new Map<string, Node[]>();
  for (let i = 0; i < revokes.length; i++) {
    for (let j = i + 1; j < revokes.length; j++) {
      const x = revokes[i];
      const y = revokes[j];
      if (votes.has(x.hash) || votes.has(y.hash)) continue;
      if (x.ev.device !== y.ev.device && x.ev.body.device === y.ev.device && y.ev.body.device === x.ev.device && concurrent(x, y)) {
        partners.set(x.hash, [...(partners.get(x.hash) ?? []), y]);
        partners.set(y.hash, [...(partners.get(y.hash) ?? []), x]);
      }
    }
  }

  const ctx: OrgCtx = {
    team,
    verified,
    hb,
    recoveryPub: input.anchor?.recoveryPub ?? null,
    statements: input.statements,
    votes,
    forked: forkAt,
    partners,
  };
  const orgCands = cands.filter((n) => ORG_TYPES.has(n.ev.type));
  const { pass, voiding: v } = orgFixedPoint(orgCands, ctx, genesisDevice);
  for (const h of pass.voids) voided.add(h);

  return {
    verified,
    hb,
    cands,
    effOrg: pass.eff,
    isVoid: v.isVoid,
    cutoffs: v.cutoffs,
    forkAt,
    pending,
    rejected,
    unauthorized: [...pass.notes],
    voided,
    newerVersion,
  };
}
// ── tasks ────────────────────────────────────────────────────────────────────

function initialLifecycle(): TaskLifecycle {
  return {
    state: 'unassigned',
    assignee: null,
    agent: null,
    assignLamport: null,
    acked: false,
    ackEvent: null,
    reminders: 0,
    holder: null,
    reviewSha: null,
    approvedSha: null,
    pushRequestSha: null,
  };
}

interface Applied {
  node: Node;
  member: string;
  before: TaskLifecycle;
}

interface Work {
  task: TeamTask;
  created: Node;
  applied: Applied[];
}

type Patch = Partial<Pick<TeamTask, 'title' | 'project' | 'group' | 'priority' | 'urgent' | 'brief' | 'noteRef' | 'phase' | 'dependsOn' | 'parent' | 'review'>>;

const BRIEF_KEYS = new Set(['goal', 'inScope', 'outOfScope', 'acceptance', 'skills']);

/**
 * `{goal, inScope[], outOfScope?[], acceptance[], skills?[]}` with bounded sizes
 * (BRIEF_LIMITS), no other keys; null clears the brief. Returns undefined when
 * the shape is wrong. Omitted optional lists are stored as `[]`.
 */
function parseBrief(v: unknown): TeamBrief | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  for (const k of Object.keys(v)) if (!BRIEF_KEYS.has(k)) return undefined;
  const L = BRIEF_LIMITS;
  if (!str(v.goal, L.goal) || !v.goal) return undefined;
  const list = (x: unknown, max: number): x is string[] => strList(x, L.items, max);
  if (!list(v.inScope, L.itemChars) || !list(v.acceptance, L.itemChars)) return undefined;
  if (v.outOfScope !== undefined && !list(v.outOfScope, L.itemChars)) return undefined;
  if (v.skills !== undefined && !list(v.skills, L.skillChars)) return undefined;
  return {
    goal: v.goal,
    inScope: [...v.inScope],
    outOfScope: [...((v.outOfScope as string[] | undefined) ?? [])],
    acceptance: [...v.acceptance],
    skills: [...((v.skills as string[] | undefined) ?? [])],
  };
}

function parsePatch(f: unknown): Patch | null {
  if (!isObj(f)) return null;
  const p: Patch = {};
  if ('title' in f) { if (!str(f.title, 200) || !f.title) return null; p.title = f.title; }
  if ('project' in f) { if (!str(f.project, 40)) return null; p.project = f.project; }
  if ('group' in f) { if (f.group !== null && !str(f.group, 64)) return null; p.group = f.group as string | null; }
  if ('priority' in f) {
    if (!Number.isInteger(f.priority) || (f.priority as number) < 0 || (f.priority as number) > 3) return null;
    p.priority = f.priority as PriorityLevel;
  }
  if ('urgent' in f) { if (typeof f.urgent !== 'boolean') return null; p.urgent = f.urgent; }
  if ('brief' in f) {
    const brief = parseBrief(f.brief);
    if (brief === undefined) return null;
    p.brief = brief;
  }
  if ('noteRef' in f) { if (f.noteRef !== null && !(str(f.noteRef, 64) && HASH_RE.test(f.noteRef))) return null; p.noteRef = f.noteRef as string | null; }
  if ('phase' in f) { if (f.phase !== null && !nonNegInt(f.phase)) return null; p.phase = f.phase as number | null; }
  if ('dependsOn' in f) { if (!strList(f.dependsOn, 32, 40, TASK_ID_RE)) return null; p.dependsOn = [...f.dependsOn]; }
  if ('parent' in f) { if (f.parent !== null && !(str(f.parent, 40) && TASK_ID_RE.test(f.parent))) return null; p.parent = f.parent as string | null; }
  if ('review' in f) { if (typeof f.review !== 'boolean') return null; p.review = f.review; }
  return p;
}

function applyPatch(t: TeamTask, p: Patch): void {
  if (p.title !== undefined) t.title = p.title;
  if (p.group !== undefined) t.group = p.group;
  if (p.priority !== undefined) t.priority = p.priority;
  if (p.urgent !== undefined) t.urgent = p.urgent;
  if ('brief' in p) { t.brief = p.brief ?? null; t.briefRev += 1; }
  if (p.noteRef !== undefined) t.noteRef = p.noteRef;
  if (p.phase !== undefined) t.phase = p.phase;
  if (p.dependsOn !== undefined) t.dependsOn = p.dependsOn;
  if (p.review !== undefined) t.review = p.review;
}

type Tried = { L: TaskLifecycle; noop?: boolean } | string;

const HOLDER_MOVES: Partial<Record<TeamTaskState, readonly TeamTaskState[]>> = {
  active: ['blocked', 'paused', 'review'],
  blocked: ['active'],
  paused: ['active'],
  changes: ['active'],
  approved: ['pushed'],
};

/** Apply one structural lifecycle event to L, or say why it doesn't apply. Role checks use S. */
function tryApply(w: Work, n: Node, L: TaskLifecycle, S: OrgState, member: string): Tried {
  const b = n.ev.body;
  const P = w.task.project;
  if (TERMINAL_STATES.has(L.state)) return 'task-closed';
  switch (n.ev.type) {
    case 'task.assign': {
      if (!canLead(S, member, P)) return 'not-lead';
      if (!str(b.member, 64) || !S.members[b.member] || S.members[b.member].devices.length === 0) return 'unknown-member';
      const agent = b.agent === undefined || b.agent === null ? null : b.agent;
      if (agent !== null && !str(agent, 32)) return 'invalid-body';
      if (L.assignee === b.member && L.agent === agent) return { L, noop: true };
      return { L: { ...initialLifecycle(), state: 'assigned', assignee: b.member, agent, assignLamport: n.ev.lamport } };
    }
    case 'task.take': {
      if (b.device !== n.ev.device) return 'take-device-mismatch';
      if (L.holder !== null) return 'already-held';
      if (!['unassigned', 'assigned', 'acknowledged'].includes(L.state)) return 'bad-state';
      if (!canWork(S, member, P)) return 'not-allowed';
      if (L.assignee !== null && L.assignee !== member) return 'not-assignee';
      return {
        L: {
          ...L,
          state: 'active',
          assignee: member,
          assignLamport: L.assignLamport ?? n.ev.lamport,
          holder: n.ev.device,
          acked: true,
          ackEvent: L.ackEvent ?? n.hash,
          reminders: 0,
        },
      };
    }
    case 'task.move-device': {
      if (L.holder === null) return 'not-held';
      if (L.assignee !== member) return 'not-assignee';
      const t = b.device;
      if (!str(t, 16) || !isLiveDevice(S, t) || S.devices[t].member !== member) return 'bad-target-device';
      return { L: { ...L, holder: t } };
    }
    case 'task.transition': {
      const to = b.to as TeamTaskState;
      const sha = b.sha === undefined ? null : b.sha;
      if (sha !== null && !(str(sha, 64) && SHA_RE.test(sha))) return 'invalid-body';
      const leadMove = to === 'cancelled' || (L.state === 'pushed' && to === 'merged') || (L.state === 'merged' && to === 'done');
      if (leadMove) {
        if (!canLead(S, member, P)) return 'not-lead';
        return { L: { ...L, state: to } };
      }
      if (n.ev.device !== L.holder) return 'not-holder';
      if (!(HOLDER_MOVES[L.state] ?? []).includes(to)) return 'bad-transition';
      if (to === 'pushed' && L.pushRequestSha === null) return 'push-not-requested';
      if (to === 'review') {
        return w.task.review
          ? { L: { ...L, state: 'review', reviewSha: sha } }
          : { L: { ...L, state: 'approved', reviewSha: sha, approvedSha: sha } };
      }
      return { L: { ...L, state: to } };
    }
    case 'review.decide': {
      if (!canLead(S, member, P)) return 'not-lead';
      if (L.state !== 'review') return 'bad-state';
      if (!str(b.sha, 64) || !SHA_RE.test(b.sha)) return 'invalid-body';
      // §11.3: the decision is bound to the sha under review.
      if (L.reviewSha !== null && b.sha !== L.reviewSha) return 'stale-sha';
      if (b.decision === 'approve') return { L: { ...L, state: 'approved', approvedSha: b.sha } };
      if (b.decision === 'changes') return { L: { ...L, state: 'changes' } };
      return 'invalid-body';
    }
    default:
      return 'unknown-type';
  }
}

/** Would these two causally-unrelated structural events be silently lost to each other? (§7.6) */
function conflicts(p: Applied, n: Node, member: string): boolean {
  const a = p.node.ev.type;
  const b = n.ev.type;
  if (a === 'task.move-device' || b === 'task.move-device') return false;
  if (a === 'task.take' && b === 'task.take') return true; // lost-claim path
  if (p.member === member) return false; // one person's own devices: sequential is fine
  if (a === 'task.assign' && b === 'task.assign') {
    const x = p.node.ev.body;
    const y = n.ev.body;
    return x.member !== y.member || (x.agent ?? null) !== (y.agent ?? null);
  }
  return true;
}

// ── the fold ─────────────────────────────────────────────────────────────────

export function fold(input: FoldInput): TeamState {
  const { team } = input;

  // 1. decode
  const decodeRejects: EventNote[] = [];
  const decoded = new Map<string, TeamEvent>();
  for (const line of input.lines) {
    let d;
    try {
      d = decodeEvent(line);
    } catch {
      decodeRejects.push({ hash: sha256Hex(typeof line === 'string' ? line : String(line)), reason: 'malformed' });
      continue;
    }
    if (d.event.team !== team) {
      decodeRejects.push({ hash: d.hash, reason: 'wrong-team' });
      continue;
    }
    if (!decoded.has(d.hash)) decoded.set(d.hash, d.event);
  }

  // 2. keys: the genesis anchor, the custodians of recovery-signed statements, and
  //    the devices of EFFECTIVE admits.
  const anchor = genesisAnchor(team, decoded);
  const anchored = new Map<string, string>();
  const statements = new Map<string, string>();
  if (anchor) {
    anchored.set(anchor.device, anchor.spki);
    for (const [hash, ev] of decoded) {
      if (ev.type !== 'recovery.restore') continue;
      const stmt = recoveryStatement(team, ev.body, anchor.recoveryPub);
      if (!stmt) continue;
      statements.set(hash, stmt);
      // The recovery key vouches for these device keys.
      for (const c of ev.body.custodians as Body[]) if (!anchored.has(c.device as string)) anchored.set(c.device as string, c.spki as string);
    }
  }
  const keys = discoverKeys(team, decoded, anchored, anchor, statements);
  const core = runCore({ team, decoded, keys, forkProofs: [...(input.forkProofs ?? [])], anchor, statements });
  const { verified, hb, cands, effOrg, isVoid, forkAt } = core;
  const concurrent = (a: Node, b: Node) => !hb(a, b) && !hb(b, a);
  const unauthorized: EventNote[] = [...core.unauthorized];
  const voided = new Set(core.voided);
  const rejected: EventNote[] = [];
  const rejectedSeen = new Set<string>();
  for (const r of [...decodeRejects, ...core.rejected]) {
    if (rejectedSeen.has(r.hash)) continue;
    rejectedSeen.add(r.hash);
    rejected.push(r);
  }

  // 6. everything else, each at its own deps
  const cache = new Map<string, OrgState>();
  const tasks = new Map<string, Work>();
  const profiles = new Map<string, MemberProfile>();
  const inventory = new Map<string, string[]>();

  const touch = (w: Work, n: Node) => {
    w.task.lastEvent = n.hash;
    w.task.lastLamport = n.ev.lamport;
  };

  const handleTask = (n: Node, S: OrgState, member: string): string | null => {
    const b = n.ev.body;
    const id = b.task;
    if (!str(id, 40) || !TASK_ID_RE.test(id)) return 'invalid-body';

    if (n.ev.type === 'task.upsert') {
      const patch = parsePatch(b.fields);
      if (!patch) return 'invalid-body';
      const existing = tasks.get(id);
      if (!existing) {
        if (id !== `${n.ev.device}-${n.ev.seq}`) return 'task-id-mismatch';
        const project = patch.project;
        if (!project || !S.projects[project]) return 'unknown-project';
        if (!patch.title) return 'invalid-body';
        let parent: string | null = null;
        if (!canLead(S, member, project)) {
          // §5.2: a Developer may create subtasks of its own tasks only.
          const pw = patch.parent ? tasks.get(patch.parent) : undefined;
          if (
            !hasRole(S, member, project, 'developer') ||
            !pw ||
            pw.task.project !== project ||
            pw.task.lifecycle.assignee !== member ||
            !hb(pw.created, n)
          ) {
            return 'not-authorised';
          }
        }
        if (patch.parent) {
          const pw = tasks.get(patch.parent);
          if (!pw || !hb(pw.created, n)) return 'unknown-parent';
          parent = patch.parent;
        }
        const task: TeamTask = {
          id,
          project,
          createdBy: member,
          createdEvent: n.hash,
          parent,
          title: patch.title,
          group: null,
          priority: DEFAULT_PRIORITY_LEVEL,
          urgent: false,
          brief: null,
          briefRev: 0,
          noteRef: null,
          phase: null,
          dependsOn: [],
          review: true,
          lifecycle: initialLifecycle(),
          effectivePriority: DEFAULT_PRIORITY_LEVEL,
          conflict: null,
          lostClaims: [],
          lastEvent: n.hash,
          lastLamport: n.ev.lamport,
        };
        applyPatch(task, patch);
        const w: Work = { task, created: n, applied: [] };
        tasks.set(id, w);
        return null;
      }
      if (!hb(existing.created, n)) return 'task-unseen';
      const t = existing.task;
      const own = t.createdBy === member && t.parent !== null && hasRole(S, member, t.project, 'developer');
      if (!canLead(S, member, t.project) && !own) return 'not-authorised';
      if (patch.project !== undefined && patch.project !== t.project) return 'project-immutable';
      if (patch.parent !== undefined && patch.parent !== t.parent) return 'parent-immutable';
      applyPatch(t, patch);
      touch(existing, n);
      return null;
    }

    const w = tasks.get(id);
    if (!w) return 'unknown-task';
    if (!hb(w.created, n)) return 'task-unseen';
    const t = w.task;
    const L = t.lifecycle;

    switch (n.ev.type) {
      case 'task.ack': {
        if (L.assignee !== member) return 'not-assignee';
        if (TERMINAL_STATES.has(L.state)) return 'task-closed';
        t.lifecycle = {
          ...L,
          acked: true,
          ackEvent: L.ackEvent ?? n.hash,
          reminders: 0,
          state: L.state === 'assigned' ? 'acknowledged' : L.state,
        };
        touch(w, n);
        return null;
      }
      case 'task.remind': {
        if (!canLead(S, member, t.project)) return 'not-lead';
        if (TERMINAL_STATES.has(L.state) || L.state === 'merged') return 'task-closed';
        if (L.assignee === null) return 'unassigned';
        t.lifecycle = { ...L, reminders: L.reminders + 1 };
        touch(w, n);
        return null;
      }
      case 'push.request': {
        if (!canLead(S, member, t.project)) return 'not-lead';
        if (L.state !== 'approved') return 'bad-state';
        if (!str(b.sha, 64) || !SHA_RE.test(b.sha)) return 'invalid-body';
        if (L.approvedSha !== null && b.sha !== L.approvedSha) return 'stale-sha';
        t.lifecycle = { ...L, pushRequestSha: b.sha };
        touch(w, n);
        return null;
      }
      default:
        break;
    }

    if (!STRUCTURAL.has(n.ev.type)) return 'unknown-type';

    if (L.state === 'needs-owner') {
      if (n.ev.type !== 'conflict.resolve') return 'needs-owner';
      if (!canLead(S, member, t.project)) return 'not-lead';
      const side = t.conflict?.sides.find((s) => s.event === b.pick);
      if (!side) return 'invalid-pick';
      for (const s of t.conflict!.sides) {
        const sn = verified.get(s.event);
        if (!sn || !hb(sn, n)) return 'conflict-unseen';
      }
      t.lifecycle = side.lifecycle;
      t.conflict = null;
      w.applied = [];
      touch(w, n);
      return null;
    }
    if (n.ev.type === 'conflict.resolve') return 'no-conflict';

    for (const p of w.applied) {
      if (!concurrent(p.node, n) || !conflicts(p, n, member)) continue;
      if (p.node.ev.type === 'task.take' && n.ev.type === 'task.take') {
        // §7.6: advisory claims, deterministic loser (the later in (lamport, device) order).
        t.lostClaims.push({ device: n.ev.device, member, event: n.hash, winner: p.node.hash });
        touch(w, n);
        return null;
      }
      const alt = tryApply(w, n, p.before, S, member);
      if (typeof alt === 'string') return alt;
      const sides: ConflictSide[] = [
        { event: p.node.hash, lifecycle: L },
        { event: n.hash, lifecycle: alt.L },
      ].sort((x, y) => (x.event < y.event ? -1 : 1));
      t.conflict = { sides };
      t.lifecycle = { ...L, state: 'needs-owner' };
      touch(w, n);
      return null;
    }

    const r = tryApply(w, n, L, S, member);
    if (typeof r === 'string') return r;
    if (!r.noop) {
      w.applied.push({ node: n, member, before: L });
      t.lifecycle = r.L;
    }
    touch(w, n);
    return null;
  };

  for (const n of cands) {
    if (ORG_TYPES.has(n.ev.type)) continue;
    if (!TASK_TYPES.has(n.ev.type)) continue; // unknown or not-yet-folded types: stored, relayed, ignored
    if (isVoid(n)) {
      voided.add(n.hash);
      continue;
    }
    const S = stateAt(n, effOrg, cache, hb);
    if (!isLiveDevice(S, n.ev.device)) {
      unauthorized.push({ hash: n.hash, reason: 'device-not-admitted' });
      continue;
    }
    const member = S.devices[n.ev.device].member;
    const b = n.ev.body;
    let reason: string | null = null;
    if (n.ev.type === 'member.profile') {
      if (str(b.name, 64) && str(b.jobRole, 64) && str(b.timezone, 64)) {
        profiles.set(member, { name: b.name, jobRole: b.jobRole, timezone: b.timezone });
      } else reason = 'invalid-body';
    } else if (n.ev.type === 'device.inventory') {
      if (strList(b.projectKeys, 256, 40, PROJECT_KEY_RE)) inventory.set(n.ev.device, [...new Set(b.projectKeys)].sort());
      else reason = 'invalid-body';
    } else {
      reason = handleTask(n, S, member);
    }
    if (reason) unauthorized.push({ hash: n.hash, reason });
  }

  // Final org view: every effective org event, with the clamped cutoffs of the effective revokes.
  const G = emptyOrg();
  for (const n of effOrg) applyOrg(G, n);
  for (const [device, c] of core.cutoffs) if (G.devices[device]) G.devices[device].cutoffSeq = c;
  // A device with a proven fork is frozen from the fork seq on: it is dead, not live.
  for (const [device, seq] of forkAt) {
    const d = G.devices[device];
    if (d) d.cutoffSeq = Math.min(d.cutoffSeq ?? seq - 1, seq - 1);
  }
  // The recovery key is bound to the team id itself, so no revocation or fork can remove it.
  if (anchor) G.recoveryPub = anchor.recoveryPub;
  for (const [member, p] of profiles) if (G.members[member]) G.members[member].profile = p;
  for (const [device, keys] of inventory) if (G.devices[device]) G.devices[device].inventory = keys;

  const outTasks: Record<string, TeamTask> = {};
  for (const [id, w] of [...tasks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const t = w.task;
    t.effectivePriority = Math.max(0, t.priority - Math.min(t.lifecycle.reminders, MAX_REMINDER_BOOST)) as PriorityLevel;
    outTasks[id] = t;
  }

  return {
    team,
    org: {
      ...G,
      custodians: liveCustodianDevices(G),
      recoveryMode: inRecovery(G),
      forks: Object.fromEntries([...forkAt].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    },
    tasks: outTasks,
    pending: core.pending.sort(byHashNote),
    rejected: rejected.sort(byHashNote),
    unauthorized: unauthorized.sort(byHashNote),
    voided: [...voided].sort(),
    newerVersion: core.newerVersion,
  };
}

/** sha256 of the canonical folded state — equal across devices iff their folds agree. */
export function stateHash(state: TeamState): string {
  return sha256Hex(canonicalize(state));
}

/**
 * §7.3 ordering for `my_tasks` and the Team board: the task this device holds,
 * then urgent, then effective priority, then the assign's lamport, then id.
 * (Phase eligibility needs the phase barrier over the fold; that lands with the
 * lifecycle/MCP work, so it is not applied here.)
 */
export function sortTasks(tasks: readonly TeamTask[], myDevice?: string): TeamTask[] {
  const key = (t: TeamTask) => [
    myDevice !== undefined && t.lifecycle.holder === myDevice ? 0 : 1,
    t.urgent ? 0 : 1,
    t.effectivePriority,
    t.lifecycle.assignLamport ?? Number.MAX_SAFE_INTEGER,
  ];
  return [...tasks].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
