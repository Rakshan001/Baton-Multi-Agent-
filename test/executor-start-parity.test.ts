// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2-E5 — re-routing `baton start` through the executor must not change one
 * character of what it prints.
 *
 * The re-route exists so that when the Orca backend lands, `baton start` gets
 * it for free. It buys nothing today, and it can only cost: people read that
 * line, scripts grep it, and the existing tests are the contract. So the
 * parity is asserted directly — the launch result the CLI prints from has to
 * survive the trip through the seam.
 *
 * The specific way this goes wrong: `startAgent` returns `promptSource`, which
 * decides whether the line says "HANDOFF.md brief" or "task description".
 * `RunHandle` had no field for it, so a naive re-route would have silently
 * turned every start into "task description".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startAgent = vi.fn(async () => ({
  slug: 'add-auth',
  agent: 'claude',
  model: 'opus',
  pid: 4242,
  promptSource: 'handoff' as const,
}));

vi.mock('../src/spawn.js', () => ({
  startAgent,
  stopAgent: vi.fn(() => true),
  hasHeadlessRun: vi.fn(() => true),
  runningHeadless: vi.fn(() => []),
}));
vi.mock('../src/terminals.js', () => ({
  createTerminal: vi.fn(async () => ({ sessionName: 's' })),
  listTerminals: vi.fn(() => []),
}));
vi.mock('../src/util/tmux.js', () => ({
  tmuxSessionExists: vi.fn(async () => true),
  killSessionFor: vi.fn(async () => undefined),
}));

const { LocalExecutor } = await import('../src/executors/local.js');

const request = {
  slug: 'add-auth',
  agentId: 'claude',
  nativeId: 'claude',
  cwd: '/repo/wt/add-auth',
  prompt: 'see HANDOFF.md',
  env: { BATON_ROOT: '/repo' },
  mode: 'headless' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('the handle carries what the CLI prints', () => {
  it('keeps promptSource, so the line does not silently become "task description"', async () => {
    const handle = await new LocalExecutor().launch(request as never);
    expect(handle.promptSource).toBe('handoff');
  });

  it('keeps the agent the backend actually chose, not the one requested', async () => {
    // `baton start` with no --agent resolves a default inside startAgent. The
    // printed name has to be the resolved one or the line is a guess.
    startAgent.mockResolvedValueOnce({
      slug: 'add-auth', agent: 'codex', model: undefined, pid: 7, promptSource: 'task',
    } as never);
    const handle = await new LocalExecutor().launch({ ...request, agentId: 'any' } as never);
    expect(handle.agentId).toBe('codex');
  });

  it('keeps the model the backend resolved', async () => {
    expect((await new LocalExecutor().launch(request as never)).model).toBe('opus');
  });

  it('keeps the pid, which the line prints', async () => {
    expect((await new LocalExecutor().launch(request as never)).pid).toBe(4242);
  });

  it('a start with no pid reports null rather than 0 — "?" is what gets printed', async () => {
    // The CLI prints `pid ${r.pid ?? '?'}`. Coercing undefined to 0 would print
    // a pid that does not exist.
    startAgent.mockResolvedValueOnce({
      slug: 'add-auth', agent: 'claude', model: undefined, pid: undefined, promptSource: 'task',
    } as never);
    expect((await new LocalExecutor().launch(request as never)).pid).toBeNull();
  });

  it('an interactive launch has no promptSource to carry, and says so', async () => {
    const handle = await new LocalExecutor().launch({ ...request, mode: 'interactive' } as never);
    expect(handle.promptSource).toBeUndefined();
  });
});
