// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `executor` block of `baton.config.json`.
 *
 * One file, two concerns: `routing` decides WHICH agent runs a task, `executor`
 * decides WHO STARTS IT. They are validated separately and on purpose (P2-E1) —
 * a typo in the executor block falls back to `local` with a visible warning and
 * routing, which the team relies on every day, keeps working. Nothing in here
 * can reject the file.
 *
 *   { "executor": {
 *       "backend": "auto",                                 // auto | local | orca
 *       "orca": { "bin": "orca", "repo": "path:/abs/repo" },
 *       "dispatch": { "maxConcurrent": 3, "maxPerAgent": 1 }
 *   } }
 *
 * Every invalid value falls back to its default rather than to "unset", because
 * a dispatcher with `maxConcurrent: 0` never dispatches and looks exactly like
 * a dispatcher with no work to do.
 */

export type ExecutorBackend = 'auto' | 'local' | 'orca';

export interface ExecutorConfig {
  backend: ExecutorBackend;
  orca: { bin: string; repo: string | null };
  dispatch: { maxConcurrent: number; maxPerAgent: number };
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  backend: 'auto',
  orca: { bin: 'orca', repo: null },
  dispatch: { maxConcurrent: 3, maxPerAgent: 1 },
};

/** More than this on one machine is an accident, not a configuration. */
const MAX_CONCURRENT_CEILING = 32;

const BACKENDS: ReadonlySet<string> = new Set(['auto', 'local', 'orca']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A whole positive integer, or null. Rejects NaN, Infinity and 1.5 alike. */
function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out.length > 0 ? out : null;
}

/**
 * Never throws, never rejects the file. Returns the config to use and every
 * reason it differs from what was written.
 */
export function validateExecutorConfig(raw: unknown): { config: ExecutorConfig; errors: string[] } {
  const errors: string[] = [];
  const file = record(raw);
  if (!file || file.executor === undefined) {
    return { config: DEFAULT_EXECUTOR_CONFIG, errors };
  }

  const block = record(file.executor);
  if (!block) {
    // P2-E1. `local` rather than `auto`: a typo should land on the conservative
    // backend, not on "pick something on the author's behalf".
    errors.push('executor: expected an object — using backend "local"');
    return { config: { ...DEFAULT_EXECUTOR_CONFIG, backend: 'local' }, errors };
  }

  let backend: ExecutorBackend = DEFAULT_EXECUTOR_CONFIG.backend;
  if (block.backend !== undefined) {
    if (typeof block.backend === 'string' && BACKENDS.has(block.backend)) {
      backend = block.backend as ExecutorBackend;
    } else {
      errors.push(`executor.backend: unknown backend ${JSON.stringify(block.backend)} — using "local"`);
      backend = 'local';
    }
  }

  const orcaBlock = record(block.orca);
  if (block.orca !== undefined && !orcaBlock) {
    errors.push('executor.orca: expected an object — using defaults');
  }
  const orca = {
    bin: trimmed(orcaBlock?.bin) ?? DEFAULT_EXECUTOR_CONFIG.orca.bin,
    repo: trimmed(orcaBlock?.repo),
  };

  const dispatchBlock = record(block.dispatch);
  if (block.dispatch !== undefined && !dispatchBlock) {
    errors.push('executor.dispatch: expected an object — using defaults');
  }
  // Each field independently: partial validity is the common case, and one typo
  // must not reset a sibling the author got right.
  let maxConcurrent = DEFAULT_EXECUTOR_CONFIG.dispatch.maxConcurrent;
  if (dispatchBlock?.maxConcurrent !== undefined) {
    const parsed = positiveInt(dispatchBlock.maxConcurrent);
    if (parsed === null) {
      errors.push('executor.dispatch.maxConcurrent: expected a whole number above 0 — using the default');
    } else if (parsed > MAX_CONCURRENT_CEILING) {
      errors.push(`executor.dispatch.maxConcurrent: capped at ${MAX_CONCURRENT_CEILING}`);
      maxConcurrent = MAX_CONCURRENT_CEILING;
    } else {
      maxConcurrent = parsed;
    }
  }
  let maxPerAgent = DEFAULT_EXECUTOR_CONFIG.dispatch.maxPerAgent;
  if (dispatchBlock?.maxPerAgent !== undefined) {
    const parsed = positiveInt(dispatchBlock.maxPerAgent);
    if (parsed === null) {
      errors.push('executor.dispatch.maxPerAgent: expected a whole number above 0 — using the default');
    } else {
      maxPerAgent = Math.min(parsed, maxConcurrent);
    }
  }

  return { config: { backend, orca, dispatch: { maxConcurrent, maxPerAgent } }, errors };
}
