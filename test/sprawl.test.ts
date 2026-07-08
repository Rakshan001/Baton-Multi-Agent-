import { describe, it, expect } from 'vitest';
import { scanDocSprawl } from '../src/kb/sprawl.js';

/**
 * P12 — `.md`-sprawl scan (propose-only). Detects the scattered agent files
 * that Baton exists to replace: a `memory-bank/` dir, stray NOTES/TODO files,
 * and multiple competing per-agent rule files. Must stay LOW false-positive:
 * a clean repo, legit organized docs, and Baton's own CLAUDE.md+AGENTS.md pair
 * must produce nothing.
 */
describe('scanDocSprawl (P12)', () => {
  it('flags a memory-bank/ directory as one finding listing its files', () => {
    const f = scanDocSprawl(['memory-bank/decisions.md', 'memory-bank/progress.md', 'src/x.ts']);
    const mb = f.find((x) => x.kind === 'memory-bank');
    expect(mb).toBeDefined();
    expect([...mb!.paths].sort()).toEqual(['memory-bank/decisions.md', 'memory-bank/progress.md']);
  });

  it('flags stray NOTES.md / TODO-*.md but not organized docs or legit root files', () => {
    const f = scanDocSprawl(['NOTES.md', 'TODO-refactor.md', 'docs/guide.md', 'README.md', 'CHANGELOG.md']);
    const notes = f.find((x) => x.kind === 'stray-notes');
    expect([...notes!.paths].sort()).toEqual(['NOTES.md', 'TODO-refactor.md']);
  });

  it('flags 2+ distinct agents’ rule files as duplicate-rules', () => {
    const f = scanDocSprawl(['.cursorrules', 'GEMINI.md', 'src/a.ts']);
    expect(f.find((x) => x.kind === 'duplicate-rules')).toBeDefined();
  });

  it('does NOT flag a clean repo with a legit AGENTS.md + CLAUDE.md pair', () => {
    expect(scanDocSprawl(['AGENTS.md', 'CLAUDE.md', 'README.md', 'src/a.ts', 'docs/how.md'])).toEqual([]);
  });

  it('does NOT flag multiple Cursor rule files alone (one agent, a legit pattern)', () => {
    const f = scanDocSprawl(['.cursor/rules/a.mdc', '.cursor/rules/b.mdc']);
    expect(f.find((x) => x.kind === 'duplicate-rules')).toBeUndefined();
  });

  it('ignores the Baton / tooling footprint', () => {
    expect(scanDocSprawl(['.baton/memory/facts/x.md', 'node_modules/pkg/NOTES.md', 'dist/NOTES.md'])).toEqual([]);
  });
});
