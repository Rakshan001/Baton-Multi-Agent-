// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P3 — the dispatcher claims on an agent's behalf, so the identity it claims
 * under has to be the one that agent will report.
 *
 * `resolveSessionSlug()` returns BATON_SLUG, and the dispatcher sets BATON_SLUG
 * to the task slug. Claim under anything else and `groundMovedNotice` greets the
 * agent, on its very first tool call, with "adopted by another agent while you
 * were quiet" — about work it was just handed. It would then correctly stop.
 *
 * This test is the reason `runDispatch` claims with `sessionSlug: slug` rather
 * than with the dispatching process's own session.
 */
import { describe, it, expect, vi } from 'vitest';
import { runDispatch, type DispatchDeps } from '../src/dispatch-run.js';
import type { DispatchLaunch } from '../src/dispatch.js';
import { resolveSessionSlug } from '../src/identity.js';
import { groundMovedNotice } from '../src/mcp-pipeline.js';
import type { Task } from '../src/store.js';
import type { Who } from '../src/lifecycle.js';

const LAUNCH: DispatchLaunch = {
  slug: 'add-auth', agentId: 'claude', nativeId: 'claude',
  mode: 'headless', source: 'plan', skills: [],
};

/** The row `claimTask` would leave behind for whoever the dispatcher claimed as. */
function claimedRow(who: Who): Task {
  return {
    slug: 'add-auth', task: 'Add auth', branch: 'baton/add-auth',
    worktreePath: '/wt/add-auth', baseBranch: 'main', baseCommit: null,
    createdAt: '2026-08-22T10:00:00.000Z', state: 'active',
    claimedBy: { agent: who.agent, sessionSlug: who.sessionSlug, at: '2026-08-22T10:00:00.000Z' },
  } as Task;
}

async function whoTheDispatcherClaimedAs(): Promise<Who> {
  let seen: Who | null = null;
  const deps: DispatchDeps = {
    claim: vi.fn(async (_r, slug, who) => { seen = who; return { slug, worktreePath: `/wt/${slug}`, branch: 'b', task: 't' }; }),
    release: vi.fn(async () => {}),
    installSkills: vi.fn(async () => []),
    writeBriefFor: vi.fn(async () => {}),
    launch: vi.fn(async (req) => ({
      executor: 'local' as const, slug: req.slug, agentId: req.agentId, ref: 'pid:1',
      mode: req.mode, startedAt: 'now', pid: 1, root: '/repo',
    })),
    recordRun: vi.fn(async () => {}),
    publish: vi.fn(),
    now: () => 'now',
  };
  await runDispatch('/repo', [LAUNCH], deps);
  return seen!;
}

describe('a dispatched agent is not told it was adopted', () => {
  it('claims under the slug the agent will resolve as its own session', async () => {
    const who = await whoTheDispatcherClaimedAs();
    expect(resolveSessionSlug({ BATON_SLUG: LAUNCH.slug } as NodeJS.ProcessEnv)).toBe(who.sessionSlug);
  });

  it('so the first tool call gets no notice at all', async () => {
    const who = await whoTheDispatcherClaimedAs();
    const selfSlug = resolveSessionSlug({ BATON_SLUG: LAUNCH.slug } as NodeJS.ProcessEnv);
    expect(groundMovedNotice(claimedRow(who), LAUNCH.slug, selfSlug)).toBeNull();
  });

  it('and the failure this prevents is real, not hypothetical', async () => {
    // Same dispatch, claimed under the dispatching process's session instead.
    const selfSlug = resolveSessionSlug({ BATON_SLUG: LAUNCH.slug } as NodeJS.ProcessEnv);
    const wrong = claimedRow({ agent: 'claude', sessionSlug: 'pid-12345' });
    expect(groundMovedNotice(wrong, LAUNCH.slug, selfSlug)).toMatch(/adopted by/);
  });
});
