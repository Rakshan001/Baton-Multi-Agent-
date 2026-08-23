// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who runs what, decided before anything spawns.
 *
 * Pure — no fs, no git, no clock — the same discipline as `pipeline.ts`, and
 * for the same reason: a dispatcher that can only be tested by starting real
 * agents is a dispatcher nobody tests. Everything I/O-shaped is injected: the
 * capability map comes from an executor, the phase barrier from `eligibleFor`,
 * the in-flight counts from the runs ledger.
 *
 * It **calls** `eligibleFor` rather than re-deriving startability. There is one
 * definition of "may start now" in this codebase and a second one here would
 * drift the first time a barrier rule changed.
 */
import { resolveLaunch, type LaunchEndpoint, type RefusalCode } from './executors/capability.js';
import type { AgentCapability, ExecutorId, RunMode } from './executors/types.js';
import { blockers, eligibleFor, phaseOf, type EligibilityOpts, type PipelineTask } from './pipeline.js';
import { entryLabel, resolveChain, suggestRoute, type ChainCostPolicy, type RoutingConfig } from './routing.js';

/** Where the agent came from. Recorded so the board can explain itself. */
export type DispatchSource = 'flag' | 'plan' | 'routing';

export interface DispatchLaunch {
  slug: string;
  agentId: string;
  /** The backend's own id — Orca's `cursor` runs a binary called `cursor-agent`. */
  nativeId: string;
  model?: string;
  mode: RunMode;
  source: DispatchSource;
  /** Skills the plan asked for; installed into the worktree by step 4. */
  skills: string[];
  /** Chain entries walked past because this backend cannot launch them. */
  skipped?: string[];
  /** P16-E7. Set when this launch crossed from self-hosted to paid with
   *  consent. Every caller that reports a dispatch names it. */
  promoted?: { from: string; to: string; reason: string };
}

export type DispatchRefusalCode =
  | RefusalCode          // unknown-agent | not-installed | no-mode | no-model
  | 'no-prompt'          // would start without ever being handed its brief
  | 'needs-agent'        // routing mode is manual: a human picks
  | 'no-route'           // nothing in the chain can run here
  | 'not-startable'      // eligibleFor said no — claimed, blocked, phase-locked, deps
  | 'at-capacity'
  | 'per-agent-capacity'
  /** The chain's next entry costs money and the reason for falling through was
   *  a gateway, not a missing CLI. Consent required (P16 step 3). */
  | 'paid-fallback-blocked'
  /** A local-tier model no configured endpoint serves — usually a typo. */
  | 'model-not-served';

export interface DispatchRefusal {
  slug: string;
  code: DispatchRefusalCode;
  reason: string;
  agentId?: string;
}

export interface DispatchLimits {
  maxConcurrent: number;
  maxPerAgent: number;
}

/** A board row as the dispatcher reads it. `PipelineTask` is deliberately the
 *  minimum the barrier needs and carries no prose; routing scores the text. */
export interface DispatchTask extends PipelineTask {
  task?: string;
}

export interface DispatchInput {
  /** The whole board. Filtering happens on `planId`, but dependencies and the
   *  phase barrier are read across all of it — a dependency may live elsewhere. */
  tasks: readonly DispatchTask[];
  /** Dispatch only this plan's tasks. Omitted: every task on the board. */
  planId?: string;
  caps: ReadonlyMap<string, AgentCapability>;
  backend: ExecutorId;
  routing: RoutingConfig;
  /** Runs already in flight — from the ledger, not from the task rows. */
  running: { total: number; byAgent: Readonly<Record<string, number>> };
  limits: DispatchLimits;
  /** Injected into `eligibleFor`: the integration barrier and team fetchability. */
  gate?: EligibilityOpts;
  /** `--agent`: a human's override. Outranks the plan, and says that it did. */
  agentFlag?: string;
  /** `--max N`: a ceiling for this run only, never a change to the limits. */
  max?: number;
  /** Money and gateways, injected — this module still knows nothing about
   *  HTTP. Per tier, because each task routes into its own. Omitted: the walk
   *  behaves exactly as it did before P16. */
  costFor?: (tier: string | null) => ChainCostPolicy;
  /** Which of your endpoints serves a model, and what we know about it. */
  endpointFor?: (model: string | undefined) => LaunchEndpoint;
}

export interface DispatchPlan {
  launches: DispatchLaunch[];
  refusals: DispatchRefusal[];
}

/** Launchable at all by this backend, ignoring which task wants it. */
function launchable(cap: AgentCapability | undefined, model: string | undefined): boolean {
  if (!cap || cap.installed === false || cap.modes.length === 0) return false;
  // A chain is a fallback the user declared, so walking past an agent that
  // cannot honour the requested model is honouring their config. Doing the same
  // for a named assignee would be substitution, and `resolveLaunch` refuses it.
  return !model || cap.supportsModel;
}

/**
 * `any` means "whatever can run here". Resolved deterministically by sorted id
 * so two dispatches of the same board pick the same agent — an `any` that
 * wandered would make a re-dispatch unexplainable.
 */
function anyLaunchable(caps: ReadonlyMap<string, AgentCapability>, model: string | undefined): string | null {
  return [...caps.keys()].sort().find((id) => launchable(caps.get(id), model)) ?? null;
}

interface Pick {
  agentId: string;
  model?: string;
  source: DispatchSource;
  skipped?: string[];
  promoted?: { from: string; to: string; reason: string };
}

async function pickAgent(
  t: DispatchTask,
  input: DispatchInput,
): Promise<Pick | DispatchRefusal> {
  const model = t.model;
  if (input.agentFlag) return { agentId: input.agentFlag, model, source: 'flag' };
  if (t.assignee) return { agentId: t.assignee, model, source: 'plan' };

  const route = suggestRoute(t.task ?? '', input.routing);
  if (route.mode === 'manual') {
    return {
      slug: t.slug, code: 'needs-agent',
      reason: `routing is set to manual — assign this task with '@agent' in the plan, or dispatch it with --agent. Nearest suggestion: ${route.agent}.`,
    };
  }
  const resolved = await resolveChain(route.chain, async (a) => launchable(input.caps.get(a), model), input.costFor?.(route.tier));
  if (resolved && 'refused' in resolved) {
    // Not 'no-route': nothing here is missing. Saying "install something" would
    // send someone after a binary that is already there.
    return {
      slug: t.slug,
      code: resolved.refused === 'model-not-served' ? 'model-not-served' : 'paid-fallback-blocked',
      reason: resolved.reason,
    };
  }
  if (!resolved) {
    const tried = route.chain.map((c) => c.agent).join(' → ');
    return {
      slug: t.slug, code: 'no-route',
      reason: `nothing in the '${route.tier ?? route.source}' chain can run under the ${input.backend} backend (tried: ${tried}).`,
    };
  }
  const agentId = resolved.entry.agent === 'any'
    ? anyLaunchable(input.caps, model)
    : resolved.entry.agent;
  if (!agentId) {
    return { slug: t.slug, code: 'no-route', reason: `routing said 'any', and the ${input.backend} backend can launch nothing.` };
  }
  return {
    agentId,
    // The plan's model outranks the tier's: one is what this task asked for,
    // the other is that tier's default.
    model: model ?? resolved.entry.model,
    source: 'routing',
    ...(resolved.skipped.length ? { skipped: resolved.skipped } : {}),
    ...(resolved.promoted
      ? { promoted: { from: entryLabel(resolved.promoted.from), to: entryLabel(resolved.promoted.to), reason: resolved.promoted.reason } }
      : {}),
  };
}

function isRefusal(p: Pick | DispatchRefusal): p is DispatchRefusal {
  return 'code' in p;
}

/**
 * Decide the launches for one dispatch.
 *
 * Order is plan order within ascending phase — the order a human reads the
 * file. It matters because it decides who gets the last free slot, and an
 * ordering nobody can predict makes `--max` feel arbitrary.
 */
export async function planDispatch(input: DispatchInput): Promise<DispatchPlan> {
  const { tasks, planId, caps, backend, limits } = input;
  const mine = planId === undefined ? tasks : tasks.filter((t) => t.planId === planId);

  // The union over every distinct assignee is exactly "eligible for somebody".
  // `eligibleFor` filters `assignee != null && assignee !== agent`, so asking it
  // with a task's own assignee is asking whether that task may start.
  const OPEN = ' open';
  const eligible = new Set<string>();
  for (const who of new Set(tasks.map((t) => t.assignee ?? OPEN))) {
    for (const t of eligibleFor(who, tasks, input.gate)) eligible.add(t.slug);
  }
  const why = new Map(blockers(tasks, input.gate).map((b) => [b.slug, b.reason]));

  const launches: DispatchLaunch[] = [];
  const refusals: DispatchRefusal[] = [];
  const perAgent = new Map<string, number>(Object.entries(input.running.byAgent));
  let total = input.running.total;

  const ordered = [...mine]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => phaseOf(a.t) - phaseOf(b.t) || a.i - b.i)
    .map((x) => x.t);

  for (const t of ordered) {
    if (!eligible.has(t.slug)) {
      // A blocked, claimed or phase-locked task has a reason; a finished one has
      // none, and listing it would make every re-dispatch of a nearly-complete
      // plan read as a wall of failures.
      const reason = why.get(t.slug);
      if (reason) refusals.push({ slug: t.slug, code: 'not-startable', reason });
      continue;
    }

    const pick = await pickAgent(t, input);
    if (isRefusal(pick)) { refusals.push(pick); continue; }

    const res = resolveLaunch({ agentId: pick.agentId, model: pick.model, want: 'any' }, caps, backend, input.endpointFor?.(pick.model));
    if (!res.ok) {
      refusals.push({ slug: t.slug, code: res.code, reason: res.message, agentId: res.agentId });
      continue;
    }

    // aider and opencode take a prompt argument and use only the model, so a
    // headless launch runs with no task at all. Claiming a task for a process
    // that will never read HANDOFF.md is the P3-E7 state reached on purpose.
    const cap = caps.get(res.agentId)!;
    if (res.mode === 'headless' && !cap.acceptsPromptAtLaunch) {
      refusals.push({
        slug: t.slug, code: 'no-prompt', agentId: res.agentId,
        reason: `'${res.agentId}' does not receive a prompt at launch under the ${backend} backend, so it would start with no task. Run it interactively, or assign an agent that does.`,
      });
      continue;
    }

    // Capacity is checked last: a task that could never launch should say why it
    // could never launch, not that the queue was full.
    const ceiling = input.max === undefined
      ? limits.maxConcurrent
      : Math.min(limits.maxConcurrent, input.running.total + input.max);
    if (total >= ceiling) {
      refusals.push({ slug: t.slug, code: 'at-capacity', agentId: res.agentId, reason: `at capacity (${total} running, limit ${ceiling}) — still queued.` });
      continue;
    }
    const mineNow = perAgent.get(res.agentId) ?? 0;
    if (mineNow >= limits.maxPerAgent) {
      refusals.push({ slug: t.slug, code: 'per-agent-capacity', agentId: res.agentId, reason: `'${res.agentId}' is already running ${mineNow} task(s), limit ${limits.maxPerAgent} — still queued.` });
      continue;
    }

    launches.push({
      slug: t.slug,
      agentId: res.agentId,
      nativeId: res.nativeId,
      ...(res.model ? { model: res.model } : {}),
      mode: res.mode,
      source: pick.source,
      skills: t.skills ?? [],
      ...(pick.skipped ? { skipped: pick.skipped } : {}),
    });
    total += 1;
    perAgent.set(res.agentId, mineNow + 1);
  }

  return { launches, refusals };
}

/**
 * Refusals a person can act on by starting the agent themselves.
 *
 * `no-mode` is Baton having no spawn args for an agent that is installed —
 * `@antigravity` is the case this exists for. `no-prompt` is a launcher that
 * would start the agent without ever handing it the brief; a human driving that
 * agent can paste it.
 *
 * `not-installed` is deliberately absent: nobody can start a CLI that is not
 * there, and telling them to open it is advice that fails at the first step.
 */
const HUMAN_STARTABLE: ReadonlySet<DispatchRefusalCode> = new Set(['no-mode', 'no-prompt']);

export interface RelayInstruction {
  slug: string;
  agentId: string;
  /** Where to run `command` — and it is not the operator's own shell. */
  where: string;
  command: string;
  /** The refusal's own words, so the instruction does not hide the reason. */
  why: string;
}

/**
 * Turn the refusals Baton cannot act on into instructions a human can.
 *
 * The command runs *inside the agent*, not in the operator's terminal, and that
 * is not a style preference: `baton take` claims as whoever runs it and reads
 * the agent id off the parent process. From the operator's own shell it
 * resolves to something else and the claim is refused as "assigned to
 * antigravity" — the exact confusion this is meant to prevent.
 */
export function relayFor(refusals: readonly DispatchRefusal[]): RelayInstruction[] {
  return refusals
    .filter((r) => HUMAN_STARTABLE.has(r.code))
    .map((r) => {
      const agentId = r.agentId ?? 'the assigned agent';
      return {
        slug: r.slug,
        agentId,
        where: `${agentId}'s own terminal, opened in this repo`,
        command: `baton take ${r.slug}`,
        // First clause only. The full refusal repeats the "install Orca" route,
        // which is advice about a different fix than the one being offered here.
        why: r.reason.split(' — ')[0]!,
      };
    });
}
