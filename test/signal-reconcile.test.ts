import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { SignalTracker, getSignals, registerHookSession } from '../src/signals.js';
import { bus } from '../src/events.js';

/**
 * P6 — lazy read-time reconciliation. With no daemon / no dashboard tab open,
 * `commit.created` never fires, so a signal for a file that has since been
 * committed or reverted would linger in the "editing now" view up to the 30-min
 * TTL. getSignals must drop a signal whose path is no longer dirty in the task's
 * worktree — but must NOT drop a signal for a file that is genuinely still being
 * worked on, including a brand-new untracked file (which `git diff HEAD` omits).
 */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-reconcile-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], root);
  return root;
}

describe('getSignals — lazy read-time reconciliation (P6)', () => {
  let root: string;
  let tracker: SignalTracker;

  beforeEach(async () => {
    root = await initRepo();
    tracker = new SignalTracker(root);
    tracker.start();
  });
  afterEach(async () => {
    tracker.stop();
    await rm(root, { recursive: true, force: true });
  });

  // Aged past the reconcile grace period (G2): brand-new signals are kept
  // unverified because the guard hook records BEFORE the file hits disk.
  const edit = (slug: string, path: string) =>
    bus.publish({ type: 'file.edited', slug, path, at: new Date(Date.now() - 60_000).toISOString() });

  it('drops a signal once the file is committed in the worktree (no commit.created event)', async () => {
    const task = await createTask('reconcile committed file', root);
    await writeFile(join(task.worktreePath, 'x.ts'), 'export const x = 1;\n', 'utf-8');
    await git(['add', 'x.ts'], task.worktreePath);
    await git(['commit', '-q', '-m', 'add x'], task.worktreePath);

    edit(task.slug, 'x.ts'); // signal lingers; no daemon cleared it

    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).not.toContain('x.ts');
  });

  it('keeps a signal for a file with genuine uncommitted changes', async () => {
    const task = await createTask('reconcile dirty file', root);
    // create + commit so the path is tracked, then modify without committing
    await writeFile(join(task.worktreePath, 'y.ts'), 'export const y = 1;\n', 'utf-8');
    await git(['add', 'y.ts'], task.worktreePath);
    await git(['commit', '-q', '-m', 'add y'], task.worktreePath);
    await writeFile(join(task.worktreePath, 'y.ts'), 'export const y = 2; // wip\n', 'utf-8');

    edit(task.slug, 'y.ts');

    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).toContain('y.ts');
  });

  it('keeps a signal for a brand-new untracked file being created (git diff HEAD omits it)', async () => {
    const task = await createTask('reconcile new file', root);
    await writeFile(join(task.worktreePath, 'brand-new.ts'), 'export const n = 1;\n', 'utf-8');
    // never `git add`ed — untracked

    edit(task.slug, 'brand-new.ts');

    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).toContain('brand-new.ts');
  });

  /**
   * "Cannot verify" and "provably gone" are different states, and the original
   * fail-open rule collapsed them. A slug with no task, no session and no watched
   * checkout has no worktree left to re-dirty its paths — keeping its signals
   * held every path forever. Observed in a real hub: a task removed by
   * `baton clean --fix` (a separate CLI process, so the daemon's in-memory
   * `task.removed` never reached SignalTracker.clear) left 791 paths pinned as
   * "editing right now", and an earlier one sat there for nine days.
   */
  it('clears signals for a holder that is provably gone (no task, session or checkout)', async () => {
    edit('removed-task', 'somewhere.ts');
    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).not.toContain('somewhere.ts');
  });

  // The grace window still protects the create race: a hook can record an edit a
  // moment before `baton new` writes tasks.json. Only aged orphans are cleared.
  it('keeps a just-recorded signal for an unknown slug (create race, within grace)', async () => {
    bus.publish({ type: 'file.edited', slug: 'not-yet-a-task', path: 'racing.ts', at: new Date().toISOString() });
    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).toContain('racing.ts');
  });

  /**
   * The same failure with a task record still present: `baton doctor` calls this
   * an "orphaned worktree (stale task)". git can't read a directory that isn't
   * there, so fail-open pinned these paths too. Existence of the checkout — not
   * whether we know the slug — is what separates "gone" from "unreadable".
   */
  it('clears signals for a task whose worktree directory is gone', async () => {
    const task = await createTask('worktree deleted underneath', root);
    await writeFile(join(task.worktreePath, 'w.ts'), 'export const w = 1;\n', 'utf-8');
    edit(task.slug, 'w.ts');
    await rm(task.worktreePath, { recursive: true, force: true });

    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).not.toContain('w.ts');
  });

  /**
   * Fail-open is preserved where it is genuinely correct: the checkout EXISTS,
   * git just cannot answer for it right now (spawn failure, not-a-repo, transient
   * FS error). Such a signal must survive — dropping it would tell an agent a
   * held path is free. A registered session root is used because any path under
   * a repo would resolve upward to that repo instead of failing.
   */
  it('fails open: keeps a signal when the checkout exists but git cannot read it', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'baton-notarepo-'));
    try {
      registerHookSession(root, 'sess-live', 'claude', notARepo);
      edit('sess-live', 'z.ts');
      const signals = await getSignals(root);
      expect(signals.map((s) => s.path)).toContain('z.ts');
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
