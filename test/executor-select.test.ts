// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2-E2 — which backend starts an agent, decided before the dispatcher needs one.
 *
 * `auto` may only choose Orca when all three are true: the binary resolves, the
 * daemon answers, and the daemon actually serves THIS repo. Two of the three is
 * not close enough — an Orca that is running but has never opened this repo
 * cannot launch anything in its worktree, and finding that out at spawn time
 * means a task that reports started and did nothing.
 *
 * Every answer carries `why`. A dispatcher that quietly used a different backend
 * than the config asked for is a debugging session nobody can start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXECUTOR_CONFIG } from '../src/executors/config.js';
import { resolveExecutor, resetExecutorChoiceCache } from '../src/executors/select.js';

const ROOT = '/repo/app';

const probe = (over: Partial<Parameters<typeof resolveExecutor>[2]> = {}) => ({
  resolveBin: vi.fn(async () => '/usr/local/bin/orca'),
  status: vi.fn(async () => ({ ok: true })),
  repos: vi.fn(async () => [ROOT]),
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_EXECUTOR_CONFIG,
  ...over,
});

describe('resolveExecutor', () => {
  beforeEach(() => resetExecutorChoiceCache());

  it('never answers "auto" — auto is a question, not a backend', async () => {
    const choice = await resolveExecutor(ROOT, config(), probe());
    expect(['local', 'orca']).toContain(choice.backend);
  });

  it('auto picks orca when the binary, the daemon and the repo all check out', async () => {
    const choice = await resolveExecutor(ROOT, config(), probe());
    expect(choice.backend).toBe('orca');
  });

  it('auto stays local when the binary is not on PATH, and says so', async () => {
    const choice = await resolveExecutor(ROOT, config(), probe({ resolveBin: vi.fn(async () => null) }));
    expect(choice.backend).toBe('local');
    expect(choice.why.toLowerCase()).toContain('not on path');
  });

  it('auto stays local when the binary exists but the daemon is not running', async () => {
    // P2-E2 exactly. An installed CLI is not a running daemon.
    const choice = await resolveExecutor(
      ROOT,
      config(),
      probe({ status: vi.fn(async () => ({ ok: false, reason: 'connection refused' })) }),
    );
    expect(choice.backend).toBe('local');
    expect(choice.why).toContain('connection refused');
  });

  it('auto stays local when Orca is running but has never opened this repo', async () => {
    // The two-of-three case. Orca cannot launch into a worktree it does not know.
    const choice = await resolveExecutor(ROOT, config(), probe({ repos: vi.fn(async () => ['/repo/other']) }));
    expect(choice.backend).toBe('local');
    expect(choice.why.toLowerCase()).toContain('repo');
  });

  it('compares repo paths after resolving them, not as raw strings', async () => {
    const choice = await resolveExecutor(
      '/repo/app/',
      config(),
      probe({ repos: vi.fn(async () => ['/repo/app']) }),
    );
    expect(choice.backend).toBe('orca');
  });

  it('a repo list that could not be read is not an empty repo list', async () => {
    // null means "could not ask". Treating it as [] would report "Orca does not
    // serve this repo", which is a claim the failed call cannot support.
    const choice = await resolveExecutor(ROOT, config(), probe({ repos: vi.fn(async () => null) }));
    expect(choice.backend).toBe('local');
    expect(choice.why.toLowerCase()).toContain('could not');
  });

  it('backend: local never probes Orca at all', async () => {
    const p = probe();
    const choice = await resolveExecutor(ROOT, config({ backend: 'local' }), p);
    expect(choice.backend).toBe('local');
    expect(p.resolveBin).not.toHaveBeenCalled();
  });

  it('backend: orca that cannot be used degrades to local, and records what was asked for', async () => {
    // Not a silent substitution: the capability layer still refuses any agent
    // only Orca could launch, so the consequence surfaces where it belongs.
    const choice = await resolveExecutor(
      ROOT,
      config({ backend: 'orca' }),
      probe({ status: vi.fn(async () => ({ ok: false, reason: 'not running' })) }),
    );
    expect(choice.backend).toBe('local');
    expect(choice.degradedFrom).toBe('orca');
  });

  it('uses the configured bin rather than assuming "orca"', async () => {
    const p = probe();
    await resolveExecutor(ROOT, config({ orca: { bin: '/opt/orca-ide', repo: null } }), p);
    expect(p.resolveBin).toHaveBeenCalledWith('/opt/orca-ide');
  });

  it('caches for 30s so a dispatch loop does not shell out per task', async () => {
    const p = probe();
    await resolveExecutor(ROOT, config(), p, () => 1_000);
    await resolveExecutor(ROOT, config(), p, () => 20_000);
    expect(p.status).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the cache is stale', async () => {
    const p = probe();
    await resolveExecutor(ROOT, config(), p, () => 1_000);
    await resolveExecutor(ROOT, config(), p, () => 40_000);
    expect(p.status).toHaveBeenCalledTimes(2);
  });

  it('caches per repo — two repos are two different answers', async () => {
    const p = probe({ repos: vi.fn(async () => [ROOT]) });
    const a = await resolveExecutor(ROOT, config(), p, () => 1_000);
    const b = await resolveExecutor('/repo/other', config(), p, () => 1_000);
    expect(a.backend).toBe('orca');
    expect(b.backend).toBe('local');
  });

  it('a probe that throws is a local answer, never an unhandled rejection', async () => {
    // This runs on the dispatch path. A rejection here stops dispatch entirely.
    const choice = await resolveExecutor(
      ROOT,
      config(),
      probe({ status: vi.fn(async () => { throw new Error('spawn EACCES'); }) }),
    );
    expect(choice.backend).toBe('local');
    expect(choice.why).toContain('EACCES');
  });
});
