// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The four verbs, which had no tests at all — the gap P2 named for itself.
 *
 * `capabilities()` was covered; `launch`, `observe`, `stop` and `reattach` were
 * not, and they are the ones the dispatcher will lean on. What matters here is
 * not that they call through, but that the ASYMMETRY between the two run modes
 * is preserved: headless runs live in an in-process Map and do not survive a
 * daemon restart, while tmux sessions do. Hiding that would make a restart look
 * lossless, and a caller would wait forever for output from a run that is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startAgent = vi.fn(async () => ({ pid: 4242 }));
const stopAgent = vi.fn(() => true);
const hasHeadlessRun = vi.fn(() => true);
const runningHeadless = vi.fn(() => [] as unknown[]);
const createTerminal = vi.fn(async () => ({ sessionName: 'baton-add-auth' }));
const listTerminals = vi.fn(() => [] as unknown[]);
const tmuxSessionExists = vi.fn(async () => true);
const killSessionFor = vi.fn(async () => undefined);

vi.mock('../src/spawn.js', () => ({ startAgent, stopAgent, hasHeadlessRun, runningHeadless }));
vi.mock('../src/terminals.js', () => ({ createTerminal, listTerminals }));
vi.mock('../src/util/tmux.js', () => ({ tmuxSessionExists, killSessionFor }));

const { LocalExecutor, localRunCount } = await import('../src/executors/local.js');

const request = (over: Record<string, unknown> = {}) => ({
  slug: 'add-auth',
  agentId: 'claude',
  nativeId: 'claude',
  cwd: '/repo/wt/add-auth',
  prompt: 'see HANDOFF.md',
  env: { BATON_ROOT: '/repo', BATON_SLUG: 'add-auth' },
  mode: 'headless' as const,
  ...over,
});

const handle = (over: Record<string, unknown> = {}) => ({
  executor: 'local' as const,
  slug: 'add-auth',
  agentId: 'claude',
  startedAt: '2026-08-21T10:00:00.000Z',
  root: '/repo',
  mode: 'headless' as const,
  ref: 'pid:4242',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('launch', () => {
  it('starts a headless run and returns a handle naming the pid', async () => {
    const h = await new LocalExecutor().launch(request() as never);
    expect(startAgent).toHaveBeenCalled();
    expect(h).toMatchObject({ mode: 'headless', slug: 'add-auth', ref: 'pid:4242' });
  });

  it('starts an interactive run through tmux and names the session', async () => {
    const h = await new LocalExecutor().launch(request({ mode: 'interactive' }) as never);
    expect(createTerminal).toHaveBeenCalled();
    expect(h.ref).toBe('tmux:baton-add-auth');
  });

  it('a headless start with no pid still returns a usable handle', async () => {
    // `pid: 0` is falsy. A handle that dropped the ref could never be stopped.
    startAgent.mockResolvedValueOnce({ pid: undefined } as never);
    const h = await new LocalExecutor().launch(request() as never);
    expect(h.ref).toBe('pid:0');
  });
});

describe('observe', () => {
  it('reports running while the run is live', async () => {
    hasHeadlessRun.mockReturnValueOnce(true);
    expect(await new LocalExecutor().observe(handle() as never)).toMatchObject({ state: 'running' });
  });

  it('reports exited once it is not', async () => {
    hasHeadlessRun.mockReturnValueOnce(false);
    expect(await new LocalExecutor().observe(handle() as never)).toMatchObject({ state: 'exited' });
  });

  it('returns no lines — output already streamed onto the bus', async () => {
    // Re-delivering it here would double every line a subscriber already has.
    expect((await new LocalExecutor().observe(handle() as never)).lines).toEqual([]);
  });
});

describe('stop', () => {
  it('stops a headless run through spawn.ts', async () => {
    expect(await new LocalExecutor().stop(handle() as never)).toBe(true);
    expect(stopAgent).toHaveBeenCalledWith('add-auth');
  });

  it('kills the tmux session for an interactive run', async () => {
    await new LocalExecutor().stop(handle({ mode: 'interactive', ref: 'tmux:x' }) as never);
    expect(killSessionFor).toHaveBeenCalledWith('/repo', 'add-auth');
  });

  it('a tmux kill that fails still reports stopped, rather than throwing at a caller', async () => {
    killSessionFor.mockRejectedValueOnce(new Error('no server running'));
    await expect(
      new LocalExecutor().stop(handle({ mode: 'interactive' }) as never),
    ).resolves.toBe(true);
  });
});

describe('reattach — the asymmetry is the point', () => {
  it('re-adopts a tmux session, which outlives the daemon', async () => {
    tmuxSessionExists.mockResolvedValueOnce(true);
    const h = handle({ mode: 'interactive', ref: 'tmux:x' });
    expect(await new LocalExecutor().reattach(h as never)).toEqual(h);
  });

  it('returns null for a headless run the restart lost', async () => {
    // The honest answer. Returning the handle would promise an output stream
    // that died with the process that owned the Map.
    hasHeadlessRun.mockReturnValueOnce(false);
    expect(await new LocalExecutor().reattach(handle() as never)).toBeNull();
  });

  it('a tmux probe that throws is "not there", not an exception at startup', async () => {
    tmuxSessionExists.mockRejectedValueOnce(new Error('tmux missing'));
    expect(await new LocalExecutor().reattach(handle({ mode: 'interactive' }) as never)).toBeNull();
  });
});

describe('localRunCount', () => {
  it('counts headless runs as well as terminals', async () => {
    // The dispatcher gates on this. Counting only terminals would let every
    // headless agent past `maxConcurrent` — the limit would hold for TUIs and
    // silently not exist for the mode the dispatcher actually uses.
    listTerminals.mockReturnValueOnce([{}, {}]);
    runningHeadless.mockReturnValueOnce([{}, {}, {}]);
    expect(localRunCount()).toBe(5);
  });

  it('is zero when nothing is running', () => {
    listTerminals.mockReturnValueOnce([]);
    runningHeadless.mockReturnValueOnce([]);
    expect(localRunCount()).toBe(0);
  });
});
