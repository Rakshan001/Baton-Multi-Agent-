/**
 * Concurrent writes to the registries (src/util/lock.ts).
 *
 * Every mutation of members.json / teams.json is load → mutate → save with
 * awaits in between, and the daemon serves concurrent requests. Before the
 * lock, two cycles could interleave and the second save silently erased the
 * first — and the erasure that made this worth a file of its own is a
 * REVOCATION: `markTokenUsed` fires on the revoked member's own next request,
 * exactly when an owner is acting on them, and its stale save put the token
 * back to work.
 *
 * The interleaving tests here fail against the unlocked code: `Promise.all`
 * starts every cycle before any of them reaches its save, which is precisely
 * the schedule that loses updates.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/util/lock.js';
import {
  addMember, cleanRegistry, loadMembers, markTokenUsed, revokeMember, setMemberTeam,
} from '../src/members.js';
import { MAX_TEAMS, addTeam, cleanTeams, loadTeams } from '../src/teams.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withLock', () => {
  it('serializes tasks on one key, in arrival order', async () => {
    const log: number[] = [];
    await Promise.all([
      withLock('k', async () => { await sleep(20); log.push(1); }),
      withLock('k', async () => { await sleep(5); log.push(2); }),
      withLock('k', async () => { log.push(3); }),
    ]);
    // Without the lock the shortest task finishes first; with it, arrival wins.
    expect(log).toEqual([1, 2, 3]);
  });

  it('does not serialize across different keys', async () => {
    // b resolves a gate that a is waiting on. If keys shared one queue this
    // would deadlock, and the test would time out.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    await Promise.all([
      withLock('a', () => gate),
      withLock('b', async () => { open(); }),
    ]);
  });

  it('a rejection releases the lock instead of wedging the queue', async () => {
    await expect(withLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withLock('k', async () => 'after')).resolves.toBe('after');
  });

  it('returns the task result and keeps read-modify-write atomic', async () => {
    let counter = 0;
    const bump = () => withLock('n', async () => {
      const seen = counter;
      await sleep(1); // the yield that lets an unserialized rival read the same value
      counter = seen + 1;
      return counter;
    });
    await Promise.all(Array.from({ length: 10 }, bump));
    expect(counter).toBe(10);
  });
});

describe('registry mutations under concurrency', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-races-'));
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('a revoke racing the member\'s own first request stays a revoke', async () => {
    await addMember(root, 'Owner'); // first member is always owner
    await addMember(root, 'Priya');
    // The owner revokes while Priya's first authenticated request is marking
    // her token used. Whichever order the lock settles on, revoked must win:
    // markTokenUsed skips revoked members, and revoke overwrites nothing else.
    await Promise.all([
      revokeMember(root, 'priya'),
      markTokenUsed(root, 'priya'),
    ]);
    const reg = await loadMembers(root);
    expect(reg.members.find((m) => m.id === 'priya')?.revokedAt).toBeTruthy();
  });

  it('concurrent team assignments all land', async () => {
    await addTeam(root, 'Core');
    await addMember(root, 'Owner');
    const names = Array.from({ length: 10 }, (_, i) => `Dev ${i}`);
    for (const n of names) await addMember(root, n);
    await Promise.all(names.map((n) => setMemberTeam(root, n, 'core')));
    const reg = await loadMembers(root);
    const inCore = reg.members.filter((m) => m.team === 'core');
    expect(inCore.length).toBe(names.length);
  });

  it('concurrent team creates all land', async () => {
    await Promise.all(['A Team', 'B Team', 'C Team', 'D Team', 'E Team'].map((n) => addTeam(root, n)));
    const teams = await loadTeams(root);
    expect(teams.map((t) => t.id).sort()).toEqual(['a-team', 'b-team', 'c-team', 'd-team', 'e-team']);
  });
});

describe('registry caps count entries kept, not rows scanned', () => {
  it('a duplicate team row does not consume a slot a real team needed', () => {
    // A duplicate first, then exactly MAX_TEAMS unique teams. The old
    // slice-then-validate dropped the last real team to keep the duplicate's
    // seat warm.
    const rows = [
      { id: 'team-0', name: 'dup of team-0' },
      ...Array.from({ length: MAX_TEAMS }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` })),
    ];
    const teams = cleanTeams({ version: 1, teams: rows });
    expect(teams.length).toBe(MAX_TEAMS);
    expect(teams.some((t) => t.id === `team-${MAX_TEAMS - 1}`)).toBe(true);
  });

  it('a malformed member row does not push a real credential past the cap', () => {
    const good = (i: number) => ({
      id: `member-${i}`, name: `M${i}`, role: 'member',
      tokenHash: 'a'.repeat(64), createdAt: new Date(0).toISOString(),
    });
    // One row with a garbage hash, then 100 valid members (MAX_MEMBERS = 100,
    // not exported — the count here is deliberately literal so a cap change
    // has to come re-read this file).
    const rows = [{ ...good(999), tokenHash: 'not-a-hash' }, ...Array.from({ length: 100 }, (_, i) => good(i))];
    const reg = cleanRegistry({ version: 1, members: rows });
    expect(reg.members.length).toBe(100);
    expect(reg.members.some((m) => m.id === 'member-99')).toBe(true);
  });
});
