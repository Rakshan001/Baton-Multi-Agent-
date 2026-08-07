/**
 * The pipeline over HTTP — phase 7's backend, against real daemons.
 *
 * The swimlane view and `baton cancel` already have unit tests. What can only
 * be checked out here is the seam: the daemon serving the same answer the CLI
 * gives, and the three gates on a mutating endpoint actually being reachable in
 * the order the route claims.
 *
 * That seam is where this project's last three real bugs lived — each time a
 * correct core behind a surface that answered wrongly — so the cancel route is
 * driven the way a browser drives it, not the way a unit test does.
 *
 * One gate is NOT exercised here, by the same convention every other
 * owner-gated route in this repo follows: these run over loopback, which
 * `decideAccess` treats as owner, so the non-owner refusal cannot be reached
 * from a test that talks to 127.0.0.1. It is a property of `requiresOwner`,
 * unit-tested in test/members.test.ts, and the cancel route consults exactly
 * that function. What IS pinned here are the three gates loopback can reach:
 * read-only, member-machine, and cross-origin.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT_RW = 7431;
const PORT_RO = 7432;
const PORT_MEMBER = 7433;

async function api(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000), ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(port, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function makeRepo(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  // A machine-global core.hooksPath must not fire in a throwaway repo — its
  // child inherits git's pipes and execa then waits on a stream that never
  // closes. (Borrowed from the daemon-api suite, same hazard.)
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

/** A board with every lane status on it: complete, open, locked. */
function seedTasks(root: string) {
  const at = '2026-08-01T00:00:00.000Z';
  return [
    { slug: 'schema', task: 'Design the schema', branch: 'baton/schema', worktreePath: join(root, '.baton/wt/schema'),
      baseBranch: 'main', baseCommit: 'aaa', createdAt: at, planId: 'auth', phase: 1, state: 'done' },
    { slug: 'api', task: 'Wire the API', branch: 'baton/api', worktreePath: join(root, '.baton/wt/api'),
      baseBranch: 'main', baseCommit: 'bbb', createdAt: at, planId: 'auth', phase: 2, state: 'active',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at } },
    { slug: 'ui', task: 'Build the UI', branch: 'baton/ui', worktreePath: '',
      baseBranch: 'main', baseCommit: null, createdAt: at, planId: 'auth', phase: 2, state: 'queued' },
    { slug: 'e2e', task: 'End to end', branch: 'baton/e2e', worktreePath: '',
      baseBranch: 'main', baseCommit: null, createdAt: at, planId: 'auth', phase: 3, state: 'queued',
      dependsOn: ['api'] },
  ];
}

const PLAN_MD = `# Auth\n\n## Phase 1\n- [ ] schema — Design the schema\n`;

/**
 * `integrated` decides whether phase 1 is holding the barrier, and the daemon
 * resolves it against real git — so the fixture has to be real too.
 *
 * A phase-1 branch that is an ancestor of `main` is a phase that landed. Left
 * out, phase 1 is done-but-unintegrated and phase 2 reads as LOCKED — which is
 * the daemon being right and the fixture being a lie. (It was, first time
 * round: this line is the fix.)
 */
async function seedRepo(root: string, opts: { integrated: boolean }): Promise<void> {
  await mkdir(join(root, '.baton'), { recursive: true });
  await writeFile(join(root, '.baton', 'tasks.json'), JSON.stringify(seedTasks(root), null, 2));
  await mkdir(join(root, 'baton', 'plans'), { recursive: true });
  await writeFile(join(root, 'baton', 'plans', 'auth.md'), PLAN_MD);
  // The traversal target. Two levels above baton/plans and ending in `.md`, so
  // `baton/plans/../../LEAKME` + the route's own suffix lands exactly on it —
  // a file the guard is the only thing standing between and the browser.
  await writeFile(join(root, 'LEAKME.md'), 'token: hunter2\n');
  if (opts.integrated) await execa('git', ['branch', 'baton/schema', 'main'], { cwd: root });
}

describe.runIf(hasDist)('pipeline over HTTP', () => {
  let base = '';
  let rw = '';
  let member = '';
  let registry = '';
  const children: ResultPromise[] = [];

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
    base = await mkdtemp(join(tmpdir(), 'baton-pipeapi-'));
    registry = join(base, 'registry');
    const [a, ro, m] = await Promise.all([
      makeRepo(base, 'repo-rw'), makeRepo(base, 'repo-ro'), makeRepo(base, 'repo-member'),
    ]);
    rw = a;
    member = m;
    // rw + member: phase 1 landed, so phase 2 is genuinely open.
    // ro: phase 1 done but NOT landed — kept that way on purpose, as the
    // integration-hold case. Two boards, both real, no extra daemon.
    await Promise.all([
      seedRepo(a, { integrated: true }),
      seedRepo(ro, { integrated: false }),
      seedRepo(m, { integrated: true }),
    ]);
    // This machine answers to somebody else's hub — the §7.6 member case.
    await writeFile(join(m, '.baton', 'host.json'),
      JSON.stringify({ url: 'http://hub.example:7077', token: 'tkn', device: 'laptop' }));
    await spawnDaemon(a, PORT_RW, true);
    await spawnDaemon(ro, PORT_RO, false);
    await spawnDaemon(m, PORT_MEMBER, true);
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c.catch(() => undefined)));
    await rm(base, { recursive: true, force: true });
  });

  describe('GET /api/pipeline', () => {
    it('serves lanes the dashboard can draw without deciding anything', async () => {
      const { status, body } = await api(PORT_RW, '/api/pipeline');
      expect(status).toBe(200);
      expect(body.lanes.map((l: any) => [l.phase, l.status]))
        .toEqual([[1, 'complete'], [2, 'open'], [3, 'locked']]);
      expect(body.openPhase).toBe(2);
      expect(body.plans).toEqual([{ id: 'auth', total: 4, done: 1, cancelled: 0 }]);
    });

    it('names who is on a task, and why a locked one cannot start', async () => {
      const { body } = await api(PORT_RW, '/api/pipeline');
      const rows = body.lanes.flatMap((l: any) => l.tasks);
      expect(rows.find((r: any) => r.slug === 'api').holder.agent).toBe('claude');
      expect(rows.find((r: any) => r.slug === 'e2e').blocker).toMatch(/phase 3 locked behind phase 2/);
    });

    it('is readable on a read-only daemon — looking is not writing', async () => {
      const { status, body } = await api(PORT_RO, '/api/pipeline');
      expect(status).toBe(200);
      expect(body.lanes).toHaveLength(3);
    });

    it('applies the REAL integration gate, not a default one', async () => {
      /*
       * The ro repo's phase-1 branch never landed on main. The daemon must
       * therefore hold the barrier at phase 1 and lock phase 2 — the same
       * answer `baton next` gives in that repo.
       *
       * This is the assertion that proves the route resolves a gate at all. It
       * caught the first version of the rw fixture, where the branch was
       * missing and phase 2 was reported locked; the daemon was right and the
       * test was wrong. Serving the view WITHOUT the gate would show phase 2
       * open here while every `baton take` in that repo is refused.
       */
      const { body } = await api(PORT_RO, '/api/pipeline');
      expect(body.integrationHold).toBe(1);
      expect(body.openPhase).toBe(1);
      expect(body.lanes.find((l: any) => l.phase === 1).status).toBe('holding');
      expect(body.lanes.find((l: any) => l.phase === 2).status).toBe('locked');
      // `ui`, not tasks[0] — lane 2's first row is `api`, which is ACTIVE and
      // so reports its holder rather than the barrier. Only a queued task can
      // show the phase lock, which is the string this test is about.
      const ui = body.lanes.find((l: any) => l.phase === 2).tasks.find((t: any) => t.slug === 'ui');
      expect(ui.blocker).toMatch(/phase 2 locked — phase 1 is finished but not integrated/);
    });
  });

  describe('GET /api/pipeline/plans/:id', () => {
    it('serves the plan as source markdown', async () => {
      const { status, body } = await api(PORT_RW, '/api/pipeline/plans/auth');
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: 'auth', markdown: PLAN_MD, path: 'baton/plans/auth.md' });
    });

    it('404s a plan that is not there, and says where plans live', async () => {
      const { status, body } = await api(PORT_RW, '/api/pipeline/plans/nope');
      expect(status).toBe(404);
      expect(body.hint).toMatch(/baton\/plans/);
    });

    it('refuses traversal — against a file that really is reachable', async () => {
      /*
       * This endpoint reads a file off the operator's disk and hands its bytes
       * to a browser. If an id escaped `baton/plans`, the route stops being a
       * plan viewer and becomes an arbitrary file read on anything the daemon
       * can open — .baton/host.json (a live member token), an .env, an ssh key.
       *
       * The target is a file PLANTED FOR THIS TEST at the repo root, two levels
       * above the plans directory and ending in `.md` so the route's own
       * suffix lands on it. That detail is the test.
       *
       * The first version of this case aimed at /etc/passwd and passed with
       * BOTH guards deleted — the traversal worked fine and the request 404'd
       * only because `/etc/passwd.md` does not exist. It was asserting the
       * absence of a file, not the presence of a guard. Mutation testing said
       * so; this version fails when either guard is weakened.
       */
      const attempts = [
        '/api/pipeline/plans/..%2F..%2FLEAKME',
        '/api/pipeline/plans/%2e%2e%2f%2e%2e%2fLEAKME',
        '/api/pipeline/plans/....%2F%2F....%2F%2FLEAKME',
        '/api/pipeline/plans/.%2E%2F.%2E%2FLEAKME',
        '/api/pipeline/plans/..%252f..%252fLEAKME',
        '/api/pipeline/plans/%2Fetc%2Fpasswd',
      ];
      for (const path of attempts) {
        const { status, body } = await api(PORT_RW, path);
        expect([400, 403, 404], `${path} was not refused`).toContain(status);
        // The decisive assertion — the secret never comes back, whatever the code.
        expect(JSON.stringify(body ?? ''), `${path} LEAKED the file`).not.toMatch(/hunter2/);
      }
    });

    it('refuses a dotfile id, which is how you ask for .env', async () => {
      const { status } = await api(PORT_RW, '/api/pipeline/plans/.env');
      expect(status).toBe(400);
    });
  });

  describe('POST /api/pipeline/cancel', () => {
    it('--dry-run returns the blast radius and writes nothing', async () => {
      const { status, body } = await post(PORT_RW, '/api/pipeline/cancel', { phase: 2, dryRun: true });
      expect(status).toBe(200);
      expect(body.dryRun).toBe(true);
      expect(body.radius.stopping.map((s: any) => s.slug)).toEqual(['api', 'ui']);
      expect(body.agentsStopped).toBe(1);
      // The warning that matters, over the wire and not just in the CLI.
      expect(body.radius.stranding).toEqual([{ slug: 'e2e', dependsOn: ['api'] }]);
      expect(body.cancelled).toEqual([]);

      const after = await api(PORT_RW, '/api/pipeline');
      const api2 = after.body.lanes.flatMap((l: any) => l.tasks).find((r: any) => r.slug === 'api');
      expect(api2.state).toBe('active');
    });

    it('refuses two scopes rather than picking one', async () => {
      const { status, body } = await post(PORT_RW, '/api/pipeline/cancel', { slug: 'api', phase: 2, dryRun: true });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Pick one scope/);
    });

    it('refuses a cross-origin write — the browser CSRF path', async () => {
      // A page on evil.com can fire this POST at localhost; CORS blocks it
      // reading the reply, not the daemon from acting on it.
      const { status } = await post(PORT_RW, '/api/pipeline/cancel',
        { phase: 2 }, { Origin: 'https://evil.example' });
      expect(status).toBe(403);
      const after = await api(PORT_RW, '/api/pipeline');
      expect(after.body.lanes.flatMap((l: any) => l.tasks).find((r: any) => r.slug === 'api').state).toBe('active');
    });

    it('refuses on a read-only daemon', async () => {
      const { status, body } = await post(PORT_RO, '/api/pipeline/cancel', { phase: 2 });
      expect(status).toBe(403);
      expect(body.error).toBe('read-only');
    });

    it('refuses on a member machine — the plan lives at the hub', async () => {
      // §7.6. Not about who is asking: cancelling here would fork the plan, and
      // nothing would report it.
      const { status, body } = await post(PORT_MEMBER, '/api/pipeline/cancel', { phase: 2 });
      expect(status).toBe(403);
      expect(body.code).toBe('not-operator');
      expect(body.error).toMatch(/hub\.example/);
    });

    it('cancels for real, and the board says so on the next read', async () => {
      const { status, body } = await post(PORT_RW, '/api/pipeline/cancel',
        { slug: 'ui', reason: 'approach abandoned' });
      expect(status).toBe(200);
      expect(body.cancelled).toEqual(['ui']);

      const { body: view } = await api(PORT_RW, '/api/pipeline');
      const ui = view.lanes.flatMap((l: any) => l.tasks).find((r: any) => r.slug === 'ui');
      expect(ui.state).toBe('cancelled');
      expect(ui.cancelledBy.reason).toBe('approach abandoned');

      // Destroys nothing — the branch name survives on the row.
      expect(ui.branch).toBe('baton/ui');
      const onDisk = JSON.parse(await readFile(join(rw, '.baton', 'tasks.json'), 'utf-8'));
      expect(onDisk.find((t: any) => t.slug === 'ui').branch).toBe('baton/ui');
    });

    it('reports an empty radius honestly rather than pretending to act', async () => {
      const { status, body } = await post(PORT_RW, '/api/pipeline/cancel', { plan: 'nonexistent', dryRun: true });
      expect(status).toBe(200);
      expect(body.radius.stopping).toEqual([]);
      expect(body.cancelled).toEqual([]);
    });
  });
});
