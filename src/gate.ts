// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two git-backed halves of "may this task start", resolved once.
 *
 * `eligibleFor` is pure and must stay that way — it is the one definition of
 * startable and it is unit-tested against plain objects. But two of its inputs
 * are facts about git that no amount of reading tasks.json can answer:
 *
 *   - has a finished phase actually landed on the base? (the integration barrier)
 *   - are a done dependency's commits reachable from here? (team mode)
 *
 * So they are probed at the edge and injected as sync predicates. This module is
 * that edge, in one place, because the alternative — every call site assembling
 * its own `{ integrated, isFetchable }` — is how one of them ends up with half a
 * gate. That already happened: `baton next` refused a locked task while `baton
 * take <slug>` claimed the same task and built its worktree.
 */
import { integratedPhases } from './integrate.js';
import { fetchableProbe } from './fetchable.js';
import type { EligibilityOpts } from './pipeline.js';
import type { Task } from './store.js';

/**
 * Resolve the gate for `tasks` in `root`.
 *
 * One fetch and one ancestry pass answer every task, so this is cheap enough to
 * call on any path that hands out work. A repo with no remote yields no
 * `isFetchable` at all and nothing is gated on reachability — solo use is
 * untouched, which is the point: a gate that fires when there is no one to
 * share with is just a broken tool.
 */
export async function resolveGate(root: string, tasks: readonly Task[]): Promise<EligibilityOpts> {
  const landed = await integratedPhases(root, tasks);
  const isFetchable = (await fetchableProbe(root, tasks.map((t) => t.pushedSha))) ?? undefined;
  return { integrated: (p: number) => landed.has(p), isFetchable };
}
