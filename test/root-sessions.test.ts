import { describe, it, expect } from 'vitest';
import { rootAgentSummary } from '../src/board.js';

/**
 * A real production hub exposed this: 6 live Claude sessions running at the
 * repo root (no `baton new`, plain terminals) were completely invisible on
 * the dashboard — collectStatus()/detectAgents() is entirely task-worktree-
 * scoped. rootAgentSummary() answers "who else is here right now?" by
 * scanning the hub root + every kb sub-project, excluding anything already
 * attached to a task worktree (that's what StatusRow.agent already covers).
 */
describe('rootAgentSummary', () => {
  const detect = (rows: Array<{ pid: number; agent: string; cwd: string }>) =>
    async () => rows;

  it('groups root sessions by agent with a count', async () => {
    const out = await rootAgentSummary('/hub', ['/hub/proj-a'], [], {
      detect: detect([
        { pid: 1, agent: 'claude', cwd: '/hub' },
        { pid: 2, agent: 'claude', cwd: '/hub' },
        { pid: 3, agent: 'cursor', cwd: '/hub/proj-a' },
      ]),
    });
    expect(out).toEqual([
      { agent: 'claude', count: 2 },
      { agent: 'cursor', count: 1 },
    ]);
  });

  it('is empty when nobody is at the root', async () => {
    const out = await rootAgentSummary('/hub', [], [], { detect: detect([]) });
    expect(out).toEqual([]);
  });
});
