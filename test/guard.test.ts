import { describe, it, expect } from 'vitest';
import { guardTarget, formatGuardMessage, slugFromWorktreePath } from '../src/commands/guard.js';
import type { FileCheck } from '../src/signals.js';

describe('guardTarget — extract the repo-relative file a PreToolUse edit targets', () => {
  const wt = '/repo/.baton/wt/fix-auth';

  it('relativizes Edit/Write/MultiEdit file_path against the worktree root', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(guardTarget({ tool_name: tool, tool_input: { file_path: `${wt}/src/auth.ts` } }, wt)).toBe('src/auth.ts');
    }
  });

  it('ignores non-edit tools and payloads without a file_path', () => {
    expect(guardTarget({ tool_name: 'Read', tool_input: { file_path: `${wt}/src/auth.ts` } }, wt)).toBeNull();
    expect(guardTarget({ tool_name: 'Edit', tool_input: {} }, wt)).toBeNull();
    expect(guardTarget({ tool_name: 'Edit' }, wt)).toBeNull();
  });

  it('ignores files outside the worktree', () => {
    expect(guardTarget({ tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } }, wt)).toBeNull();
  });
});

describe('formatGuardMessage — the advisory note injected into the agent context', () => {
  it('names the holders and their tasks when the file is busy', () => {
    const check: FileCheck = {
      busy: true,
      by: [
        { slug: 'refactor-auth', agent: 'cursor', lastEditAt: new Date(Date.now() - 40_000).toISOString() },
        { slug: 'fix-login', agent: null, lastEditAt: '' },
      ],
    };
    const msg = formatGuardMessage('src/auth.ts', check)!;
    expect(msg).toContain('src/auth.ts');
    expect(msg).toContain('refactor-auth');
    expect(msg).toContain('cursor');
    expect(msg).toContain('fix-login');
    expect(msg).toMatch(/check_files|get_report/); // points the agent at the coordination tools
  });

  it('includes the holder\'s progress note when they reported one', () => {
    const check: FileCheck = {
      busy: true,
      by: [{ slug: 'refactor-auth', agent: 'cursor', lastEditAt: new Date().toISOString(), note: 'rewriting the refresh flow' }],
    };
    expect(formatGuardMessage('src/auth.ts', check)).toContain('rewriting the refresh flow');
  });

  it('returns null when the file is free (zero happy-path tokens)', () => {
    expect(formatGuardMessage('src/auth.ts', { busy: false, by: [] })).toBeNull();
  });
});

describe('slugFromWorktreePath — self-identity fallback when BATON_SLUG is absent', () => {
  it('extracts the slug from a .baton/wt path', () => {
    expect(slugFromWorktreePath('/repo/.baton/wt/fix-auth')).toBe('fix-auth');
    expect(slugFromWorktreePath('/repo/.baton/wt/fix-auth/sub/dir')).toBe('fix-auth');
  });
  it('returns undefined outside a baton worktree', () => {
    expect(slugFromWorktreePath('/repo')).toBeUndefined();
  });
});
