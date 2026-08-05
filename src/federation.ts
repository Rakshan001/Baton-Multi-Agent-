/**
 * Cross-machine member presence + federated file claims — the "who is editing
 * what" plane, across DIFFERENT machines.
 *
 * > Not to be confused with `collectPresence` in src/board.ts. That answers
 * > "which agent sessions are running on THIS machine" from the local hook
 * > session registry, and is unrelated to membership. This module answers "which
 * > remote MEMBERS are connected to this host, and what files do they hold" —
 * > different identities, different lifetime, different transport. Neither
 * > replaces the other.
 *
 * This is the federation of a mechanism Baton already has. `touch_files` /
 * `check_files` (src/signals.ts) already answer "is anyone on this file?" for
 * agents sharing ONE filesystem. The only thing missing across machines is a
 * place to pool those answers, which is what this store is.
 *
 * Three properties are deliberate and load-bearing:
 *
 * 1. **Claims are ADVISORY. Claiming an already-claimed path SUCCEEDS.** A hard
 *    lock is not implementable here and pretending otherwise would be a lie:
 *    members' agents run on machines we do not control, writing to their own
 *    clones, and no daemon can stop a `write()` on someone else's disk. What a
 *    claim buys is that a well-behaved agent asks first and gets a truthful
 *    answer. The wall against bad code is the merge boundary, not this.
 * 2. **Every timestamp is assigned by the HOST, on receipt.** Member clocks are
 *    never read or compared. Two machines disagreeing by a few minutes would
 *    otherwise reorder claims and expire live ones (edge case E9).
 * 3. **Nothing here is persisted, ever.** Presence and claims are in-memory,
 *    lost on restart, and rebuilt from the next heartbeats. Truth lives in git;
 *    this plane is a view with a TTL, so losing it cannot lose data.
 */

/** A member missing this long is considered gone. Heartbeats are ~30 s. */
export const PRESENCE_TTL_MS = 90_000;
/** A claim not refreshed within this window expires silently. */
export const CLAIM_TTL_MS = 15 * 60_000;

const MAX_CLAIMS_PER_MEMBER = 200;
const MAX_MEMBERS = 100;
const PATH_MAX = 400;
/** Per member. Oldest is dropped first — a warning nobody read in 20 notices
 *  is not going to be read now, and an unbounded queue is a memory leak. */
const MAX_WARNINGS = 20;
const WARNING_MAX = 400;

/** Identity of whoever sent a heartbeat, as resolved by the auth layer. */
export interface ClaimActor {
  id: string;
  name: string;
}

/** One claimed file, as the host records it. */
export interface Claim {
  /** Hub sub-project id, or null for a single-repo hub. */
  projectId: string | null;
  /** REPO-RELATIVE path. Absolute paths differ per machine and would never match. */
  relPath: string;
  memberId: string;
  memberName: string;
  agent: string | null;
  branch: string | null;
  /** Host-assigned. */
  openedAt: string;
  /** Host-assigned; bumped on every refresh. */
  refreshedAt: string;
}

export interface PresenceEntry {
  memberId: string;
  memberName: string;
  device: string | null;
  /** How many agent sessions that member reported running. */
  sessions: number;
  /** Host-assigned. */
  since: string;
  lastSeen: string;
}

/** What a member's daemon sends. Untrusted: every field is bounded on receipt. */
export interface HeartbeatInput {
  device?: string;
  sessions?: number;
  claims?: Array<{
    projectId?: string | null;
    relPath?: string;
    agent?: string | null;
    branch?: string | null;
  }>;
}

/**
 * Two members holding the same path on the SAME branch. Different branches are
 * not a conflict — divergent branches meet at merge, not in a working tree — so
 * those surface as information instead (`sameBranch: false`).
 */
export interface ClaimOverlap {
  projectId: string | null;
  relPath: string;
  sameBranch: boolean;
  holders: Array<{ memberId: string; memberName: string; agent: string | null; branch: string | null; since: string }>;
}

/**
 * An owner's notice to one member.
 *
 * Delivered in the heartbeat RESPONSE rather than pushed, because the only
 * channel that reliably reaches a member's daemon is the one it opens itself.
 * Retained rather than drained on read: a daemon that crashes between receiving
 * and printing must not silently lose the notice, so the member re-reads the
 * same list every 30 s and tracks by `id` what it has already shown.
 */
export interface MemberWarning {
  id: string;
  message: string;
  /** Display name of the owner who sent it. */
  from: string;
  /** Host-assigned. */
  at: string;
}

export interface HeartbeatResult {
  /** Paths this heartbeat newly claimed (not previously held by this member). */
  opened: string[];
  /** Paths this member dropped since its last heartbeat. */
  released: string[];
  /** Overlaps involving this member, after applying the heartbeat. */
  overlaps: ClaimOverlap[];
  /** Undismissed notices for this member — see MemberWarning. */
  warnings: MemberWarning[];
  joined: boolean;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One local edit signal, as `getSignals` shapes it — the publish-side input. */
export interface LocalSignal {
  path: string;
  holders: Array<{ slug: string; agent: string | null; state: 'active' | 'settled' }>;
}

/**
 * This machine's active signals, shaped as claims to publish.
 *
 * Pure so both halves of the bug it fixes stay pinned by tests:
 *
 * 1. **Every claim carries its sub-project.** Only tasks record `projectId`, so
 *    `co-*` checkouts and `sess-*` root sessions used to publish null — and a
 *    null matches ANY project on the receiving side (see `remoteHoldersFor`,
 *    which deliberately treats an unknown project as "could be mine"). That
 *    reported a teammate's `src/index.ts` in proj-a as a hold on proj-b's:
 *    exactly the false conflict 87b4114 removed locally, still alive
 *    cross-machine because the publish side discarded the id. `projectOfSlug`
 *    (conflicts.ts `holderProjects`) recovers it for all three holder kinds.
 *
 * 2. **One claim per (projectId, path), not per path.** `getSignals` groups
 *    holders by path STRING alone, so a hub's proj-a and proj-b `src/index.ts`
 *    arrive as a single signal. Stopping at the first active holder therefore
 *    dropped the second project's claim entirely — it was never published at
 *    all. The key matches how the host stores them (`keyOf`).
 *
 * Only `active` holders publish: `settled` means touched recently but since
 * committed or reverted, which is explicitly not a reason for anyone to wait.
 */
export function localClaims(
  signals: LocalSignal[],
  tasks: Array<{ slug: string; projectId?: string; branch?: string }>,
  projectOfSlug: Map<string, string>,
): Array<{ projectId: string | null; relPath: string; agent: string | null; branch: string | null }> {
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const claims: Array<{ projectId: string | null; relPath: string; agent: string | null; branch: string | null }> = [];
  const seen = new Set<string>();
  for (const s of signals) {
    for (const h of s.holders) {
      if (h.state !== 'active') continue;
      const projectId = bySlug.get(h.slug)?.projectId ?? projectOfSlug.get(h.slug) ?? null;
      const key = keyOf(projectId, s.path);
      if (seen.has(key)) continue; // the host merges across members; don't duplicate within one
      seen.add(key);
      claims.push({ projectId, relPath: s.path, agent: h.agent ?? null, branch: bySlug.get(h.slug)?.branch ?? null });
    }
  }
  return claims;
}

/** Repo-relative, no traversal, no absolute paths — the cross-machine contract. */
export function isClaimablePath(p: string): boolean {
  if (!p || p.length > PATH_MAX) return false;
  if (/\p{Cc}/u.test(p)) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.split('/').filter(Boolean);
  return parts.length > 0 && !parts.some((s) => s === '..' || s === '.');
}

// Separator is NUL: it cannot occur in a project id (charset [a-z0-9._-]) or a
// path, so a key can never be ambiguous between the two fields.
const keyOf = (projectId: string | null, relPath: string): string => `${projectId ?? ''}\u0000${relPath}`;

interface MemberState {
  entry: PresenceEntry;
  /** key → claim */
  claims: Map<string, Claim>;
  warnings: MemberWarning[];
}

export class PresenceStore {
  private members = new Map<string, MemberState>();
  /** Host-assigned, monotonic. Only has to be unique within one host process —
   *  warnings do not survive a restart, so neither must their ids. */
  private warnSeq = 0;

  /**
   * Record a heartbeat, replacing that member's claim set wholesale.
   *
   * Replace-not-merge is deliberate: the heartbeat is a full statement of what
   * the member currently holds, so a file they stopped editing disappears
   * without needing an explicit release message that could be lost.
   */
  heartbeat(actor: ClaimActor, hb: HeartbeatInput, now: number): HeartbeatResult {
    const id = str(actor.id, 64);
    if (!id) return { opened: [], released: [], overlaps: [], warnings: [], joined: false };

    const iso = new Date(now).toISOString();
    const existing = this.members.get(id);
    const joined = !existing;
    if (!existing && this.members.size >= MAX_MEMBERS) {
      return { opened: [], released: [], overlaps: [], warnings: [], joined: false };
    }

    const prevClaims = existing?.claims ?? new Map<string, Claim>();
    const nextClaims = new Map<string, Claim>();

    for (const raw of (hb.claims ?? []).slice(0, MAX_CLAIMS_PER_MEMBER)) {
      const relPath = str(raw?.relPath, PATH_MAX).replace(/\\/g, '/');
      if (!isClaimablePath(relPath)) continue;
      const projectId = raw?.projectId == null ? null : (str(raw.projectId, 80) || null);
      const key = keyOf(projectId, relPath);
      const before = prevClaims.get(key);
      nextClaims.set(key, {
        projectId,
        relPath,
        memberId: id,
        memberName: str(actor.name, 80) || id,
        agent: raw?.agent == null ? null : (str(raw.agent, 40) || null),
        branch: raw?.branch == null ? null : (str(raw.branch, 200) || null),
        // Keep the ORIGINAL open time across refreshes so "held since" is honest.
        openedAt: before?.openedAt ?? iso,
        refreshedAt: iso,
      });
    }

    const entry: PresenceEntry = {
      memberId: id,
      memberName: str(actor.name, 80) || id,
      device: str(hb.device, 80) || null,
      sessions: Number.isFinite(hb.sessions) ? Math.max(0, Math.min(99, Math.floor(hb.sessions as number))) : 0,
      since: existing?.entry.since ?? iso,
      lastSeen: iso,
    };
    // Warnings survive the heartbeat that replaces the claim set: they are the
    // owner's message to a person, not a property of what that person holds.
    const warnings = existing?.warnings ?? [];
    this.members.set(id, { entry, claims: nextClaims, warnings });

    const opened = [...nextClaims.keys()].filter((k) => !prevClaims.has(k)).map((k) => nextClaims.get(k)!.relPath);
    const released = [...prevClaims.keys()].filter((k) => !nextClaims.has(k)).map((k) => prevClaims.get(k)!.relPath);

    return { opened, released, joined, warnings: [...warnings], overlaps: this.overlapsFor(id, now) };
  }

  /** Drop a member entirely (explicit disconnect, or an owner clearing them). */
  remove(memberId: string): boolean {
    return this.members.delete(memberId);
  }

  /**
   * Release ONE claim on a member's behalf — the owner's "clear a stale claim"
   * control for edge case E1, where an agent died mid-edit and its claim will
   * otherwise sit there for the rest of the 15-minute TTL.
   *
   * Returns the claim that was dropped, or null if it was not held. Note this
   * is a correction to a VIEW, not to the member's filesystem: if that member's
   * daemon is in fact alive and still editing the file, its next heartbeat
   * re-states the claim and it comes straight back. That is the right outcome —
   * the alternative would be a host silently suppressing a true signal.
   */
  releaseClaim(memberId: string, projectId: string | null, relPath: string): Claim | null {
    const state = this.members.get(memberId);
    if (!state) return null;
    const key = keyOf(projectId, relPath.replace(/\\/g, '/'));
    const claim = state.claims.get(key);
    if (!claim) return null;
    state.claims.delete(key);
    return claim;
  }

  /**
   * Queue an owner's notice for a member. Returns null when that member is not
   * connected: warning is a live-plane action, and a notice queued for someone
   * who may never reconnect would be a promise the host cannot keep. The caller
   * says so plainly rather than reporting a delivery that did not happen.
   */
  warn(memberId: string, message: string, from: string, now: number): MemberWarning | null {
    const state = this.members.get(memberId);
    if (!state) return null;
    const text = str(message, WARNING_MAX);
    if (!text) return null;
    const warning: MemberWarning = {
      id: `w${++this.warnSeq}`,
      message: text,
      from: str(from, 80) || 'owner',
      at: new Date(now).toISOString(),
    };
    state.warnings = [...state.warnings, warning].slice(-MAX_WARNINGS);
    return warning;
  }

  /** Notices currently queued for a member — what the owner's UI shows as sent. */
  warningsFor(memberId: string): MemberWarning[] {
    return [...(this.members.get(memberId)?.warnings ?? [])];
  }

  /** Members whose last heartbeat is still within the presence TTL. */
  presence(now: number): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    for (const { entry } of this.members.values()) {
      if (now - Date.parse(entry.lastSeen) <= PRESENCE_TTL_MS) out.push(entry);
    }
    return out.sort((a, b) => a.memberId.localeCompare(b.memberId));
  }

  /** Live claims: held by a present member and refreshed within the claim TTL. */
  claims(now: number): Claim[] {
    const live = new Set(this.presence(now).map((p) => p.memberId));
    const out: Claim[] = [];
    for (const [id, state] of this.members) {
      if (!live.has(id)) continue;
      for (const c of state.claims.values()) {
        if (now - Date.parse(c.refreshedAt) <= CLAIM_TTL_MS) out.push(c);
      }
    }
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /**
   * Who else holds the paths in `paths`, excluding `exceptMemberId`. This is
   * what `check_files` federates: the answer names the holder, the branch, and
   * how long they have held it, so the asking agent can decide for itself.
   */
  holdersFor(paths: string[], now: number, exceptMemberId?: string): Record<string, Claim[]> {
    const wanted = new Set(paths.map((p) => p.replace(/\\/g, '/')));
    // Null-prototype, like remote-claims.ts: `__proto__` is a legal filename,
    // and on a plain object `out['__proto__'] ??= []` finds the inherited
    // accessor, skips the assignment, and throws on .push. No production
    // caller reaches this today, but it is the same loaded gun as its sibling.
    const out: Record<string, Claim[]> = Object.create(null) as Record<string, Claim[]>;
    for (const c of this.claims(now)) {
      if (!wanted.has(c.relPath)) continue;
      if (exceptMemberId && c.memberId === exceptMemberId) continue;
      (out[c.relPath] ??= []).push(c);
    }
    return out;
  }

  /** Live claims grouped by (projectId, relPath) — one scan, shared by both overlap views. */
  private liveByKey(now: number): Map<string, Claim[]> {
    const byKey = new Map<string, Claim[]>();
    for (const c of this.claims(now)) {
      const k = keyOf(c.projectId, c.relPath);
      const at = byKey.get(k);
      if (at) at.push(c);
      else byKey.set(k, [c]);
    }
    return byKey;
  }

  private toOverlap(holders: Claim[]): ClaimOverlap {
    const branches = new Set(holders.map((h) => h.branch ?? ''));
    return {
      projectId: holders[0].projectId,
      relPath: holders[0].relPath,
      // One distinct branch across all holders = they are in each other's way.
      sameBranch: branches.size === 1,
      holders: holders.map((h) => ({
        memberId: h.memberId, memberName: h.memberName, agent: h.agent, branch: h.branch, since: h.openedAt,
      })),
    };
  }

  /** Overlaps touching one member's claims. */
  overlapsFor(memberId: string, now: number): ClaimOverlap[] {
    const mine = this.members.get(memberId);
    if (!mine) return [];
    const byKey = this.liveByKey(now);
    const out: ClaimOverlap[] = [];
    for (const key of mine.claims.keys()) {
      const holders = byKey.get(key) ?? [];
      if (holders.length >= 2) out.push(this.toOverlap(holders));
    }
    return out;
  }

  /**
   * Every current overlap, for the dashboard's who's-editing view.
   *
   * A key with two or more live holders is an overlap no matter whose claims
   * you start from, so this reads the grouped map directly — asking
   * overlapsFor() once per member repeated the full presence scan, claim scan,
   * and sort M times per call, on endpoints the dashboard polls every 10s.
   */
  allOverlaps(now: number): ClaimOverlap[] {
    const out: ClaimOverlap[] = [];
    for (const holders of this.liveByKey(now).values()) {
      if (holders.length >= 2) out.push(this.toOverlap(holders));
    }
    return out;
  }

  /**
   * Drop members past the presence TTL. Returns who left so the caller can emit
   * `member.left`. Called on a timer AND opportunistically from reads, so a
   * stopped timer can never make a departed member look present.
   */
  sweep(now: number): { left: PresenceEntry[] } {
    const left: PresenceEntry[] = [];
    for (const [id, state] of [...this.members]) {
      if (now - Date.parse(state.entry.lastSeen) > PRESENCE_TTL_MS) {
        left.push(state.entry);
        this.members.delete(id);
      }
    }
    return { left };
  }

  /** Test/observability helper — how many members are tracked, TTL ignored. */
  size(): number {
    return this.members.size;
  }
}
