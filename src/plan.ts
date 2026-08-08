// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plan files: markdown in, a validated task graph out.
 *
 * The format is markdown with frontmatter because a plan has to survive three
 * audiences — a human reviewing it before it lands, an agent asked to edit it,
 * and the UI rendering it — and markdown is the only one of those that needs no
 * translation for any of them. It is also what `readBrief` already parses for
 * handoff briefs, so this is a format the repo keeps rather than a new one.
 *
 * A plan file is INERT DATA. Nothing here executes anything, and nothing it
 * contains is ever run — which is what makes it safe to apply a plan that
 * arrived over git. Its text still reaches an agent's context, so callers must
 * treat plan prose as untrusted input, not as instruction.
 *
 * Pure: parsing and validation never touch the filesystem, so every rule below
 * is provable by unit test.
 */
import { slugify } from './util/slug.js';

/** Plan ids and task slugs both become filenames, branch names and CLI args. */
const PLAN_ID_MAX = 60;
const TASK_SLUG_MAX = 40;
/** An assignee is matched against agent ids, which are slugs of the same shape. */
const AGENT_ID_MAX = 40;

export interface PlanTask {
  slug: string;
  task: string;
  phase: number;
  dependsOn: string[];
  assignee: string | null;
  scope: string[];
  skills: string[];
  principles: string[];
  expects: string[];
}

export interface Plan {
  id: string;
  goal: string;
  requireReview: boolean;
  tasks: PlanTask[];
  phases: Array<{ number: number; name: string }>;
}

export interface PlanIssue {
  /** Where it is, as a human reads the file: a slug, a phase, or 'plan'. */
  where: string;
  message: string;
}

export class PlanError extends Error {
  issues: PlanIssue[];
  constructor(issues: PlanIssue[]) {
    super(`plan is not valid:\n${issues.map((i) => `  ${i.where}: ${i.message}`).join('\n')}`);
    this.name = 'PlanError';
    this.issues = issues;
  }
}

/* ------------------------------- parsing -------------------------------- */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Scalar frontmatter only — a plan header holds strings and booleans, and a
 *  general YAML parser would be a dependency and an attack surface for neither. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0 || line.trimStart().startsWith('#')) continue;
    meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** `**scope:** a, b` → ['a','b']. Backticks are formatting, not content. */
function listField(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^`|`$/g, '').trim())
    .filter(Boolean);
}

const PHASE_HEADING = /^##\s+(?:phase\s*)?(\d+)\s*(?:[—\-:·]\s*(.*))?$/i;
/** A heading that means to be a phase but carries no number — see `parsePlan`. */
const PHASE_LIKE = /^##\s+phase\b/i;
/** Any other level-2 heading. `(?!#)` so `###` task headings fall through. */
const SECTION_HEADING = /^##(?!#)\s/;
/**
 * The whole heading, not just its first word. Matching `\S+` here used to make a
 * multi-word name fail the regex outright, and a heading that fails to match is
 * indistinguishable from prose — so `### add auth schema` and everything under
 * it vanished from the plan silently. Capture it all, then peel a trailing
 * `@agent`, and let the slug rule below reject what it must with a message.
 */
const TASK_HEADING = /^###\s+(.+?)\s*$/;
const TRAILING_ASSIGNEE = /\s@(\S+)$/;
const FIELD = /^\*\*([a-z]+):\*\*\s*(.*)$/i;
/** A known field key in any shape but the one that works — see `parsePlan`. */
const MISWRITTEN_FIELD = /^(?:[-*+]\s+)?[*_]{0,2}(scope|skills|principles|expects|dependsOn|after|task)[*_]{0,2}\s*:\s*(.*)$/i;
/**
 * Differs from a safe slug only by case or spacing — a typo, not an attack.
 * Must START and END alphanumeric: that is what keeps `__proto__` out of the
 * gentle branch, where its message would have read like a formatting nit.
 */
const TYPO_SHAPED = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/;

/**
 * Parse a plan file. Structural problems are collected rather than thrown on
 * the first one: someone fixing a plan wants the whole list, not a game of
 * whack-a-mole.
 */
export function parsePlan(text: string, fallbackId = 'plan'): { plan: Plan; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const { meta, body } = parseFrontmatter(text);

  const rawId = meta.plan || fallbackId;
  const id = slugify(rawId, PLAN_ID_MAX);
  if (!id) issues.push({ where: 'plan', message: `plan id '${rawId}' is not usable as a name` });

  const tasks: PlanTask[] = [];
  const phases: Array<{ number: number; name: string }> = [];
  let phase = 0;
  let current: PlanTask | null = null;
  const descr: string[] = [];

  const flush = (): void => {
    if (!current) return;
    if (!current.task) current.task = descr.join(' ').trim();
    tasks.push(current);
    current = null;
    descr.length = 0;
  };

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const ph = PHASE_HEADING.exec(trimmed);
    if (ph) {
      flush();
      phase = Number(ph[1]);
      phases.push({ number: phase, name: (ph[2] ?? '').trim() });
      continue;
    }
    if (PHASE_LIKE.test(trimmed)) {
      // "## Phase two" reads as a new phase and parses as prose, so every task
      // under it would join the PREVIOUS phase — tasks meant to be serialized
      // ending up running in parallel, which is the one thing the barrier is
      // for. Refuse to guess the number.
      issues.push({ where: 'plan', message: `phase heading '${trimmed}' has no number — write it as '## Phase 2 — Name'` });
      continue;
    }
    if (SECTION_HEADING.test(trimmed)) {
      // Some other `##` section — a note, a rationale. It is not a phase, so the
      // phase does not change, but it does end the task above it: without the
      // flush its prose would be appended to that task's description and handed
      // to an agent as instruction.
      flush();
      continue;
    }
    const th = TASK_HEADING.exec(trimmed);
    if (th) {
      flush();
      let raw = th[1];
      let assignee: string | null = null;
      const at = TRAILING_ASSIGNEE.exec(raw);
      if (at) {
        assignee = at[1];
        raw = raw.slice(0, at.index).trim();
      }
      const slug = slugify(raw, TASK_SLUG_MAX);
      if (!slug) {
        issues.push({ where: raw, message: 'task name is not usable as a slug' });
        continue;
      }
      if (slug !== raw) {
        // Never silently rewrite: a slug becomes a branch name and a directory,
        // and a plan that arrived over git is untrusted input.
        issues.push({
          where: raw,
          message: TYPO_SHAPED.test(raw)
            ? `task name must be a lowercase slug — write it as '${slug}'`
            : `unsafe task name — write it as '${slug}'`,
        });
        continue;
      }
      // An assignee is dropped rather than kept, but the issue still stops the
      // plan: it reaches tasks.json and gets matched against agent ids, so a
      // path-shaped one must never survive as a value anybody trusts.
      if (assignee !== null && assignee !== slugify(assignee, AGENT_ID_MAX)) {
        issues.push({ where: slug, message: `unsafe assignee '@${assignee}'` });
        assignee = null;
      }
      if (phase === 0) issues.push({ where: slug, message: 'task appears before any "## Phase N" heading' });
      current = {
        slug, task: '', phase, dependsOn: [], assignee,
        scope: [], skills: [], principles: [], expects: [],
      };
      continue;
    }
    if (!current) continue;
    const f = FIELD.exec(trimmed);
    if (f) {
      const key = f[1].toLowerCase();
      const val = f[2];
      if (key === 'scope') current.scope = listField(val);
      else if (key === 'skills') current.skills = listField(val);
      else if (key === 'principles') current.principles = listField(val);
      else if (key === 'expects') current.expects = val.split(';').map((s) => s.trim()).filter(Boolean);
      else if (key === 'dependson' || key === 'after') current.dependsOn = listField(val);
      else if (key === 'task') current.task = val.trim();
      else issues.push({ where: current.slug, message: `unknown field '${key}'` });
      continue;
    }
    // A field written the wrong way silently becomes prose, and the task ships
    // with no scope at all — which in a phase full of parallel agents is the
    // collision the scope declaration exists to prevent. `**foo:**` already
    // errors as an unknown field; not catching `- scope:` too meant the stricter
    // mistake was reported and the looser one was not.
    const miswritten = MISWRITTEN_FIELD.exec(trimmed);
    if (miswritten) {
      const key = miswritten[1].toLowerCase();
      issues.push({
        where: current.slug,
        message: `'${miswritten[1]}' is written as prose, not a field — use \`**${key}:** ${miswritten[2] || '<value>'}\`. As written the task has no ${key}.`,
      });
      continue;
    }
    if (trimmed) descr.push(trimmed);
  }
  flush();

  const plan: Plan = {
    id,
    goal: meta.goal ?? '',
    // Review is ON unless a plan opts out: the evidence gate proves work
    // happened, not that it is right, and review is the only layer aimed at
    // correctness. Opting out must be a written choice.
    requireReview: (meta.requirereview ?? 'true').toLowerCase() !== 'false',
    tasks,
    phases,
  };
  return { plan, issues };
}

/* ------------------------------ validation ------------------------------ */

/**
 * Does a glob-ish scope entry overlap another? Prefix comparison up to the first
 * wildcard — enough to catch `src/db/**` vs `src/db/schema.ts`, which is the
 * shape that actually collides.
 *
 * The prefix has to land on a path boundary. A bare `startsWith` makes `src/db`
 * cover `src/dbutil.ts`, and since overlap is a HARD error, that false positive
 * rejects a perfectly good plan — the failure nobody debugs, because the tool
 * sounds certain.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  return overlappingPair(a, b) !== null;
}

/**
 * The two entries that actually collide, for the error message. Reporting the
 * whole of both scopes reads as noise when one path in ten is the problem —
 * and the person fixing it has to find that path themselves.
 */
export function overlappingPair(a: string[], b: string[]): [string, string] | null {
  const stem = (s: string): string => {
    const n = s.replace(/\\/g, '/').replace(/^\.\//, '');
    const at = n.search(/[*?[]/);
    return (at === -1 ? n : n.slice(0, at)).replace(/\/+$/, '');
  };
  /** `outer` contains `inner`: same path, or a parent directory of it. */
  const covers = (outer: string, inner: string): boolean =>
    outer === '' || (inner.startsWith(outer) && inner[outer.length] === '/');
  for (const x of a) {
    for (const y of b) {
      const [sx, sy] = [stem(x), stem(y)];
      if (sx === sy || covers(sx, sy) || covers(sy, sx)) return [x, y];
    }
  }
  return null;
}

/**
 * Every rule that must hold before a plan may create tasks.
 *
 * Validation happens BEFORE anything exists, because the alternative is a
 * half-applied plan — and a half-applied plan is worse than no plan, since the
 * barrier will happily gate on tasks that were never meant to exist.
 */
export function validatePlan(plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const bySlug = new Map<string, PlanTask>();

  for (const t of plan.tasks) {
    if (bySlug.has(t.slug)) {
      issues.push({ where: t.slug, message: 'duplicate task name' });
      continue;
    }
    bySlug.set(t.slug, t);
    if (!t.task) issues.push({ where: t.slug, message: 'no description — an agent needs to know what to build' });
  }

  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      const dep = bySlug.get(d);
      if (!dep) {
        issues.push({ where: t.slug, message: `depends on '${d}', which this plan does not define` });
        continue;
      }
      // A dependency in a LATER phase can never be satisfied: the barrier will
      // not open that phase until this one finishes, and this one is waiting on
      // it. Deadlock at apply time rather than at 3am.
      if (dep.phase > t.phase) {
        issues.push({ where: t.slug, message: `depends on '${d}' in a later phase (${dep.phase} > ${t.phase}) — that can never be satisfied` });
      }
    }
  }

  for (const cycle of findCycles(plan.tasks)) {
    issues.push({ where: cycle[0], message: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  // Tasks in the SAME phase run concurrently by design, so overlapping scope is
  // not a warning here — it is two agents editing one file at the same time,
  // which is the exact outcome the phase barrier cannot prevent.
  const byPhase = new Map<number, PlanTask[]>();
  for (const t of plan.tasks) {
    const list = byPhase.get(t.phase);
    if (list) list.push(t); else byPhase.set(t.phase, [t]);
  }
  for (const [phase, list] of byPhase) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!list[i].scope.length || !list[j].scope.length) continue;
        const hit = overlappingPair(list[i].scope, list[j].scope);
        if (hit) {
          const [x, y] = hit;
          issues.push({
            where: `phase ${phase}`,
            message: `'${list[i].slug}' (${x}) and '${list[j].slug}' (${y}) run in parallel over the same files — split them, or move one to another phase`,
          });
        }
      }
    }
  }

  if (!plan.tasks.length) issues.push({ where: 'plan', message: 'no tasks' });
  return issues;
}

/** Dependency cycles, each as the slug path that closes the loop. */
function findCycles(tasks: PlanTask[]): string[][] {
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const walk = (slug: string, path: string[]): void => {
    if (state.get(slug) === 'done') return;
    if (state.get(slug) === 'open') {
      const at = path.indexOf(slug);
      const cycle = [...path.slice(at), slug];
      const key = [...cycle].sort().join('|');
      if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      return;
    }
    state.set(slug, 'open');
    for (const d of bySlug.get(slug)?.dependsOn ?? []) {
      if (bySlug.has(d)) walk(d, [...path, slug]);
    }
    state.set(slug, 'done');
  };

  for (const t of tasks) walk(t.slug, []);
  return cycles;
}

/** Parse and validate in one step. Throws PlanError with every problem found. */
export function loadPlan(text: string, fallbackId?: string): Plan {
  const { plan, issues } = parsePlan(text, fallbackId);
  const all = [...issues, ...validatePlan(plan)];
  if (all.length) throw new PlanError(all);
  return plan;
}
