import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalTracker, checkFiles, getSignals, setProgress, getProgress, clearProgress } from '../src/signals.js';
import { bus } from '../src/events.js';

describe('task progress notes', () => {
  let root: string;
  let tracker: SignalTracker;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-progress-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    tracker = new SignalTracker(root);
    tracker.start();
  });
  afterEach(async () => {
    tracker.stop();
    await rm(root, { recursive: true, force: true });
  });

  const edit = (slug: string, path: string) =>
    bus.publish({ type: 'file.edited', slug, path, at: new Date().toISOString() });

  it('stores and reads back a note per task', () => {
    setProgress(root, 'fix-auth', 'refactoring token expiry, ~2 commits left');
    expect(getProgress(root).get('fix-auth')?.note).toBe('refactoring token expiry, ~2 commits left');
  });

  it('latest note wins (one line per task)', () => {
    setProgress(root, 'fix-auth', 'first');
    setProgress(root, 'fix-auth', 'second');
    expect(getProgress(root).get('fix-auth')?.note).toBe('second');
  });

  it('surfaces the note on the holder in getSignals and checkFiles', async () => {
    edit('fix-auth', 'src/auth.ts');
    setProgress(root, 'fix-auth', 'rewriting the refresh flow');

    const sig = (await getSignals(root)).find((s) => s.path === 'src/auth.ts');
    expect(sig?.holders[0].note).toBe('rewriting the refresh flow');

    const check = await checkFiles(root, ['src/auth.ts']);
    expect(check['src/auth.ts'].by[0].note).toBe('rewriting the refresh flow');
  });

  it('clears a note (and commit.created clears it via the tracker)', () => {
    setProgress(root, 'fix-auth', 'wip');
    clearProgress(root, 'fix-auth');
    expect(getProgress(root).get('fix-auth')).toBeUndefined();

    setProgress(root, 'fix-auth', 'wip again');
    bus.publish({ type: 'commit.created', slug: 'fix-auth', sha: 'abc', message: 'done', at: new Date().toISOString() });
    expect(getProgress(root).get('fix-auth')).toBeUndefined();
  });
});
