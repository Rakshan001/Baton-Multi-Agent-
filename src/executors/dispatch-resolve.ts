// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turning a plan file into a dispatch decision, and the seams that carry it out.
 *
 * Extracted from the command because the daemon needs exactly the same answer:
 * a phone that approves a plan must be shown what the CLI would launch, not a
 * second implementation that can drift from it (P10-E1 turns on the two
 * agreeing). Nothing here prints — callers decide how to render.
 */
import { basename } from 'node:path';
import { loadTasks, mutateTasks } from '../store.js';
import { loadPlan, PlanError, type Plan } from '../plan.js';
import { readPlanFile } from '../commands/plan.js';
import { planDigest } from '../plan-trust.js';
import { planDispatch, type DispatchPlan, type DispatchTask } from '../dispatch.js';
import type { ClaimedTask, DispatchDeps } from '../dispatch-run.js';
import { loadExecutorConfig } from './config.js';
import { LocalExecutor } from './local.js';
import { OrcaExecutor } from './orca.js';
import { createOrcaProbe } from './orca-probe.js';
import { resolveExecutor } from './select.js';
import { listRuns, recordRun } from './runs.js';
import type { AgentCapability, Executor, ExecutorId } from './types.js';
import { resolveGate } from '../gate.js';
import { claimTask } from '../commands/claim.js';
import { releaseClaim } from '../lifecycle.js';
import { loadRouting } from '../routing.js';
import { loadLiveEndpoints } from '../endpoints/live-endpoints.js';
import { buildBrief, writeBrief } from '../handoff/brief.js';
import { taskContract } from '../mcp-pipeline.js';
import { buildOrientation } from '../kb/orient.js';
import { installSkill, isSkillAgent } from '../skills/install.js';
import { bus } from '../events.js';

export interface ResolveOpts {
  agent?: string;
  backend?: string;
  max?: string;
  /** P16 step 3. Off by default: a gateway outage must not move queued work
   *  onto a paid model without someone saying so. */
  allowPaidFallback?: boolean;
}

export interface ResolvedDispatch {
  plan: Plan;
  path: string;
  digest: string;
  decision: DispatchPlan;
  backend: ExecutorId;
  executor: Executor;
  caps: ReadonlyMap<string, AgentCapability>;
  /** Config and routing problems, for the caller to surface however it likes. */
  warnings: string[];
}

/** A refusal to resolve at all — a bad plan, or a backend that cannot be used. */
export class DispatchUnresolvable extends Error {
  code: 'plan-invalid' | 'backend-unavailable' | 'unknown-backend';
  detail: string[];
  constructor(code: DispatchUnresolvable['code'], message: string, detail: string[] = []) {
    super(message);
    this.name = 'DispatchUnresolvable';
    this.code = code;
    this.detail = detail;
  }
}

/** A pid we can still signal. `kill(pid, 0)` throws for both gone and foreign. */
function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** In-flight runs, by agent — from the ledger, the only record of what this
 *  machine actually started. */
async function inFlight(root: string): Promise<{ total: number; byAgent: Record<string, number> }> {
  const runs = (await listRuns(root)).filter((r) => !r.endedAt && isAlive(r.pid));
  const byAgent: Record<string, number> = {};
  for (const r of runs) byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + 1;
  return { total: runs.length, byAgent };
}

export async function resolvePlanDispatch(
  root: string,
  file: string,
  opts: ResolveOpts = {},
): Promise<ResolvedDispatch> {
  const { text, path } = await readPlanFile(root, file);
  let plan: Plan;
  try {
    plan = loadPlan(text, basename(path, '.md'));
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    throw new DispatchUnresolvable(
      'plan-invalid',
      `${path} — ${e.issues.length} problem${e.issues.length === 1 ? '' : 's'}`,
      e.issues.map((i) => `${i.where}: ${i.message}`),
    );
  }

  const warnings: string[] = [];
  const { config, errors } = await loadExecutorConfig(root);
  warnings.push(...errors);

  const wanted = opts.backend as ExecutorId | undefined;
  if (wanted && wanted !== 'local' && wanted !== 'orca') {
    throw new DispatchUnresolvable('unknown-backend', `unknown backend '${wanted}' — expected "local" or "orca".`);
  }
  const choice = await resolveExecutor(
    root,
    { backend: wanted ?? config.backend, orca: config.orca },
    createOrcaProbe(),
  );
  if (wanted === 'orca' && choice.backend !== 'orca') {
    // Asked for explicitly and unavailable: refuse rather than degrade. A plan
    // assigned to `@antigravity` only launches under Orca, and quietly running
    // local would turn that into a refusal nobody could explain.
    throw new DispatchUnresolvable('backend-unavailable', `the orca backend was asked for but cannot be used — ${choice.why}`);
  }
  if (choice.degradedFrom) warnings.push(`${choice.why} — using the local backend`);

  const executor: Executor = choice.backend === 'orca' ? new OrcaExecutor() : new LocalExecutor();
  const [caps, routing, tasks, live] = await Promise.all([
    executor.capabilities(root),
    loadRouting(root),
    loadTasks(root),
    // One probe per endpoint for the whole dispatch round, not one per queued
    // task. `null` when nothing is configured, and then dispatch is byte-for-
    // byte what it was before P16.
    loadLiveEndpoints(root),
  ]);
  warnings.push(...routing.errors);

  const decision = await planDispatch({
    tasks: tasks as DispatchTask[],
    planId: plan.id,
    caps,
    backend: choice.backend,
    routing: routing.config,
    running: await inFlight(root),
    limits: config.dispatch,
    gate: await resolveGate(root, tasks),
    ...(opts.agent ? { agentFlag: opts.agent } : {}),
    ...(opts.max ? { max: Number(opts.max) } : {}),
    ...(live
      ? {
          costFor: (tier: string | null) => live.policyFor(tier, opts.allowPaidFallback),
          endpointFor: (model?: string) => live.endpointFor(model),
        }
      : {}),
  });

  return { plan, path, digest: planDigest(text), decision, backend: choice.backend, executor, caps, warnings };
}

/** Install this task's skills into its own worktree, one note per failure. */
async function installSkillsInto(worktreePath: string, skills: string[], agentId: string): Promise<string[]> {
  const notes: string[] = [];
  if (!isSkillAgent(agentId)) {
    // Not a failed dispatch: the brief still lists the skills by name, and the
    // agent can read them. A missing skill is a degraded agent (P3-E6).
    return skills.length ? [`'${agentId}' has no skill directory Baton can write — the brief lists ${skills.join(', ')} by name instead`] : [];
  }
  for (const id of skills) {
    try {
      // `installSkill` git-excludes everything it writes (Q22). This used to
      // exclude `res.rel` here instead, which named SKILL.md and missed the
      // references/ dir beside it — and only this call site remembered at all.
      await installSkill(worktreePath, id, agentId);
    } catch (e) {
      notes.push(`skill '${id}': ${(e as Error).message}`);
    }
  }
  return notes;
}

/** The real seams `runDispatch` writes through. */
export function dispatchDeps(root: string, executor: Executor): DispatchDeps {
  return {
    claim: async (r, slug, who, o): Promise<ClaimedTask> => {
      const { task } = await claimTask(r, slug, who, { override: o.override });
      return { slug: task.slug, worktreePath: task.worktreePath, branch: task.branch, task: task.task };
    },
    release: async (r, slug) => {
      const outcome = await mutateTasks(r, (tasks) => {
        const o = releaseClaim(tasks, slug, { agent: '', sessionSlug: slug });
        return { tasks: o.ok ? tasks.map((t) => (t.slug === slug ? o.task : t)) : null, result: o };
      });
      if (!outcome.ok) throw new Error(outcome.refusal.message);
    },
    installSkills: installSkillsInto,
    writeBriefFor: async (r, task, agentId, model) => {
      const row = (await loadTasks(r)).find((t) => t.slug === task.slug);
      if (!row) throw new Error(`'${task.slug}' vanished from the board between the claim and the brief`);
      const brief = await buildBrief(row, {
        // Nobody handed this off. `from` defaults to 'claude', and a brief that
        // names an agent which was never involved is a false record of where the
        // work came from.
        from: 'baton', to: agentId, root: r, ...(model ? { model } : {}),
        contract: taskContract(row),
        // Best-effort: a repo with no knowledge graph still gets a brief.
        orientation: await buildOrientation(r, { topic: row.task, cwd: row.worktreePath }).catch(() => ''),
      });
      await writeBrief(brief);
    },
    launch: (req) => executor.launch(req),
    recordRun,
    publish: (event) => bus.publish(event),
    now: () => new Date().toISOString(),
  };
}
