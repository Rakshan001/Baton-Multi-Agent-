import { describe, it, expect } from 'vitest';
import { delimiter } from 'node:path';
import { ensureBinPath, commonBinDirs } from '../src/util/path-env.js';

describe('ensureBinPath', () => {
  it('appends missing common bin dirs (POSIX)', () => {
    if (process.platform === 'win32') return; // no-op on Windows
    const env = { PATH: '/usr/bin' };
    ensureBinPath(env);
    const parts = env.PATH.split(delimiter);
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
  });

  it('is idempotent and never reorders existing entries', () => {
    if (process.platform === 'win32') return;
    const env = { PATH: '/opt/homebrew/bin:/my/custom' };
    ensureBinPath(env);
    expect(env.PATH.startsWith('/opt/homebrew/bin:/my/custom')).toBe(true); // existing kept first
    const after = env.PATH;
    ensureBinPath(env);
    expect(env.PATH).toBe(after); // second pass changes nothing
  });

  it('handles an empty PATH', () => {
    if (process.platform === 'win32') return;
    const env: NodeJS.ProcessEnv = {};
    ensureBinPath(env);
    expect(env.PATH?.split(delimiter)).toEqual(commonBinDirs());
  });
});
