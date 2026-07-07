import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalTracker, checkFiles } from '../src/signals.js';
import { bus } from '../src/events.js';

describe('checkFiles self-edit exclusion', () => {
  let root: string;
  let tracker: SignalTracker;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-selfsig-'));
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

  it('does not report the caller its own live edits as busy', async () => {
    edit('me', 'src/x.ts');

    // Without exclusion, the file is busy (regression guard).
    const seen = await checkFiles(root, ['src/x.ts']);
    expect(seen['src/x.ts'].busy).toBe(true);

    // Excluding the caller's own slug, it is not busy for them.
    const mine = await checkFiles(root, ['src/x.ts'], 'me');
    expect(mine['src/x.ts'].busy).toBe(false);
    expect(mine['src/x.ts'].by).toEqual([]);
  });

  it('still surfaces OTHER agents editing a file the caller also touched', async () => {
    edit('me', 'src/y.ts');
    edit('other', 'src/y.ts');

    const res = await checkFiles(root, ['src/y.ts'], 'me');
    expect(res['src/y.ts'].busy).toBe(true);
    expect(res['src/y.ts'].by.map((h) => h.slug)).toEqual(['other']);
  });
});
