// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeMembers, addMember, bearerFrom, cleanRegistry, EMPTY_REGISTRY, hasActiveMembers,
  hashToken, isExpiredInvite, loadMembers, markTokenUsed, MemberError, memberId, membersPath,
  mintToken, revokeMember, rotateMember, verifyToken, type MemberRegistry,
} from '../src/members.js';
import { canSeeWarnings, decideAccess, isHostProcessPath, isTerminalPath, requiresOwner } from '../src/access.js';
import { hostnameOf, isAllowedHostHeader, isLoopbackAddr } from '../src/util/origin.js';

/**
 * Until `--host`, the only access control was "the connection came from
 * 127.0.0.1". These tests pin the replacement: what a token is, that it is never
 * stored, that revocation bites immediately, and that a network connection can
 * never reach a terminal.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-members-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/* ---------------- tokens ---------------- */

describe('mintToken', () => {
  it('produces a prefixed 256-bit token', () => {
    const t = mintToken();
    expect(t).toMatch(/^baton_[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(seen.size).toBe(200);
  });
});

describe('bearerFrom', () => {
  it('reads a well-formed Authorization header', () => {
    expect(bearerFrom('Bearer baton_abc')).toBe('baton_abc');
    expect(bearerFrom('Bearer   baton_abc  ')).toBe('baton_abc');
  });

  /*
   * No cookie and no query-string fallback, deliberately: both put a live
   * credential somewhere it gets logged, cached, or sent in a Referer.
   */
  it('refuses anything that is not exactly a bearer header', () => {
    expect(bearerFrom(undefined)).toBe('');
    expect(bearerFrom('')).toBe('');
    expect(bearerFrom('Basic abc')).toBe('');
    expect(bearerFrom('baton_abc')).toBe('');
    expect(bearerFrom('Bearer')).toBe('');
    expect(bearerFrom('Bearer a b')).toBe('');
  });
});

describe('memberId', () => {
  it('slugs a display name and refuses one with nothing usable', () => {
    expect(memberId('Priya Sharma')).toBe('priya-sharma');
    expect(memberId('  ***  ')).toBe('');
  });
});

/* ---------------- registry ---------------- */

describe('addMember', () => {
  it('returns the token once and stores only its hash', async () => {
    const { member, token } = await addMember(root, 'Priya');
    expect(token).toMatch(/^baton_[0-9a-f]{64}$/);
    expect(member.tokenHash).toBe(hashToken(token));

    // the raw token must appear nowhere on disk
    const onDisk = await readFile(membersPath(root), 'utf-8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(member.tokenHash);
  });

  it('writes the registry 0600', async () => {
    await addMember(root, 'Priya');
    const mode = (await stat(membersPath(root))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // A registry with no owner could never manage itself again.
  it('makes the first member an owner regardless of what was asked', async () => {
    const { member } = await addMember(root, 'Priya', 'member');
    expect(member.role).toBe('owner');
    const second = await addMember(root, 'Sam');
    expect(second.member.role).toBe('member');
  });

  it('refuses a duplicate active id and an unusable name', async () => {
    await addMember(root, 'Priya');
    await expect(addMember(root, 'priya')).rejects.toBeInstanceOf(MemberError);
    await expect(addMember(root, '***')).rejects.toBeInstanceOf(MemberError);
  });
});

describe('verifyToken', () => {
  it('matches the right member and rejects a near-miss', async () => {
    const a = await addMember(root, 'Priya');
    const b = await addMember(root, 'Sam');
    const reg = await loadMembers(root);

    expect(verifyToken(reg, a.token)?.id).toBe('priya');
    expect(verifyToken(reg, b.token)?.id).toBe('sam');
    // one hex digit different
    const tampered = `${a.token.slice(0, -1)}${a.token.endsWith('0') ? '1' : '0'}`;
    expect(verifyToken(reg, tampered)).toBeNull();
  });

  it('rejects malformed tokens without touching the registry', () => {
    const reg = EMPTY_REGISTRY();
    expect(verifyToken(reg, '')).toBeNull();
    expect(verifyToken(reg, 'baton_short')).toBeNull();
    expect(verifyToken(reg, 'not-a-token')).toBeNull();
  });

  // Revocation must bite immediately — there is no session to invalidate.
  it('stops matching the moment a member is revoked', async () => {
    await addMember(root, 'Owner');
    const sam = await addMember(root, 'Sam');
    expect(verifyToken(await loadMembers(root), sam.token)?.id).toBe('sam');

    await revokeMember(root, 'sam');
    expect(verifyToken(await loadMembers(root), sam.token)).toBeNull();
  });
});

describe('revokeMember', () => {
  it('refuses to revoke the only owner — that is a lockout, not security', async () => {
    await addMember(root, 'Priya');
    await expect(revokeMember(root, 'priya')).rejects.toThrow(/only owner/);
  });

  it('allows revoking an owner once another exists', async () => {
    await addMember(root, 'Priya');
    await addMember(root, 'Sam', 'owner');
    const revoked = await revokeMember(root, 'priya');
    expect(revoked.revokedAt).toBeTruthy();
    expect(activeMembers(await loadMembers(root)).map((m) => m.id)).toEqual(['sam']);
  });

  it('reports an unknown member instead of silently succeeding', async () => {
    await expect(revokeMember(root, 'nobody')).rejects.toBeInstanceOf(MemberError);
  });
});

describe('loadMembers / cleanRegistry', () => {
  // Absent or corrupt must mean "nobody is authorized", never "everybody".
  it('treats an absent or corrupt registry as empty', async () => {
    expect(hasActiveMembers(await loadMembers(root))).toBe(false);
    await writeFile(membersPath(root), 'not json at all', 'utf-8');
    expect(hasActiveMembers(await loadMembers(root))).toBe(false);
  });

  it('drops entries whose hash could never match anything', () => {
    const reg = cleanRegistry({
      version: 1,
      members: [
        { id: 'ok', name: 'ok', role: 'owner', tokenHash: 'a'.repeat(64), createdAt: 'x' },
        { id: 'bad', name: 'bad', role: 'owner', tokenHash: 'nope', createdAt: 'x' },
        { id: '', name: 'noid', role: 'owner', tokenHash: 'b'.repeat(64), createdAt: 'x' },
      ],
    });
    expect(reg.members.map((m) => m.id)).toEqual(['ok']);
  });

  it('refuses a registry version it does not understand', () => {
    expect(cleanRegistry({ version: 99, members: [{ id: 'x' }] }).members).toHaveLength(0);
  });
});

/* ---------------- the boundary itself ---------------- */

describe('isLoopbackAddr', () => {
  it('recognises every local form node reports', () => {
    expect(isLoopbackAddr('127.0.0.1')).toBe(true);
    expect(isLoopbackAddr('::1')).toBe(true);
    expect(isLoopbackAddr('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddr('127.0.0.53')).toBe(true);
  });

  it('rejects network addresses and nonsense', () => {
    expect(isLoopbackAddr('192.168.1.20')).toBe(false);
    expect(isLoopbackAddr('10.0.0.5')).toBe(false);
    expect(isLoopbackAddr('100.71.2.3')).toBe(false); // tailscale range
    expect(isLoopbackAddr(undefined)).toBe(false);
    expect(isLoopbackAddr('')).toBe(false);
  });
});

describe('isAllowedHostHeader', () => {
  it('always allows loopback, with or without a port', () => {
    expect(isAllowedHostHeader('localhost:7077', [])).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1', [])).toBe(true);
  });

  /*
   * The rebinding hole `--host` could otherwise re-open: an attacker who points
   * evil.com at this daemon's address still arrives saying `Host: evil.com`.
   */
  it('allows only names the operator declared', () => {
    expect(isAllowedHostHeader('mac-mini.tail1234.ts.net:7077', ['mac-mini.tail1234.ts.net'])).toBe(true);
    expect(isAllowedHostHeader('evil.com', ['mac-mini.tail1234.ts.net'])).toBe(false);
    expect(isAllowedHostHeader('evil.com', [])).toBe(false);
    expect(isAllowedHostHeader(undefined, ['anything'])).toBe(false);
  });

  it('strips ports and IPv6 brackets consistently', () => {
    expect(hostnameOf('[::1]:7077')).toBe('::1');
    expect(hostnameOf('example.com:7077')).toBe('example.com');
    expect(hostnameOf('example.com')).toBe('example.com');
  });
});

describe('decideAccess', () => {
  const reg = (): MemberRegistry => EMPTY_REGISTRY();

  it('lets any local request through with no credential — unchanged behaviour', () => {
    for (const path of ['/api/tasks', '/api/terminals', '/index.html', '/api/tasks/x/terminal/input']) {
      const d = decideAccess({ remoteAddr: '127.0.0.1', path, authorization: undefined }, reg());
      expect(d.allow).toBe(true);
    }
  });

  it('401s a remote /api request with no token, and challenges', () => {
    const d = decideAccess({ remoteAddr: '192.168.1.9', path: '/api/tasks', authorization: undefined }, reg());
    expect(d).toMatchObject({ allow: false, status: 401, challenge: true });
  });

  it('401s a remote /api request whose token is not in the registry', async () => {
    await addMember(root, 'Priya');
    const d = decideAccess(
      { remoteAddr: '192.168.1.9', path: '/api/tasks', authorization: `Bearer ${mintToken()}` },
      await loadMembers(root),
    );
    expect(d.allow).toBe(false);
  });

  it('admits a remote request bearing a valid token', async () => {
    const { token } = await addMember(root, 'Priya');
    const d = decideAccess(
      { remoteAddr: '192.168.1.9', path: '/api/tasks', authorization: `Bearer ${token}` },
      await loadMembers(root),
    );
    expect(d).toMatchObject({ allow: true, local: false });
    expect(d.allow && d.member?.id).toBe('priya');
  });

  /*
   * A terminal is an interactive shell on the host. Exposing it is a decision
   * that must be taken on purpose, not inherited from turning on `--host` — so
   * a valid token does NOT buy access to one.
   */
  it('refuses terminals to a remote caller even WITH a valid token', async () => {
    const { token } = await addMember(root, 'Priya');
    const registry = await loadMembers(root);
    for (const path of ['/api/terminals', '/api/tasks/feat/terminal', '/api/tasks/feat/terminal/input', '/api/tasks/feat/terminal/stream']) {
      const d = decideAccess({ remoteAddr: '192.168.1.9', path, authorization: `Bearer ${token}` }, registry);
      expect(d).toMatchObject({ allow: false, status: 403 });
    }
  });

  it('serves static assets to a remote caller — they hold no repo data', () => {
    const d = decideAccess({ remoteAddr: '192.168.1.9', path: '/assets/index.js', authorization: undefined }, reg());
    expect(d.allow).toBe(true);
  });

  it('classifies terminal paths without catching lookalikes', () => {
    expect(isTerminalPath('/api/terminals')).toBe(true);
    expect(isTerminalPath('/api/tasks/x/terminal')).toBe(true);
    expect(isTerminalPath('/api/tasks/x/terminal/resize')).toBe(true);
    expect(isTerminalPath('/api/tasks/x/terminals-report')).toBe(false);
    expect(isTerminalPath('/api/tasks')).toBe(false);
  });

  it('refuses a remote member the right to START an agent on this machine', () => {
    /*
     * agent/start execas an agent CLI in the host's worktree with the host's
     * credentials and a caller-supplied prompt — the same capability rule 2
     * refuses for terminals, reached through a different door. It was
     * write-gated only, so any authenticated member of a `--host --write`
     * daemon could run one.
     *
     * The refusal lands BEFORE token verification, exactly as the terminal one
     * does: 403 (never allowed from here) rather than 401 (bring a credential),
     * because no credential makes this reachable remotely.
     */
    const path = '/api/tasks/feat/agent/start';
    const d = decideAccess({ remoteAddr: '192.168.1.9', path, authorization: 'Bearer baton_anything' }, reg());
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.status).toBe(403);

    // Locally it stays exactly as it was — this is the normal way to run Baton.
    expect(decideAccess({ remoteAddr: '127.0.0.1', path, authorization: undefined }, reg()).allow).toBe(true);
  });

  it('classifies host-process paths without catching lookalikes', () => {
    expect(isHostProcessPath('/api/tasks/x/agent/start')).toBe(true);
    expect(isHostProcessPath('/api/tasks/x/agent/stop')).toBe(false);   // ending a run is not starting one
    expect(isHostProcessPath('/api/tasks/x/agent/started')).toBe(false);
    expect(isHostProcessPath('/api/agents')).toBe(false);
  });
});

/**
 * `--behind-proxy`, and the hole it closes.
 *
 * Baton's own Share panel told you to run a Cloudflare tunnel with
 * `--url http://localhost:7077` and no `--host`. cloudflared then dials the
 * daemon over LOOPBACK, so every request that walked in off the public internet
 * arrived wearing 127.0.0.1 and rule 1 handed it owner rights: no member token,
 * plus terminals and agent launches — an interactive shell and arbitrary process
 * execution on the host, both of which rule 2 is supposed to make unreachable
 * from anywhere but this machine, forever. The member registry was not consulted
 * at all, so revoking a token changed nothing.
 */
describe('decideAccess behind a reverse proxy', () => {
  const proxied = (path: string, authorization?: string) =>
    ({ remoteAddr: '127.0.0.1', path, authorization, trustLoopback: false });

  it('demands a token from a loopback caller once a proxy can reach the port', async () => {
    const d = decideAccess(proxied('/api/tasks'), EMPTY_REGISTRY());
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.status).toBe(401);   // bring a credential
  });

  it('admits a proxied caller carrying a real token, as a member and NOT as local', async () => {
    const m = await addMember(root, 'Priya');
    const d = decideAccess(proxied('/api/tasks', `Bearer ${m.token}`), await loadMembers(root));
    expect(d.allow).toBe(true);
    // `local` is what gates terminals, agent launches and every owner control.
    // A member reaching us through the tunnel must never inherit it.
    expect(d.allow && d.local).toBe(false);
    expect(d.allow && d.member?.id).toBe('priya');
    expect(requiresOwner(d)).toBe(false);              // ...but Priya really is the owner
  });

  it('still refuses terminals and agent launches, token or not', async () => {
    const m = await addMember(root, 'Priya');
    const reg = await loadMembers(root);
    for (const path of ['/api/terminals', '/api/tasks/x/terminal', '/api/tasks/x/agent/start']) {
      const d = decideAccess(proxied(path, `Bearer ${m.token}`), reg);
      expect(d.allow).toBe(false);
      expect(d.allow === false && d.status).toBe(403);
    }
  });

  it('leaves the local-first default completely alone when the flag is absent', () => {
    // The flag is opt-in: absent means today's behaviour, byte for byte.
    const d = decideAccess({ remoteAddr: '127.0.0.1', path: '/api/tasks', authorization: undefined }, EMPTY_REGISTRY());
    expect(d.allow).toBe(true);
    expect(d.allow && d.local).toBe(true);
  });

  it('still serves the dashboard static assets, or the login page is unreachable', () => {
    // Non-/api paths carry no repo data, and a browser cannot put an
    // Authorization header on a navigation — gating them would leave a proxied
    // member staring at a 401 with no page to type a token into.
    expect(decideAccess(proxied('/assets/index.js'), EMPTY_REGISTRY()).allow).toBe(true);
  });
});

describe('requiresOwner', () => {
  it('never gates a local caller — they already have the shell', () => {
    const d = decideAccess({ remoteAddr: '127.0.0.1', path: '/api/members', authorization: undefined }, EMPTY_REGISTRY());
    expect(requiresOwner(d)).toBe(false);
  });

  it('gates a remote non-owner and admits a remote owner', async () => {
    const owner = await addMember(root, 'Priya');          // first → owner
    const plain = await addMember(root, 'Sam');            // → member
    const registry = await loadMembers(root);
    const asOwner = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/members', authorization: `Bearer ${owner.token}` }, registry);
    const asMember = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/members', authorization: `Bearer ${plain.token}` }, registry);
    expect(requiresOwner(asOwner)).toBe(false);
    expect(requiresOwner(asMember)).toBe(true);
  });

  it('gates a denied decision', () => {
    const d = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/x', authorization: undefined }, EMPTY_REGISTRY());
    expect(requiresOwner(d)).toBe(true);
  });
});

describe('canSeeWarnings', () => {
  /*
   * Warnings are owner↔member correspondence. The roster row is public to the
   * hub; the reprimand text on it is not — a member reads their own and nobody
   * else's, or the warn button becomes a broadcast.
   */
  it('owner (loopback or remote owner token) sees every member\'s warnings', async () => {
    const local = decideAccess({ remoteAddr: '127.0.0.1', path: '/api/members', authorization: undefined }, EMPTY_REGISTRY());
    expect(canSeeWarnings(local, 'anyone')).toBe(true);

    const owner = await addMember(root, 'Priya');          // first → owner
    await addMember(root, 'Sam');
    const registry = await loadMembers(root);
    const asOwner = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/members', authorization: `Bearer ${owner.token}` }, registry);
    expect(canSeeWarnings(asOwner, 'sam')).toBe(true);
  });

  it('a plain member sees exactly their own row\'s warnings', async () => {
    await addMember(root, 'Priya');
    const plain = await addMember(root, 'Sam');
    const registry = await loadMembers(root);
    const asMember = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/members', authorization: `Bearer ${plain.token}` }, registry);
    expect(canSeeWarnings(asMember, 'sam')).toBe(true);
    expect(canSeeWarnings(asMember, 'priya')).toBe(false);
    expect(canSeeWarnings(asMember, 'local')).toBe(false);
  });

  it('a denied decision sees none', () => {
    const d = decideAccess({ remoteAddr: '10.0.0.2', path: '/api/members', authorization: undefined }, EMPTY_REGISTRY());
    expect(canSeeWarnings(d, 'sam')).toBe(false);
  });
});

/**
 * Invites (Phase 7). An invite is a member whose token expires if it is never
 * redeemed — it travels through whatever channel someone happens to use, so an
 * un-redeemed one should stop being a key eventually.
 */
describe('invite expiry', () => {
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-invite-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('accepts a fresh invite and refuses it once the deadline passes', async () => {
    const { token } = await addMember(dir, 'Priya', 'member', { expiresInMs: 3600_000 });
    const reg = await loadMembers(dir);
    expect(verifyToken(reg, token)).toMatchObject({ id: 'priya' });
    expect(verifyToken(reg, token, Date.now() + 2 * 3600_000)).toBeNull();
  });

  /*
   * The property that keeps expiry a safeguard rather than a hazard: once
   * someone is actually working, their credential must not die under them.
   */
  it('stops applying the deadline once the token has been used', async () => {
    const { token } = await addMember(dir, 'Priya', 'member', { expiresInMs: 3600_000 });
    expect(await markTokenUsed(dir, 'priya')).toBe(true);
    const reg = await loadMembers(dir);
    expect(verifyToken(reg, token, Date.now() + 999 * 3600_000)).toMatchObject({ id: 'priya' });
    // Idempotent — the server calls this opportunistically on every request.
    expect(await markTokenUsed(dir, 'priya')).toBe(false);
  });

  it('leaves a member with no deadline alone', async () => {
    const { token } = await addMember(dir, 'Priya');
    const reg = await loadMembers(dir);
    expect(verifyToken(reg, token, Date.now() + 999 * 3600_000)).toMatchObject({ id: 'priya' });
  });

  it('survives a save/load round trip', async () => {
    await addMember(dir, 'Priya', 'member', { expiresInMs: 3600_000 });
    const m = (await loadMembers(dir)).members[0];
    expect(m.expiresAt).toBeTruthy();
    expect(isExpiredInvite(m, Date.parse(m.expiresAt!) + 1000)).toBe(true);
    expect(isExpiredInvite(m, Date.parse(m.expiresAt!) - 1000)).toBe(false);
  });
});

describe('rotateMember', () => {
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-rotate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /*
   * A REPLACE, never an addition. Two live tokens for one identity would make
   * revoking the leaked one guesswork.
   */
  it('kills the previous token the moment a new one exists', async () => {
    const first = await addMember(dir, 'Priya');
    const second = await rotateMember(dir, 'priya');
    expect(second.token).not.toBe(first.token);
    const reg = await loadMembers(dir);
    expect(verifyToken(reg, first.token)).toBeNull();
    expect(verifyToken(reg, second.token)).toMatchObject({ id: 'priya' });
  });

  it('makes the rotated token an un-redeemed invite again', async () => {
    await addMember(dir, 'Priya');
    await markTokenUsed(dir, 'priya');
    const { token } = await rotateMember(dir, 'priya', { expiresInMs: 3600_000 });
    const reg = await loadMembers(dir);
    expect(reg.members[0].firstUsedAt).toBeUndefined();
    expect(verifyToken(reg, token, Date.now() + 2 * 3600_000)).toBeNull();
  });

  it('keeps role and identity — it is a new key, not a new person', async () => {
    await addMember(dir, 'Priya'); // first member is owner
    const { member } = await rotateMember(dir, 'priya');
    expect(member).toMatchObject({ id: 'priya', role: 'owner' });
  });

  it('refuses an unknown or revoked member', async () => {
    await addMember(dir, 'Priya');
    await addMember(dir, 'Sam');
    await revokeMember(dir, 'sam');
    await expect(rotateMember(dir, 'sam')).rejects.toBeInstanceOf(MemberError);
    await expect(rotateMember(dir, 'nobody')).rejects.toBeInstanceOf(MemberError);
  });
});
