import { describe, expect, it } from 'vitest';
import { composeGraphifyIgnore } from '../src/commands/kb.js';

const MARKER = '# baton: generated knowledge-base files (do not index)';

describe('composeGraphifyIgnore', () => {
  it('mirrors the repo .gitignore when creating the file fresh', () => {
    const out = composeGraphifyIgnore('', 'node_modules/\nsecrets/\n*.local\n')!;
    expect(out).toContain('secrets/');           // custom ignore preserved
    expect(out).toContain('*.local');
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

  it('is idempotent — returns null when the managed block is already present', () => {
    const existing = `secrets/\n\n${MARKER}\nCODEBASE.md\nAGENTS.md\nkb/\n`;
    expect(composeGraphifyIgnore(existing, 'whatever\n')).toBeNull();
  });

  it('appends to a user-authored .graphifyignore without mirroring .gitignore', () => {
    // The user already chose to own .graphifyignore — respect it, just add our block.
    const out = composeGraphifyIgnore('build-output/\n', 'should-not-appear/\n')!;
    expect(out).toContain('build-output/');
    expect(out).not.toContain('should-not-appear/');
    expect(out).toContain(MARKER);
  });
});
