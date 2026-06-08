import { describe, it, expect } from 'vitest';
import { matchAgentToWorktree } from '../src/agents.js';

describe('matchAgentToWorktree', () => {
  const wt = '/repo/.baton/wt/navbar';

  it('matches when cwd equals the worktree path', () => {
    expect(matchAgentToWorktree(wt, wt)).toBe(true);
  });

  it('matches when cwd is nested inside the worktree', () => {
    expect(matchAgentToWorktree('/repo/.baton/wt/navbar/src', wt)).toBe(true);
  });

  it('does not match a sibling worktree', () => {
    expect(matchAgentToWorktree('/repo/.baton/wt/header', wt)).toBe(false);
  });

  it('does not match a prefix-but-not-boundary path', () => {
    // "navbar-2" must not match "navbar"
    expect(matchAgentToWorktree('/repo/.baton/wt/navbar-2', wt)).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(matchAgentToWorktree('/somewhere/else', wt)).toBe(false);
  });
});
