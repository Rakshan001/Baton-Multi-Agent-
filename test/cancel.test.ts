/**
 * §8 — cancellation: stop work, destroy nothing.
 *
 * Two things carry the weight here, and neither is the state change itself.
 *
 * 1. **The blast radius is computed, not eyeballed.** "Cancelling phase 2 stops
 *    3 active agents" is the number a human confirms against, and a preview
 *    produced by different code from the write is a preview that can lie. So
 *    `blastRadius` is pure and unit-tested, and `cancelCmd` consumes exactly it.
 *
 * 2. **Cancelling STRANDS its dependents.** `depBlocker` refuses a dependency
 *    that was cancelled, and nothing ever clears that — the dependency will
 *    never reach `done`. So cancelling one task can permanently kill work in a
 *    later phase, and the confirmation has to say so before the fact rather
 *    than after. This was verified against `depBlocker` rather than assumed;
 *    the first version of the doc comment claimed the opposite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blastRadius, agentsStopped, eligibleFor, blockers, stateOf,
  type PipelineTask,
} from '../src/pipeline.js';
import { cancelTasks } from '../src/lifecycle.js';
import { resolveScope, cancelCmd } from '../src/commands/cancel.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { git } from '../src/util/exec.js';

const t = (over: Partial<PipelineTask> & { slug: string }): PipelineTask => ({
  phase: 1, state: 'queued', ...over,
});

describe('blastRadius — what a cancellation would touch', () => {
  const board: PipelineTask[] = [
    t({ slug: 'schema', phase: 1, state: 'done' }),
    t({ slug: 'api', phase: 2, state: 'active', claimedBy: { agent: 'claude', sessionSlug: 's1', at: '' } }),
    t({ slug: 'ui', phase: 2, state: 'active', claimedBy: { agent: 'cursor', sessionSlug: 's2', at: '' } }),
    t({ slug: 'docs', phase: 2, state: 'queued' }),
    t({ slug: 'e2e', phase: 3, state: 'queued', dependsOn: ['api', 'ui'] }),
  ];

  it('names every unfinished task in a phase, and who is on it', () => {
    const r = blastRadius(board, { kind: 'phase', phase: 2 });
    expect(r.stopping.map((s) => s.slug)).toEqual(['api', 'ui', 'docs']);
    expect(r.stopping.find((s) => s.slug === 'api')?.holder).toBe('claude');
    expect(r.stopping.find((s) => s.slug === 'docs')?.holder).toBeNull();
  });

  it('counts only the agents actually working — the headline number', () => {
    // `docs` is queued: cancelling it interrupts nobody, and counting it would
    // overstate the cost of the click.
    expect(agentsStopped(blastRadius(board, { kind: 'phase', phase: 2 }))).toBe(2);
  });

  it('lists finished tasks separately so the numbers reconcile', () => {
    const r = blastRadius(board, { kind: 'phase', phase: 1 });
    expect(r.stopping).toEqual([]);
    expect(r.alreadyFinished).toEqual(['schema']);
  });

  it('warns that dependents will be stranded', () => {
    const r = blastRadius(board, { kind: 'phase', phase: 2 });
    expect(r.stranding).toEqual([{ slug: 'e2e', dependsOn: ['api', 'ui'] }]);
  });

  it('follows the chain — stranding is transitive, and a one-hop count lies', () => {
    /*
     * Found by driving a real plan through the daemon, not by unit test: this
     * reported "2 stranded" for a graph that kills 3. Cancel A, and B can never
     * start; B never reaches `done`, so C can never start either. The number
     * appears in a confirmation under the word STRANDED, so undercounting it is
     * the one direction that matters.
     */
    const chain: PipelineTask[] = [
      t({ slug: 'a', phase: 1, state: 'active' }),
      t({ slug: 'b', phase: 2, dependsOn: ['a'] }),
      t({ slug: 'c', phase: 3, dependsOn: ['b'] }),
      t({ slug: 'd', phase: 3, dependsOn: ['c'] }),
      t({ slug: 'unrelated', phase: 2 }),
    ];
    const r = blastRadius(chain, { kind: 'task', slug: 'a' });
    expect(r.stranding).toEqual([
      { slug: 'b', dependsOn: ['a'] },
      { slug: 'c', dependsOn: ['b'] },
      { slug: 'd', dependsOn: ['c'] },
    ]);
    // Each is named by what strands IT, so the reader can act on the right one.
    expect(r.stranding.map((s) => s.slug)).not.toContain('unrelated');
  });

  it('does not strand through a dependency that is already finished', () => {
    // `b` depends on `done-already` as well as on `a`. Only `a` strands it —
    // listing a finished task as a cause would send someone to fix nothing.
    const g: PipelineTask[] = [
      t({ slug: 'a', phase: 1, state: 'active' }),
      t({ slug: 'done-already', phase: 1, state: 'done' }),
      t({ slug: 'b', phase: 2, dependsOn: ['a', 'done-already'] }),
    ];
    expect(blastRadius(g, { kind: 'task', slug: 'a' }).stranding)
      .toEqual([{ slug: 'b', dependsOn: ['a'] }]);
  });

  it('and stranding is REAL — the dependent can never start afterwards', () => {
    /*
     * The assertion behind the warning, checked against the eligibility rule
     * rather than asserted in prose. If `depBlocker` ever treated a cancelled
     * dependency as satisfied, the warning above would be scaremongering and
     * this test would say so.
     */
    // The WHOLE of phase 2, so the phase barrier is not the thing blocking
    // `e2e`. Cancelling counts as terminal, so phase 2 completes and phase 3
    // opens — and `e2e` is STILL unstartable, which isolates the dependency as
    // the cause rather than the ordering.
    const after = cancelTasks(board as Task[], ['api', 'ui', 'docs'], 'rakshan', '2026-08-07T00:00:00.000Z').tasks;
    expect(eligibleFor('claude', after as PipelineTask[]).map((x) => x.slug)).not.toContain('e2e');
    expect(blockers(after as PipelineTask[]).find((b) => b.slug === 'e2e')?.reason).toMatch(/cancelled/);
  });

  it('scopes to one task, and to a whole plan', () => {
    expect(blastRadius(board, { kind: 'task', slug: 'api' }).stopping.map((s) => s.slug)).toEqual(['api']);

    const planned: PipelineTask[] = [
      t({ slug: 'a', planId: 'auth' }), t({ slug: 'b', planId: 'auth' }), t({ slug: 'c', planId: 'billing' }),
    ];
    expect(blastRadius(planned, { kind: 'plan', planId: 'auth' }).stopping.map((s) => s.slug)).toEqual(['a', 'b']);
  });
});

describe('cancelTasks — the transition', () => {
  const board: Task[] = [
    { slug: 'api', state: 'active', branch: 'baton/api', worktreePath: '/w/api', baseCommit: 'abc',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-01T00:00:00.000Z' },
      contributors: [{ agent: 'claude', from: '2026-08-01T00:00:00.000Z' }] } as unknown as Task,
    { slug: 'done-one', state: 'done', branch: 'baton/d', worktreePath: '/w/d', baseCommit: 'def' } as unknown as Task,
  ];

  it('destroys nothing — branch, worktree and base commit all survive', () => {
    const { tasks } = cancelTasks(board, ['api'], 'rakshan', '2026-08-07T12:00:00.000Z', 'approach abandoned');
    const api = tasks.find((x) => x.slug === 'api')!;
    expect(stateOf(api as PipelineTask)).toBe('cancelled');
    // The whole point of §8: cancelling reverses a decision, and the commits are
    // often the most valuable output of an approach that turned out wrong.
    expect(api.branch).toBe('baton/api');
    expect(api.worktreePath).toBe('/w/api');
    expect(api.baseCommit).toBe('abc');
  });

  it('records who and why — the agent is told both on its next tool call', () => {
    const { tasks } = cancelTasks(board, ['api'], 'rakshan', '2026-08-07T12:00:00.000Z', 'approach abandoned');
    expect(tasks.find((x) => x.slug === 'api')!.cancelledBy).toEqual({
      actor: 'rakshan', at: '2026-08-07T12:00:00.000Z', reason: 'approach abandoned',
    });
  });

  it('closes the contributor stretch and drops the live holder', () => {
    const { tasks } = cancelTasks(board, ['api'], 'rakshan', '2026-08-07T12:00:00.000Z');
    const api = tasks.find((x) => x.slug === 'api')!;
    // Who did the work stays answerable; who is working on it now becomes nobody.
    expect(api.contributors).toEqual([{ agent: 'claude', from: '2026-08-01T00:00:00.000Z', to: '2026-08-07T12:00:00.000Z' }]);
    expect(api.claimedBy).toBeUndefined();
  });

  it('never rewinds a finished task', () => {
    // Cancelling a phase must not turn completed work into cancelled work: the
    // barrier already lifted on it, and the report is already written.
    const { tasks, cancelled } = cancelTasks(board, ['api', 'done-one'], 'rakshan', '2026-08-07T12:00:00.000Z');
    expect(cancelled).toEqual(['api']);
    expect(stateOf(tasks.find((x) => x.slug === 'done-one')! as PipelineTask)).toBe('done');
  });
});

describe('resolveScope — one scope, never a guess', () => {
  it('reads each of the three scopes', () => {
    expect(resolveScope('api', {})).toEqual({ kind: 'task', slug: 'api' });
    expect(resolveScope(undefined, { phase: '2' })).toEqual({ kind: 'phase', phase: 2 });
    expect(resolveScope(undefined, { plan: 'auth' })).toEqual({ kind: 'plan', planId: 'auth' });
  });

  it('refuses two scopes rather than picking one', () => {
    // Guessing here stops work nobody asked to stop.
    expect(resolveScope('api', { phase: '2' })).toMatch(/Pick one scope/);
  });

  it('refuses none, and a phase that is not a phase', () => {
    expect(resolveScope(undefined, {})).toMatch(/Name what to cancel/);
    expect(resolveScope(undefined, { phase: 'two' })).toMatch(/Not a phase/);
  });
});

describe('baton cancel — end to end', () => {
  let repo = '';
  let cwd = '';

  beforeEach(async () => {
    repo = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cancel-')));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
    await writeFile(join(repo, '.gitignore'), '.baton/\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-qm', 'init'], repo);
    await mkdir(join(repo, '.baton'), { recursive: true });
    await saveTasks(repo, [
      { slug: 'api', task: 'api', branch: 'baton/api', worktreePath: join(repo, '.baton/wt/api'),
        baseBranch: 'main', baseCommit: 'abc', createdAt: '2026-08-01T00:00:00.000Z',
        phase: 2, state: 'active', claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-01T00:00:00.000Z' } },
      { slug: 'e2e', task: 'e2e', branch: 'baton/e2e', worktreePath: '',
        baseBranch: 'main', baseCommit: null, createdAt: '2026-08-01T00:00:00.000Z',
        phase: 3, state: 'queued', dependsOn: ['api'] },
    ] as unknown as Task[]);
    cwd = process.cwd();
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(repo, { recursive: true, force: true });
  });

  async function capture(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    try { await fn(); } finally { console.log = log; console.error = err; }
    return lines.join('\n');
  }

  it('--dry-run shows the radius and writes nothing', async () => {
    const out = await capture(() => cancelCmd('api', { dryRun: true }));
    expect(out).toMatch(/stops 1 task and 1 working agent/);
    expect(out).toMatch(/claude is on it now/);
    expect(out).toMatch(/STRANDED/);
    expect(out).toMatch(/e2e/);
    // A dry run that wrote would be the worst of both.
    expect((await loadTasks(repo)).find((x) => x.slug === 'api')!.state).toBe('active');
  });

  it('cancels for real, keeps the work, and says the stop is not instant', async () => {
    const out = await capture(() => cancelCmd('api', { reason: 'approach abandoned' }));
    const api = (await loadTasks(repo)).find((x) => x.slug === 'api')!;
    expect(api.state).toBe('cancelled');
    expect(api.cancelledBy?.reason).toBe('approach abandoned');
    expect(api.branch).toBe('baton/api');
    // Promising an immediate halt would be a lie the user discovers by watching
    // commits land after the confirmation.
    expect(out).toMatch(/next tool call/);
  });

  it('reports honestly when there is nothing to cancel', async () => {
    await cancelCmd('api', {});
    const out = await capture(() => cancelCmd('api', {}));
    expect(out).toMatch(/Nothing to cancel/);
  });
});
