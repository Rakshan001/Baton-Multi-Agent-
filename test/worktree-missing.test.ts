import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { hasUnsavedWork, worktreeStatus } from '../src/git.js';
import { collectStatus } from '../src/board.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { claimTask } from '../src/commands/claim.js';
import { doneCmd } from '../src/commands/take.js';
import { removeTaskWorktree } from '../src/commands/rm.js';
import { verdictFor, type Evidence } from '../src/evidence.js';

/**
 * A deleted worktree used to be indistinguishable from a pristine one.
 *
 * `worktreeStatus` mapped BOTH "git could not answer" and "git says nothing
 * changed" to `clean`, so a task whose directory someone deleted was drawn as a
 * tidy checkout on the board, in `baton ls`, and in the dashboard — and the done
 * gate printed "working tree clean" about a path it had never read.
 */
describe('a worktree that is not there', () => {
  let root: string;
  let wt: string;
  let cwd: string;
  let out: string[];
  let err: string[];
  const env = { ...process.env };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-gone-'));
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
    process.env.BATON_AGENT = 'claude';
    process.env.BATON_SLUG = 's1';
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

  async function claimed(over: Partial<Task> = {}): Promise<void> {
    await saveTasks(root, [{
      slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
      worktreePath: join(root, '.baton', 'wt', 'auth-api'), baseBranch: 'HEAD', baseCommit: null,
      createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
      scope: ['src/**'], expects: [], state: 'queued', requireReview: true, ...over,
    }]);
    wt = (await claimTask(root, 'auth-api', { agent: 'claude', sessionSlug: 's1' })).task.worktreePath;
  }

  it('tells a deleted worktree apart from a clean one', async () => {
    await claimed();
    expect((await worktreeStatus(wt)).state).toBe('clean');
    await rm(wt, { recursive: true, force: true });
    expect((await worktreeStatus(wt)).state).toBe('missing');
  });

  /** The one that made this hard to see: git answers, and answers "nothing". */
  it('still calls an untouched checkout clean', async () => {
    await claimed();
    expect((await worktreeStatus(wt)).state).toBe('clean');
    await writeFile(join(wt, 'src', 'a.ts'), 'x\nedited\n', 'utf-8');
    expect((await worktreeStatus(wt)).state).toBe('dirty');
  });

  it('reports a path that never existed as missing, not clean', async () => {
    expect((await worktreeStatus(join(root, 'never', 'here'))).state).toBe('missing');
  });

  it('does not draw a vanished worktree as a tidy one on the board', async () => {
    await claimed();
    await rm(wt, { recursive: true, force: true });
    const [row] = await collectStatus(root);
    expect(row.status).toBe('missing');
  });

  /**
   * The guards that read `state !== 'clean'` to mean "there is work here to
   * lose". A worktree that is already gone has nothing to lose, and refusing to
   * remove it would strand the task row forever.
   */
  it('is not mistaken for unsaved work', async () => {
    await claimed();
    const present = await worktreeStatus(wt);
    await rm(wt, { recursive: true, force: true });
    const gone = await worktreeStatus(wt);
    expect(hasUnsavedWork(present)).toBe(false);
    expect(hasUnsavedWork(gone)).toBe(false);
    expect(gone.state).toBe('missing');   // not clean, but still safe to remove
  });

  it('lets baton rm clean up a task whose worktree is already gone', async () => {
    await claimed();
    await rm(wt, { recursive: true, force: true });
    await expect(removeTaskWorktree('auth-api', {}, root)).resolves.toBeTruthy();
    expect(await loadTasks(root)).toEqual([]);
  });

  /**
   * The gate must not claim a check passed when it never ran. Not a refusal
   * either — the commits are the evidence, and the branch outlives the folder.
   */
  it('says the check could not run instead of "working tree clean"', async () => {
    await claimed();
    await writeFile(join(wt, 'src', 'a.ts'), 'x\nwork\n', 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'the work'], wt);
    await rm(wt, { recursive: true, force: true });

    await doneCmd('auth-api', {});
    const said = out.join('\n');
    expect(said).toContain('worktree is gone');
    expect(said).not.toContain('working tree clean');
    const [t] = await loadTasks(root);
    expect(t.state).toBe('review');            // the commits still count
    expect(t.finishedSha).toBeTruthy();        // read from the branch, not the folder
  });

  it('keeps refusing a done with nothing behind it, worktree or not', async () => {
    await claimed();
    await rm(wt, { recursive: true, force: true });
    await doneCmd('auth-api', {});
    expect(out.join('\n')).toContain('no commits');
    expect((await loadTasks(root))[0].state).toBe('active');
  });
});

describe('the evidence verdict on a missing worktree (pure)', () => {
  const base: Evidence = {
    commits: 2, headSha: 'abc1234', files: ['src/a.ts'], scope: ['src/**'],
    dirtyFiles: [], conflictFiles: [], expects: [], attested: false,
  };

  it('warns without refusing', () => {
    const v = verdictFor({ ...base, worktreeMissing: true });
    expect(v.refusals).toEqual([]);
    expect(v.pass).toBe(true);
    expect(v.checks.some((c) => c.level === 'warn' && c.label.includes('worktree is gone'))).toBe(true);
    expect(v.checks.some((c) => c.label === 'working tree clean')).toBe(false);
  });

  it('still refuses zero commits — a gone worktree is not an excuse', () => {
    const v = verdictFor({ ...base, commits: 0, worktreeMissing: true });
    expect(v.refusals.map((r) => r.label)).toContain('no commits on this branch');
  });
});
