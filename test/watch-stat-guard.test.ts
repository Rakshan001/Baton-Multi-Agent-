/**
 * `isDirectory` runs inside the fs-watch debounce timer — a bare setTimeout
 * callback, in a process with no `uncaughtException` handler. A throw there is
 * not a lost event; it is daemon death (watchers, SSE, poller, coordination).
 *
 * `statSync(p, { throwIfNoEntry: false })` suppresses ENOENT/ENOTDIR ONLY. It
 * still throws on ELOOP and EACCES, both of which a real checkout can produce:
 * a self-referential symlink, or a parent whose permissions change between the
 * fs event and the 300ms debounce firing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirectory } from '../src/watch.js';

describe('watch — isDirectory never throws out of the debounce timer', () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'baton-statguard-')); });
  afterEach(async () => {
    await chmod(join(base, 'locked'), 0o755).catch(() => {}); // so rm can descend
    await rm(base, { recursive: true, force: true });
  });

  it('survives a symlink loop (ELOOP)', async () => {
    const loop = join(base, 'loop');
    await symlink(loop, loop); // points at itself

    // Establish that the raw call really does throw — otherwise this test
    // passes for the wrong reason and pins nothing.
    expect(() => statSync(loop, { throwIfNoEntry: false })).toThrow();
    expect(isDirectory(loop)).toBe(false);
  });

  it('survives an unreadable parent directory (EACCES)', async () => {
    const locked = join(base, 'locked');
    await mkdir(locked);
    const inside = join(locked, 'file.ts');
    await writeFile(inside, 'x', 'utf-8');
    await chmod(locked, 0o000);

    // Running as root defeats permission checks — skip rather than assert a
    // throw that cannot happen.
    let raw: unknown;
    try { statSync(inside, { throwIfNoEntry: false }); raw = 'no-throw'; } catch { raw = 'threw'; }
    if (raw === 'no-throw') return; // root, or a filesystem without POSIX perms

    expect(isDirectory(inside)).toBe(false);
  });

  it('still answers correctly for the ordinary cases it exists to judge', async () => {
    const dir = join(base, 'src');
    await mkdir(dir);
    const file = join(dir, 'a.ts');
    await writeFile(file, 'x', 'utf-8');

    expect(isDirectory(dir)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(join(base, 'gone'))).toBe(false); // deleted path stays recordable
  });
});
