import { describe, expect, it } from 'vitest';
import { composeGraphifyIgnore } from '../src/kb/graphifyignore.js';

const MARKER = '# baton: generated knowledge-base files (do not index)';
const BARE = `${MARKER}\nCODEBASE.md\nAGENTS.md\nkb/\n`;

describe('composeGraphifyIgnore', () => {
  it('mirrors the repo .gitignore when creating the file fresh', () => {
    const out = composeGraphifyIgnore('', 'node_modules/\nout-tsc/\nlogs/\n')!;
    expect(out).toContain('out-tsc/');          // custom ignore preserved
    expect(out).toContain('logs/');
    expect(out).toContain('mirrored from .gitignore');
    expect(out).toContain(MARKER);
    expect(out.trimEnd().endsWith('kb/')).toBe(true);
  });

  it('writes just the managed block when there is no .gitignore', () => {
    const out = composeGraphifyIgnore('', null)!;
    expect(out).not.toContain('mirrored from .gitignore');
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).toContain('CODEBASE.md');
  });

  it('upgrades a stale BARE managed file to honour the .gitignore', () => {
    const out = composeGraphifyIgnore(BARE, 'out-tsc/\nlogs/\n');
    expect(out).not.toBeNull();
    expect(out!).toContain('mirrored from .gitignore');
    expect(out!).toContain('out-tsc/');
    expect(out!).toContain(MARKER);
  });

  it('leaves a bare managed file alone when there is no .gitignore to mirror', () => {
    expect(composeGraphifyIgnore(BARE, null)).toBeNull();
    expect(composeGraphifyIgnore(BARE, '   \n')).toBeNull();
  });

  it('is idempotent — returns null when already mirrored + managed', () => {
    const good = composeGraphifyIgnore('', 'out-tsc/\n')!;
    expect(composeGraphifyIgnore(good, 'out-tsc/\n')).toBeNull();
  });

  it('appends to a user-authored .graphifyignore without mirroring .gitignore', () => {
    const out = composeGraphifyIgnore('build-output/\n', 'should-not-appear/\n')!;
    expect(out).toContain('build-output/');
    expect(out).not.toContain('should-not-appear/');
    expect(out).toContain(MARKER);
  });
});
