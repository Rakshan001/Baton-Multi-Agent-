import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { approve, reject } from '../src/lifecycle.js';
import { blockers, isContributor, openPhase, phaseComplete, reviewableBy } from '../src/pipeline.js';
import { claimTask } from '../src/commands/claim.js';
import { doneCmd } from '../src/commands/take.js';
import { reviewApproveCmd, reviewRejectCmd } from '../src/commands/review.js';
import { nextCmd } from '../src/commands/next.js';
import { saveReview } from '../src/reviews.js';

const NOW = '2026-08-05T12:00:00.000Z';

const task = (over: Partial<Task> = {}): Task => ({
  slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
  worktreePath: '/tmp/wt/auth-api', baseBranch: 'main', baseCommit: 'aaa111',
  createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
  state: 'review', requireReview: true, finishedSha: 'deadbee',
  claimedBy: { agent: 'claude', sessionSlug: 's1', at: NOW },
  contributors: [{ agent: 'claude', from: NOW, to: NOW }],
  ...over,
});

const claude = { agent: 'claude', sessionSlug: 's1' };
const cursor = { agent: 'cursor', sessionSlug: 's2' };

describe('the review verdict (pure)', () => {
  it('approves a task in review, records who and when', () => {
    const r = approve([task()], 'auth-api', cursor, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('done');
    expect(r.task.reviewedBy).toEqual({ actor: 'cursor', at: NOW, verdict: 'approve' });
  });

  /**
   * The rule the whole gate rests on. An author reviewing their own work re-runs
   * the judgement that produced it, with the same blind spots.
   */
  it('refuses the agent currently holding the task', () => {
    const r = approve([task()], 'auth-api', claude, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('self-review');
    expect(r.refusal.message).toContain('must not be a contributor');
  });

  /** A fresh session does not launder authorship: identity is the agent id. */
  it('refuses an earlier contributor even from a different session', () => {
    const t = task({
      claimedBy: { agent: 'cursor', sessionSlug: 's9', at: NOW },
      contributors: [{ agent: 'claude', from: NOW, to: NOW }, { agent: 'cursor', from: NOW, to: NOW }],
    });
    const r = approve([t], 'auth-api', { agent: 'claude', sessionSlug: 'a-brand-new-session' }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('self-review');
  });

  it.each(['queued', 'active', 'blocked', 'done', 'cancelled'] as const)(
    'refuses a verdict on a %s task', (state) => {
      const r = approve([task({ state })], 'auth-api', cursor, NOW);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal.code).toBe('wrong-state');
    });

  it('refuses an unknown slug', () => {
    const r = approve([task()], 'nope', cursor, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('missing');
  });

  /** Two pieces of shared state must not contradict each other. */
  it('refuses to approve over the review record’s own open findings', () => {
    const r = approve([task()], 'auth-api', cursor, NOW, { openFindings: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('open-findings');
    expect(r.refusal.message).toContain('3 open findings');
  });

  it('--force buys past open findings — but never past the contributor rule', () => {
    const forced = approve([task()], 'auth-api', cursor, NOW, { openFindings: 3, force: true });
    expect(forced.ok).toBe(true);

    const self = approve([task()], 'auth-api', claude, NOW, { openFindings: 0, force: true });
    expect(self.ok).toBe(false);
    if (self.ok) return;
    expect(self.refusal.code).toBe('self-review');
  });

  it('sends a rejection back to active with the branch and history intact', () => {
    const r = reject([task()], 'auth-api', cursor, '  the migration has no down step  ', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('active');
    expect(r.task.branch).toBe('baton/auth-api');
    expect(r.task.worktreePath).toBe('/tmp/wt/auth-api');
    expect(r.task.contributors).toHaveLength(1);
    expect(r.task.reviewedBy).toEqual({
      actor: 'cursor', at: NOW, verdict: 'reject', notes: 'the migration has no down step',
    });
  });

  /** It recorded the head the gate accepted, and nothing is accepted now. */
  it('drops finishedSha on rejection', () => {
    const r = reject([task()], 'auth-api', cursor, 'redo it', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.finishedSha).toBeUndefined();
  });

  it('refuses a rejection with no reason — that is how a rejection loop starts', () => {
    for (const notes of ['', '   ']) {
      const r = reject([task()], 'auth-api', cursor, notes, NOW);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal.message).toContain('needs a reason');
    }
  });

  it('refuses a self-rejection too — a verdict is a second party either way', () => {
    const r = reject([task()], 'auth-api', claude, 'looks wrong', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('self-review');
  });

  it('leaves every other task untouched', () => {
    const other = task({ slug: 'other', state: 'queued' });
    const r = approve([task(), other], 'auth-api', cursor, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasks.find((t) => t.slug === 'other')).toEqual(other);
  });
});

describe('review in the board', () => {
  it('holds its phase — review is not finished work', () => {
    const tasks = [task({ state: 'review' }), task({ slug: 'b', state: 'done' })];
    expect(phaseComplete(tasks, 1)).toBe(false);
    expect(openPhase(tasks)).toBe(1);
  });

  it('lifts the barrier once approved', () => {
    const r = approve([task(), task({ slug: 'b', state: 'done' })], 'auth-api', cursor, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(phaseComplete(r.tasks, 1)).toBe(true);
    expect(openPhase(r.tasks)).toBe(Infinity);
  });

  it('names the wait instead of reporting it as work in flight', () => {
    const reasons = blockers([task()]).map((b) => b.reason);
    expect(reasons).toEqual(['awaiting review — a different agent must judge it']);
  });

  it('offers the review to agents who did not write it, and to nobody else', () => {
    const tasks = [task()];
    expect(reviewableBy('cursor', tasks).map((t) => t.slug)).toEqual(['auth-api']);
    expect(reviewableBy('claude', tasks)).toEqual([]);
  });

  it('counts both handles as authorship', () => {
    const t = task({ claimedBy: undefined, contributors: [{ agent: 'codex', from: NOW, to: NOW }] });
    expect(isContributor(t, 'codex')).toBe(true);
    expect(isContributor(task({ contributors: undefined }), 'claude')).toBe(true); // via claimedBy
    expect(isContributor(t, 'cursor')).toBe(false);
  });
});

/** The verdict against a real repo: real commits, real worktree, real files. */
describe('baton review approve/reject', () => {
  let root: string;
  let wt: string;
  let out: string[];
  let err: string[];
  let cwd: string;
  const env = { ...process.env };

  const become = (agent: string, slug: string): void => {
    process.env.BATON_AGENT = agent;
    process.env.BATON_SLUG = slug;
  };

  async function inReview(over: Partial<Task> = {}): Promise<void> {
    await saveTasks(root, [{
      slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
      worktreePath: join(root, '.baton', 'wt', 'auth-api'), baseBranch: 'HEAD', baseCommit: null,
      createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
      scope: ['src/**'], expects: [], state: 'queued', requireReview: true, ...over,
    }]);
    become('claude', 's1');
    wt = (await claimTask(root, 'auth-api', { agent: 'claude', sessionSlug: 's1' })).task.worktreePath;
    await writeFile(join(wt, 'src', 'a.ts'), 'x\n// work\n', 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'the work'], wt);
    await doneCmd('auth-api', {});
    out = []; err = [];
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-verdict-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.env = { ...env };
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses the author, then accepts a second agent', async () => {
    await inReview();
    expect((await loadTasks(root))[0].state).toBe('review');

    await reviewApproveCmd('auth-api');                    // still claude
    expect(err.join('\n')).toContain('must not be a contributor');
    expect(process.exitCode).toBe(1);
    expect((await loadTasks(root))[0].state).toBe('review');

    process.exitCode = undefined;
    become('cursor', 's2');
    await reviewApproveCmd('auth-api');
    const [t] = await loadTasks(root);
    expect(t.state).toBe('done');
    expect(t.reviewedBy?.actor).toBe('cursor');
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses to approve while the recorded review has open findings', async () => {
    await inReview();
    await saveReview(root, 'auth-api', {
      fixedPoint: 'main', head: 'abc1234',
      findings: [{ axis: 'security', title: 'no authz check', source: 'security-baseline', hard: true }],
      skipped: [],
    });
    become('cursor', 's2');

    await reviewApproveCmd('auth-api');
    expect(err.join('\n')).toContain('1 open finding');
    expect((await loadTasks(root))[0].state).toBe('review');

    process.exitCode = undefined;
    await reviewApproveCmd('auth-api', { force: true });
    expect((await loadTasks(root))[0].state).toBe('done');
    expect(out.join('\n')).toContain('approved over 1 open finding');
  });

  it('sends the work back with the reason, and the next agent reads it', async () => {
    await inReview();
    become('cursor', 's2');
    await reviewRejectCmd('auth-api', { notes: 'no test for the empty case' });

    const [t] = await loadTasks(root);
    expect(t.state).toBe('active');
    expect(t.worktreePath).toBe(wt);                       // the branch is not lost
    expect(t.reviewedBy?.notes).toBe('no test for the empty case');

    out = [];
    become('claude', 's1');
    await nextCmd();
    expect(out.join('\n')).toContain('no test for the empty case');
  });

  /**
   * "Do you have any pending task?" asked by an agent that already holds one.
   * Answering "nothing eligible" is how a restarted session abandons its work.
   */
  it('points a returning agent at the work it already holds', async () => {
    await inReview();
    become('cursor', 's2');
    await reviewRejectCmd('auth-api', { notes: 'redo the parser' });
    out = [];
    become('claude', 'a-fresh-session-after-the-limit');
    await nextCmd();
    const said = out.join('\n');
    expect(said).toContain('You already hold 1 task');
    expect(said).toContain('cd ');
    expect(said).not.toContain('Nothing eligible');
  });

  it('offers the review as work to an agent who did not write it', async () => {
    await inReview();
    out = [];
    become('cursor', 's2');
    await nextCmd();
    const said = out.join('\n');
    expect(said).toContain('Awaiting your verdict');
    expect(said).toContain('baton review approve auth-api');
    // The contradiction that would stop an agent mid-list.
    expect(said).not.toContain('Nothing eligible');
  });

  it('does not offer it back to the agent who wrote it', async () => {
    await inReview();
    out = [];
    become('claude', 's1');
    await nextCmd();
    expect(out.join('\n')).not.toContain('Awaiting your verdict');
  });

  it('refuses a rejection with no reason before touching the board', async () => {
    await inReview();
    become('cursor', 's2');
    await reviewRejectCmd('auth-api', { notes: '   ' });
    expect(err.join('\n')).toContain('needs a reason');
    expect((await loadTasks(root))[0].state).toBe('review');
  });
});
