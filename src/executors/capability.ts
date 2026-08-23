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
import type { EndpointConfig } from '../endpoints/config.js';
import type { EndpointHealth } from '../endpoints/health.js';
import { agentsReachingKind, reachesKind } from '../endpoints/reach.js';

export type { AgentCapability, ExecutorId, RunMode } from './types.js';

export type RefusalCode =
  | 'unknown-agent'
  | 'not-installed'
  | 'no-mode'
  | 'no-model'
  /** An impossible pairing: this agent's vendor allows no self-hosted model. */
  | 'no-endpoint'
  /** The gateway did not answer. */
  | 'endpoint-unreachable'
  /** It answered 401 — or we have no credential to send it. */
  | 'endpoint-unauthorized';

export interface LaunchWant {
  agentId: string;
  model?: string;
  /** `'any'` lets the resolver pick; it prefers headless. */
  want: RunMode | 'any';
}

/**
 * The endpoint serving the wanted model, if one does, and what we know about
 * it. `endpoint: null` is the ordinary case — a vendor model — and refuses
 * nothing. An absent `health` means nobody probed: a dispatcher that has not
 * asked must not refuse on an answer it never got.
 */
export interface LaunchEndpoint {
  endpoint: EndpointConfig | null;
  health?: EndpointHealth;
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
  via?: LaunchEndpoint,
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

  const endpointRefusal = refuseEndpoint(cap, model, via);
  if (endpointRefusal) return endpointRefusal;

  return { ok: true, agentId, nativeId: cap.nativeId, mode, model };
}

/**
 * P16 step 2. Only reached when the wanted model is served by one of YOUR
 * endpoints — a vendor model never gets here, so Antigravity on Antigravity's
 * own models keeps launching exactly as before (P16-E6).
 */
function refuseEndpoint(
  cap: AgentCapability,
  model: string | undefined,
  via: LaunchEndpoint | undefined,
): Resolution | null {
  const endpoint = via?.endpoint;
  if (!endpoint) return null;
  const agentId = cap.agentId;

  if (cap.endpointVia === null) {
    const who = agentsReachingKind(endpoint.kind);
    return {
      ok: false, code: 'no-endpoint', agentId,
      message: `'${agentId}' cannot be pointed at a self-hosted model — its vendor allows no custom endpoint. Assign ${who.join(', ') || 'an agent that can reach it'}, or remove the model '${model}' to use ${agentId}'s own models.`,
    };
  }

  if (!reachesKind(cap.endpointVia, endpoint.kind)) {
    const who = agentsReachingKind(endpoint.kind);
    return {
      ok: false, code: 'no-endpoint', agentId,
      message: `'${endpoint.id}' serves ${endpoint.kind} and '${agentId}' does not speak that dialect. Assign ${who.join(', ') || 'an agent that does'}, or serve '${model}' from an endpoint '${agentId}' can reach.`,
    };
  }

  // Declared a credential that is not there. Launching anyway would call a
  // gateway with no key — see endpoints/config.ts.
  if (!endpoint.usable) {
    return {
      ok: false, code: 'endpoint-unauthorized', agentId,
      message: `'${endpoint.id}' is configured but unusable: ${endpoint.unusable}. Baton will not call a gateway without the credential it was told to send.`,
    };
  }

  // A probe that timed out is not permission to launch. It is also not proof
  // the gateway is down, so the message says which of the two we know.
  if (via?.health === 'unknown') {
    return {
      ok: false, code: 'endpoint-unreachable', agentId,
      message: `'${endpoint.id}' (${endpoint.url}) did not answer in time, so we cannot tell whether '${model}' would run — it may be slow, or unreachable from this machine. Baton will not move this task to a paid model on its own.`,
    };
  }

  if (via?.health === 'unreachable') {
    return {
      ok: false, code: 'endpoint-unreachable', agentId,
      message: `'${endpoint.id}' (${endpoint.url}) did not answer, so '${model}' cannot run. Start the gateway or fix the URL — Baton will not move this task to a paid model on its own.`,
    };
  }

  if (via?.health === 'unauthorized') {
    return {
      ok: false, code: 'endpoint-unauthorized', agentId,
      message: `'${endpoint.id}' rejected the credential (HTTP 401/403). The gateway is up, so this is the key, not the connection: check ${endpoint.keyRef ?? 'the credential it expects'}.`,
    };
  }

  return null;
}
