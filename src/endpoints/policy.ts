// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P27 — which provider each agent talks to, decided per agent and per repo.
 *
 * `.refs/IDE` has one button that rewrites `~/.claude/settings.json` globally,
 * for every project on the machine, forever. This is the same idea done
 * properly: per agent, per repo, opt-in, reversible, and applied as launch
 * environment rather than as a file anybody's other tools have to share.
 *
 * ## The rule that must not be broken
 *
 * A `gateway`-mode agent whose gateway is unreachable **refuses**. It never
 * falls back to the vendor.
 *
 * P16's cost rule protects a bill, and can be overridden by someone who decides
 * the money is worth it. This one protects the code, and cannot: falling back
 * would send a company's source to Anthropic or OpenAI at the exact moment the
 * developer believed it was staying on their network. A silent data leak
 * dressed up as resilience is worse than a failed launch, every time.
 *
 * ## Precedence, and why it stops where it does
 *
 *   repo → user → default `vendor`
 *
 * A company pins `gateway` for its repos by committing `providers` into that
 * repo's `baton.config.json`. That pin travels with the repo and therefore
 * cannot reach a developer's side project — which is the point (P27-E6). The
 * user setting is per machine, so two people on one repo may differ (P27-E10).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from '../store.js';
import { withLock } from '../util/lock.js';
import { endpointViaFor, type EndpointVia } from './reach.js';
import type { EndpointConfig } from './config.js';
import type { EndpointHealth } from './health.js';

/** `unavailable` is never configurable — see `readProviderPolicy`. */
export type ProviderMode = 'vendor' | 'gateway' | 'unavailable';

export type ProviderModeSource = 'repo' | 'user' | 'default' | 'vendor-forbids' | 'environment';

export interface ProviderDecision {
  agent: string;
  mode: ProviderMode;
  source: ProviderModeSource;
  /** Already phrased for a human; shown inline in the settings row. */
  detail: string;
}

export interface ProviderPolicy {
  /** From this repo's `baton.config.json` — committed, and shared by the team. */
  repo: Record<string, ProviderMode>;
  /** From `.baton/providers.json` — this machine only. */
  user: Record<string, ProviderMode>;
}

/** Only the two a person may choose. See `readProviderPolicy`. */
const SETTABLE: ReadonlySet<string> = new Set(['vendor', 'gateway']);

/** The variable each dialect reads, so an exported one can be detected without
 *  spelling any agent's name here. */
const BASE_URL_ENV: Readonly<Record<string, string>> = {
  'anthropic-base-url': 'ANTHROPIC_BASE_URL',
  'openai-base-url': 'OPENAI_BASE_URL',
  'native-model-string': 'OLLAMA_API_BASE',
};

/**
 * The `providers` block of a config file.
 *
 * `unavailable` is deliberately not settable. It is an OBSERVATION about what a
 * vendor permits, owned by `reach.ts` — letting a config declare it would let
 * someone disable an agent for a whole team from a file that is supposed to
 * describe routing, and it would drift from the researched table the first time
 * a vendor changed its mind.
 */
export function readProviderPolicy(raw: unknown): Record<string, ProviderMode> {
  if (!raw || typeof raw !== 'object') return {};
  const block = (raw as { providers?: unknown }).providers;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  const out: Record<string, ProviderMode> = {};
  for (const [agent, mode] of Object.entries(block as Record<string, unknown>)) {
    if (typeof mode === 'string' && SETTABLE.has(mode)) out[agent] = mode as ProviderMode;
  }
  return out;
}

function vendorForbids(agent: string, via: EndpointVia): string {
  return via === null
    ? `'${agent}' cannot be pointed at your own models — its vendor allows no custom endpoint for the reasoning model. That is their decision, not a setting here.`
    : '';
}

export function resolveProviderMode(
  agent: string,
  policy: ProviderPolicy,
  env: NodeJS.ProcessEnv,
): ProviderDecision {
  const via = endpointViaFor(agent);

  // Checked first, and it outranks every config: a repo pinning `gateway` for
  // Antigravity has asked for something impossible, and pretending to honour it
  // produces a confusing agent error at launch instead of a clear answer now.
  if (via === null) {
    return { agent, mode: 'unavailable', source: 'vendor-forbids', detail: vendorForbids(agent, via) };
  }

  // Re-checked here and not only in `readProviderPolicy`: the policy object is
  // plain data that a future caller could assemble without going through the
  // reader, and a mode nobody recognises is not a choice somebody made.
  const setBy = (source: Record<string, ProviderMode>): ProviderMode | null =>
    SETTABLE.has(source[agent]) ? source[agent] : null;
  const fromRepo = setBy(policy.repo);
  const fromUser = setBy(policy.user);
  const wanted = fromRepo ?? fromUser ?? 'vendor';
  const source: ProviderModeSource = fromRepo ? 'repo' : fromUser ? 'user' : 'default';

  if (wanted !== 'gateway') {
    return {
      agent,
      mode: 'vendor',
      source,
      detail: `'${agent}' uses its own subscription or key. Nothing is written anywhere.`,
    };
  }

  /*
   * P27-E4 — the developer exported the variable themselves. That is an
   * explicit act, and overwriting it would silently redirect an agent they had
   * deliberately pointed somewhere else. Only the variable THIS agent actually
   * reads counts: an exported ANTHROPIC_BASE_URL says nothing about codex.
   */
  const name = BASE_URL_ENV[via];
  if (name && typeof env[name] === 'string' && env[name]!.trim()) {
    return {
      agent,
      mode: 'vendor',
      source: 'environment',
      detail: `Your shell already exports ${name}, so '${agent}' is left pointed where you put it. Unset it to route through your gateway.`,
    };
  }

  return {
    agent,
    mode: 'gateway',
    source,
    detail: `'${agent}' is routed to your own models${source === 'repo' ? ' by this repo' : ''}. If the gateway is unreachable it will refuse rather than fall back.`,
  };
}

/**
 * Why this launch must not happen, or null.
 *
 * Only ever fires for a `gateway`-mode agent: `vendor` is the untouched path
 * and `unavailable` was never going to be routed, so neither has anything to
 * refuse. `health` is P17's probe result.
 */
export function providerLaunchRefusal(
  decision: ProviderDecision,
  endpoint: EndpointConfig | null,
  health: EndpointHealth,
): string | null {
  if (decision.mode !== 'gateway') return null;

  /*
   * Gateway mode with nothing configured is not a healthy vendor launch. It is
   * a developer who believes their code is staying on their network with
   * nothing whatsoever making that true — the belief is the danger, so this
   * refuses rather than quietly doing the ordinary thing.
   */
  if (!endpoint) {
    return `'${decision.agent}' is set to use your own models, but no endpoint is configured to serve them. Refusing to launch: running it now would send this repo to the vendor while you believed it was staying on your network. Configure an endpoint, or set '${decision.agent}' back to vendor.`;
  }
  if (!endpoint.usable) {
    return `'${decision.agent}' is set to use your own models, and '${endpoint.id}' is unusable: ${endpoint.unusable}. Refusing to launch rather than falling back to the vendor, which would send this repo off your network.`;
  }

  // `unknown` is in here on purpose. An indeterminate probe is not permission —
  // the same asymmetry as everywhere else: "we could not tell" must never
  // resolve to the option that sends code to a third party.
  const why: Partial<Record<EndpointHealth, string>> = {
    unreachable: `'${endpoint.id}' did not answer`,
    unauthorized: `'${endpoint.id}' rejected the credential`,
    unknown: `'${endpoint.id}' did not answer in time`,
  };
  const reason = why[health];
  if (!reason) return null;

  return `${reason}, and '${decision.agent}' is set to use your own models. Refusing to launch: falling back to the vendor would send this repo off your network at the moment you believed it was staying on it. Fix the gateway, or set '${decision.agent}' back to vendor deliberately.`;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** This machine's own choices. Not committed: two people on one repo may
 *  legitimately differ (P27-E10). */
export function providerPolicyPath(root: string): string {
  return join(batonDir(root), 'providers.json');
}

export async function loadProviderPolicy(root: string): Promise<ProviderPolicy> {
  let repoRaw: unknown = null;
  try {
    repoRaw = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
  } catch {
    // No config, or one we cannot parse. Neither is a reason to route anything
    // anywhere: the default is `vendor`, which changes nothing.
  }
  let userRaw: unknown = null;
  try {
    userRaw = JSON.parse(await readFile(providerPolicyPath(root), 'utf-8'));
  } catch {
    /* never set on this machine */
  }
  return { repo: readProviderPolicy(repoRaw), user: readProviderPolicy(userRaw) };
}

/**
 * Set (or clear) this machine's mode for one agent.
 *
 * P27-E8 — this lands on the NEXT launch. A running agent is not re-pointed
 * underneath itself, which would change where its code is going mid-edit.
 */
export async function setUserProviderMode(
  root: string,
  agent: string,
  mode: ProviderMode | null,
): Promise<Record<string, ProviderMode>> {
  return withLock(providerPolicyPath(root), async () => {
    const { user } = await loadProviderPolicy(root);
    const next = { ...user };
    if (mode === null || !SETTABLE.has(mode)) delete next[agent];
    else next[agent] = mode;
    const path = providerPolicyPath(root);
    await mkdir(batonDir(root), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ providers: next }, null, 2)}\n`);
    await rename(tmp, path);
    return next;
  });
}
