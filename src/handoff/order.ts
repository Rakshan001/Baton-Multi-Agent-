// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turn a flat pile of handoff briefs into a pipeline.
 *
 * Ten open briefs in creation order tell you nothing about what to pick up. The
 * ordering information already exists — plans have phases, task contracts carry
 * `dependsOn` — it just never reached the structured entry the dashboard reads.
 *
 * This assigns each brief a **step**: step 1 is everything you can start now,
 * step 2 is everything that only waits on step 1, and so on. Briefs sharing a
 * step are genuinely parallel — hand them to different agents at the same time.
 */

import type { BriefEntry } from './resume.js';

export interface OrderedBrief extends BriefEntry {
  /** 1-based position in the pipeline. Briefs sharing a step can run together. */
  step: number;
  /** True when another open brief shares this step. */
  parallel: boolean;
  /** No open brief is holding this one up — safe to paste now. */
  ready: boolean;
  /** Slugs of open briefs this one waits on. */
  blockedBy: string[];
  /** This brief sits in a dependency cycle and can never become ready on its own. */
  cyclic: boolean;
}

/** Creation time, oldest first; briefs without one sort last but stay stable. */
function byCreated(a: BriefEntry, b: BriefEntry): number {
  const ta = Date.parse(a.created || '');
  const tb = Date.parse(b.created || '');
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
  return a.slug.localeCompare(b.slug);
}

/**
 * Order briefs into pipeline steps.
 *
 * A dependency naming a brief that is **not open** is treated as satisfied: the
 * usual reason a dependency has no brief is that the work was finished and its
 * brief closed. Blocking on it would freeze the pipeline permanently.
 */
export function orderBriefs(briefs: BriefEntry[]): OrderedBrief[] {
  if (briefs.length === 0) return [];

  const open = new Set(briefs.map((b) => b.slug));
  // Only dependencies that are still open can block anything.
  const blockers = new Map<string, string[]>(
    briefs.map((b) => [b.slug, (b.dependsOn ?? []).filter((d) => d !== b.slug && open.has(d))]),
  );

  // Kahn's algorithm, one whole layer at a time: everything with nothing left to
  // wait for shares a step, which is exactly the set that can run in parallel.
  const step = new Map<string, number>();
  const settled = new Set<string>();
  const sorted = [...briefs].sort(byCreated);

  for (let n = 1; settled.size < sorted.length; n++) {
    const layer = sorted.filter(
      (b) => !settled.has(b.slug) && blockers.get(b.slug)!.every((d) => settled.has(d)),
    );
    // Nothing became available: everything left is in a cycle. Placing them all
    // on one final step terminates the loop instead of spinning forever.
    if (layer.length === 0) {
      for (const b of sorted) if (!settled.has(b.slug)) step.set(b.slug, n);
      break;
    }
    for (const b of layer) step.set(b.slug, n);
    for (const b of layer) settled.add(b.slug);
  }

  const perStep = new Map<number, number>();
  for (const s of step.values()) perStep.set(s, (perStep.get(s) ?? 0) + 1);

  const ordered = sorted.map((b): OrderedBrief => {
    const blockedBy = blockers.get(b.slug)!;
    const cyclic = !settled.has(b.slug);
    return {
      ...b,
      step: step.get(b.slug) ?? 1,
      parallel: (perStep.get(step.get(b.slug) ?? 1) ?? 1) > 1,
      // A brief in a cycle is never "ready": pasting it cannot make progress.
      ready: !cyclic && blockedBy.length === 0,
      blockedBy,
      cyclic,
    };
  });

  // An explicit phase is the author's stated intent and outranks anything we
  // infer from the dependency graph.
  const phases = [...new Set(ordered.map((b) => b.phase).filter((p): p is string => !!p))].sort();
  const phaseRank = new Map(phases.map((p, i) => [p, i]));

  return ordered.sort((a, b) => {
    const pa = a.phase ? phaseRank.get(a.phase)! : -1;
    const pb = b.phase ? phaseRank.get(b.phase)! : -1;
    if (pa !== pb) return pa - pb;
    if (a.step !== b.step) return a.step - b.step;
    return byCreated(a, b);
  });
}
