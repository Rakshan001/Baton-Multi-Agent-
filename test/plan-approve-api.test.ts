// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P10's daemon half — approving and dispatching a plan over HTTP.
 *
 * A phone reaches these through Orca's relay, which forwards from the desktop,
 * so from Baton's side the caller is loopback. What has to hold over the wire
 * is the same gate `baton plan approve` enforces locally: approval is recorded
 * against the plan's exact bytes, and the caller has to say which bytes it read.
 *
 * Driven against real daemons, like the pipeline suite, because the thing being
 * tested is the seam — a correct core behind a route that answers wrongly is
 * the failure this project keeps having.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { planDigest } from '../src/plan-trust.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT_RW = 7441;
const PORT_RO = 7442;

const PLAN = `---
plan: auth
goal: Ship auth
---

## Phase 1

### auth-docs @antigravity
**scope:** \`docs/**\`

Write the auth docs.
`;

async function api(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (port: number, path: string, body: unknown) =>
  api(port, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function makeRepo(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  await mkdir(join(dir, 'baton', 'plans'), { recursive: true });
  await writeFile(join(dir, 'baton', 'plans', 'auth.md'), PLAN);
  await execa('node', [DIST_CLI, 'plan', 'apply', 'auth'], { cwd: dir, reject: false });
  return dir;
}

describe.runIf(hasDist)('plan approval over HTTP', () => {
  let base = '';
  let rw = '';
  let registry = '';
  const children: ResultPromise[] = [];
  const digest = planDigest(PLAN);

  const spawnDaemon = async (cwd: string, port: number, write: boolean): Promise<void> => {
    const child = execa('node', [DIST_CLI, 'serve', ...(write ? ['--write'] : []), '--port', String(port)], {
      cwd, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: registry },
    });
    children.push(child);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-approve-'));
    registry = join(base, 'registry');
    const [a, ro] = await Promise.all([makeRepo(base, 'repo-rw'), makeRepo(base, 'repo-ro')]);
    rw = a;
    await spawnDaemon(a, PORT_RW, true);
    await spawnDaemon(ro, PORT_RO, false);
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c.catch(() => undefined)));
    await rm(base, { recursive: true, force: true });
  });

  describe('GET /api/pipeline/plans', () => {
    it('lists the plans on disk with their approval state', async () => {
      const { status, body } = await api(PORT_RW, '/api/pipeline/plans');
      expect(status).toBe(200);
      expect(body.plans).toHaveLength(1);
      expect(body.plans[0]).toMatchObject({ id: 'auth', approved: false });
    });
  });

  describe('GET /api/pipeline/plans/:id', () => {
    it('always carries the digest, because an approval cannot be made without one', async () => {
      const { status, body } = await api(PORT_RW, '/api/pipeline/plans/auth');
      expect(status).toBe(200);
      expect(body.sha256).toBe(digest);
      expect(body.approved).toBe(false);
      expect(body.markdown).toContain('auth-docs');   // the dashboard's field, untouched
    });

    it('resolves the decision only when asked, and shows refusals as well as launches', async () => {
      // Resolving probes the executor and reads the whole board. The dashboard
      // reads this route just to render markdown, so it must not pay for that.
      const plain = await api(PORT_RW, '/api/pipeline/plans/auth');
      expect(plain.body.refusals).toBeUndefined();

      const { status, body } = await api(PORT_RW, '/api/pipeline/plans/auth?resolve=1');
      expect(status).toBe(200);
      // antigravity has no local launcher, so this is a refusal, not a launch —
      // and the phone must be shown that rather than an empty list.
      //
      // Which refusal code depends on the machine, and both are correct: a dev
      // box with antigravity present reports `no-mode` (detected, but Baton
      // won't guess its spawn args), a CI runner without it reports
      // `not-installed`. Asserting one of them made this test pass locally and
      // fail on every runner. What the route actually promises is that the task
      // is refused rather than silently launched under a different agent.
      expect(body.refusals[0].slug).toBe('auth-docs');
      expect(['no-mode', 'not-installed']).toContain(body.refusals[0].code);
      expect(body.launches).toEqual([]);
    });

    it('refuses a plan id that tries to leave the plans directory', async () => {
      const { status } = await api(PORT_RW, '/api/pipeline/plans/..%2F..%2FLEAKME');
      expect(status).toBeGreaterThanOrEqual(400);
    });

    it('404s a plan that does not exist', async () => {
      expect((await api(PORT_RW, '/api/pipeline/plans/nope')).status).toBe(404);
    });
  });

  describe('POST approve — P10-E1, E2, E3', () => {
    it('refuses a digest that is not the plan on disk', async () => {
      // The phone rendered something else, or the plan changed under it. Either
      // way approving it would vouch for bytes nobody read.
      const r = await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: 'a1'.repeat(32) });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('digest-mismatch');
      expect(r.body.sha256).toBe(digest);
    });

    it('refuses when no digest is sent at all', async () => {
      // Omitting it must not read as "approve whatever is there".
      expect((await post(PORT_RW, '/api/pipeline/plans/auth/approve', {})).status).toBe(400);
    });

    it('records the approval when the digest matches', async () => {
      const r = await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: digest });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, planId: 'auth', sha256: digest });
      expect((await api(PORT_RW, '/api/pipeline/plans/auth')).body.approved).toBe(true);
    });

    it('is idempotent — a retry or a double tap is a no-op', async () => {
      const first = await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: digest });
      const second = await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: digest });
      expect(second.status).toBe(200);
      expect(second.body.at).toBe(first.body.at);   // not re-stamped
      expect(second.body.alreadyApproved).toBe(true);
    });
  });

  describe('POST /api/dispatch — P10-E5', () => {
    it('reports refusals alongside launches, never just a count', async () => {
      // "Dispatched" over three silent refusals is a lie, and it is the lie a
      // phone is most likely to tell because its screen is small.
      await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: digest });
      const r = await post(PORT_RW, '/api/dispatch', { plan: 'auth', dryRun: true });
      expect(r.status).toBe(200);
      expect(r.body.refusals[0]).toMatchObject({ slug: 'auth-docs' });
      expect(r.body.started).toEqual([]);
      expect(r.body.dryRun).toBe(true);
    });

    it('refuses to dispatch a plan nobody approved', async () => {
      const r = await post(PORT_RW, '/api/dispatch', { plan: 'nope' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
  });

  /*
   * One plan, one name.
   *
   * Approval was keyed four ways at once — this route used the name in the
   * request, `GET /api/plans` used the frontmatter's `plan:`, `GET
   * /api/pipeline/plans` used the file name, and the CLI used the frontmatter
   * again. Each mismatch failed closed, so nothing ran unapproved; what it cost
   * was an approve button that did not stick, which is how a person learns to
   * press it without reading.
   */
  describe('plan identity across the surfaces', () => {
    it('shows one approval on every surface that reports one', async () => {
      await post(PORT_RW, '/api/pipeline/plans/auth/approve', { sha256: digest });

      const phone = await api(PORT_RW, '/api/pipeline/plans');
      const doc = await api(PORT_RW, '/api/pipeline/plans/auth');
      const board = await api(PORT_RW, '/api/plans?plan=auth');

      expect(phone.body.plans.find((p: any) => p.id === 'auth').approved).toBe(true);
      expect(doc.body.approved).toBe(true);
      expect(board.body.plans[0].planId).toBe('auth');
      expect(board.body.plans[0].approval.state).toBe('approved');
    });

    it('refuses a plan whose frontmatter names something other than its file', async () => {
      // Two ids for one file is what made the four surfaces disagree. Refused
      // at the parser, so the CLI and the daemon refuse it identically.
      await writeFile(join(rw, 'baton', 'plans', 'renamed.md'), PLAN);   // declares `plan: auth`

      const listed = (await api(PORT_RW, '/api/plans?plan=renamed')).body.plans[0];
      expect(listed.parses).toBe(false);
      expect(JSON.stringify(listed.issues)).toContain('renamed.md');
      expect(listed.approval.state).toBe('unapproved');

      const approve = await post(PORT_RW, '/api/pipeline/plans/renamed/approve', {
        sha256: planDigest(PLAN),
      });
      expect(approve.status).toBe(422);
      expect(approve.body.code).toBe('plan-invalid');

      const dispatched = await post(PORT_RW, '/api/dispatch', { plan: 'renamed' });
      expect(dispatched.status).toBe(422);
      await rm(join(rw, 'baton', 'plans', 'renamed.md'));
    });

    it('never approves or dispatches a file outside the plans directory', async () => {
      // `auth.md` passes the id grammar, and `readPlanFile` reads a spelling
      // that ends in `.md` relative to the repo root and the daemon's cwd
      // instead of `baton/plans/`. The approval recorded for it named an id no
      // other route resolves to that file.
      await writeFile(join(rw, 'elsewhere.md'), PLAN.replace('plan: auth', 'plan: elsewhere'));

      const approve = await post(PORT_RW, '/api/pipeline/plans/elsewhere.md/approve', {
        sha256: planDigest(PLAN.replace('plan: auth', 'plan: elsewhere')),
      });
      expect(approve.status).toBe(404);

      const dispatched = await post(PORT_RW, '/api/dispatch', { plan: 'elsewhere.md' });
      expect(dispatched.status).toBe(404);
    });

    it('carries a CLI approval to every screen, and back', async () => {
      // The shape of the original bug, from the other end: `baton plan approve`
      // recorded the frontmatter's id while the dashboard read the file name,
      // so approving in a terminal left the screen saying "unapproved" and
      // dispatching from the screen said the plan had never been approved.
      const text = PLAN.replace('plan: auth', 'plan: from-cli');
      await writeFile(join(rw, 'baton', 'plans', 'from-cli.md'), text);
      await execa('node', [DIST_CLI, 'plan', 'approve', 'from-cli'], { cwd: rw, reject: false });

      const board = (await api(PORT_RW, '/api/plans?plan=from-cli')).body.plans[0];
      const phone = (await api(PORT_RW, '/api/pipeline/plans')).body.plans
        .find((p: any) => p.id === 'from-cli');
      const doc = (await api(PORT_RW, '/api/pipeline/plans/from-cli')).body;

      expect(board.approval.state).toBe('approved');
      expect(phone.approved).toBe(true);
      expect(doc.approved).toBe(true);
      // And the daemon dispatches it without asking for an approval again.
      const r = await post(PORT_RW, '/api/dispatch', { plan: 'from-cli', dryRun: true });
      expect(r.status).toBe(200);
      await rm(join(rw, 'baton', 'plans', 'from-cli.md'));
    }, 30_000);

    it('never puts the operator\'s absolute paths in a refusal', async () => {
      // A refusal reaches a browser and, through Orca's relay, a phone. Naming
      // the file it read as `/Users/<someone>/code/...` tells all of them where
      // this repo lives — the same rule the plan inventory already keeps for
      // its unreadable rows.
      await writeFile(join(rw, 'baton', 'plans', 'invalid.md'), '---\nplan: invalid\n---\n\n# nothing\n');
      const r = await api(PORT_RW, '/api/pipeline/plans/invalid?resolve=1');
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).not.toContain(rw);
      expect(JSON.stringify(r.body)).toContain('invalid.md');
      await rm(join(rw, 'baton', 'plans', 'invalid.md'));
    });

    it('does not follow a symlink out of the plans directory', async () => {
      // The charset guard and the containment check both work on the path
      // STRING. A symlink is neither — and git carries symlinks, which is the
      // way a plan file arrives here in the first place.
      await writeFile(join(base, 'secret.txt'), 'token=hunter2\n');
      await symlink(join(base, 'secret.txt'), join(rw, 'baton', 'plans', 'leak.md'));

      const r = await api(PORT_RW, '/api/pipeline/plans/leak');
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body)).not.toContain('hunter2');
      await rm(join(rw, 'baton', 'plans', 'leak.md'));
    });
  });

  describe('read-only — P10-E4', () => {
    it('refuses approval', async () => {
      const r = await post(PORT_RO, '/api/pipeline/plans/auth/approve', { sha256: digest });
      expect(r.status).toBe(403);
    });

    it('refuses dispatch', async () => {
      expect((await post(PORT_RO, '/api/dispatch', { plan: 'auth' })).status).toBe(403);
    });

    it('still serves the read side, so the phone can show the plan', async () => {
      // Read-only is not "no information". The whole point of the screen is to
      // let someone see what would run before deciding to allow it.
      expect((await api(PORT_RO, '/api/pipeline/plans')).status).toBe(200);
    });
  });
});
