import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { SignalTracker, getSignals, checkFiles, SIGNAL_WINDOW_MIN, SETTLED_WINDOW_MIN } from '../src/signals.js';
import { batonDir } from '../src/store.js';
import { bus } from '../src/events.js';

/**
 * ISS-15 — read-time hiders must not erase real work. A signal whose path stops
 * being dirty (committed, merged, reverted) is not noise to delete: it is the
 * evidence for "X finished editing Y 2m ago". It settles instead — kept briefly
 * as a dimmed, opt-in entry, invisible to the coordination path (guard /
 * checkFiles) that must only ever wait on genuinely active edits.
 */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-settled-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], root);
  return root;
}

/** Aged past RECONCILE_GRACE_MS so read-time reconcile actually verifies it. */
const edit = (slug: string, path: string) =>
  bus.publish({ type: 'file.edited', slug, path, at: new Date(Date.now() - 60_000).toISOString() });

/** Commit a file inside a worktree so its path is genuinely clean vs HEAD. */
async function commitFile(wt: string, path: string, body: string): Promise<void> {
  await writeFile(join(wt, path), body, 'utf-8');
  await git(['add', path], wt);
  await git(['commit', '-q', '-m', `add ${path}`], wt);
}

const withSettled = { includeSettled: true };

describe('ISS-15 — signals settle instead of being deleted', () => {
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

  it('keeps a signal through its own commit.created as a settled entry', async () => {
    const task = await createTask('settle on commit', root);
    await commitFile(task.worktreePath, 'x.ts', 'export const x = 1;\n');
    edit(task.slug, 'x.ts');

    bus.publish({ type: 'commit.created', slug: task.slug, sha: 'abc123', message: 'add x' });

    // The board can still explain what just happened...
    const shown = await getSignals(root, SIGNAL_WINDOW_MIN, withSettled);
    const sig = shown.find((s) => s.path === 'x.ts');
    expect(sig).toBeDefined();
    expect(sig!.holders[0]!.state).toBe('settled');
    expect(sig!.holders[0]!.settledAt).toBeTruthy();

    // ...while the default (coordination) view treats it as done.
    expect((await getSignals(root)).map((s) => s.path)).not.toContain('x.ts');
  });

  it('settles a committed file at read time with no commit event (daemon-less)', async () => {
    const task = await createTask('settle via reconcile', root);
    await commitFile(task.worktreePath, 'y.ts', 'export const y = 1;\n');
    edit(task.slug, 'y.ts');

    expect((await getSignals(root)).map((s) => s.path)).not.toContain('y.ts');

    const sig = (await getSignals(root, SIGNAL_WINDOW_MIN, withSettled)).find((s) => s.path === 'y.ts');
    expect(sig?.holders[0]?.state).toBe('settled');
  });

  it('flips a re-dirtied path back to active', async () => {
    const task = await createTask('re-dirty', root);
    await commitFile(task.worktreePath, 'z.ts', 'export const z = 1;\n');
    edit(task.slug, 'z.ts');

    await getSignals(root); // settles it
    await writeFile(join(task.worktreePath, 'z.ts'), 'export const z = 2; // wip\n', 'utf-8');

    const sig = (await getSignals(root)).find((s) => s.path === 'z.ts');
    expect(sig).toBeDefined();
    expect(sig!.holders[0]!.state).toBe('active');
    expect(sig!.holders[0]!.settledAt).toBeUndefined();
  });

  it('hard-clears on task.removed — the worktree is gone, nothing to show', async () => {
    const task = await createTask('removed', root);
    await commitFile(task.worktreePath, 'gone.ts', 'export const g = 1;\n');
    edit(task.slug, 'gone.ts');

    bus.publish({ type: 'task.removed', slug: task.slug });

    expect((await getSignals(root, SIGNAL_WINDOW_MIN, withSettled)).map((s) => s.path)).not.toContain('gone.ts');
  });

  it('hides settled entries past the settled window, and reclaims them on the next settle', async () => {
    const task = await createTask('expiry', root);
    await commitFile(task.worktreePath, 'old.ts', 'export const o = 1;\n');
    edit(task.slug, 'old.ts');
    await getSignals(root); // settles it

    // Age the settled stamp past the window (deterministic — no fake timers around git).
    const db = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(batonDir(root), 'history.db'));
    const old = new Date(Date.now() - (SETTLED_WINDOW_MIN + 1) * 60_000).toISOString();
    db.prepare(`UPDATE edit_signals SET settledAt = ? WHERE path = ?`).run(old, 'old.ts');

    // Hiding is enforced by the query, so it holds immediately and unconditionally.
    expect((await getSignals(root, SIGNAL_WINDOW_MIN, withSettled)).map((s) => s.path)).not.toContain('old.ts');

    // Reclamation is housekeeping folded into the settle write path: the next
    // settle sweeps the expired row for good rather than letting it accumulate.
    await commitFile(task.worktreePath, 'next.ts', 'export const n = 1;\n');
    edit(task.slug, 'next.ts');
    await getSignals(root); // settles next.ts → sweeps old.ts

    const left = db.prepare(`SELECT COUNT(*) AS n FROM edit_signals WHERE path = ?`).get('old.ts') as { n: number };
    expect(left.n).toBe(0); // gone, not merely hidden
    db.close();
  });

  // Isolates the signal path via edit-then-revert: a *committed* file would still
  // be busy through checkFiles' committed-but-unmerged union (the conflicts layer),
  // which is intended and separate from ISS-15.
  it('never reports a settled path as busy — a finished edit is not a reason to wait', async () => {
    await commitFile(root, 'free.ts', 'export const f = 1;\n'); // exists on main
    const task = await createTask('not busy', root);
    await writeFile(join(task.worktreePath, 'free.ts'), 'export const f = 2; // wip\n', 'utf-8');
    edit(task.slug, 'free.ts');
    await git(['checkout', '--', 'free.ts'], task.worktreePath); // reverted — never committed

    await getSignals(root); // settles it

    const check = await checkFiles(root, ['free.ts']);
    expect(check['free.ts']!.busy).toBe(false);
    expect(check['free.ts']!.by).toHaveLength(0);
  });

  it('does not fabricate a conflict warning between an active and a settled holder', async () => {
    const a = await createTask('holder a', root);
    const b = await createTask('holder b', root);
    // a settles (committed); b is genuinely still editing the same path.
    await commitFile(a.worktreePath, 'shared.ts', 'export const s = 1;\n');
    await writeFile(join(b.worktreePath, 'shared.ts'), 'export const s = 2; // wip\n', 'utf-8');
    edit(a.slug, 'shared.ts');
    edit(b.slug, 'shared.ts');

    const sig = (await getSignals(root, SIGNAL_WINDOW_MIN, withSettled)).find((s) => s.path === 'shared.ts');
    expect(sig!.holders).toHaveLength(2); // both shown on the board...
    expect(sig!.level).toBe('info'); // ...but only one is actually holding it
  });
});
