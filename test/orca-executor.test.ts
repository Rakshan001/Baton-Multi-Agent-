// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P4 — the Orca backend, against a scripted binary.
 *
 * `fake-orca.mjs` prints the same envelopes real Orca does and records every
 * call, so the things this executor must get right — the ORDER of create →
 * wait → send, and the env fence — are assertions rather than hopes. Starting a
 * real Electron app per test would be slow, flaky, and could not produce
 * `selector_not_found` on demand.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcaExecutor } from '../src/executors/orca.js';
import type { LaunchRequest } from '../src/executors/types.js';

const FAKE = new URL('./fixtures/fake-orca.mjs', import.meta.url).pathname;
let dir = '';
let calls = '';

const ok = (result: unknown) => ({ id: '1', ok: true, result, _meta: { runtimeId: 'r' } });
const fail = (code: string, message: string) =>
  ({ id: 'local', ok: false, error: { code, message }, _meta: { runtimeId: null } });

async function script(entries: Record<string, unknown>): Promise<OrcaExecutor> {
  const path = join(dir, 'script.json');
  await writeFile(path, JSON.stringify({ _calls: calls, ...entries }));
  return new OrcaExecutor({
    bin: process.execPath,
    prefixArgs: [FAKE],
    env: { FAKE_ORCA_SCRIPT: path, ORCA_TERMINAL_HANDLE: 'leaked', ORCA_PANE_KEY: 'p', ORCA_AGENT_LAUNCH_TOKEN: 't' },
  });
}

async function recorded(): Promise<Array<{ key: string; args: string[]; fenced: string[] }>> {
  return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-exec-'));
  calls = join(dir, 'calls.jsonl');
  await writeFile(calls, '');
});

const REQ: LaunchRequest = {
  slug: 'add-auth', agentId: 'antigravity', nativeId: 'antigravity',
  cwd: '/repo/.baton/wt/add-auth', prompt: 'read HANDOFF.md',
  env: { BATON_ROOT: '/repo', BATON_SLUG: 'add-auth' }, mode: 'interactive',
};

describe('launch', () => {
  const HAPPY = {
    'repo list': ok([{ id: 'r1', path: '/repo' }]),
    'terminal create': ok({ handle: 'h1' }),
    'terminal wait': ok({ state: 'tui-idle' }),
    'terminal send': ok({ sent: true }),
  };

  it('creates, waits, then sends — in that order', async () => {
    // Sending before the TUI settles types a pointer into a buffer that is not
    // listening; the agent then sits at a prompt having read nothing (P4-E4).
    const handle = await (await script(HAPPY)).launch(REQ);
    expect((await recorded()).map((c) => c.key))
      .toEqual(['repo list', 'terminal create', 'terminal wait', 'terminal send']);
    expect(handle.ref).toBe('orca:h1');
    expect(handle.executor).toBe('orca');
  });

  it('launches antigravity, which is the entire reason this backend exists', async () => {
    const handle = await (await script(HAPPY)).launch(REQ);
    expect(handle.agentId).toBe('antigravity');
  });

  it('strips the attestation env from every single call', async () => {
    // A Baton daemon started from an Orca terminal inherits these, and Orca then
    // attests the dispatcher's calls as coming from that terminal.
    await (await script(HAPPY)).launch(REQ);
    for (const call of await recorded()) expect(call.fenced, call.key).toEqual([]);
  });

  it('names the worktree by absolute path, not by a name Orca would have to know', async () => {
    await (await script(HAPPY)).launch(REQ);
    const create = (await recorded()).find((c) => c.key === 'terminal create')!;
    expect(create.args).toContain('path:/repo/.baton/wt/add-auth');
    expect(create.args).toContain('baton:add-auth');
  });

  it('P4-E1: an unregistered repo refuses with the command that fixes it', async () => {
    const ex = await script({ ...HAPPY, 'terminal create': fail('selector_not_found', 'no worktree matched') });
    await expect(ex.launch(REQ)).rejects.toThrow(/orca repo add/);
  });

  it('P4-E1: says so before creating anything when the repo is not registered at all', async () => {
    // Cheaper and clearer than letting the selector fail: `repo list` answers
    // the same question without leaving a terminal behind.
    const ex = await script({ ...HAPPY, 'repo list': ok([{ id: 'r1', path: '/somewhere/else' }]) });
    await expect(ex.launch(REQ)).rejects.toThrow(/orca repo add/);
    expect((await recorded()).map((c) => c.key)).toEqual(['repo list']);
  });

  it('P4-E4: a wait that times out sends nothing, and does not leave the terminal open', async () => {
    const ex = await script({ ...HAPPY, 'terminal wait': fail('timeout', 'still starting'), 'terminal close': ok({ closed: true }) });
    await expect(ex.launch(REQ)).rejects.toThrow(/not-idle|did not become ready/i);
    const keys = (await recorded()).map((c) => c.key);
    expect(keys).not.toContain('terminal send');
    // An orphan TUI in the user's window, attached to a task that was released,
    // is the visible half of the "looks busy and isn't" state.
    expect(keys).toContain('terminal close');
  });

  it('refuses a model on an agent Orca cannot start with one', async () => {
    const ex = await script(HAPPY);
    await expect(ex.launch({ ...REQ, model: 'sonnet' })).rejects.toThrow(/antigravity/);
  });

  it('passes a model through for an agent that supports one', async () => {
    const ex = await script(HAPPY);
    await ex.launch({ ...REQ, agentId: 'claude', nativeId: 'claude', model: 'sonnet' });
    const create = (await recorded()).find((c) => c.key === 'terminal create')!;
    expect(create.args.join(' ')).toContain('sonnet');
  });
});

describe('observe — P4-E7', () => {
  it('redacts a secret before it can reach the bus', async () => {
    const ex = await script({
      'terminal read': ok({ lines: ['starting up', 'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'], nextCursor: 'c2' }),
    });
    const seen = await ex.observe({ executor: 'orca', slug: 'add-auth', agentId: 'claude', ref: 'orca:h1', mode: 'interactive', startedAt: 'now', root: '/repo' });
    expect(seen.lines[0]).toBe('starting up');
    expect(seen.lines[1]).toMatch(/redacted/);
    expect(seen.lines.join(' ')).not.toContain('sk-ant-api03');
    expect(seen.cursor).toBe('c2');
  });

  it('reports a read it could not make as unknown, never as idle', async () => {
    const ex = await script({ 'terminal read': fail('terminal_handle_stale', 'gone') });
    const seen = await ex.observe({ executor: 'orca', slug: 'a', agentId: 'claude', ref: 'orca:h1', mode: 'interactive', startedAt: 'now', root: '/repo' });
    expect(seen.state).toBe('unknown');
  });
});

describe('reattach — P4-E2', () => {
  const handle = { executor: 'orca' as const, slug: 'a', agentId: 'claude', ref: 'orca:h1', mode: 'interactive' as const, startedAt: 'now', root: '/repo' };

  it('returns null for a handle Orca no longer knows', async () => {
    // After an Orca restart the run is LOST, not running. Saying "running"
    // would leave a task looking worked-on with nothing behind it.
    const ex = await script({ 'terminal show': fail('terminal_handle_stale', 'gone') });
    await expect(ex.reattach(handle)).resolves.toBeNull();
  });

  it('returns the handle when Orca still has the terminal', async () => {
    const ex = await script({ 'terminal show': ok({ handle: 'h1', title: 'baton:a' }) });
    await expect(ex.reattach(handle)).resolves.toMatchObject({ ref: 'orca:h1' });
  });

  it('returns null when Orca is not answering at all', async () => {
    // "Could not ask" and "gone" both mean the daemon must not claim it is
    // running; the difference belongs in a message, not in a fabricated state.
    const ex = await script({});
    await expect(ex.reattach(handle)).resolves.toBeNull();
  });
});

describe('available — P4-E8', () => {
  it('is ok when orca answers', async () => {
    const ex = await script({ status: ok({ version: '1.4.178' }) });
    await expect(ex.available()).resolves.toMatchObject({ ok: true });
  });

  it('is not ok, with a reason, when it does not', async () => {
    const ex = await script({ status: fail('runtime_unavailable', 'Orca is not running') });
    const r = await ex.available();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not running/);
  });
});
