/**
 * Multi-repo hub support: the git repos are sub-projects listed in kb.json,
 * while the hub root may be plain or git-initialized for coordination metadata.
 * These tests lock down resolving the Baton root and creating a task whose
 * worktree branches off a chosen sub-project instead of the hub root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { git } from '../src/util/exec.js';
import { branchExists } from '../src/git.js';
import { loadTasks, resolveBatonRoot } from '../src/store.js';
import { createTask, ProjectRequiredError, UnknownProjectError } from '../src/commands/new.js';
import { mergeTaskBranch } from '../src/commands/merge.js';
import { removeTaskWorktree } from '../src/commands/rm.js';
import { collectStatus } from '../src/board.js';
import { checkFiles, getSignals, recordHookEdit } from '../src/signals.js';

/** A git sub-repo with one commit on `main`. */
async function initSubRepo(root: string): Promise<void> {
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), '# sub\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
}

/** A hub: a plain (non-git) folder with `.baton/` + a kb.json listing sub-repos. */
async function initHub(): Promise<{ hub: string; projA: string; projB: string }> {
  const hub = await mkdtemp(join(tmpdir(), 'baton-hub-'));
  const projA = join(hub, 'proj-a');
  const projB = join(hub, 'proj-b');
  await mkdir(projA, { recursive: true });
  await mkdir(projB, { recursive: true });
  await initSubRepo(projA);
  await initSubRepo(projB);
  await mkdir(join(hub, '.baton'), { recursive: true });
  await writeFile(
    join(hub, '.baton', 'kb.json'),
    JSON.stringify({
      root: hub,
      projects: [
        { id: 'proj-a', name: 'proj-a', path: projA, graphPath: join(projA, 'graphify-out', 'graph.json') },
        { id: 'proj-b', name: 'proj-b', path: projB, graphPath: join(projB, 'graphify-out', 'graph.json') },
      ],
      mergedGraphPath: join(hub, '.baton', 'kb', 'merged-graph.json'),
      lastBuiltAt: null,
    }),
    'utf-8',
  );
  return { hub, projA, projB };
}

describe('resolveBatonRoot', () => {
  it('returns the hub root (a non-git folder that holds .baton/)', async () => {
    const { hub } = await initHub();
    try {
      expect(await resolveBatonRoot(hub)).toBe(hub);
    } finally {
      await rm(hub, { recursive: true, force: true });
    }
  });

  it('walks up from a sub-directory to the nearest .baton/', async () => {
    const { hub, projA } = await initHub();
    try {
      // From inside a sub-repo with no .baton of its own, resolve up to the hub.
      expect(await resolveBatonRoot(projA)).toBe(hub);
    } finally {
      await rm(hub, { recursive: true, force: true });
    }
  });
});

describe('createTask on a multi-repo hub', () => {
  let hub: string, projA: string, projB: string;
  beforeEach(async () => { ({ hub, projA, projB } = await initHub()); });
  afterEach(async () => { await rm(hub, { recursive: true, force: true }); });

  it('branches the worktree off the chosen sub-project, not the hub root', async () => {
    const task = await createTask('Fix the checkout crash', hub, 'proj-a');
    expect(task.slug).toBe('fix-the-checkout-crash');
    expect(task.projectId).toBe('proj-a');
    expect(task.repoRoot).toBe(projA);
    // The worktree lives under the hub's .baton/wt, but the branch is in proj-a.
    expect(task.worktreePath).toBe(join(hub, '.baton', 'wt', task.slug));
    expect(existsSync(task.worktreePath)).toBe(true);
    expect(await branchExists('baton/fix-the-checkout-crash', projA)).toBe(true);
    expect(await branchExists('baton/fix-the-checkout-crash', projB)).toBe(false);
    // Recorded in the hub's tasks.json.
    const tasks = await loadTasks(hub);
    expect(tasks.map((t) => t.slug)).toContain(task.slug);
  });

  it('rejects task creation on a hub when no project is chosen', async () => {
    await expect(createTask('Do something', hub)).rejects.toBeInstanceOf(ProjectRequiredError);
  });

  it('still requires a project when the hub root is git-initialized', async () => {
    await git(['init', '-q'], hub);
    await git(['config', 'user.email', 'test@baton.dev'], hub);
    await git(['config', 'user.name', 'Baton Test'], hub);
    await git(['checkout', '-q', '-b', 'main'], hub);

    await expect(createTask('Do something', hub)).rejects.toBeInstanceOf(ProjectRequiredError);

    const task = await createTask('Fix the hub picker', hub, 'proj-a');
    expect(task.projectId).toBe('proj-a');
    expect(task.repoRoot).toBe(projA);
    expect(await branchExists(task.branch, projA)).toBe(true);
    expect(await branchExists(task.branch, hub)).toBe(false);
  });

  it('rejects an unknown project id', async () => {
    await expect(createTask('Do something', hub, 'nope')).rejects.toBeInstanceOf(UnknownProjectError);
  });

  /**
   * Per-task git questions must be asked of the task's OWN repo. Both of these
   * used to be asked of the served root, and both failure modes are SILENT:
   * `aheadBehind` returns {0,0} on any error, and `changedFiles` skips a failed
   * diff. On a hub the served root is not the branch's repo, so the board drew
   * every task as having nothing to merge and overlap detection went blind to
   * everything already committed.
   */
  it('reports a sub-project task as ahead of its base — asked of the task\'s repo, not the hub', async () => {
    const task = await createTask('Add a banner', hub, 'proj-a');
    await fsWriteFile(join(task.worktreePath, 'banner.txt'), 'hi\n', 'utf-8');
    await git(['add', '.'], task.worktreePath);
    await git(['commit', '-q', '-m', 'add banner'], task.worktreePath);

    const rows = await collectStatus(hub);
    const row = rows.find((r) => r.slug === task.slug)!;
    expect(row.ahead).toBe(1);
    expect(row.behind).toBe(0);
  });

  it('sees a COMMITTED change when detecting overlap between two hub tasks', async () => {
    // Both tasks touch shared.txt in the same repo, and each COMMITS it — the
    // uncommitted half of changedFiles finds nothing, so if the committed half
    // is asked of the wrong repo the overlap vanishes entirely.
    const a = await createTask('Task one', hub, 'proj-a');
    const b = await createTask('Task two', hub, 'proj-a');
    for (const t of [a, b]) {
      await fsWriteFile(join(t.worktreePath, 'shared.txt'), `${t.slug}\n`, 'utf-8');
      await git(['add', '.'], t.worktreePath);
      await git(['commit', '-q', '-m', `touch shared from ${t.slug}`], t.worktreePath);
    }

    const rows = await collectStatus(hub);
    expect(rows.find((r) => r.slug === a.slug)!.conflictFiles).toContain('shared.txt');
    expect(rows.find((r) => r.slug === b.slug)!.conflictFiles).toContain('shared.txt');
  });

  it('does NOT fabricate a conflict between identical paths in DIFFERENT projects', async () => {
    // `src/index.ts` in proj-a and `src/index.ts` in proj-b are two unrelated
    // files that merely spell the same relative path. Warning on them is worse
    // than saying nothing: a coordination signal that cries wolf on every
    // conventional filename is one agents learn to scroll past.
    const a = await createTask('Task in a', hub, 'proj-a');
    const b = await createTask('Task in b', hub, 'proj-b');
    for (const t of [a, b]) {
      await mkdir(join(t.worktreePath, 'src'), { recursive: true });
      await fsWriteFile(join(t.worktreePath, 'src', 'index.ts'), `// ${t.slug}\n`, 'utf-8');
      await git(['add', '.'], t.worktreePath);
      await git(['commit', '-q', '-m', `touch index from ${t.slug}`], t.worktreePath);
    }

    const rows = await collectStatus(hub);
    expect(rows.find((r) => r.slug === a.slug)!.conflictFiles).toEqual([]);
    expect(rows.find((r) => r.slug === b.slug)!.conflictFiles).toEqual([]);
  });

  it('answers check_files per project — busy in my repo, free across repos', async () => {
    // The same question the edit guard and the check_files MCP tool ask before
    // an agent touches a file. Answering "busy" because an unrelated repo has a
    // file of that name is how a coordination tool gets muted.
    const a = await createTask('Holder in a', hub, 'proj-a');
    const sameRepo = await createTask('Asker in a', hub, 'proj-a');
    const otherRepo = await createTask('Asker in b', hub, 'proj-b');
    await mkdir(join(a.worktreePath, 'src'), { recursive: true });
    await fsWriteFile(join(a.worktreePath, 'src', 'index.ts'), '// held\n', 'utf-8');
    await git(['add', '.'], a.worktreePath);
    await git(['commit', '-q', '-m', 'hold index'], a.worktreePath);

    const asSameRepo = (await checkFiles(hub, ['src/index.ts'], sameRepo.slug))['src/index.ts'];
    expect(asSameRepo.busy).toBe(true);
    expect(asSameRepo.by.map((h) => h.slug)).toContain(a.slug);

    const asOtherRepo = (await checkFiles(hub, ['src/index.ts'], otherRepo.slug))['src/index.ts'];
    expect(asOtherRepo.busy).toBe(false);
    expect(asOtherRepo.by).toEqual([]);
  });

  it('keeps a live cross-project edit at info — both holders shown, no overlap warning', async () => {
    // Every repo has a README.md. Two agents editing their own one are not in
    // each other's way, and `warning` is what pushes a signal.overlap event to
    // both of them.
    const a = await createTask('Live in a', hub, 'proj-a');
    const b = await createTask('Live in b', hub, 'proj-b');
    for (const t of [a, b]) {
      await fsWriteFile(join(t.worktreePath, 'README.md'), `# ${t.slug}\n`, 'utf-8'); // dirty, so it survives reconcile
      recordHookEdit(hub, { slug: t.slug, path: 'README.md' });
    }

    const row = (await getSignals(hub)).find((s) => s.path === 'README.md')!;
    expect(row.holders.map((h) => h.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(row.level).toBe('info');
  });

  it('merges a sub-project task back into its own repo, then removes the worktree', async () => {
    const task = await createTask('Add a changelog', hub, 'proj-b');
    // Make a commit in the worktree so there is something to merge.
    await fsWriteFile(join(task.worktreePath, 'CHANGELOG.md'), '# changes\n', 'utf-8');
    await git(['add', '.'], task.worktreePath);
    await git(['commit', '-q', '-m', 'add changelog'], task.worktreePath);

    const result = await mergeTaskBranch(task.slug, { squash: true, archive: true }, hub);
    expect(result.merged).toBe(task.slug);
    expect(result.into).toBe('main'); // proj-b's current branch, not the hub
    // The change landed on proj-b's main.
    const log = await git(['-C', projB, 'log', '--oneline', 'main'], projB);
    expect(log).toContain('Add a changelog');

    await removeTaskWorktree(task.slug, {}, hub);
    expect(existsSync(task.worktreePath)).toBe(false);
    expect(await branchExists(task.branch, projB)).toBe(false);
    expect((await loadTasks(hub)).map((t) => t.slug)).not.toContain(task.slug);
  });
});
