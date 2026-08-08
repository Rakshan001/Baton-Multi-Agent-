// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is the agent holding this task still alive?
 *
 * The MCP heartbeat alone is the wrong answer, and getting it wrong is
 * expensive: an agent running a twenty-minute build makes no tool calls, so a
 * heartbeat-only rule declares it stalled and hands its worktree to somebody
 * else — the exact double-write the pipeline exists to prevent.
 *
 *   liveness = max(heartbeat from the presence table, newest mtime in the worktree)
 *
 * File mtime proves an agent is alive while it is silent. Neither signal alone
 * is sufficient: a worktree can also sit untouched while an agent thinks.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { liveSessions } from './signals.js';
import type { PipelineTask } from './pipeline.js';
import type { Task } from './store.js';

/** Never walked: huge, and their mtimes say nothing about the agent. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__']);

/**
 * Newest mtime under `dir`, or 0.
 *
 * Bounded on purpose — this runs per task on a board read, and an unbounded walk
 * of a monorepo worktree would cost more than the answer is worth. The cap can
 * only make liveness look OLDER, never newer, so the failure mode is refusing a
 * takeover we might have allowed: the safe direction.
 */
export function newestMtimeIn(dir: string, budget = 2000): number {
  let newest = 0;
  let seen = 0;
  const walk = (d: string, depth: number): void => {
    if (seen >= budget || depth > 6) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable or gone — no signal, not an error
    }
    for (const e of entries) {
      if (seen >= budget) return;
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      seen++;
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* raced with a delete — skip */ }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * A `livenessOf` for the pipeline's stall rules, built once per board read.
 *
 * Returning 0 for a task nobody has claimed is deliberate: `isStalled` only
 * looks at `active` tasks, and an active task always has a holder.
 */
export function livenessProbe(root: string, opts: { mtime?: (dir: string) => number } = {}): (t: PipelineTask) => number {
  const mtimeOf = opts.mtime ?? newestMtimeIn;
  // One query, not one per task: the presence table is the same for all of them.
  const heartbeat = new Map<string, number>();
  for (const s of liveSessions(root)) {
    const at = Date.parse(s.at);
    if (!Number.isNaN(at)) heartbeat.set(s.slug, Math.max(heartbeat.get(s.slug) ?? 0, at));
  }
  const mtimeCache = new Map<string, number>();

  return (t: PipelineTask): number => {
    // The claim time is a floor, so a task claimed one minute ago is never
    // "silent for two hours" just because nothing has been written yet.
    const beat = Math.max(
      heartbeat.get(t.claimedBy?.sessionSlug ?? '') ?? 0,
      heartbeat.get(t.slug) ?? 0,
      t.claimedBy ? Date.parse(t.claimedBy.at) || 0 : 0,
    );
    // Worktree fields live on Task, not on the pipeline's minimum shape — a task
    // with no worktree simply contributes no mtime signal.
    const { worktreePath, baseCommit } = t as Partial<Task>;
    if (!worktreePath || !baseCommit) return beat;
    let m = mtimeCache.get(worktreePath);
    if (m === undefined) {
      m = mtimeOf(worktreePath);
      mtimeCache.set(worktreePath, m);
    }
    return Math.max(beat, m);
  };
}
