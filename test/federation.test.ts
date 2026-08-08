// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { localClaims,
  CLAIM_TTL_MS, PRESENCE_TTL_MS, PresenceStore, isClaimablePath,
} from '../src/federation.js';

/**
 * The federated "who is editing what" plane — remote MEMBERS, not the local
 * agent sessions `collectPresence` reports (test/presence.test.ts covers those).
 *
 * What is pinned here is mostly the three properties that make it honest: a
 * claim never BLOCKS anything, every timestamp comes from the host rather than a
 * member's clock, and nothing survives a restart except by being re-reported.
 */
const T0 = Date.parse('2026-07-30T12:00:00.000Z');
const priya = { id: 'priya', name: 'Priya' };
const sam = { id: 'sam', name: 'Sam' };

const claim = (relPath: string, over: Record<string, unknown> = {}) =>
  ({ relPath, projectId: null, agent: 'claude', branch: 'main', ...over });

describe('isClaimablePath', () => {
  it('accepts repo-relative paths only', () => {
    expect(isClaimablePath('src/a.ts')).toBe(true);
    expect(isClaimablePath('api-server/src/x.ts')).toBe(true);
  });

  /*
   * Absolute paths are the cross-machine trap: valid on the sender, meaningless
   * everywhere else, so a claim keyed on one silently matches nothing and the
   * coordination quietly does nothing at all.
   */
  it('refuses absolute paths and traversal', () => {
    expect(isClaimablePath('/Users/priya/repo/src/a.ts')).toBe(false);
    expect(isClaimablePath('C:/repo/a.ts')).toBe(false);
    expect(isClaimablePath('../outside.ts')).toBe(false);
    expect(isClaimablePath('a/./b')).toBe(false);
    expect(isClaimablePath('')).toBe(false);
  });
});

describe('heartbeat + presence', () => {
  it('registers a member and reports them online', () => {
    const s = new PresenceStore();
    const r = s.heartbeat(priya, { device: 'laptop', sessions: 2, claims: [claim('src/a.ts')] }, T0);
    expect(r.joined).toBe(true);
    expect(r.opened).toEqual(['src/a.ts']);

    const online = s.presence(T0);
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({ memberId: 'priya', device: 'laptop', sessions: 2 });
  });

  it('drops a member from presence once the TTL lapses', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts')] }, T0);
    expect(s.presence(T0 + PRESENCE_TTL_MS - 1)).toHaveLength(1);
    expect(s.presence(T0 + PRESENCE_TTL_MS + 1)).toHaveLength(0);
    // their claims go with them — a claim from someone gone is not a live claim
    expect(s.claims(T0 + PRESENCE_TTL_MS + 1)).toHaveLength(0);
  });

  it('sweep reports who left so the caller can emit member.left', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, {}, T0);
    s.heartbeat(sam, {}, T0);
    expect(s.sweep(T0 + 1000).left).toHaveLength(0);
    const { left } = s.sweep(T0 + PRESENCE_TTL_MS + 1);
    expect(left.map((e) => e.memberId).sort()).toEqual(['priya', 'sam']);
    expect(s.size()).toBe(0);
  });

  /*
   * The heartbeat is a full statement of what the member holds, so a file they
   * stopped editing disappears without needing an explicit release message that
   * could be lost in transit.
   */
  it('replaces the claim set wholesale and reports what was released', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts'), claim('b.ts')] }, T0);
    const r = s.heartbeat(priya, { claims: [claim('b.ts'), claim('c.ts')] }, T0 + 1000);
    expect(r.opened).toEqual(['c.ts']);
    expect(r.released).toEqual(['a.ts']);
    expect(s.claims(T0 + 1000).map((c) => c.relPath)).toEqual(['b.ts', 'c.ts']);
  });

  it('keeps the original open time across refreshes so "held since" is honest', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0 + 60_000);
    const c = s.claims(T0 + 60_000)[0];
    expect(c.openedAt).toBe(new Date(T0).toISOString());
    expect(c.refreshedAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('a claim dropped from the set stops being live even while the member stays online', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    s.heartbeat(priya, { claims: [claim('b.ts')] }, T0 + CLAIM_TTL_MS + 1000);
    expect(s.claims(T0 + CLAIM_TTL_MS + 1000).map((c) => c.relPath)).toEqual(['b.ts']);
  });

  it('ignores unusable paths instead of rejecting the whole heartbeat', () => {
    const s = new PresenceStore();
    const r = s.heartbeat(priya, { claims: [claim('/abs/a.ts'), claim('../b.ts'), claim('ok.ts')] }, T0);
    expect(r.opened).toEqual(['ok.ts']);
  });

  /*
   * Edge case E9. Two machines minutes apart would otherwise reorder claims and
   * expire live ones, so a member's own clock is never read.
   */
  it('ignores member-supplied timing entirely — the host stamps everything', () => {
    const s = new PresenceStore();
    const lying = { ...claim('a.ts'), openedAt: '1999-01-01T00:00:00.000Z', refreshedAt: '2099-01-01T00:00:00.000Z' };
    s.heartbeat(priya, { claims: [lying] }, T0);
    const c = s.claims(T0)[0];
    expect(c.openedAt).toBe(new Date(T0).toISOString());
    expect(c.refreshedAt).toBe(new Date(T0).toISOString());
  });
});

describe('overlaps — advisory, never blocking', () => {
  /*
   * The central property. A hard lock is not implementable across machines we do
   * not control, so a second claim SUCCEEDS and both sides are merely told.
   */
  it('lets a second member claim a held path, and tells both', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts', { branch: 'main' })] }, T0);
    const r = s.heartbeat(sam, { claims: [claim('src/a.ts', { branch: 'main' })] }, T0 + 1000);

    expect(r.opened).toEqual(['src/a.ts']);          // NOT refused
    expect(s.claims(T0 + 1000)).toHaveLength(2);     // both are recorded

    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0].sameBranch).toBe(true);
    expect(r.overlaps[0].holders.map((h) => h.memberId).sort()).toEqual(['priya', 'sam']);
  });

  // Divergent branches meet at merge, not in a working tree.
  it('treats the same path on different branches as information, not conflict', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts', { branch: 'feat/x' })] }, T0);
    const r = s.heartbeat(sam, { claims: [claim('src/a.ts', { branch: 'feat/y' })] }, T0 + 1000);
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0].sameBranch).toBe(false);
  });

  it('does not treat the same path in different projects as an overlap', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts', { projectId: 'api' })] }, T0);
    const r = s.heartbeat(sam, { claims: [claim('src/a.ts', { projectId: 'web' })] }, T0 + 1000);
    expect(r.overlaps).toHaveLength(0);
  });

  it('reports one entry per overlapping path across the whole hub', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts'), claim('b.ts')] }, T0);
    s.heartbeat(sam, { claims: [claim('a.ts')] }, T0);
    const all = s.allOverlaps(T0);
    expect(all).toHaveLength(1);
    expect(all[0].relPath).toBe('a.ts');
  });

  it('stops reporting an overlap once one holder goes away', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    s.heartbeat(sam, { claims: [claim('a.ts')] }, T0);
    expect(s.allOverlaps(T0)).toHaveLength(1);
    s.heartbeat(sam, { claims: [claim('a.ts')] }, T0 + PRESENCE_TTL_MS + 1); // priya went quiet
    expect(s.allOverlaps(T0 + PRESENCE_TTL_MS + 1)).toHaveLength(0);
  });
});

describe('holdersFor — what check_files federates', () => {
  it('names the other holders, their branch, and how long they have held it', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts', { branch: 'main', agent: 'claude' })] }, T0);
    s.heartbeat(sam, { claims: [claim('src/b.ts')] }, T0);

    const held = s.holdersFor(['src/a.ts', 'src/b.ts', 'src/never.ts'], T0, 'sam');
    expect(Object.keys(held)).toEqual(['src/a.ts']); // sam's own claim excluded
    expect(held['src/a.ts'][0]).toMatchObject({
      memberId: 'priya', branch: 'main', agent: 'claude', openedAt: new Date(T0).toISOString(),
    });
  });

  it('returns nothing when only the asker holds the path', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    expect(s.holdersFor(['a.ts'], T0, 'priya')).toEqual({});
  });
});

describe('host restart', () => {
  /*
   * Presence is a view with a TTL, never persisted. A restarted host knows
   * nothing until members heartbeat again — which is correct: a claim restored
   * from disk could outlive the agent that made it, and a stale claim is worse
   * than no claim because it is believed.
   */
  it('starts empty and rebuilds purely from heartbeats', () => {
    const before = new PresenceStore();
    before.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    expect(before.claims(T0)).toHaveLength(1);

    const afterRestart = new PresenceStore();
    expect(afterRestart.presence(T0)).toHaveLength(0);
    expect(afterRestart.claims(T0)).toHaveLength(0);

    afterRestart.heartbeat(priya, { claims: [claim('a.ts')] }, T0 + 30_000);
    expect(afterRestart.claims(T0 + 30_000)).toHaveLength(1);
  });
});

describe('bounds', () => {
  it('caps claims per member', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: Array.from({ length: 500 }, (_, i) => claim(`f${i}.ts`)) }, T0);
    expect(s.claims(T0).length).toBeLessThanOrEqual(200);
  });

  it('ignores a heartbeat with no usable actor id', () => {
    const s = new PresenceStore();
    const r = s.heartbeat({ id: '', name: 'x' }, { claims: [claim('a.ts')] }, T0);
    expect(r.joined).toBe(false);
    expect(s.size()).toBe(0);
  });

  it('clamps a nonsense session count', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { sessions: -5 }, T0);
    expect(s.presence(T0)[0].sessions).toBe(0);
    s.heartbeat(priya, { sessions: 10_000 }, T0 + 1);
    expect(s.presence(T0 + 1)[0].sessions).toBe(99);
  });

  it('removes a member on explicit disconnect', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    expect(s.remove('priya')).toBe(true);
    expect(s.presence(T0)).toHaveLength(0);
    expect(s.claims(T0)).toHaveLength(0);
  });
});

/**
 * Owner controls (Phase 6). The store half — the HTTP half, including the
 * owner-only gate, lives in test/member-controls.test.ts.
 */
describe('releaseClaim', () => {
  it('clears one claim without touching the rest of that member', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts'), claim('b.ts')] }, T0);
    const cleared = s.releaseClaim('priya', null, 'a.ts');
    expect(cleared?.relPath).toBe('a.ts');
    expect(s.claims(T0).map((c) => c.relPath)).toEqual(['b.ts']);
  });

  /*
   * The property that keeps this honest: clearing corrects the shared VIEW, not
   * the member's disk. If their agent really is still on the file, the next
   * heartbeat re-states it and it comes back — a host able to permanently
   * suppress a true signal would be worse than one that shows a stale one.
   */
  it('does not stick — a live member re-states the claim on its next heartbeat', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    s.releaseClaim('priya', null, 'a.ts');
    expect(s.claims(T0)).toHaveLength(0);
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0 + 30_000);
    expect(s.claims(T0 + 30_000).map((c) => c.relPath)).toEqual(['a.ts']);
  });

  it('reports a miss rather than pretending it cleared something', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    expect(s.releaseClaim('priya', null, 'nope.ts')).toBeNull();
    expect(s.releaseClaim('nobody', null, 'a.ts')).toBeNull();
    // project scoping is part of the identity of a claim, not decoration
    expect(s.releaseClaim('priya', 'web', 'a.ts')).toBeNull();
  });

  it('distinguishes the same path in two projects', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts', { projectId: 'web' }), claim('a.ts', { projectId: 'api' })] }, T0);
    s.releaseClaim('priya', 'web', 'a.ts');
    expect(s.claims(T0).map((c) => c.projectId)).toEqual(['api']);
  });
});

describe('warn', () => {
  it('queues a notice and returns it on every heartbeat until the member goes', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    const w = s.warn('priya', 'please stop force-pushing main', 'Sam', T0);
    expect(w).toMatchObject({ message: 'please stop force-pushing main', from: 'Sam' });
    // Host-assigned, like every other timestamp on this plane.
    expect(w!.at).toBe(new Date(T0).toISOString());

    // Re-sent, not drained: a daemon that dies between receiving and printing
    // must not swallow the notice.
    expect(s.heartbeat(priya, { claims: [] }, T0 + 1000).warnings).toHaveLength(1);
    expect(s.heartbeat(priya, { claims: [] }, T0 + 2000).warnings).toHaveLength(1);
  });

  /*
   * Warning someone who is not connected must FAIL, not queue silently. An
   * owner told "sent" would believe the person had been told and move on.
   */
  it('refuses when the member is not connected', () => {
    const s = new PresenceStore();
    expect(s.warn('ghost', 'hello?', 'Sam', T0)).toBeNull();
  });

  it('refuses an empty message', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, {}, T0);
    expect(s.warn('priya', '   ', 'Sam', T0)).toBeNull();
  });

  it('survives the heartbeat that replaces the claim set', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('a.ts')] }, T0);
    s.warn('priya', 'careful', 'Sam', T0);
    const r = s.heartbeat(priya, { claims: [claim('z.ts')] }, T0 + 1000);
    expect(r.warnings).toHaveLength(1);
    expect(r.opened).toEqual(['z.ts']);
  });

  it('caps the queue and keeps the newest', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, {}, T0);
    for (let i = 0; i < 30; i++) s.warn('priya', `notice ${i}`, 'Sam', T0 + i);
    const queued = s.warningsFor('priya');
    expect(queued).toHaveLength(20);
    expect(queued[queued.length - 1].message).toBe('notice 29');
  });

  it('drops the queue when the member is removed', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, {}, T0);
    s.warn('priya', 'careful', 'Sam', T0);
    s.remove('priya');
    expect(s.warningsFor('priya')).toEqual([]);
  });
});

/**
 * The publish side of the cross-machine claim protocol. Two independent bugs
 * lived in the loop this replaces, and both are pinned here.
 */
describe('localClaims — shaping this machine\'s signals for a host', () => {
  const active = (slug: string, agent: string | null = null) =>
    ({ slug, agent, state: 'active' as const });

  it('publishes a task claim with its projectId and branch', () => {
    const out = localClaims(
      [{ path: 'src/auth.ts', holders: [active('fix-auth', 'claude')] }],
      [{ slug: 'fix-auth', projectId: 'proj-a', branch: 'baton/fix-auth' }],
      new Map(),
    );
    expect(out).toEqual([{ projectId: 'proj-a', relPath: 'src/auth.ts', agent: 'claude', branch: 'baton/fix-auth' }]);
  });

  it('scopes a co-* checkout holder, which carries no task at all', () => {
    // Before: projectId null -> matched every project on the receiving side.
    const out = localClaims(
      [{ path: 'src/index.ts', holders: [active('co-proj-a')] }],
      [],
      new Map([['co-proj-a', 'proj-a']]),
    );
    expect(out[0].projectId).toBe('proj-a');
  });

  it('publishes BOTH projects when a path collides across sub-projects', () => {
    // getSignals groups by path STRING alone, so a hub's proj-a and proj-b
    // src/index.ts arrive as ONE signal. Stopping at the first active holder
    // did not merely mis-scope proj-b's claim — it never sent it.
    const out = localClaims(
      [{ path: 'src/index.ts', holders: [active('co-proj-a'), active('co-proj-b')] }],
      [],
      new Map([['co-proj-a', 'proj-a'], ['co-proj-b', 'proj-b']]),
    );
    expect(out.map((c) => c.projectId).sort()).toEqual(['proj-a', 'proj-b']);
    expect(out).toHaveLength(2);
  });

  it('still emits ONE claim per (project, path) when two holders share both', () => {
    const out = localClaims(
      [{ path: 'src/index.ts', holders: [active('a'), active('b')] }],
      [{ slug: 'a', projectId: 'proj-a' }, { slug: 'b', projectId: 'proj-a' }],
      new Map(),
    );
    expect(out).toHaveLength(1);
  });

  it('never publishes a settled holder — committed or reverted is not a reason to wait', () => {
    const out = localClaims(
      [{ path: 'src/a.ts', holders: [{ slug: 'x', agent: null, state: 'settled' }] }],
      [{ slug: 'x', projectId: 'proj-a' }],
      new Map(),
    );
    expect(out).toEqual([]);
  });

  it('leaves projectId null when the holder genuinely belongs to no sub-project', () => {
    // A single repo, or a hub-root session. Null here is correct and the
    // receiving side deliberately treats it as "could be mine" rather than
    // suppressing on a guess.
    const out = localClaims(
      [{ path: 'src/a.ts', holders: [active('sess-hub')] }],
      [],
      new Map(),
    );
    expect(out[0].projectId).toBeNull();
  });
});
