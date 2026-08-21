// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Can this agent be launched, here, now — decided before anything spawns.
 *
 * Pure, so the entire failure matrix is a unit test rather than something you
 * find out by starting a process.
 *
 * The rule that shapes every answer: **refuse, never substitute.** A plan
 * saying `@antigravity` is an instruction. Quietly starting Claude because
 * Antigravity is unavailable turns the plan's split into a fiction and bills
 * the user for a model they did not choose. Fallback is legitimate only where
 * the user asked for it — a routing `chain` — and that is walked by
 * routing.ts:resolveChain, not here.
 */
import type { AgentCapability, ExecutorId, RunMode } from './types.js';

export type { AgentCapability, ExecutorId, RunMode } from './types.js';

export type RefusalCode = 'unknown-agent' | 'not-installed' | 'no-mode' | 'no-model';

export interface LaunchWant {
  agentId: string;
  model?: string;
  /** `'any'` lets the resolver pick; it prefers headless. */
  want: RunMode | 'any';
}

export type Resolution =
  | { ok: true; agentId: string; nativeId: string; mode: RunMode; model?: string }
  | { ok: false; code: RefusalCode; agentId: string; message: string };

/** The other backend, named for remediation text. */
function otherBackend(backend: ExecutorId): string {
  return backend === 'local' ? 'orca' : 'local';
}

/**
 * Headless first when the caller has no preference: its output reaches the
 * event bus and the dashboard, a TUI's does not. An explicit `want` always
 * wins — a caller asking for a terminal wants a human to be able to type.
 */
function pickMode(modes: readonly RunMode[], want: RunMode | 'any'): RunMode | null {
  if (want !== 'any') return modes.includes(want) ? want : null;
  if (modes.includes('headless')) return 'headless';
  if (modes.includes('interactive')) return 'interactive';
  return null;
}

export function resolveLaunch(
  req: LaunchWant,
  caps: ReadonlyMap<string, AgentCapability>,
  backend: ExecutorId,
): Resolution {
  const { agentId, model, want } = req;
  const cap = caps.get(agentId);

  if (!cap) {
    const known = [...caps.keys()].sort();
    const hint = known.length
      ? ` Known to the ${backend} backend: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''}.`
      : '';
    return {
      ok: false, code: 'unknown-agent', agentId,
      message: `'${agentId}' is not an agent the ${backend} backend knows.${hint} Fix the assignee, or add it to ~/.baton/agents.json.`,
    };
  }

  if (cap.installed === false) {
    return {
      ok: false, code: 'not-installed', agentId,
      message: `'${agentId}' is known to the ${backend} backend but its CLI is not installed on this machine. Install it, or assign the task to an agent that is.`,
    };
  }

  const mode = pickMode(cap.modes, want);
  if (!mode) {
    // The two shapes of "no" read very differently to a user, so say which.
    const message = cap.modes.length === 0
      ? `'${agentId}' has no launcher in the ${backend} backend — it can be detected but not started. The ${otherBackend(backend)} backend can launch it: install Orca, register this repo with it, and set executor.backend. Otherwise change the assignee.`
      : `'${agentId}' cannot run ${want} under the ${backend} backend (it supports: ${cap.modes.join(', ')}). Ask for ${cap.modes[0]} instead, or use the ${otherBackend(backend)} backend.`;
    return { ok: false, code: 'no-mode', agentId, message };
  }

  if (model && !cap.supportsModel) {
    return {
      ok: false, code: 'no-model', agentId,
      message: `'${agentId}' cannot be started with a specific model under the ${backend} backend, and dropping '${model}' silently would run something the plan did not ask for. Remove the model from the task, or assign an agent that supports one.`,
    };
  }

  return { ok: true, agentId, nativeId: cap.nativeId, mode, model };
}
