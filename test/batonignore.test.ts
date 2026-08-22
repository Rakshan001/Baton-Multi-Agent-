// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { composeBatonGitignore, BATON_GITIGNORE_START } from '../src/kb/batonignore.js';

describe('composeBatonGitignore — gitignore the footprint `kb init` writes', () => {
  it('creates the managed block on a fresh repo (local mode ignores CODEBASE.md)', () => {
    const out = composeBatonGitignore('', false)!;
    expect(out).toContain(BATON_GITIGNORE_START);
    for (const e of ['.baton/*', 'graphify-out/', '.graphifyignore', '.mcp.json', 'CODEBASE.md']) {
      expect(out).toContain(e);
    }
  });

  it('leaves .baton/agents.json committable — the docs tell teams to share it', () => {
    const out = composeBatonGitignore('', false)!;
    // `.baton/*` with a negation, never `.baton/`: git does not descend into
    // an ignored directory, so a dir-ignore would make the negation dead.
    expect(out).toContain('!**/.baton/agents.json');
    expect(out).not.toMatch(/^(\*\*\/)?\.baton\/$/m);
  });

  it('keeps CODEBASE.md tracked in share mode (teammates get the map)', () => {
    const out = composeBatonGitignore('', true)!;
    expect(out).toContain('.baton/*');
    expect(out).not.toContain('CODEBASE.md');
  });

  it('appends to an existing user .gitignore without clobbering it', () => {
    const out = composeBatonGitignore('node_modules/\ndist/\n', false)!;
    expect(out).toContain('node_modules/');
    expect(out).toContain('dist/');
    expect(out).toContain(BATON_GITIGNORE_START);
    expect(out.indexOf('node_modules/')).toBeLessThan(out.indexOf(BATON_GITIGNORE_START));
  });

  it('is idempotent — a second run makes no change', () => {
    const once = composeBatonGitignore('node_modules/\n', false)!;
    expect(composeBatonGitignore(once, false)).toBeNull();
  });

  it('replaces the managed block when share mode toggles (drops CODEBASE.md)', () => {
    const local = composeBatonGitignore('node_modules/\n', false)!;
    expect(local).toContain('CODEBASE.md');
    const shared = composeBatonGitignore(local, true)!;
    expect(shared).not.toContain('CODEBASE.md');
    expect(shared).toContain('node_modules/');
    // only one managed block, not two
    expect(shared.split(BATON_GITIGNORE_START)).toHaveLength(2);
  });

  it('no-ops on a hub root whose .gitignore already ignores everything (/*)', () => {
    expect(composeBatonGitignore('/*\n!/.gitignore\n!/kb/\n', false)).toBeNull();
  });
});
