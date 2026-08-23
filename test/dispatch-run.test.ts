// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P3 step 4 — carrying out a dispatch.
 *
 * The decision is pure and tested elsewhere. This is the part with consequences:
 * a claim is written, a worktree is built, a brief lands on disk and a process
 * starts. Every ordering here exists because of a specific bad state:
 *
 *   claim before spawn   — `startAgent` needs a materialized worktree, and only
 *                          `claimTask` builds one
 *   brief before launch  — the prompt is a pointer to HANDOFF.md; launching
 *                          first races the agent against its own brief
 *   release on failure   — a claimed task with no process looks busy and isn't,
 *                          and holds its phase against everyone (P3-E7)
 */
import { describe, it, expect, vi } from 'vitest';
import { runDispatch, type DispatchDeps } from '../src/dispatch-run.js';
import type { DispatchLaunch } from '../src/dispatch.js';

const LAUNCH: DispatchLaunch = {
  slug: 'add-auth', agentId: 'claude', nativeId: 'claude', mode: 'headless',
  source: 'plan', skills: [], model: 'sonnet',
};

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    claim: vi.fn(async (_root: string, slug: string, _who: unknown, _o: unknown) => ({
      slug, worktreePath: `/wt/${slug}`, branch: `baton/${slug}`, task: 'Add auth',
    })),
    release: vi.fn(async () => {}),
    installSkills: vi.fn(async () => []),
    writeBriefFor: vi.fn(async () => {}),
    launch: vi.fn(async (req) => ({
      executor: 'local' as const, slug: req.slug, agentId: req.agentId, ref: 'pid:42',
      mode: req.mode, startedAt: '2026-08-22T10:00:00.000Z', pid: 42, root: '/repo',
    })),
    recordRun: vi.fn(async () => {}),
    publish: vi.fn(),
    now: () => '2026-08-22T10:00:00.000Z',
    ...over,
  };
}

describe('runDispatch — the happy path', () => {
  it('claims, briefs, then launches, in that order', async () => {
    const order: string[] = [];
    const d = deps({
      claim: vi.fn(async (_r: string, slug: string) => { order.push('claim'); return { slug, worktreePath: `/wt/${slug}`, branch: 'b', task: 't' }; }),
      writeBriefFor: vi.fn(async () => { order.push('brief'); }),
      launch: vi.fn(async (req) => { order.push('launch'); return { executor: 'local' as const, slug: req.slug, agentId: req.agentId, ref: 'pid:1', mode: req.mode, startedAt: 'now', pid: 1, root: '/repo' }; }),
    });
    const r = await runDispatch('/repo', [LAUNCH], d);
    expect(order).toEqual(['claim', 'brief', 'launch']);
    expect(r.started).toHaveLength(1);
  });

  it('claims with the task slug as the session, so the agent is not "adopted"', async () => {
    // `resolveSessionSlug()` returns BATON_SLUG, which spawn.ts sets to the task
    // slug. Claiming under any other session makes `groundMovedNotice` tell the
    // agent it was adopted by someone else on its very first tool call.
    const d = deps();
    await runDispatch('/repo', [LAUNCH], d);
    expect(d.claim).toHaveBeenCalledWith('/repo', 'add-auth', { agent: 'claude', sessionSlug: 'add-auth' }, { override: false });
  });

  it('launches inside the worktree the claim built, never the main checkout', async () => {
    const d = deps();
    await runDispatch('/repo', [LAUNCH], d);
    expect(vi.mocked(d.launch).mock.calls[0]![0]).toMatchObject({ cwd: '/wt/add-auth' });
  });

  it('hands the agent a pointer, never the plan prose', async () => {
    // Plan text is untrusted input that arrived by git. Everything it says
    // belongs behind a fence in HANDOFF.md, not in the instruction channel.
    const d = deps();
    await runDispatch('/repo', [LAUNCH], d);
    const { prompt } = vi.mocked(d.launch).mock.calls[0]![0];
    expect(prompt).toMatch(/HANDOFF\.md/);
    expect(prompt).toContain('add-auth');
    expect(prompt.length).toBeLessThan(400);
    expect(prompt).not.toContain('Add auth');
  });

  it('sets the identity env the MCP tools read back', async () => {
    const d = deps();
    await runDispatch('/repo', [LAUNCH], d);
    expect(vi.mocked(d.launch).mock.calls[0]![0].env).toMatchObject({
      BATON_ROOT: '/repo', BATON_SLUG: 'add-auth', BATON_AGENT: 'claude',
    });
  });

  it('records the run and announces it', async () => {
    const d = deps();
    await runDispatch('/repo', [LAUNCH], d);
    expect(d.recordRun).toHaveBeenCalledWith('/repo', expect.objectContaining({ slug: 'add-auth', pid: 42 }));
    expect(d.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'dispatch.started', slug: 'add-auth', agent: 'claude' }));
  });
});

describe('runDispatch — P3-E7: a claim that cannot become a run is released', () => {
  it('releases the claim when the launch throws', async () => {
    const d = deps({ launch: vi.fn(async () => { throw new Error('spawn ENOENT'); }) });
    const r = await runDispatch('/repo', [LAUNCH], d);
    expect(d.release).toHaveBeenCalledWith('/repo', 'add-auth');
    expect(r.started).toEqual([]);
    expect(r.failed[0]).toMatchObject({ slug: 'add-auth', code: 'launch-failed' });
    expect(r.failed[0]!.reason).toContain('ENOENT');
  });

  it('releases the claim when the brief cannot be written', async () => {
    // An agent started against a missing brief reads nothing and does nothing.
    const d = deps({ writeBriefFor: vi.fn(async () => { throw new Error('EACCES'); }) });
    const r = await runDispatch('/repo', [LAUNCH], d);
    expect(d.release).toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(r.failed[0]!.code).toBe('brief-failed');
  });

  it('reports the release failing too, rather than swallowing it', async () => {
    // A claim that could not be released is exactly the stuck state, and the
    // operator is the only one who can clear it. Saying so is the whole job.
    const d = deps({
      launch: vi.fn(async () => { throw new Error('nope'); }),
      release: vi.fn(async () => { throw new Error('tasks.json is locked'); }),
    });
    const r = await runDispatch('/repo', [LAUNCH], d);
    expect(r.failed[0]!.reason).toMatch(/still claimed/i);
    expect(r.failed[0]!.reason).toMatch(/baton (start|cancel)/);
  });

  it('a refused claim is not a failure to release — nothing was taken', async () => {
    const d = deps({ claim: vi.fn(async () => { throw new Error('already held by codex'); }) });
    const r = await runDispatch('/repo', [LAUNCH], d);
    expect(d.release).not.toHaveBeenCalled();
    expect(r.failed[0]).toMatchObject({ code: 'claim-refused' });
  });

  it('one task failing does not stop the rest of the dispatch', async () => {
    const second = { ...LAUNCH, slug: 'add-ui', agentId: 'codex', nativeId: 'codex' };
    const d = deps({
      launch: vi.fn(async (req) => {
        if (req.slug === 'add-auth') throw new Error('boom');
        return { executor: 'local' as const, slug: req.slug, agentId: req.agentId, ref: 'pid:2', mode: req.mode, startedAt: 'now', pid: 2, root: '/repo' };
      }),
    });
    const r = await runDispatch('/repo', [LAUNCH, second], d);
    expect(r.started.map((s) => s.slug)).toEqual(['add-ui']);
    expect(r.failed.map((f) => f.slug)).toEqual(['add-auth']);
  });
});

describe('runDispatch — P3-E6: a missing skill is a degraded agent, not a broken one', () => {
  const WITH_SKILLS = { ...LAUNCH, skills: ['tdd', 'nonesuch'] };

  it('dispatches anyway and puts the failure in the report', async () => {
    const d = deps({ installSkills: vi.fn(async () => ['nonesuch: no such skill in the catalog']) });
    const r = await runDispatch('/repo', [WITH_SKILLS], d);
    expect(r.started).toHaveLength(1);
    expect(r.started[0]!.notes).toEqual(['nonesuch: no such skill in the catalog']);
  });

  it('dispatches even when skill installation throws outright', async () => {
    const d = deps({ installSkills: vi.fn(async () => { throw new Error('disk full'); }) });
    const r = await runDispatch('/repo', [WITH_SKILLS], d);
    expect(r.started).toHaveLength(1);
    expect(r.started[0]!.notes.join(' ')).toMatch(/disk full/);
  });

  it('installs into the worktree, not the main checkout', async () => {
    // Parallel agents must not share a skill set, and the checkout the human is
    // reading must stay clean.
    const d = deps();
    await runDispatch('/repo', [WITH_SKILLS], d);
    expect(d.installSkills).toHaveBeenCalledWith('/wt/add-auth', ['tdd', 'nonesuch'], 'claude');
  });
});

describe('runDispatch — P3-E9: --dry-run writes nothing', () => {
  it('claims nothing, briefs nothing, launches nothing', async () => {
    const d = deps();
    const r = await runDispatch('/repo', [LAUNCH], d, { dryRun: true });
    for (const fn of [d.claim, d.installSkills, d.writeBriefFor, d.launch, d.recordRun, d.publish]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(r.started.map((s) => s.slug)).toEqual(['add-auth']);
    expect(r.dryRun).toBe(true);
  });
});

describe('runDispatch — P3-E12: the flag reaches the claim, not just the pick', () => {
  it('claims with an override when the agent came from --agent', async () => {
    // Half-plumbed, this is the bug the live smoke test found: the dispatcher
    // picks the flag's agent, `claim` refuses because the row still names the
    // plan's, and the operator is told their own override is not allowed.
    const d = deps();
    await runDispatch('/repo', [{ ...LAUNCH, source: 'flag' }], d);
    expect(vi.mocked(d.claim).mock.calls[0]![3]).toEqual({ override: true });
  });

  it('claims normally when the plan or routing chose the agent', async () => {
    for (const source of ['plan', 'routing'] as const) {
      const d = deps();
      await runDispatch('/repo', [{ ...LAUNCH, source }], d);
      expect(vi.mocked(d.claim).mock.calls[0]![3], source).toEqual({ override: false });
    }
  });
});

/**
 * P3-E11 — the agent exits without finishing.
 *
 * A dispatched agent that dies on bad arguments or a missing key leaves a task
 * `active`, claimed, with nothing behind it: the phase stays held, `next` skips
 * it, and the board reads as work in progress. That is the same stuck state
 * P3-E7 releases a claim to avoid, arriving by a different route.
 *
 * `blocked` is the honest record — never `done`, which `verdictFor` owns.
 */
import { exitOutcome } from '../src/dispatch-run.js';

describe('exitOutcome', () => {
  it('blocks a task whose agent exited non-zero, naming the code', () => {
    const o = exitOutcome('add-auth', 'active', { code: 1, stopped: false });
    expect(o.block).toBe(true);
    expect(o.block && o.reason).toMatch(/exited 1/);
    expect(o.block && o.reason).toContain('baton start add-auth');
  });

  it('blocks a task whose agent exited cleanly without completing it', () => {
    // Exit 0 is not success here: success is `complete_task`, which moves the
    // task out of `active`. A process that returned 0 and left the task where
    // it found it did not do the work.
    const o = exitOutcome('add-auth', 'active', { code: 0, stopped: false });
    expect(o.block).toBe(true);
    expect(o.block && o.reason).toMatch(/without completing/);
  });

  it('says so when the operator stopped it, rather than blaming the agent', () => {
    const o = exitOutcome('add-auth', 'claimed', { code: null, stopped: true });
    expect(o.block).toBe(true);
    expect(o.block && o.reason).toMatch(/stopped/);
    expect(o.block && o.reason).not.toMatch(/exited/);
  });

  it('leaves a finished task alone — done is not this function\'s to decide', () => {
    for (const state of ['done', 'review', 'cancelled'] as const) {
      expect(exitOutcome('add-auth', state, { code: 0, stopped: false }).block, state).toBe(false);
    }
  });

  it('does not overwrite a blocker the agent reported itself', () => {
    // The agent's own reason names the actual obstacle. "exited 0" replaces it
    // with the least useful true statement available.
    expect(exitOutcome('add-auth', 'blocked', { code: 0, stopped: false }).block).toBe(false);
  });

  it('leaves a queued task alone — it was released, not abandoned', () => {
    expect(exitOutcome('add-auth', 'queued', { code: 1, stopped: false }).block).toBe(false);
  });
});

/**
 * Every command these messages name has to exist.
 *
 * The first draft told the operator to run `baton take <slug> --release`, which
 * is not a command — a recovery instruction that fails is worse than none,
 * because it is read at the exact moment somebody is already stuck.
 */
describe('the recovery commands are real', () => {
  it('names only commands the CLI registers', async () => {
    const { readFile } = await import('node:fs/promises');
    // The command tree lives in main.ts, not cli.ts. cli.ts is a launcher whose
    // emptiness is the feature: it runs the Node-version check before the
    // module graph — and 60-odd command modules — is resolved.
    const cli = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    const registered = new Set([...cli.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]!));
    const source = await readFile(new URL('../src/dispatch-run.ts', import.meta.url), 'utf8');
    const named = [...source.matchAll(/`baton ([a-z-]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const cmd of named) expect(registered, cmd).toContain(cmd);
  });
});
