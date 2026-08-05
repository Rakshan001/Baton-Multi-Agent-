import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { collectStatus } from '../src/board.js';
import { lsCmd } from '../src/commands/ls.js';
import { taskAddCmd, taskRmCmd } from '../src/commands/task.js';

function row(over: Partial<Task> & { slug: string }): Task {
  return {
    task: over.slug, branch: `baton/${over.slug}`, worktreePath: `/nope/${over.slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: new Date().toISOString(),
    phase: 0, dependsOn: [], assignee: null, scope: [], state: 'queued',
    ...over,
  };
}

describe('the board with lazy worktrees', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-board-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a) => { err.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /**
   * `worktreeStatus` reports a failed git call as `clean`, which was harmless
   * when every task had a worktree. A queued task has none, so without the
   * materialization guard the board draws every unstarted task as a tidy
   * checkout — and spawns git per phantom path to do it.
   */
  it('does not ask git about a task that has no worktree', async () => {
    // worktreePath points at the REAL repo, and the repo is deliberately dirty,
    // so git has a loud answer ready. Only baseCommit === null stops us asking —
    // seeing the placeholder instead of that answer is what proves the guard.
    await writeFile(join(root, 'untracked.ts'), 'x\n', 'utf-8');
    await saveTasks(root, [row({ slug: 'queued-one', worktreePath: root, branch: 'main' })]);
    await lsCmd();
    const text = out.join('\n');
    expect(text).toMatch(/queued-one\s+—/);
    expect(text).not.toMatch(/queued-one\s+(clean|dirty|conflict)/);
  });

  it('keeps queued rows off the worktree status board entirely', async () => {
    await saveTasks(root, [
      row({ slug: 'real-one', worktreePath: root, baseCommit: 'abc' }),
      row({ slug: 'queued-one' }),
    ]);
    const rows = await collectStatus(root);
    expect(rows.map((r) => r.slug)).toEqual(['real-one']);
  });

  it('groups by phase, names the open one, and says which are locked', async () => {
    await saveTasks(root, [
      row({ slug: 'schema', phase: 1, state: 'done', baseCommit: 'abc' }),
      row({ slug: 'api', phase: 2, state: 'active', baseCommit: 'abc', claimedBy: { agent: 'cursor', sessionSlug: 's', at: new Date().toISOString() } }),
      row({ slug: 'ship', phase: 3 }),
      row({ slug: 'stray' }),
    ]);
    await lsCmd();
    const text = out.join('\n');
    expect(text).toContain('PHASE 1  ✓ complete');
    expect(text).toContain('PHASE 2  ← open');
    expect(text).toContain('PHASE 3  locked behind phase 2');
    expect(text).toContain('UNPHASED');
    expect(text).toContain('cursor');
  });

  it('says the plan is finished rather than going quiet', async () => {
    await saveTasks(root, [row({ slug: 'schema', phase: 1, state: 'done', baseCommit: 'abc' })]);
    await lsCmd();
    expect(out.join('\n')).toContain('every phase complete');
  });

  /** An agent told only "nothing to do" cannot tell a finished plan from a wedged one. */
  it('names what is waiting on a human', async () => {
    await saveTasks(root, [row({ slug: 'api', phase: 1, state: 'blocked', stoppedReason: 'needs a schema decision' })]);
    await lsCmd();
    expect(out.join('\n')).toContain('needs a schema decision');
  });

  it('keeps the old flat table when nothing is phased', async () => {
    await saveTasks(root, [row({ slug: 'plain', baseCommit: 'abc' })]);
    await lsCmd();
    expect(out[0]).toContain('SLUG');
    expect(out.join('\n')).not.toContain('PHASE');
  });
});

describe('baton task add', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-taskadd-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a) => { err.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('queues a row and creates nothing on disk', async () => {
    await taskAddCmd('fix the readme typo', {});
    const [t] = await loadTasks(root);
    expect(t.slug).toBe('fix-the-readme-typo');
    expect(t.state).toBe('queued');
    expect(t.baseCommit).toBeNull();
    await expect(readdir(join(root, '.baton', 'wt'))).rejects.toThrow();   // no worktree dir
    const branches = await git(['branch', '--list', 'baton/*'], root);
    expect(branches.trim()).toBe('');                                     // no branch
  });

  it('records the contract fields', async () => {
    await taskAddCmd('rate limit login', { phase: '2', assignee: 'claude', scope: 'src/mw/**', expects: 'vitest passes; 429 on the 6th try' });
    const [t] = await loadTasks(root);
    expect(t.phase).toBe(2);
    expect(t.assignee).toBe('claude');
    expect(t.scope).toEqual(['src/mw/**']);
    expect(t.expects).toEqual(['vitest passes', '429 on the 6th try']);
  });

  /** Unsatisfiable is never what anyone meant, so both shapes refuse. */
  it('refuses a dependency that does not exist, and writes nothing', async () => {
    await taskAddCmd('wire metrics', { after: 'ghost' });
    expect(err.join('\n')).toContain("no task 'ghost'");
    expect(process.exitCode).toBe(1);
    await expect(loadTasks(root)).resolves.toEqual([]);
  });

  it('refuses a dependency in a later phase', async () => {
    await taskAddCmd('api', { phase: '2' });
    await taskAddCmd('schema', { phase: '1', after: 'api' });
    expect(err.join('\n')).toContain('can never be satisfied');
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['api']);
  });

  it('rejects a phase that is not a whole number', async () => {
    await taskAddCmd('x', { phase: 'two' });
    expect(process.exitCode).toBe(1);
    await expect(loadTasks(root)).resolves.toEqual([]);
  });

  /**
   * Same rule as a plan, different room: a plan is applied unattended, while
   * this command has a human in front of it who may know better.
   */
  it('warns on same-phase scope overlap but still queues the task', async () => {
    await taskAddCmd('throttle', { phase: '1', scope: 'src/mw/**' });
    await taskAddCmd('metrics', { phase: '1', scope: 'src/mw/count.ts' });
    expect(err.join('\n')).toContain('run in parallel');
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['throttle', 'metrics']);
  });

  it('does not warn about a task in another phase, or a finished one', async () => {
    await taskAddCmd('throttle', { phase: '1', scope: 'src/mw/**' });
    await taskAddCmd('later', { phase: '2', scope: 'src/mw/**' });
    expect(err.join('\n')).not.toContain('run in parallel');
  });

  it('dedupes a slug that is already taken', async () => {
    await taskAddCmd('fix login', {});
    await taskAddCmd('fix login', {});
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['fix-login', 'fix-login-2']);
  });
});

describe('baton task rm', () => {
  let root: string;
  let err: string[];
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-taskrm-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    err = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('removes a queued task', async () => {
    await saveTasks(root, [row({ slug: 'never-started' })]);
    await taskRmCmd('never-started');
    await expect(loadTasks(root)).resolves.toEqual([]);
  });

  /** Deleting the row would leave the branch and the worktree with nothing
   *  pointing at them — that is `baton rm`'s job, and it knows how. */
  it('refuses a task that has a worktree behind it', async () => {
    const started = [row({ slug: 'started', baseCommit: 'abc' })];
    await saveTasks(root, started);
    await taskRmCmd('started');
    expect(err.join('\n')).toContain('baton rm started');
    expect(process.exitCode).toBe(1);
    await expect(loadTasks(root)).resolves.toEqual(started);
  });

  it('refuses a task an agent is holding', async () => {
    await saveTasks(root, [row({ slug: 'held', state: 'active' })]);
    await taskRmCmd('held');
    expect(process.exitCode).toBe(1);
    expect(await loadTasks(root)).toHaveLength(1);
  });

  it('exits non-zero on an unknown slug', async () => {
    await taskRmCmd('nope');
    expect(err.join('\n')).toContain("No task 'nope'");
    expect(process.exitCode).toBe(1);
  });
});
