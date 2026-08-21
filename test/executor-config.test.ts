// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2-E1 — the `executor` block is validated on its own, and a typo in it must
 * never disarm the tool.
 *
 * `baton.config.json` holds routing and now holds executor settings. They are
 * one file and two concerns: routing decides WHICH agent, the executor decides
 * WHO STARTS IT. A malformed executor block falls back to `local` with a
 * visible warning, and routing — which the team relies on every day — keeps
 * working, because nothing here can reject the file.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXECUTOR_CONFIG, validateExecutorConfig } from '../src/executors/config.js';

describe('validateExecutorConfig', () => {
  it('defaults to auto when the file has no executor block', () => {
    const { config, errors } = validateExecutorConfig({ routing: { mode: 'auto' } });
    expect(config).toEqual(DEFAULT_EXECUTOR_CONFIG);
    expect(errors).toEqual([]);
  });

  it('reads a complete block', () => {
    const { config, errors } = validateExecutorConfig({
      executor: {
        backend: 'orca',
        orca: { bin: '/usr/local/bin/orca', repo: 'path:/abs/repo' },
        dispatch: { maxConcurrent: 5, maxPerAgent: 2 },
      },
    });
    expect(errors).toEqual([]);
    expect(config).toMatchObject({
      backend: 'orca',
      orca: { bin: '/usr/local/bin/orca', repo: 'path:/abs/repo' },
      dispatch: { maxConcurrent: 5, maxPerAgent: 2 },
    });
  });

  it('falls back to local — never auto — when the backend is unknown', () => {
    // `auto` could resolve to a backend the author did not ask for. A typo
    // should land on the conservative one, not on "pick something".
    const { config, errors } = validateExecutorConfig({ executor: { backend: 'orka' } });
    expect(config.backend).toBe('local');
    expect(errors.join(' ')).toContain('orka');
  });

  it('a non-object executor block does not reject the file', () => {
    // The whole point of P2-E1: routing must survive an executor typo.
    for (const bad of ['local', 42, null, []]) {
      const { config, errors } = validateExecutorConfig({ executor: bad });
      expect(config.backend).toBe('local');
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('refuses a concurrency of zero, which would silently stop dispatch', () => {
    // A dispatcher that never dispatches looks identical to one with no work.
    const { config, errors } = validateExecutorConfig({
      executor: { dispatch: { maxConcurrent: 0 } },
    });
    expect(config.dispatch.maxConcurrent).toBe(DEFAULT_EXECUTOR_CONFIG.dispatch.maxConcurrent);
    expect(errors.join(' ')).toContain('maxConcurrent');
  });

  it('refuses a negative or fractional concurrency', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { config } = validateExecutorConfig({ executor: { dispatch: { maxConcurrent: bad } } });
      expect(config.dispatch.maxConcurrent).toBe(DEFAULT_EXECUTOR_CONFIG.dispatch.maxConcurrent);
    }
  });

  it('caps concurrency at something a laptop survives', () => {
    // 200 agents is not a configuration, it is an accident.
    const { config, errors } = validateExecutorConfig({
      executor: { dispatch: { maxConcurrent: 200 } },
    });
    expect(config.dispatch.maxConcurrent).toBeLessThanOrEqual(32);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('keeps a good field when a sibling field is bad', () => {
    // Partial validity is the common case: one typo should not reset the block.
    const { config } = validateExecutorConfig({
      executor: { backend: 'local', dispatch: { maxConcurrent: 4, maxPerAgent: 'two' } },
    });
    expect(config.dispatch.maxConcurrent).toBe(4);
    expect(config.dispatch.maxPerAgent).toBe(DEFAULT_EXECUTOR_CONFIG.dispatch.maxPerAgent);
  });

  it('ignores an empty orca bin rather than trying to spawn ""', () => {
    const { config } = validateExecutorConfig({ executor: { orca: { bin: '   ' } } });
    expect(config.orca.bin).toBe(DEFAULT_EXECUTOR_CONFIG.orca.bin);
  });

  it('never throws, whatever is in the file', () => {
    for (const junk of [null, undefined, 'a string', 7, [], { executor: { orca: 3 } }]) {
      expect(() => validateExecutorConfig(junk)).not.toThrow();
    }
  });
});
