// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The folded team task → local pipeline row projection (Team Sync v2 §7.1).
 *
 * Team tasks live ONLY in the fold. A row with `origin:'team'` in a Baton
 * root's `tasks.json` is a materialised PROJECTION of one: every team field on
 * it is recomputed from the fold here, and nothing writes those fields any
 * other way — a local change to a team task is an event followed by a refold.
 * The row keeps its local-only fields (worktree, branch, `claimedBy`, …); those
 * are the caller's to merge, which is why this returns fields, not a row.
 *
 * Everything here is PURE.
 *
 * Naming, because the two sides disagree on it:
 *   pipeline `member`   = the PERSON  = fold `lifecycle.assignee`
 *   pipeline `assignee` = the AGENT id = fold `lifecycle.agent`
 */
import type { PipelineFields, PriorityLabel, TaskBrief, TaskState } from '../pipeline.js';
import type { ProjectDef } from './projects.js';
import { DEFAULT_PRIORITY_LEVEL, type PriorityLevel, type TeamTask, type TeamTaskState } from './types.js';

/* ------------------------------------------------------------------ */
/* Priority (C1)                                                       */
/* ------------------------------------------------------------------ */

const LEVEL_OF: Readonly<Record<PriorityLabel, PriorityLevel>> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const LABEL_OF: Readonly<Record<PriorityLevel, PriorityLabel>> = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };

/** Local display label → the fold's numeric level. An unknown label reads as the default. */
export function levelOf(label: PriorityLabel): PriorityLevel {
  return Object.hasOwn(LEVEL_OF, label) ? LEVEL_OF[label] : DEFAULT_PRIORITY_LEVEL;
}

/** The fold's numeric level → the local display label. An unknown level reads as the default. */
export function priorityFromLevel(level: PriorityLevel): PriorityLabel {
  return Object.hasOwn(LABEL_OF, level) ? LABEL_OF[level] : LABEL_OF[DEFAULT_PRIORITY_LEVEL];
}

/* ------------------------------------------------------------------ */
/* State (C2)                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fold state → row state. Total by type (a `Record` over every
 * `TeamTaskState`), so a new fold state cannot compile without a mapping.
 * `unassigned` is the only rename; the rest are one-to-one.
 */
export const TASK_STATE_OF: Readonly<Record<TeamTaskState, TaskState>> = {
  unassigned: 'queued',
  assigned: 'assigned',
  acknowledged: 'acknowledged',
  active: 'active',
  blocked: 'blocked',
  paused: 'paused',
  review: 'review',
  changes: 'changes',
  approved: 'approved',
  pushed: 'pushed',
  merged: 'merged',
  done: 'done',
  cancelled: 'cancelled',
  'needs-owner': 'needs-owner',
};

/**
 * Row state → fold state, the inverse of `TASK_STATE_OF`. Also total by type.
 * `claimed` is the one local-only state (a solo claim whose worktree is still
 * being made) and has no team equivalent, so it maps to null.
 */
export const TEAM_STATE_OF: Readonly<Record<TaskState, TeamTaskState | null>> = {
  queued: 'unassigned',
  claimed: null,
  assigned: 'assigned',
  acknowledged: 'acknowledged',
  active: 'active',
  blocked: 'blocked',
  paused: 'paused',
  review: 'review',
  changes: 'changes',
  approved: 'approved',
  pushed: 'pushed',
  merged: 'merged',
  done: 'done',
  cancelled: 'cancelled',
  'needs-owner': 'needs-owner',
};

export function taskStateOf(s: TeamTaskState): TaskState {
  return TASK_STATE_OF[s];
}

export function teamStateOf(s: TaskState): TeamTaskState | null {
  return TEAM_STATE_OF[s];
}

/* ------------------------------------------------------------------ */
/* Projects (C5)                                                       */
/* ------------------------------------------------------------------ */

/** The fields of the fold's `ProjectInfo` this adapter reads. */
export interface FoldProject {
  name: string;
  remotes: string[];
  rootCommits: string[];
  subpath: string | null;
}

/** Fold `ProjectInfo` (null subpath) → `ProjectDef` for matchProjects (absent subpath). */
export function projectDefOf(key: string, p: FoldProject): ProjectDef {
  return {
    key,
    name: p.name,
    remotes: [...p.remotes],
    rootCommits: [...p.rootCommits],
    ...(p.subpath !== null ? { subpath: p.subpath } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* The projection (C3)                                                 */
/* ------------------------------------------------------------------ */

export interface MaterializeContext {
  /**
   * The local slug for a fold task id, used to translate `dependsOn` (fold ids)
   * into the slugs the pipeline resolves. An id with no local row is kept as
   * is, so the dependency reads as unknown and blocks — never as satisfied.
   */
  slugOf?: (teamId: string) => string | undefined;
}

/** Every field the fold owns on a team row. The row's other fields are local. */
export type TeamProjection = Required<Pick<PipelineFields,
  'origin' | 'teamId' | 'state' | 'priority' | 'urgent' | 'member' | 'assignee' | 'reminders' | 'briefRev' | 'dependsOn' | 'requireReview'
>> & Pick<PipelineFields, 'phase' | 'assignLamport' | 'brief'> & { task: string };

const PROJECTED_KEYS = [
  'origin', 'teamId', 'task', 'state', 'priority', 'urgent', 'member', 'assignee', 'reminders',
  'briefRev', 'dependsOn', 'requireReview', 'phase', 'assignLamport', 'brief',
] as const satisfies ReadonlyArray<keyof TeamProjection>;

const strList = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

/** The fold stores the brief opaquely; only the structured shape reaches an agent's prompt. */
function briefOf(b: unknown): TaskBrief | undefined {
  if (typeof b !== 'object' || b === null) return undefined;
  const o = b as Record<string, unknown>;
  if (typeof o.goal !== 'string') return undefined;
  if (!strList(o.inScope) || !strList(o.outOfScope) || !strList(o.acceptance) || !strList(o.skills)) return undefined;
  return { goal: o.goal, inScope: [...o.inScope], outOfScope: [...o.outOfScope], acceptance: [...o.acceptance], skills: [...o.skills] };
}

/**
 * The row fields for a folded team task. Pure: the same fold task and context
 * always give the same fields, so two devices project one task identically.
 */
export function materialize(task: TeamTask, ctx: MaterializeContext = {}): TeamProjection {
  const L = task.lifecycle;
  const brief = briefOf(task.brief);
  return {
    origin: 'team',
    teamId: task.id,
    task: task.title,
    state: taskStateOf(L.state),
    priority: priorityFromLevel(task.priority),
    urgent: task.urgent,
    member: L.assignee,
    assignee: L.agent,
    reminders: L.reminders,
    briefRev: task.briefRev,
    dependsOn: task.dependsOn.map((id) => ctx.slugOf?.(id) ?? id),
    requireReview: task.review,
    phase: task.phase ?? undefined,
    assignLamport: L.assignLamport ?? undefined,
    brief,
  };
}

/** Does this device hold the take (§7.6)? Only then may it move the task forward. */
export function isHeldHere(task: TeamTask, device: string): boolean {
  return task.lifecycle.holder === device;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Is `row` still an exact projection of `task`? False means the row drifted
 * (a local write, or a fold that moved on) and must be re-materialised. An
 * absent field and an `undefined` one compare equal, as they do in JSON.
 */
export function projectionMatches(
  row: Partial<Record<(typeof PROJECTED_KEYS)[number], unknown>>,
  task: TeamTask,
  ctx: MaterializeContext = {},
): boolean {
  const want = materialize(task, ctx);
  return PROJECTED_KEYS.every((k) => same(row[k], want[k]));
}
