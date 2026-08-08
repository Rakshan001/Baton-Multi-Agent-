// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pipeline's agent surface: my_tasks / take_task / complete_task /
 * report_blocked.
 *
 * Everything here already exists as a CLI command and a pure transition — these
 * four are the same operations reached from inside an agent's own session,
 * which is the difference between a pipeline a person drives and one the agents
 * drive themselves. They deliberately share the lifecycle functions rather than
 * re-deciding anything: a second copy of "may I claim this" would drift, and the
 * copy an agent reaches for is the one that must not.
 *
 * Two deliberate omissions:
 *   - No `force`. Buying past a gate is a person's call, made in a terminal.
 *     An agent that can waive its own attestation has no attestation.
 *   - No plan editing. Agents execute a plan; they do not rewrite it mid-flight.
 *
 * Every answer carries its next command, so the tool descriptions (a permanent
 * per-session context tax, budgeted in mcp-help.ts) stay down to the trigger.
 */
import { z } from 'zod';
import { asText } from './mcp-format.js';
import { TOOL_HELP } from './mcp-help.js';
import { loadTasks, type Task } from './store.js';
import { branchCommits, worktreeStatus } from './git.js';
import type { DiffStamp } from './handoff/progress-ledger.js';
import { blockers, eligibleFor, integrationHold, isTerminal, phaseOf, reviewableBy, stateOf, takeable } from './pipeline.js';
import { resolveGate } from './gate.js';
import { block, nextFor, type Who } from './lifecycle.js';
import { claimTask, ClaimRefused } from './commands/claim.js';
import { finishTask } from './commands/finish.js';
import { livenessProbe } from './liveness.js';
import { resolveAgentId, resolveSessionSlug } from './identity.js';
import { mutateTasks } from './store.js';

/**
 * The subset of the MCP registrar this module needs. The SDK's own signature is
 * generic over each tool's zod shape, which does not survive being passed as a
 * value — so mcp.ts casts its wrapped `reg` to this once, at the boundary,
 * rather than every tool being registered through an `any`.
 */
export type ToolArgs = Record<string, unknown>;
export type RegisterTool = (
  name: string,
  config: { description: string; inputSchema?: Record<string, unknown> },
  cb: (args: ToolArgs) => Promise<{ content: { type: 'text'; text: string }[] }>,
) => unknown;

/**
 * Has the ground moved under a working agent?
 *
 * An agent inside a worktree has no reason to look at the board again, so a
 * task cancelled underneath it would be discovered at `complete_task` — after
 * the work. Pure, so every case is a unit test; mcp.ts does the reading and
 * attaches the result to whatever tool the agent called next, which is the
 * soonest moment it can possibly hear.
 */
export function groundMovedNotice(
  task: Task | undefined,
  slug: string,
  selfSlug: string,
): string | null {
  if (!task) return `STOP: task '${slug}' no longer exists. Do not continue — nothing you write will be merged.`;
  const state = stateOf(task);
  if (state === 'cancelled') {
    const by = task.cancelledBy ? ` by ${task.cancelledBy.actor}` : '';
    const why = task.cancelledBy?.reason ? ` (${task.cancelledBy.reason})` : '';
    return `STOP: task '${slug}' was cancelled${by}${why}. Do not continue — nothing further will be merged.`;
  }
  const held = task.claimedBy?.sessionSlug;
  if (held && held !== selfSlug && (state === 'active' || state === 'claimed')) {
    // Two agents in one worktree double-write. Saying so is the whole point:
    // the displaced agent is the only party that can stop.
    return `NOTE: '${slug}' was adopted by ${task.claimedBy?.agent ?? 'another agent'} while you were quiet. Stop, or take it back explicitly with \`baton take ${slug} --resume\` — two agents in one worktree overwrite each other.`;
  }
  return null;
}

/**
 * The diff behind a checkpoint, read from the task's own worktree and branch.
 *
 * Best-effort by design: a checkpoint must never fail because git was busy, and
 * an absent stamp simply means the claim was not checked — which `checkpointFlag`
 * treats as "no opinion" rather than as a pass.
 */
export async function diffStampFor(root: string, slug: string): Promise<DiffStamp | undefined> {
  try {
    const t = (await loadTasks(root)).find((x) => x.slug === slug);
    if (!t?.worktreePath) return undefined;
    const [st, commits] = await Promise.all([
      worktreeStatus(t.worktreePath),
      branchCommits(t.branch, t.baseCommit ?? t.baseBranch, t.repoRoot ?? t.worktreePath),
    ]);
    if (st.state === 'missing') return undefined;   // nothing read, so nothing claimed
    return { filesChanged: st.changedFiles.length, insertions: st.insertions, deletions: st.deletions, commits: commits.length };
  } catch {
    return undefined;
  }
}

/** Who is calling. Same resolution as the CLI, so both agree about ownership. */
async function caller(): Promise<Who> {
  return { agent: await resolveAgentId(), sessionSlug: resolveSessionSlug() };
}

const holds = (t: Task, who: Who): boolean =>
  t.claimedBy?.agent === who.agent && !isTerminal(stateOf(t));

/** One task, described the way an agent needs it: contract, not bookkeeping. */
function brief(t: Task): Record<string, unknown> {
  return {
    slug: t.slug,
    task: t.task,
    state: stateOf(t),
    ...(phaseOf(t) ? { phase: phaseOf(t) } : {}),
    ...(t.scope?.length ? { scope: t.scope } : {}),
    ...(t.expects?.length ? { expects: t.expects } : {}),
    ...(t.principles?.length ? { principles: t.principles } : {}),
    ...(t.dependsOn?.length ? { dependsOn: t.dependsOn } : {}),
  };
}

/**
 * Resolve which task a tool call is about.
 *
 * A named slug wins. Otherwise it is the task this agent holds — and if it
 * holds more than one, we refuse rather than guess: acting on the wrong task is
 * the hallucination class this whole design is built against, and a coin flip
 * here would be Baton itself doing it.
 */
function resolveOwn(tasks: Task[], who: Who, slug?: string): { task: Task } | { error: string } {
  if (slug) {
    const t = tasks.find((x) => x.slug === slug);
    return t ? { task: t } : { error: `No task '${slug}'. Call my_tasks to see what is yours.` };
  }
  const mine = tasks.filter((t) => holds(t, who));
  if (mine.length === 1) return { task: mine[0]! };
  if (mine.length === 0) return { error: 'You are not holding a task. Call my_tasks, then take_task.' };
  return { error: `You hold ${mine.length} tasks (${mine.map((t) => t.slug).join(', ')}) — name the one you mean.` };
}

export function registerPipelineTools(reg: RegisterTool, root: string): void {
  reg(
    'my_tasks',
    { description: TOOL_HELP.my_tasks, inputSchema: {} },
    async () => {
      const who = await caller();
      const tasks = await loadTasks(root);
      const liveness = livenessProbe(root);
      const now = Date.now();

      const held = tasks.filter((t) => holds(t, who));
      // Gated: listing work as startable that take_task would then refuse is
      // how an agent ends up in a retry loop against a locked phase.
      const gate = await resolveGate(root, tasks);
      const startable = eligibleFor(who.agent, tasks, gate) as Task[];
      const toReview = reviewableBy(who.agent, tasks) as Task[];
      // Someone else's work that went quiet. Offered, not taken: adopting it is
      // an explicit act, because two agents in one worktree is the failure the
      // whole claim mechanism exists to prevent.
      const stalled = (takeable(tasks, { now, livenessOf: liveness }) as Task[])
        .filter((t) => t.claimedBy?.agent !== who.agent);

      return asText({
        agent: who.agent,
        // Ordered by what to do first: finish what you hold, then unblock others
        // by reviewing, then start something new.
        holding: held.map((t) => ({
          ...brief(t),
          worktree: t.worktreePath,
          ...(t.reviewedBy?.verdict === 'reject' ? { sentBackBy: t.reviewedBy.actor, fix: t.reviewedBy.notes } : {}),
          next: stateOf(t) === 'blocked'
            ? `still blocked: ${t.stoppedReason ?? ''} — resolve it, or hand it back with \`baton pause ${t.slug}\``
            : `complete_task when finished · report_blocked if you cannot proceed · \`baton pause ${t.slug}\` if you are out of time`,
        })),
        awaitingYourReview: toReview.map((t) => ({
          ...brief(t),
          worktree: t.worktreePath,
          writtenBy: t.contributors?.map((c) => c.agent) ?? [t.claimedBy?.agent].filter(Boolean),
          next: `read the diff, then: \`baton review approve ${t.slug}\` or \`baton review reject ${t.slug} -n "<what to fix>"\``,
        })),
        startable: startable.map(brief),
        stalledYouCouldAdopt: stalled.map((t) => ({
          slug: t.slug, task: t.task, heldBy: t.claimedBy?.agent ?? 'unknown',
          next: `\`baton take ${t.slug} --resume\` — read what is already there before adding to it`,
        })),
        ...(held.length || startable.length || toReview.length ? {} : {
          // An empty answer with no cause looks identical to a finished plan.
          // Gated like the list above, or the two causes an agent cannot see
          // for itself — an unlanded phase, an unpushed dependency — are
          // exactly the ones missing from the explanation.
          waitingOn: blockers(tasks, gate).slice(0, 10),
        }),
        tip: held.length
          ? 'Finish what you hold before starting anything else.'
          : startable.length ? 'take_task to claim one.' : undefined,
      });
    },
  );

  reg(
    'take_task',
    {
      description: TOOL_HELP.take_task,
      inputSchema: {
        slug: z.string().optional().describe('Which task. Omit to take the next one for you.'),
        resume: z.boolean().optional().describe('Adopt a stalled task another agent left — read its worktree before adding to it'),
      },
    },
    async (args: ToolArgs) => {
      const { slug, resume } = args as { slug?: string; resume?: boolean };
      const who = await caller();
      const tasks = await loadTasks(root);

      let target = slug;
      if (!target) {
        // Same gate the CLI uses: a phase whose branches have not landed keeps
        // the next one locked, and an agent over MCP must not be handed work
        // that `baton next` refuses to offer a human.
        const gate = await resolveGate(root, tasks);
        const pick = nextFor(who.agent, tasks, gate);
        if (!pick) {
          const held = integrationHold(tasks, gate);
          return asText({
            claimed: null,
            why: 'Nothing is startable for you right now.',
            waitingOn: blockers(tasks, gate).slice(0, 10),
            tip: held !== null
              ? `Phase ${held} is finished but its branches are not on the base, so later phases stay locked. A human runs \`baton integrate ${held}\` — you cannot land it yourself.`
              : 'Call my_tasks — there may be a review waiting for you, which is what lifts the phase barrier.',
          });
        }
        target = pick.slug;
      }

      try {
        const { task, materialized } = await claimTask(root, target, who, { resume: Boolean(resume) });
        return asText({
          claimed: brief(task),
          // The isolation rule, in the answer rather than in the description:
          // it costs nothing here and it is what keeps parallel agents apart.
          worktree: task.worktreePath,
          branch: task.branch,
          rule: `Work ONLY inside ${task.worktreePath}. Edits elsewhere are recorded against this task and may collide with another agent.`,
          ...(materialized ? {} : { note: 'This worktree already had work in it — read it before adding to it.' }),
          whenDone: 'complete_task',
          ifStuck: 'report_blocked (keeps it yours) · `baton pause` (hands it back, loses nothing)',
        });
      } catch (e) {
        if (!(e instanceof ClaimRefused)) throw e;
        return asText({ claimed: null, refused: e.message, code: e.code, tip: 'Call my_tasks for what is actually available to you.' });
      }
    },
  );

  reg(
    'complete_task',
    {
      description: TOOL_HELP.complete_task,
      inputSchema: {
        slug: z.string().optional().describe('Which task. Omit if you hold exactly one.'),
        attest: z.boolean().optional().describe('You RAN what the plan expects and it passed. Your claim, recorded as yours — not a verification.'),
      },
    },
    async (args: ToolArgs) => {
      const { slug, attest } = args as { slug?: string; attest?: boolean };
      const who = await caller();
      const tasks = await loadTasks(root);
      const found = resolveOwn(tasks, who, slug);
      if ('error' in found) return asText({ completed: false, refused: found.error });

      const task = found.task;
      const state = stateOf(task);
      if (state === 'review') return asText({ completed: false, refused: `'${task.slug}' is already in review — a different agent decides it now.` });
      if (isTerminal(state)) return asText({ completed: false, refused: `'${task.slug}' is already ${state}.` });
      if (task.claimedBy && task.claimedBy.agent !== who.agent) {
        return asText({ completed: false, refused: `'${task.slug}' is held by ${task.claimedBy.agent}, not you.` });
      }

      // No `force` on purpose — see the module header.
      const r = await finishTask(root, task, who, { attest: Boolean(attest) });
      if (!r.landedIn) {
        return asText({
          completed: false,
          checks: r.verdict.checks,
          refused: r.verdict.refusals.length
            ? 'The evidence does not hold yet. The task is untouched — it is still yours.'
            : 'This task expects evidence you have not attested to. Run it, then call complete_task with attest:true.',
        });
      }
      return asText({
        completed: true,
        state: r.landedIn,
        checks: r.verdict.checks,
        ...(r.verdict.outOfScope.length ? { outOfScopeRecorded: r.verdict.outOfScope } : {}),
        next: r.landedIn === 'review'
          ? 'A different agent must approve it. Call my_tasks for what to do next.'
          : 'Done. Call my_tasks for what is next.',
      });
    },
  );

  reg(
    'report_blocked',
    {
      description: TOOL_HELP.report_blocked,
      inputSchema: {
        reason: z.string().describe('What is actually in the way — specific enough for a person to act on'),
        slug: z.string().optional().describe('Which task. Omit if you hold exactly one.'),
      },
    },
    async (args: ToolArgs) => {
      const { reason, slug } = args as { reason: string; slug?: string };
      const who = await caller();

      type Blocked = { ok: true; slug: string } | { ok: false; message: string };
      const out = await mutateTasks<Blocked>(root, (tasks) => {
        const found = resolveOwn(tasks, who, slug);
        if ('error' in found) return { tasks: null, result: { ok: false as const, message: found.error } };
        const r = block(tasks, found.task.slug, who, reason ?? '', new Date().toISOString());
        return r.ok
          ? { tasks: r.tasks, result: { ok: true as const, slug: r.task.slug } }
          : { tasks: null, result: { ok: false as const, message: r.refusal.message } };
      });

      if (!out.ok) return asText({ blocked: false, refused: out.message });
      return asText({
        blocked: true,
        slug: out.slug,
        // Blocked stays OWNED. A blocked task returned to the pool is a loop,
        // not a queue — the next agent hits the same wall.
        note: 'Recorded, and the task is still yours. It shows as a named blocker until a person resolves it.',
        next: `If you were wrong and can continue, just keep working — call complete_task when finished. If you are also out of time: \`baton pause ${out.slug}\`.`,
      });
    },
  );
}
