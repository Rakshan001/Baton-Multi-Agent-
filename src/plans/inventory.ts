// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every plan on disk, and whether a human has approved the bytes that are
 * there now.
 *
 * The dashboard used to derive its plan list from the TASKS (`pipeline-view.ts`
 * — `tasks.map(t => t.planId)`), so a plan file that had never been
 * `plan apply`-ed appeared nowhere at all. That hid the one checkpoint the whole
 * safety model rests on: `baton plan approve`, recorded against the plan's exact
 * bytes. This module is the missing half — what exists on disk, as opposed to
 * what is running.
 *
 * It COMPOSES the existing judgement and adds none of its own: `parsePlan` and
 * `validatePlan` decide what a plan says and whether it is sound, `planDigest`
 * and `trustVerdict` decide whether it is approved. A second opinion here would
 * eventually disagree with `baton dispatch`, and a screen that says "approved"
 * about a plan the CLI refuses is worse than no screen.
 *
 * Read-only: it opens plan files and the trust store, and writes neither.
 *
 * Two rules worth stating out loud:
 *
 *   A plan that fails to parse is LISTED, with its issues. It is the row
 *   somebody has to fix, and dropping it would hide exactly the plan that needs
 *   attention.
 *
 *   A plan id is hostile input. It arrives from a directory listing and from an
 *   HTTP path, and it becomes a file path — so the grammar is checked BEFORE
 *   anything is joined, never normalized-and-hoped, exactly as the
 *   plan-markdown route in `src/server.ts` already warns.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLANS_DIR } from '../commands/plan.js';
import { isSafePlanId, parsePlan, validatePlan, type PlanIssue } from '../plan.js';
import { loadTrust, planDigest, trustVerdict, type TrustRecord } from '../plan-trust.js';
import { loadTasks, type Task } from '../store.js';

/**
 * A plan id, as one safe path segment — re-exported from `plan.ts`, where the
 * parser that decides a plan's identity defines it.
 *
 * One definition, deliberately: this module, the daemon's plan routes and the
 * parser all have to agree on what a plan may be called, and the last time two
 * of them disagreed about a plan's NAME an approval made on one surface did not
 * exist on another.
 */
export { isSafePlanId };

/**
 * What a person needs to know before acting on a plan.
 *
 * `void` is `trustVerdict`'s `changed` in the words the screen needs: somebody
 * approved this plan and the file moved underneath the approval. It is not a
 * weaker "approved" — it is the case the byte-exact gate exists to catch.
 *
 * `unknown` is the file we could not read. No bytes, so nothing to vouch for,
 * and saying "unapproved" would imply we had looked.
 */
export interface PlanApproval {
  state: 'approved' | 'unapproved' | 'void' | 'unknown';
  /** `trustVerdict`'s own words, verbatim — including how to fix it. */
  reason: string | null;
  approvedBy: string | null;
  /** ISO timestamp of the approval, when there is one. */
  at: string | null;
  /** The digest that was approved, which for `void` is NOT the one on disk. */
  sha256: string | null;
}

export interface PlanInventoryEntry {
  /** The filename stem — the safe path segment, and what a URL names. */
  id: string;
  /**
   * The plan's id — the key `baton plan approve`, `baton dispatch` and the
   * trust store all use. Identical to `id` by construction now: a plan is
   * identified by its file name, and a frontmatter `plan:` that disagrees is an
   * issue rather than a second identity. Kept as its own field because callers
   * read it as "the approval key" rather than as "the file name".
   */
  planId: string;
  /** Repo-relative, for display. Never an absolute path out of the operator's disk. */
  path: string;
  goal: string;
  /** Tasks the FILE declares — not rows on the board. */
  tasks: number;
  phases: number;
  /**
   * Would `loadPlan` accept this file? Parse-level and validation-level issues
   * are one answer on purpose, because applying a plan is all-or-nothing: a
   * plan that parses and then fails validation cannot be applied either.
   */
  parses: boolean;
  /** Every problem, parse-level and validation-level, in reading order. */
  issues: PlanIssue[];
  /** False when the file could not be read at all; every field below is then empty. */
  readable: boolean;
  /** Has this plan created tasks? "On disk" and "running" are different states. */
  applied: boolean;
  /** How many rows on the board this plan owns. */
  appliedTasks: number;
  /** The digest of the bytes on disk right now. */
  sha256: string | null;
  approval: PlanApproval;
}

/** `baton/plans/README.md` is the directory's own documentation, shipped by
 *  baton itself — not somebody's plan. Listing it would put a permanently
 *  unparseable row on the screen, which is how people learn to ignore the
 *  colour that means "fix me". */
const NOT_A_PLAN = 'readme.md';

function approvalOf(record: TrustRecord | null, digest: string | null): PlanApproval {
  if (digest === null) {
    return {
      state: 'unknown',
      reason: 'this plan could not be read, so nothing can be vouched for.',
      approvedBy: record?.approvedBy ?? null,
      at: record?.at ?? null,
      sha256: record?.sha256 ?? null,
    };
  }
  const verdict = trustVerdict(record, digest);
  if (verdict.ok) {
    return {
      state: 'approved',
      reason: null,
      approvedBy: verdict.record.approvedBy,
      at: verdict.record.at,
      sha256: verdict.record.sha256,
    };
  }
  return {
    state: verdict.code === 'changed' ? 'void' : 'unapproved',
    reason: verdict.reason,
    approvedBy: record?.approvedBy ?? null,
    at: record?.at ?? null,
    sha256: record?.sha256 ?? null,
  };
}

/**
 * Every plan file in `baton/plans/`, with what parsing, validation and the
 * trust store say about it.
 *
 * Never throws for a bad directory or a bad file: a missing directory is "no
 * plans", and one unreadable file is one bad row, not a blank screen. The
 * screen exists to show what needs attention, so it has to survive the thing
 * that needs attention.
 *
 * `tasks` may be passed in by a caller that already loaded the board; omitted,
 * it is read here.
 */
export async function planInventory(root: string, tasks?: readonly Task[]): Promise<PlanInventoryEntry[]> {
  let names: string[];
  try {
    names = await readdir(join(root, PLANS_DIR));
  } catch {
    return [];                       // no plans directory is "no plans", not an error
  }

  const ids = names
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== NOT_A_PLAN)
    .map((f) => f.slice(0, -3))
    // Refused before it is ever joined into a path. A name the grammar rejects
    // is not a plan we can serve, approve or link to.
    .filter(isSafePlanId)
    // Byte order, not locale order: a deterministic list on every machine.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!ids.length) return [];

  const [trust, board] = await Promise.all([
    loadTrust(root),
    tasks ? Promise.resolve(tasks) : loadTasks(root),
  ]);

  const out: PlanInventoryEntry[] = [];
  for (const id of ids) {
    const path = `${PLANS_DIR}/${id}.md`;
    let text: string | null = null;
    let readError = 'unknown';
    try {
      text = await readFile(join(root, PLANS_DIR, `${id}.md`), 'utf-8');
    } catch (e) {
      // The errno, not the message: node puts the absolute path in the message,
      // and this row is rendered in a browser that has no business learning
      // where the operator's repo lives.
      readError = (e as NodeJS.ErrnoException)?.code ?? 'unknown';
    }

    if (text === null) {
      out.push({
        id, planId: id, path, goal: '', tasks: 0, phases: 0,
        parses: false,
        issues: [{ where: 'plan', message: `${path} could not be read (${readError})` }],
        readable: false,
        applied: board.some((t) => t.planId === id),
        appliedTasks: board.filter((t) => t.planId === id).length,
        sha256: null,
        approval: approvalOf(trust[id] ?? null, null),
      });
      continue;
    }

    const { plan, issues } = parsePlan(text, id);
    const all = [...issues, ...validatePlan(plan)];
    const digest = planDigest(text);
    // `plan.id` is this file's name — `parsePlan` takes the id from the file
    // and reports a frontmatter `plan:` that disagrees as an issue, so this
    // screen, `baton plan approve` and `baton dispatch` are keyed the same way
    // by construction rather than by three modules remembering to agree.
    const owned = board.filter((t) => t.planId === plan.id);
    out.push({
      id,
      planId: plan.id,
      path,
      goal: plan.goal,
      tasks: plan.tasks.length,
      phases: new Set(plan.tasks.map((t) => t.phase)).size,
      parses: all.length === 0,
      issues: all,
      readable: true,
      applied: owned.length > 0,
      appliedTasks: owned.length,
      sha256: digest,
      approval: approvalOf(trust[plan.id] ?? null, digest),
    });
  }
  return out;
}
