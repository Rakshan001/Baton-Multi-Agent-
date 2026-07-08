import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { SignalTracker, getSignals } from '../src/signals.js';
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

  const edit = (slug: string, path: string) =>
    bus.publish({ type: 'file.edited', slug, path, at: new Date().toISOString() });

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

  it('fails open: keeps a signal whose slug has no matching task (cannot verify)', async () => {
    edit('ghost-slug', 'somewhere.ts');
    const signals = await getSignals(root);
    expect(signals.map((s) => s.path)).toContain('somewhere.ts');
  });
});
