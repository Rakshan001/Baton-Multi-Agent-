/**
 * Applying a plan to the task list.
 *
 * A plan file is edited by humans and by agents, and re-applied whenever it
 * changes — so `apply` is not "create tasks", it is a THREE-WAY problem: what
 * the file says now, what the board says now, and what an agent is holding
 * while you ask. Getting that wrong is not a lost row, it is an agent whose
 * scope moved under its feet mid-edit.
 *
 * Two rules the whole module exists to enforce:
 *
 *   Finished work is never rewound. A plan that changes a `done` task does not
 *   reopen it. The plan is a statement of intent; history is a statement of
 *   fact, and intent does not get to edit fact.
 *
 *   Removal is not deletion. Dropping a task that never materialized removes a
 *   row. Dropping one that has a branch and a worktree CANCELS it — deleting it
 *   would orphan the worktree on disk with nothing left pointing at it.
 *
 * Pure: no filesystem, no clock. The caller supplies `now` and the worktree
 * root, so every rule below is provable by unit test.
 */
import { join } from 'node:path';
import type { Plan, PlanTask } from './plan.js';
import { isTerminal, stateOf } from './pipeline.js';
import type { Task } from './store.js';

export type PlanChange =
  /** No such task — a queued row will be created. */
  | 'new'
  /** Already matches the plan. Nothing to write. */
  | 'keep'
  /** Queued and untouched, so the plan's edit lands safely. */
  | 'update'
  /** An agent is holding this right now. Needs --force. */
  | 'update-live'
  /** Done or cancelled, and the plan disagrees. Reported, never rewound. */
  | 'frozen'
  /** Gone from the plan, never started, nothing on disk — the row goes. */
  | 'drop'
  /** Gone from the plan but work exists — cancelled, worktree left alone. */
  | 'cancel'
  /** The slug is taken by something this plan does not own. Refuses to apply. */
  | 'conflict';

export interface PlanEntry {
  slug: string;
  change: PlanChange;
  /** Which fields the plan moves — empty for new/keep/drop. */
  fields: string[];
  /** Stored state of the existing task, for the human reading the dry run. */
  state?: string;
  /** Who holds it, when someone does. */
  holder?: string;
  note?: string;
}

export interface ApplyOpts {
  /** Where worktrees live — `<batonRoot>/.baton/wt`. Names only; nothing is created. */
  wtRoot: string;
  /** ISO timestamp for anything this apply writes. */
  now: string;
  /** Recorded on a cancellation, so the board can say who dropped the task. */
  actor?: string;
  baseBranch?: string;
  projectId?: string;
  /** Proceed even when live or conflicting tasks are affected. */
  force?: boolean;
}

export interface ApplyResult {
  tasks: Task[];
  entries: PlanEntry[];
  /** Entries that need --force. Non-empty and unforced ⇒ `tasks` is unchanged. */
  blocking: PlanEntry[];
  /** True when the task list would actually change on disk. */
  dirty: boolean;
}

/** Fields a plan owns. Anything else on a Task belongs to the runtime. */
const OWNED = ['task', 'phase', 'dependsOn', 'assignee', 'scope', 'skills', 'principles', 'expects'] as const;

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Which plan-owned fields differ between the file and the recorded task. */
function movedFields(t: Task, p: PlanTask): string[] {
  const out: string[] = [];
  for (const f of OWNED) {
    const differs = f === 'task' ? t.task !== p.task
      : f === 'phase' ? (t.phase ?? 0) !== p.phase
      : f === 'assignee' ? (t.assignee ?? null) !== p.assignee
      : !sameList(t[f] as string[] | undefined, p[f]);
    if (differs) out.push(f);
  }
  return out;
}

/**
 * Has this task ever become real on disk? A queued plan row carries the branch
 * NAME it intends to use, which is not the same as owning a branch — only a
 * recorded baseCommit proves the worktree was actually created.
 */
function materialized(t: Task): boolean {
  return Boolean(t.baseCommit);
}

function holderOf(t: Task): string | undefined {
  return t.claimedBy?.agent;
}

/** A queued row: a JSON record and nothing else. The branch and worktree named
 *  here are intentions — `take` materializes them, and until then no git object
 *  and no directory exists. That laziness is what makes a 40-task plan cheap. */
function queuedRow(p: PlanTask, plan: Plan, o: ApplyOpts): Task {
  return {
    slug: p.slug,
    task: p.task,
    branch: `baton/${p.slug}`,
    worktreePath: join(o.wtRoot, p.slug),
    baseBranch: o.baseBranch ?? 'HEAD',
    baseCommit: null,
    createdAt: o.now,
    ...(o.projectId ? { projectId: o.projectId } : {}),
    planId: plan.id,
    phase: p.phase,
    dependsOn: p.dependsOn,
    assignee: p.assignee,
    scope: p.scope,
    skills: p.skills,
    principles: p.principles,
    expects: p.expects,
    state: 'queued',
  };
}

/** The plan's fields written onto an existing row, leaving runtime state alone. */
function merged(t: Task, p: PlanTask, plan: Plan): Task {
  return {
    ...t,
    task: p.task,
    planId: plan.id,
    phase: p.phase,
    dependsOn: p.dependsOn,
    assignee: p.assignee,
    scope: p.scope,
    skills: p.skills,
    principles: p.principles,
    expects: p.expects,
  };
}

/**
 * Compute the new task list and the human-readable diff.
 *
 * Nothing is written when anything blocks: a half-applied plan is worse than an
 * unapplied one, because the phase barrier will then gate on tasks nobody meant
 * to create.
 */
export function applyPlan(existing: readonly Task[], plan: Plan, opts: ApplyOpts): ApplyResult {
  const entries: PlanEntry[] = [];
  const bySlug = new Map(existing.map((t) => [t.slug, t]));
  const out: Task[] = existing.map((t) => t);
  const indexOf = new Map(existing.map((t, i) => [t.slug, i]));
  const inPlan = new Set(plan.tasks.map((t) => t.slug));
  const dropped = new Set<string>();

  for (const p of plan.tasks) {
    const t = bySlug.get(p.slug);
    if (!t) {
      entries.push({ slug: p.slug, change: 'new', fields: [] });
      out.push(queuedRow(p, plan, opts));
      continue;
    }
    // A slug owned by a different plan — or by a hand-made task — is not ours to
    // rewrite. Both would land on the same `baton/<slug>` branch, so the collision
    // is real, not bookkeeping.
    if (t.planId !== plan.id) {
      entries.push({
        slug: p.slug,
        change: 'conflict',
        fields: [],
        state: stateOf(t),
        note: t.planId ? `already owned by plan '${t.planId}'` : 'already exists as a hand-made task',
      });
      continue;
    }
    const fields = movedFields(t, p);
    const state = stateOf(t);
    if (!fields.length) {
      entries.push({ slug: p.slug, change: 'keep', fields: [], state });
      continue;
    }
    if (isTerminal(state)) {
      // Finished is finished. Reported so the human sees the plan and the board
      // disagree, but the record of what happened does not get edited.
      entries.push({ slug: p.slug, change: 'frozen', fields, state, note: `${state} — will not rewind` });
      continue;
    }
    const live = state !== 'queued';
    entries.push({
      slug: p.slug,
      change: live ? 'update-live' : 'update',
      fields,
      state,
      holder: holderOf(t),
    });
    const at = indexOf.get(p.slug);
    if (at !== undefined) out[at] = merged(t, p, plan);
  }

  for (const t of existing) {
    if (t.planId !== plan.id || inPlan.has(t.slug)) continue;
    const state = stateOf(t);
    if (isTerminal(state)) {
      // Dropping a finished task from the file does not unfinish it.
      entries.push({ slug: t.slug, change: 'keep', fields: [], state, note: 'no longer in the plan; history kept' });
      continue;
    }
    if (!materialized(t) && state === 'queued') {
      entries.push({ slug: t.slug, change: 'drop', fields: [], state });
      dropped.add(t.slug);
      continue;
    }
    // Work exists. Deleting the row would orphan a branch and a worktree with
    // nothing left pointing at them, so cancel instead — visible, and reversible
    // by putting the task back in the plan.
    entries.push({
      slug: t.slug,
      change: 'cancel',
      fields: [],
      state,
      holder: holderOf(t),
      note: 'removed from the plan — cancelled, worktree kept',
    });
    const at = indexOf.get(t.slug);
    if (at !== undefined) {
      out[at] = {
        ...t,
        state: 'cancelled',
        cancelledBy: { actor: opts.actor ?? 'plan', at: opts.now, reason: 'removed from the plan' },
      };
    }
  }

  // What a human has to see before it happens: a slug we cannot own, an edit
  // landing under a working agent, or a cancellation of work already started.
  const blocking = entries.filter((e) =>
    e.change === 'conflict'
    || e.change === 'update-live'
    || (e.change === 'cancel' && e.state !== 'queued'));
  const tasks = out.filter((t) => !dropped.has(t.slug));
  const dirty = entries.some((e) => e.change !== 'keep' && e.change !== 'frozen');
  // A conflict is never forceable: two tasks cannot share one branch name.
  const hard = blocking.some((e) => e.change === 'conflict');
  return {
    tasks: !hard && (opts.force || blocking.length === 0) ? tasks : existing.map((t) => t),
    entries,
    blocking,
    dirty,
  };
}

/** The dry-run rendering. One line per task, widest-first so it reads as a table. */
export function renderDiff(entries: readonly PlanEntry[]): string[] {
  const mark: Record<PlanChange, string> = {
    new: '+', keep: '=', update: '~', 'update-live': '~', frozen: '~', drop: '-', cancel: '-', conflict: '!',
  };
  const width = Math.max(0, ...entries.map((e) => e.slug.length));
  return entries.map((e) => {
    const what = e.change === 'new' ? 'new'
      : e.change === 'keep' ? (e.note ?? 'unchanged')
      : e.change === 'drop' ? 'removed'
      : e.change === 'cancel' ? (e.note ?? 'cancelled')
      : e.change === 'conflict' ? (e.note ?? 'slug conflict')
      : e.change === 'frozen' ? `${e.fields.join(', ')} changed`
      : `${e.fields.join(', ')} changed`;
    const tail = e.change === 'update-live' ? `  ${(e.state ?? '').toUpperCase()}${e.holder ? ` (${e.holder})` : ''}`
      : e.change === 'frozen' ? `  ${e.note ?? ''}`
      : e.change === 'conflict' ? '  REFUSED'
      : '';
    return `  ${mark[e.change]} ${e.slug.padEnd(width)}  ${what}${tail}`;
  });
}
