import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { taskOf, trustedLineage, withTaskTrailer, TASK_TRAILER } from '../src/trailers.js';
import { hooksDir, hookScript, installCommitHook, HOOK_MARKER } from '../src/hooks-git.js';
import { branchCommits } from '../src/git.js';
import { reindexHistory } from '../src/commands/reindex.js';
import { queryFile, recordMerge } from '../src/history.js';
import { saveTasks, type Task } from '../src/store.js';

describe('the Baton-Task trailer (pure)', () => {
  it('reads the slug back out of a message', () => {
    expect(taskOf('do a thing\n\nBaton-Task: auth-api\n')).toBe('auth-api');
    expect(taskOf('do a thing')).toBeNull();
  });

  it('opens a new trailer block after a prose body', () => {
    const out = withTaskTrailer('add the endpoint\n\nIt handles tokens.', 'auth-api');
    expect(out).toBe('add the endpoint\n\nIt handles tokens.\n\nBaton-Task: auth-api\n');
  });

  /** Appending into a prose paragraph would stop git reading it as a trailer. */
  it('joins an existing trailer block rather than starting a second one', () => {
    const out = withTaskTrailer('fix it\n\nSigned-off-by: T <t@t.dev>', 'auth-api');
    expect(out).toBe('fix it\n\nSigned-off-by: T <t@t.dev>\nBaton-Task: auth-api\n');
  });

  it('handles a subject-only message', () => {
    expect(withTaskTrailer('fix it', 'auth-api')).toBe('fix it\n\nBaton-Task: auth-api\n');
  });

  /** Amends and rebases re-run over messages that already carry one; a commit
   *  stamped twice would make one task look like two. */
  it('never restamps a message that already claims a task', () => {
    const once = withTaskTrailer('fix it', 'auth-api');
    expect(withTaskTrailer(once, 'auth-api')).toBe(once);
    expect(withTaskTrailer(once, 'a-different-task')).toBe(once);   // the first claim stands
  });

  it('is a real git trailer, not just a line we can find', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-tr-'));
    try {
      await git(['init', '-q', '-b', 'main'], dir);
      await git(['config', 'user.email', 't@t.dev'], dir);
      await git(['config', 'user.name', 't'], dir);
      await writeFile(join(dir, 'a.txt'), 'x\n', 'utf-8');
      await git(['add', '-A'], dir);
      await git(['commit', '-qm', withTaskTrailer('add a\n\nWith a body.', 'auth-api')], dir);
      // git's own trailer parser has to agree, or `git log --format=%(trailers)`
      // and every other tool sees nothing.
      const out = await git(['log', '-1', '--format=%(trailers:key=Baton-Task,valueonly)'], dir);
      expect(out.trim()).toBe('auth-api');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** §7.5 — anyone who can push can write a trailer. */
describe('trailer poisoning', () => {
  const known = new Set(['auth-api', 'auth-ui']);
  const c = (sha: string, slug?: string) => ({ sha, message: slug ? `work\n\n${TASK_TRAILER}: ${slug}\n` : 'work' });

  it('honors a trailer only when the task actually exists here', () => {
    const { trusted, rejected } = trustedLineage([c('a1', 'auth-api'), c('b2', 'stranger')], known);
    expect(trusted).toEqual([{ sha: 'a1', slug: 'auth-api' }]);
    expect(rejected).toEqual([{ sha: 'b2', slug: 'stranger' }]);
  });

  it('treats a commit with no trailer as neither trusted nor forged', () => {
    const { trusted, rejected } = trustedLineage([c('a1')], known);
    expect(trusted).toEqual([]);
    expect(rejected).toEqual([]);        // no claim is not a lie
  });
});

describe('the commit hook', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'baton-hook-'));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  /**
   * The bug this test exists for: Baton's own hardening sets `core.hooksPath=`,
   * which makes `rev-parse --git-path hooks` answer `./`. The hook was written
   * to the repository root, where nothing ever runs it — and nothing reported a
   * problem, so the install looked like it had worked.
   */
  it('finds the real hooks directory despite our own core.hooksPath override', async () => {
    expect(await hooksDir(repo)).toBe(join(repo, '.git', 'hooks'));
  });

  it('honors a repo that configures its own hooks path', async () => {
    await git(['config', 'core.hooksPath', '.husky'], repo);
    expect(await hooksDir(repo)).toBe(join(repo, '.husky'));
  });

  it('installs an executable hook where git will actually run it', async () => {
    expect(await installCommitHook(repo, '/opt/baton/cli.js', '/usr/bin/node')).toBe('installed');
    const file = join(repo, '.git', 'hooks', 'prepare-commit-msg');
    expect(await readFile(file, 'utf-8')).toBe(hookScript('/usr/bin/node', '/opt/baton/cli.js'));
    expect(((await stat(file)).mode & 0o111) !== 0).toBe(true);
    expect(await installCommitHook(repo, '/opt/baton/cli.js', '/usr/bin/node')).toBe('already');
  });

  /** Someone else's hook is their tooling. Clobbering it is not a trade Baton
   *  gets to make on their behalf for a convenience. */
  it('refuses to overwrite a hook it did not write', async () => {
    const dir = join(repo, '.git', 'hooks');
    await mkdir(dir, { recursive: true });
    const theirs = '#!/bin/sh\necho "husky"\n';
    await writeFile(join(dir, 'prepare-commit-msg'), theirs, 'utf-8');

    expect(await installCommitHook(repo, '/opt/baton/cli.js')).toBe('foreign');
    expect(await readFile(join(dir, 'prepare-commit-msg'), 'utf-8')).toBe(theirs);
  });

  it('marks its own hook so overwriting it is safe', () => {
    expect(hookScript('/usr/bin/node', '/cli.js')).toContain(HOOK_MARKER);
  });

  /** A hook that can block `git commit` can strand an agent's work. */
  it('exits 0 on every path', () => {
    const s = hookScript('/usr/bin/node', '/cli.js');
    expect(s).not.toMatch(/exit [1-9]/);
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  /** Amend and merge messages must not be restamped. */
  it('only stamps a plain commit or -m', () => {
    expect(hookScript('/n', '/c')).toContain('""|message) ;;');
  });
});

describe('rebuilding the index from git', () => {
  let root: string;
  let wt: string;

  const row = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
    worktreePath: join(root, 'wt'), baseBranch: 'main', baseCommit: null,
    createdAt: '2026-08-06T10:00:00.000Z', ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-reidx-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    const base = await git(['rev-parse', 'HEAD'], root);

    wt = join(root, 'wt');
    await git(['worktree', 'add', '-q', '-b', 'baton/auth-api', wt], root);
    await saveTasks(root, [row({ baseCommit: base })]);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const commit = async (message: string): Promise<void> => {
    await writeFile(join(wt, 'src', 'a.ts'), `x\n${message}\n`, 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', message], wt);
  };

  /** The storage model's load-bearing claim: losing .baton/ costs nothing
   *  permanent, because the trailers in git put the index back. */
  it('recovers file lineage after the database is deleted', async () => {
    await commit(withTaskTrailer('add the endpoint', 'auth-api'));
    await commit(withTaskTrailer('handle the empty case', 'auth-api'));

    const r = await reindexHistory(root, root);
    expect(r.indexed).toBe(2);
    expect(r.forged).toEqual([]);
    expect(r.untrailed).toBe(0);

    const hits = queryFile(root, 'src/a.ts');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.slug === 'auth-api')).toBe(true);
  });

  it('will not index a commit claiming a task this repo never created', async () => {
    await commit(withTaskTrailer('innocuous', 'someone-elses-task'));
    const r = await reindexHistory(root, root);
    expect(r.indexed).toBe(0);
    expect(r.forged).toEqual([{ sha: expect.any(String) as unknown as string, slug: 'someone-elses-task' }]);
    expect(queryFile(root, 'src/a.ts')).toEqual([]);
  });

  it('counts commits made before the hook existed instead of guessing at them', async () => {
    await commit('no trailer here');
    const r = await reindexHistory(root, root);
    expect(r.untrailed).toBe(1);
    expect(r.indexed).toBe(0);
  });

  it('is idempotent — a second reindex changes nothing', async () => {
    await commit(withTaskTrailer('add the endpoint', 'auth-api'));
    await reindexHistory(root, root);
    const again = await reindexHistory(root, root);
    expect(again.indexed).toBe(1);
    expect(queryFile(root, 'src/a.ts')).toHaveLength(1);   // not duplicated
  });

  /** branchCommits used to read %s — the subject only — so the trailer in the
   *  body was invisible to the one reader that needed it. */
  it('carries the full commit body, not just the subject', async () => {
    await commit(withTaskTrailer('add the endpoint\n\nWhy it matters.', 'auth-api'));
    const [c] = await branchCommits('baton/auth-api', 'main', root);
    expect(c!.message).toBe('add the endpoint');          // subject, as every other caller expects
    expect(c!.body).toContain('Baton-Task: auth-api');
  });
});

/**
 * Reindex walks task BRANCHES, so the index now holds real commits that are not
 * on main. An agent told "src/db.ts was changed by auth-schema" that assumes the
 * change has landed builds against code nowhere it can see.
 */
describe('landed vs still on a branch', () => {
  let root: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-flight-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    const base = await git(['rev-parse', 'HEAD'], root);
    wt = join(root, 'wt');
    await git(['worktree', 'add', '-q', '-b', 'baton/auth-api', wt], root);
    await saveTasks(root, [{
      slug: 'auth-api', task: 'the api', branch: 'baton/auth-api', worktreePath: wt,
      baseBranch: 'main', baseCommit: base, createdAt: '2026-08-06T10:00:00.000Z',
    }]);
    await writeFile(join(wt, 'src', 'a.ts'), 'x\nwork\n', 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', withTaskTrailer('add the endpoint', 'auth-api')], wt);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('does not report reindexed branch work as merged', async () => {
    await reindexHistory(root, root);
    const [hit] = queryFile(root, 'src/a.ts');
    expect(hit!.slug).toBe('auth-api');
    expect(hit!.merged).toBe(false);          // a real change, and it has NOT landed
  });

  it('reports it as merged once the merge is recorded', async () => {
    await reindexHistory(root, root);
    recordMerge(root, {
      slug: 'auth-api', mergedAt: '2026-08-06T12:00:00.000Z',
      archivedRef: 'refs/baton/archive/auth-api', commits: [],
    });
    expect(queryFile(root, 'src/a.ts')[0]!.merged).toBe(true);
  });
});
