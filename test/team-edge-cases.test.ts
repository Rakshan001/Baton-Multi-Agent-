/**
 * The collaboration plane's edge-case matrix, as executable checks.
 *
 * Each case here is one a real team hits and that would otherwise be discovered
 * the expensive way — two agents colliding, a member silently locked out, a
 * revoked contractor still showing as holding a file. The matrix itself lives in
 * the plan; this file is the half of it that can be proven rather than asserted.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresenceStore, PRESENCE_TTL_MS } from '../src/federation.js';
import {
  addMember, loadMembers, markTokenUsed, memberId, membersPath, revokeMember, rotateMember,
  verifyToken,
} from '../src/members.js';
import { decideAccess, requiresOwner } from '../src/access.js';
import { lanAddresses } from '../src/reachability.js';

const T0 = Date.parse('2026-07-30T12:00:00.000Z');
const priya = { id: 'priya', name: 'Priya' };
const sam = { id: 'sam', name: 'Sam' };
const claim = (relPath: string, over: Record<string, unknown> = {}) =>
  ({ relPath, projectId: null, agent: 'claude', branch: 'main', ...over });

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-edge-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ */

describe('E4 — a member goes offline and keeps working', () => {
  /*
   * Losing the tunnel must not lose work or corrupt the shared picture. Truth
   * lives in git; the live plane is a view that rebuilds itself.
   */
  it('drops them on TTL, then restores everything from one reconnect heartbeat', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts'), claim('src/b.ts')] }, T0);
    expect(s.claims(T0)).toHaveLength(2);

    // Tunnel dies. No goodbye is ever sent — absence is the only signal.
    const late = T0 + PRESENCE_TTL_MS + 1000;
    expect(s.presence(late)).toHaveLength(0);
    expect(s.claims(late)).toHaveLength(0);

    // They were editing the whole time; one heartbeat restores the picture.
    s.heartbeat(priya, { claims: [claim('src/a.ts'), claim('src/b.ts')] }, late + 1000);
    expect(s.claims(late + 1000).map((c) => c.relPath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  /*
   * And the conflict that built up while they were away has to surface on
   * reconnect, not be swallowed because the "opened" moment passed unobserved.
   */
  it('reports a conflict that formed while they were disconnected', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/shared.ts')] }, T0);

    const late = T0 + PRESENCE_TTL_MS + 1000;
    s.heartbeat(sam, { claims: [claim('src/shared.ts')] }, late); // Priya has aged out
    expect(s.overlapsFor('sam', late)).toHaveLength(0);

    const back = s.heartbeat(priya, { claims: [claim('src/shared.ts')] }, late + 1000);
    expect(back.overlaps).toHaveLength(1);
    expect(back.overlaps[0]).toMatchObject({ relPath: 'src/shared.ts', sameBranch: true });
  });
});

describe('E11 — two members, one display name', () => {
  it('keeps them distinct by id when the names differ only in punctuation', async () => {
    await addMember(dir, 'Sam Okafor');
    await addMember(dir, 'Sam O.');
    const ids = (await loadMembers(dir)).members.map((m) => m.id);
    expect(ids).toEqual(['sam-okafor', 'sam-o']);
  });

  /*
   * When two names DO collide into one id, the second is refused rather than
   * silently overwriting or shadowing the first. Two people sharing one
   * identity would make every attribution and every revocation ambiguous.
   */
  it('refuses a second member whose name slugs onto an existing id', async () => {
    await addMember(dir, 'Sam Okafor');
    expect(memberId('sam okafor!!')).toBe('sam-okafor');
    await expect(addMember(dir, 'sam okafor!!')).rejects.toThrow(/already exists/);
  });
});

describe('E8 / E24 — a leaked token', () => {
  it('rotation kills the old token instantly, mid-session or not', async () => {
    const first = await addMember(dir, 'Priya');
    await markTokenUsed(dir, 'priya'); // they are actively working
    const second = await rotateMember(dir, 'priya');

    const reg = await loadMembers(dir);
    // The next request with the leaked token is refused — there is no session
    // to expire and no grace period to wait out.
    expect(verifyToken(reg, first.token)).toBeNull();
    expect(verifyToken(reg, second.token)).toMatchObject({ id: 'priya' });
  });

  it('revocation bites on the very next request', async () => {
    await addMember(dir, 'Owner');
    const { token } = await addMember(dir, 'Contractor');
    expect(verifyToken(await loadMembers(dir), token)).toMatchObject({ id: 'contractor' });
    await revokeMember(dir, 'contractor');
    expect(verifyToken(await loadMembers(dir), token)).toBeNull();
  });
});

describe('E19 — an invite that is never redeemed', () => {
  it('stops authenticating at the access boundary once it expires', async () => {
    const { token } = await addMember(dir, 'Priya', 'member', { expiresInMs: 3600_000 });
    const reg = await loadMembers(dir);
    const req = { remoteAddr: '192.168.1.9', path: '/api/workspace', authorization: `Bearer ${token}` };

    // Fresh: allowed, so `baton join` can fetch the layout it needs.
    expect(decideAccess(req, reg).allow).toBe(true);

    // Expired: the whole join flow is refused, not just some of it.
    const past = { ...reg, members: reg.members.map((m) => ({ ...m, expiresAt: new Date(Date.now() - 1000).toISOString() })) };
    const denied = decideAccess(req, past);
    expect(denied.allow).toBe(false);
    expect(denied.allow === false && denied.status).toBe(401);
  });

  it('a REDEEMED token keeps working past the same deadline', async () => {
    const { token } = await addMember(dir, 'Priya', 'member', { expiresInMs: 1 });
    await markTokenUsed(dir, 'priya');
    const reg = await loadMembers(dir);
    expect(decideAccess(
      { remoteAddr: '192.168.1.9', path: '/api/status', authorization: `Bearer ${token}` },
      reg,
    ).allow).toBe(true);
  });
});

describe('E6 / E7 — removing someone who is causing damage', () => {
  it('clears their live claims so nobody keeps routing around a ghost', () => {
    const s = new PresenceStore();
    s.heartbeat(priya, { claims: [claim('src/a.ts')] }, T0);
    s.heartbeat(sam, { claims: [claim('src/b.ts')] }, T0);
    // What the revoke endpoint does after writing the registry.
    s.remove('sam');
    expect(s.claims(T0).map((c) => c.memberId)).toEqual(['priya']);
  });

  /*
   * The thing removal CANNOT do. Pinned as a test so nobody later "fixes" the
   * dialog copy into a promise the product cannot keep.
   */
  it('leaves the registry tombstone, because attribution has to outlive access', async () => {
    await addMember(dir, 'Owner');
    await addMember(dir, 'Contractor');
    await revokeMember(dir, 'contractor');
    const m = (await loadMembers(dir)).members.find((x) => x.id === 'contractor');
    expect(m?.revokedAt).toBeTruthy();
    expect(m).toBeTruthy(); // not deleted — the audit trail survives
  });
});

describe('E17 — the hub always keeps an owner', () => {
  it('refuses to revoke the last one, however it is asked', async () => {
    await addMember(dir, 'Owner');
    await addMember(dir, 'Member');
    await expect(revokeMember(dir, 'owner')).rejects.toThrow(/only owner/);
    // …and the refusal is not bypassable by removing everyone else first.
    await revokeMember(dir, 'member');
    await expect(revokeMember(dir, 'owner')).rejects.toThrow(/only owner/);
  });

  it('a member is never treated as an owner by the gate', async () => {
    await addMember(dir, 'Owner');
    const { token } = await addMember(dir, 'Member');
    const decision = decideAccess(
      { remoteAddr: '192.168.1.9', path: '/api/members/owner/revoke', authorization: `Bearer ${token}` },
      await loadMembers(dir),
    );
    expect(decision.allow).toBe(true);
    expect(requiresOwner(decision)).toBe(true); // → the endpoint 403s
  });
});

describe('corrupt or hostile members.json', () => {
  /*
   * The file is 0600 but it is still a file on disk. Nothing in it may be able
   * to turn into access it should not grant.
   */
  it('treats an unreadable registry as "nobody is authorized", never as open', async () => {
    await addMember(dir, 'Owner');
    await writeFile(membersPath(dir), 'not json at all', 'utf-8');
    const reg = await loadMembers(dir);
    expect(reg.members).toEqual([]);
    expect(decideAccess(
      { remoteAddr: '192.168.1.9', path: '/api/status', authorization: 'Bearer baton_' + 'a'.repeat(64) },
      reg,
    ).allow).toBe(false);
  });

  it('drops an entry with a malformed hash rather than letting it linger', async () => {
    await addMember(dir, 'Owner');
    const raw = JSON.parse(await readFile(membersPath(dir), 'utf-8'));
    raw.members.push({ id: 'ghost', name: 'Ghost', role: 'owner', tokenHash: 'nonsense', createdAt: 'x' });
    await writeFile(membersPath(dir), JSON.stringify(raw), 'utf-8');
    expect((await loadMembers(dir)).members.map((m) => m.id)).toEqual(['owner']);
  });

  it('never lets a stored role of nonsense become owner', async () => {
    await addMember(dir, 'Owner');
    const raw = JSON.parse(await readFile(membersPath(dir), 'utf-8'));
    raw.members[0].role = 'superuser';
    await writeFile(membersPath(dir), JSON.stringify(raw), 'utf-8');
    expect((await loadMembers(dir)).members[0].role).toBe('member');
  });
});

describe('E23 — reachability never reports loopback as shareable', () => {
  it('finds only real, non-loopback addresses', () => {
    // Whatever this machine has, none of it may be a loopback address — that is
    // the failure the Share panel exists to catch.
    for (const a of lanAddresses()) {
      expect(a).not.toMatch(/^127\./);
      expect(a).not.toBe('::1');
    }
  });
});
