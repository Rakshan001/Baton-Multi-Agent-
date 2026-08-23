// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Carrying out a dispatch: claim, skills, brief, launch, record.
 *
 * Every seam is injected, because each one of them writes something — a claim
 * in tasks.json, a worktree on disk, a file in it, a process. Testing the
 * ordering by starting real agents is not testing it.
 *
 * The order is the design:
 *   claim → the worktree exists (only `claimTask` builds one) and the race is
 *           already settled under `withTasksLock`
 *   skills → into the worktree, so parallel agents do not share a skill set
 *   brief  → on disk before anything can read it
 *   launch → handed a pointer to that brief, never the plan's prose
 *   record → the ledger, then the bus
 *
 * A claim that cannot become a running process is released. A task stuck
 * `claimed` with nothing in it looks busy, is invisible to `next`, and holds
 * its phase against every other agent (P3-E7).
 */
import type { BatonEvent } from './events.js';
import type { DispatchLaunch } from './dispatch.js';
import type { LaunchRequest, RunHandle } from './executors/types.js';
import type { DispatchRun } from './executors/runs.js';
import type { Who } from './lifecycle.js';
import { isTerminal, type TaskState } from './pipeline.js';

/** The part of a claimed task this module needs. Deliberately not `Task`. */
export interface ClaimedTask {
  slug: string;
  worktreePath: string;
  branch: string;
  task: string;
}

export interface DispatchDeps {
  claim: (root: string, slug: string, who: Who, opts: { override: boolean }) => Promise<ClaimedTask>;
  release: (root: string, slug: string) => Promise<void>;
  /** Returns one note per skill that could not be installed. Never throws for
   *  a single bad skill — that is P3-E6's whole point. */
  installSkills: (worktreePath: string, skills: string[], agentId: string) => Promise<string[]>;
  writeBriefFor: (root: string, task: ClaimedTask, agentId: string, model?: string) => Promise<void>;
  launch: (req: LaunchRequest) => Promise<RunHandle>;
  recordRun: (root: string, run: DispatchRun) => Promise<void>;
  publish: (event: BatonEvent) => void;
  now: () => string;
}

export interface StartedTask {
  slug: string;
  agentId: string;
  model?: string;
  mode: string;
  pid: number | null;
  /** Things that went wrong without stopping the dispatch — a missing skill. */
  notes: string[];
}

export type DispatchFailureCode = 'claim-refused' | 'brief-failed' | 'launch-failed';

export interface DispatchFailure {
  slug: string;
  agentId: string;
  code: DispatchFailureCode;
  reason: string;
}

export interface DispatchReport {
  started: StartedTask[];
  failed: DispatchFailure[];
  dryRun: boolean;
}

/**
 * ~200 characters, and not one of them from the plan.
 *
 * This sidesteps all six of Orca's `promptInjectionMode` variants and the
 * multi-line paste behaviour of 36 different TUIs, and it keeps plan prose —
 * which arrived by git, from a branch nobody necessarily read — out of the
 * instruction channel entirely. The prose is in HANDOFF.md, behind a fence.
 */
export function dispatchPrompt(slug: string): string {
  return `Baton assigned you task \`${slug}\`. Read ./HANDOFF.md first — that is your brief and your acceptance criteria. `
    + 'Use the baton MCP tools (my_tasks, check_files, save_progress, complete_task). Work only inside this directory.';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Release a claim that cannot become a run — and say so loudly if that fails
 * too, because then the task really is stuck and only a human can clear it.
 */
async function releaseOrSay(root: string, slug: string, deps: DispatchDeps, reason: string): Promise<string> {
  try {
    await deps.release(root, slug);
    return reason;
  } catch (e) {
    return `${reason}. The claim could not be released either (${message(e)}) — '${slug}' is still claimed and will look busy. Restart it with \`baton start ${slug}\`, or drop it with \`baton cancel ${slug}\`.`;
  }
}

/** How a dispatched process ended. `code` is null when a signal ended it. */
export interface AgentExit {
  code: number | null;
  stopped: boolean;
}

/**
 * P3-E11 — what the board should say once a dispatched process is gone.
 *
 * Exit 0 is not success. Success is `complete_task`, which moves the task out
 * of `active`; a process that returned 0 and left the task exactly where it
 * found it did not do the work. Leaving it `active` with no process is the
 * stuck state — held phase, skipped by `next`, reads as work in progress.
 *
 * Never `done`: `verdictFor` owns that, and it needs evidence this function
 * does not have.
 */
export function exitOutcome(
  slug: string,
  state: TaskState,
  exit: AgentExit,
): { block: false } | { block: true; reason: string } {
  // Finished, cancelled, or awaiting a verdict — the agent got where it was
  // going, and nothing here improves on that.
  if (isTerminal(state) || state === 'review') return { block: false };
  // The agent named the obstacle itself. "exited 0" would replace a real reason
  // with the least useful true statement available.
  if (state === 'blocked') return { block: false };
  // Released (P3-E7) or never claimed: there is no claim to explain.
  if (state === 'queued') return { block: false };
  if (exit.stopped) {
    return { block: true, reason: `stopped before it finished — still claimed, so nothing else will pick it up; \`baton start ${slug}\` runs it again on the same brief` };
  }
  const how = exit.code === null ? 'ended without an exit code' : `exited ${exit.code}`;
  return {
    block: true,
    reason: `the agent ${how} without completing the task — read its output, then \`baton start ${slug}\` to run it again on the same brief`,
  };
}

export async function runDispatch(
  root: string,
  launches: readonly DispatchLaunch[],
  deps: DispatchDeps,
  opts: { dryRun?: boolean } = {},
): Promise<DispatchReport> {
  const started: StartedTask[] = [];
  const failed: DispatchFailure[] = [];

  if (opts.dryRun) {
    // Same list, nothing touched. The point of a dry run is that what it prints
    // is what would happen — so it reports from the same decision, not a second
    // code path that can drift from the first.
    return {
      started: launches.map((l) => ({
        slug: l.slug, agentId: l.agentId, model: l.model, mode: l.mode, pid: null, notes: [],
      })),
      failed: [],
      dryRun: true,
    };
  }

  for (const l of launches) {
    let claimed: ClaimedTask;
    try {
      // P3-E12: `--agent` outranks the plan's `@agent`, and the claim enforces
      // that rule too — without this the flag picks an agent the claim then
      // refuses, and the operator is told their own override is not allowed.
      claimed = await deps.claim(root, l.slug, { agent: l.agentId, sessionSlug: l.slug }, { override: l.source === 'flag' });
    } catch (e) {
      // Nothing was taken, so there is nothing to release.
      failed.push({ slug: l.slug, agentId: l.agentId, code: 'claim-refused', reason: message(e) });
      continue;
    }

    // A degraded agent, not a broken one: the brief still lists the skill names.
    const notes: string[] = [];
    if (l.skills.length) {
      try {
        notes.push(...await deps.installSkills(claimed.worktreePath, l.skills, l.agentId));
      } catch (e) {
        notes.push(`skills could not be installed: ${message(e)}`);
      }
    }

    try {
      await deps.writeBriefFor(root, claimed, l.agentId, l.model);
    } catch (e) {
      failed.push({
        slug: l.slug, agentId: l.agentId, code: 'brief-failed',
        reason: await releaseOrSay(root, l.slug, deps, `the brief could not be written (${message(e)})`),
      });
      continue;
    }

    let handle: RunHandle;
    try {
      handle = await deps.launch({
        slug: l.slug,
        agentId: l.agentId,
        nativeId: l.nativeId,
        ...(l.model ? { model: l.model } : {}),
        cwd: claimed.worktreePath,
        prompt: dispatchPrompt(l.slug),
        env: {
          BATON_ROOT: root,
          BATON_SLUG: l.slug,
          BATON_TASK: claimed.task,
          BATON_AGENT: l.agentId,
        },
        title: l.slug,
        mode: l.mode,
      });
    } catch (e) {
      failed.push({
        slug: l.slug, agentId: l.agentId, code: 'launch-failed',
        reason: await releaseOrSay(root, l.slug, deps, `launch failed (${message(e)})`),
      });
      continue;
    }

    await deps.recordRun(root, {
      slug: l.slug,
      agentId: handle.agentId,
      executor: handle.executor,
      mode: handle.mode,
      pid: handle.pid ?? null,
      startedAt: handle.startedAt || deps.now(),
    });
    deps.publish({ type: 'dispatch.started', slug: l.slug, agent: l.agentId, source: l.source });

    started.push({
      slug: l.slug, agentId: handle.agentId, model: l.model, mode: handle.mode,
      pid: handle.pid ?? null, notes,
    });
  }

  return { started, failed, dryRun: false };
}
