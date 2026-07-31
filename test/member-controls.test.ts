/**
 * Owner controls over HTTP — the dashboard's warn / disconnect / remove /
 * clear-claim buttons, end to end against a real daemon.
 *
 * These run over loopback, which `decideAccess` treats as owner (someone with
 * shell access to the host has nothing left to be protected from). The
 * non-owner refusal itself is a property of `requiresOwner`, unit-tested in
 * test/members.test.ts, and the endpoints below consult exactly that function —
 * so what is pinned HERE is the behaviour on the allowed path: that each action
 * does what its label claims, and that the ones which cannot do what they claim
 * say so instead of reporting success.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { createHash } from 'node:crypto';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT = 7396;
const BASE = `http://127.0.0.1:${PORT}`;

interface Json { status: number; body: any }

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (path: string, body?: unknown): Promise<Json> =>
  api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** One heartbeat as `local` — the identity a loopback caller gets. */
const beat = (claims: unknown[] = []): Promise<Json> =>
  post('/api/presence/heartbeat', { device: 'test-box', sessions: 1, claims });

describe.runIf(hasDist)('owner controls', () => {
  let dir = '';
  let child: ResultPromise | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-owner-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Priya'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Sam'], { cwd: dir });

    child = execa('node', [DIST_CLI, 'serve', '--write', '--port', String(PORT)], { cwd: dir, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('GET /api/members', () => {
    it('returns the roster without ever exposing a token hash', async () => {
      const { status, body } = await api('/api/members');
      expect(status).toBe(200);
      const ids = body.members.map((m: any) => m.id);
      expect(ids).toContain('priya');
      expect(ids).toContain('sam');
      expect(JSON.stringify(body)).not.toMatch(/tokenHash/);
      // Priya was added first, so she is owner regardless of what was asked for.
      expect(body.members.find((m: any) => m.id === 'priya').role).toBe('owner');
    });

    it('tells a loopback viewer it may act, and says why', async () => {
      const { body } = await api('/api/members');
      expect(body.viewer).toMatchObject({ local: true, isOwner: true, memberId: null });
    });

    it('shows a registered member offline until they heartbeat', async () => {
      const { body } = await api('/api/members');
      expect(body.members.find((m: any) => m.id === 'priya').online).toBe(false);
    });

    /*
     * A loopback heartbeat registers as `local`, which is not in members.json.
     * Showing it as an unregistered row beats dropping it: those claims are
     * real and appear in the who's-editing view either way.
     */
    it('includes an unregistered live member rather than hiding its claims', async () => {
      await beat([{ projectId: null, relPath: 'src/a.ts', agent: 'claude', branch: 'main' }]);
      const { body } = await api('/api/members');
      const local = body.members.find((m: any) => m.id === 'local');
      expect(local).toMatchObject({ registered: false, online: true, claims: 1 });
      expect(body.claims.map((c: any) => c.relPath)).toContain('src/a.ts');
    });
  });

  describe('warn', () => {
    it('refuses to claim delivery to someone who is not connected', async () => {
      const { status, body } = await post('/api/members/priya/warn', { message: 'careful' });
      expect(status).toBe(409);
      expect(body.error).toMatch(/not connected/);
    });

    it('requires a message', async () => {
      await beat();
      const { status, body } = await post('/api/members/local/warn', { message: '  ' });
      expect(status).toBe(400);
      expect(body.error).toMatch(/needs a message/);
    });

    it('delivers on the next heartbeat and keeps re-sending it', async () => {
      await beat();
      const sent = await post('/api/members/local/warn', { message: 'stop touching src/db.ts' });
      expect(sent.status).toBe(200);
      expect(sent.body.warning.message).toBe('stop touching src/db.ts');

      const first = await beat();
      expect(first.body.warnings.map((w: any) => w.message)).toContain('stop touching src/db.ts');
      // Re-sent, not drained — the reader de-dupes by id.
      const second = await beat();
      expect(second.body.warnings).toHaveLength(first.body.warnings.length);
      expect(second.body.warnings[0].id).toBe(first.body.warnings[0].id);
    });

    it('shows the owner what was sent', async () => {
      const { body } = await api('/api/members');
      const local = body.members.find((m: any) => m.id === 'local');
      expect(local.warnings.length).toBeGreaterThan(0);
      expect(local.warnings[0].message).toBe('stop touching src/db.ts');
    });
  });

  describe('claim release', () => {
    it('names the miss instead of reporting a clear that did not happen', async () => {
      await beat([{ projectId: null, relPath: 'src/a.ts', agent: 'claude', branch: 'main' }]);
      const { status, body } = await post('/api/claims/release', { memberId: 'local', relPath: 'src/nope.ts' });
      expect(status).toBe(404);
      expect(body.error).toMatch(/src\/nope\.ts/);
    });

    it('clears a live claim and is honest that it may come back', async () => {
      await beat([{ projectId: null, relPath: 'src/a.ts', agent: 'claude', branch: 'main' }]);
      const { status, body } = await post('/api/claims/release', { memberId: 'local', relPath: 'src/a.ts' });
      expect(status).toBe(200);
      expect(body.cleared.relPath).toBe('src/a.ts');
      expect(body.note).toMatch(/re-states it/);
      expect((await api('/api/presence')).body.claims).toHaveLength(0);
    });

    it('rejects a request missing either half of the identity', async () => {
      expect((await post('/api/claims/release', { memberId: 'local' })).status).toBe(400);
      expect((await post('/api/claims/release', { relPath: 'a.ts' })).status).toBe(400);
    });
  });

  describe('disconnect', () => {
    it('drops them from the live view and says the token still works', async () => {
      await beat([{ projectId: null, relPath: 'src/a.ts', agent: 'claude', branch: 'main' }]);
      const { status, body } = await post('/api/members/local/disconnect');
      expect(status).toBe(200);
      expect(body.dropped).toBe(true);
      expect(body.note).toMatch(/token still works/);
      expect((await api('/api/presence')).body.members).toHaveLength(0);

      // Soft, as advertised: the next heartbeat brings them straight back.
      await beat();
      expect((await api('/api/presence')).body.members).toHaveLength(1);
    });

    it('reports plainly when there was nobody to disconnect', async () => {
      const { status, body } = await post('/api/members/priya/disconnect');
      expect(status).toBe(200);
      expect(body.dropped).toBe(false);
      expect(body.note).toMatch(/not connected/);
    });
  });

  describe('revoke', () => {
    it('refuses to strand the hub without an owner', async () => {
      const { status, body } = await post('/api/members/priya/revoke');
      expect(status).toBe(409);
      expect(body.error).toMatch(/only owner/);
    });

    it('revokes a member and states plainly what revocation cannot undo', async () => {
      const { status, body } = await post('/api/members/sam/revoke');
      expect(status).toBe(200);
      expect(body.member.id).toBe('sam');
      expect(body.note).toMatch(/stays on their machine/);

      const roster = await api('/api/members');
      expect(roster.body.members.find((m: any) => m.id === 'sam').revokedAt).toBeTruthy();
    });

    it('404s an unknown member rather than inventing one', async () => {
      const { status } = await post('/api/members/nobody/revoke');
      expect(status).toBe(409); // MemberError: no active member
    });
  });
});

/**
 * The read-only daemon. Every owner control writes something — members.json for
 * revoke, the shared view for the others — so all of them are refused, and the
 * refusal points at the CLI, which still works when the dashboard cannot.
 */
describe.runIf(hasDist)('owner controls on a read-only daemon', () => {
  const RO_PORT = 7397;
  const RO = `http://127.0.0.1:${RO_PORT}`;
  let dir = '';
  let child: ResultPromise | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-owner-ro-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Priya'], { cwd: dir });

    child = execa('node', [DIST_CLI, 'serve', '--port', String(RO_PORT)], { cwd: dir, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${RO}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses every control and points at the CLI', async () => {
    for (const path of ['/api/members/priya/warn', '/api/members/priya/disconnect', '/api/members/priya/revoke']) {
      const res = await fetch(`${RO}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status, path).toBe(403);
      expect((await res.json()).error, path).toBe('read-only');
    }
  });

  it('still serves the roster — reading who is here is not a write', async () => {
    const res = await fetch(`${RO}/api/members`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
    expect((await res.json()).members.map((m: any) => m.id)).toContain('priya');
  });
});

/**
 * The invite flow end to end: mint on the host, fetch the workspace layout with
 * the token, and land the host link — the "one copied command in an empty
 * folder" path, minus the actual `git clone` (covered in test/workspace.test.ts).
 */
describe.runIf(hasDist)('invites', () => {
  const INV_PORT = 7398;
  const INV = `http://127.0.0.1:${INV_PORT}`;
  let dir = '';
  let child: ResultPromise | null = null;

  const req = async (path: string, init?: RequestInit): Promise<Json> => {
    const res = await fetch(`${INV}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      ...init,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-invite-e2e-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    // A remote so the repo is describable in a manifest at all.
    await execa('git', ['remote', 'add', 'origin', 'https://example.com/acme/hub.git'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Owner'], { cwd: dir });

    child = execa('node', [DIST_CLI, 'serve', '--write', '--port', String(INV_PORT)], { cwd: dir, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${INV}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('mints a token, a ready-to-paste command, and a deadline', async () => {
    const { status, body } = await req('/api/members', { method: 'POST', body: JSON.stringify({ name: 'Priya' }) });
    expect(status).toBe(200);
    expect(body.token).toMatch(/^baton_[0-9a-f]{64}$/);
    expect(body.command).toContain(`--token ${body.token}`);
    expect(body.command).toMatch(/^npx baton join http/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    // The warning rides the response, so any client has it without inventing one.
    expect(body.note).toMatch(/private channel/);
  });

  it('refuses a duplicate name rather than silently issuing a second key', async () => {
    const { status, body } = await req('/api/members', { method: 'POST', body: JSON.stringify({ name: 'Priya' }) });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/);
  });

  it('requires a name', async () => {
    expect((await req('/api/members', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('serves the workspace layout the join command needs', async () => {
    const { status, body } = await req('/api/workspace');
    expect(status).toBe(200);
    expect(body.manifest.projects[0].remote).toBe('https://example.com/acme/hub.git');
  });

  it('rotate replaces the token — the old one is dead, not merely superseded', async () => {
    const first = await req('/api/members', { method: 'POST', body: JSON.stringify({ name: 'Sam' }) });
    const second = await req('/api/members/sam/rotate', { method: 'POST' });
    expect(second.status).toBe(200);
    expect(second.body.token).not.toBe(first.body.token);
    expect(second.body.note).toMatch(/stopped working/);

    // Proven at the auth boundary, not just in the response text.
    const reg = JSON.parse(await readFile(join(dir, '.baton', 'members.json'), 'utf-8'));
    const sam = reg.members.find((m: any) => m.id === 'sam');
    expect(sam.tokenHash).toBe(createHash('sha256').update(second.body.token, 'utf-8').digest('hex'));
  });

  it('shows an un-redeemed invite on the roster as pending, with its deadline', async () => {
    const { body } = await req('/api/members');
    const priya = body.members.find((m: any) => m.id === 'priya');
    expect(priya.expiresAt).toBeTruthy();
    expect(priya.firstUsedAt).toBeUndefined();
  });
});
