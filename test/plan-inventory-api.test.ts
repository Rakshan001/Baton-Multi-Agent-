// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The plan inventory over HTTP.
 *
 * `planInventory` is unit-tested next door; what can only be checked out here
 * is the seam — the daemon serving the same answer, on a surface that has to be
 * reachable by someone who cannot write.
 *
 * Read-only ON PURPOSE, and the daemon under test is started without `--write`:
 * seeing what is waiting for your approval must not require write access, and a
 * GET that reads plan files and a trust store must write neither.
 *
 * Driven against a real daemon, like the pipeline and approval suites, because
 * a correct core behind a route that answers wrongly is the failure this
 * project keeps having.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
// Port comes from the kernel at spawn time — see test/helpers/free-port.ts.
let PORT_RO = 0;

/** A distinctive line of prose. If it reaches the client, the route is
 *  inlining plan markdown it was not asked for. */
const SECRET_PROSE = 'Ship-it-prose-that-must-not-travel';

const GOOD = `---
plan: auth
goal: Ship auth
---

## Phase 1 — Build

### auth-docs
**scope:** \`docs/**\`

${SECRET_PROSE}
`;

/** Parses, fails validation: two tasks over one file in one phase. */
const BROKEN = `---
plan: clash
goal: Two agents, one file
---

## Phase 1

### one
**scope:** \`src/same.ts\`

Edit it.

### two
**scope:** \`src/same.ts\`

Edit it too.
`;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT_RO}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const at = '2026-09-01T00:00:00.000Z';

describe.runIf(hasDist)('the plan inventory over HTTP', () => {
  let base = '';
  let root = '';
  let registry = '';
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-inventory-api-'));
    registry = join(base, 'registry');
    root = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', root]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: root });
    await execa('git', ['config', 'user.name', 't'], { cwd: root });
    // A machine-global core.hooksPath must not fire in a throwaway repo.
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });

    await mkdir(join(root, 'baton', 'plans'), { recursive: true });
    await writeFile(join(root, 'baton', 'plans', 'auth.md'), GOOD);
    await writeFile(join(root, 'baton', 'plans', 'clash.md'), BROKEN);
    // A plan that was applied: its rows are on the board. `running` and
    // `on disk` have to stay distinguishable in the answer.
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, '.baton', 'tasks.json'), JSON.stringify([
      { slug: 'auth-docs', task: 'Write the auth docs', branch: 'baton/auth-docs',
        worktreePath: join(root, '.baton/wt/auth-docs'), baseBranch: 'main', baseCommit: null,
        createdAt: at, planId: 'auth', phase: 1 },
    ]));

    PORT_RO = await freePort();
    const child = execa('node', [DIST_CLI, 'serve', '--port', String(PORT_RO)], {
      cwd: root, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: registry },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT_RO}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map((c) => c.catch(() => undefined)));
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('serves every plan on disk from a READ-ONLY daemon', async () => {
    const { status, body } = await api('/api/plans');
    expect(status).toBe(200);
    expect(body.dir).toBe('baton/plans');
    expect(body.plans.map((p: any) => p.id)).toEqual(['auth', 'clash']);
  });

  it('carries the approval state as data, and the command that fixes it', async () => {
    const { body } = await api('/api/plans');
    const auth = body.plans.find((p: any) => p.id === 'auth');
    expect(auth.goal).toBe('Ship auth');
    expect(auth.tasks).toBe(1);
    expect(auth.approval.state).toBe('unapproved');
    expect(auth.approval.reason).toMatch(/baton plan approve/);
    expect(auth.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps "on disk" and "running" distinguishable', async () => {
    const { body } = await api('/api/plans');
    const auth = body.plans.find((p: any) => p.id === 'auth');
    const clash = body.plans.find((p: any) => p.id === 'clash');
    expect(auth.applied).toBe(true);
    expect(auth.appliedTasks).toBe(1);
    // The blind spot this endpoint exists to close: on disk, no tasks, and
    // until now invisible everywhere in the dashboard.
    expect(clash.applied).toBe(false);
    expect(clash.appliedTasks).toBe(0);
  });

  it('lists a plan that fails validation, with its issues as text', async () => {
    const { body } = await api('/api/plans');
    const clash = body.plans.find((p: any) => p.id === 'clash');
    expect(clash.parses).toBe(false);
    expect(clash.issues.length).toBeGreaterThan(0);
    expect(clash.issues[0]).toHaveProperty('where');
    expect(clash.issues[0]).toHaveProperty('message');
  });

  it('never inlines the plan markdown', async () => {
    const { body } = await api('/api/plans');
    // The whole document is a separate, deliberate request
    // (GET /api/pipeline/plans/:id). A list must not ship every plan's body.
    expect(JSON.stringify(body)).not.toContain(SECRET_PROSE);
    for (const p of body.plans) expect(p.markdown).toBeUndefined();
  });

  it('answers for one plan when asked for one', async () => {
    const { status, body } = await api('/api/plans?plan=clash');
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => p.id)).toEqual(['clash']);
  });

  it('404s a plan that is not there — a name is not a plan', async () => {
    const { status } = await api('/api/plans?plan=nope');
    expect(status).toBe(404);
  });

  it('rejects an id that escapes the plans directory with 400', async () => {
    for (const bad of [
      '../../.baton/host', '..%2f..%2f.baton%2fhost', '..', '.env',
      'a/b', 'a%2Fb', '%2e%2e%2fhost', 'plan%00.md',
    ]) {
      const { status, body } = await api(`/api/plans?plan=${bad}`);
      expect(status, bad).toBe(400);
      expect(body.code, bad).toBe('bad-plan-id');
      // Refused by the grammar, before anything was joined into a path — so
      // there is nothing read to leak back.
      expect(body.plans, bad).toBeUndefined();
    }
  });

  it('reads a planted file no more than it lists it', async () => {
    // `baton/plans/.env.md` never leaves the directory, so containment has
    // nothing to object to — the charset is the only guard that stops it.
    await writeFile(join(root, 'baton', 'plans', '.env.md'), 'AWS_SECRET=hunter2\n');
    const { body } = await api('/api/plans');
    expect(body.plans.map((p: any) => p.id)).not.toContain('.env');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    await rm(join(root, 'baton', 'plans', '.env.md'));
  });

  it('has no side effect: a GET approves nothing and writes nothing', async () => {
    const before = (await readdir(join(root, '.baton'))).sort();
    const tasks = await readFile(join(root, '.baton', 'tasks.json'), 'utf-8');
    const plan = await readFile(join(root, 'baton', 'plans', 'auth.md'), 'utf-8');

    await api('/api/plans');
    await api('/api/plans?plan=auth');

    expect((await readdir(join(root, '.baton'))).sort()).toEqual(before);
    expect(await readFile(join(root, '.baton', 'tasks.json'), 'utf-8')).toBe(tasks);
    expect(await readFile(join(root, 'baton', 'plans', 'auth.md'), 'utf-8')).toBe(plan);
    // The one file a plan surface must never create by being looked at.
    expect(existsSync(join(root, '.baton', 'trusted-plans.json'))).toBe(false);
  });
});
