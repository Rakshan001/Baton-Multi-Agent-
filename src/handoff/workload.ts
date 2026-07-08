/**
 * Workload-aware handoff (S5). Routing (src/routing.ts) picks a target agent by
 * task *type*; this layer adds the missing *availability* dimension so a busy
 * agent isn't handed yet another task. Pure + unit-tested; the daemon feeds it
 * live loads and the routing pick, the dashboard surfaces the recommendation.
 */

/** A task's git state — `dirty`/`conflict` means an agent is actively churning it. */
export interface LoadRow {
  agent: string | null;
  status: string;
}

/** Count each agent's actively-worked (dirty/conflict) tasks. Clean/idle tasks
 *  and unassigned rows don't add load — we want "who's heads-down right now". */
export function agentActiveLoads(rows: LoadRow[]): Record<string, number> {
  const loads: Record<string, number> = {};
  for (const r of rows) {
    if (!r.agent) continue;
    if (r.status === 'dirty' || r.status === 'conflict') loads[r.agent] = (loads[r.agent] ?? 0) + 1;
  }
  return loads;
}

export interface PickHandoffOpts {
  /** Agents that could receive the task (installed / available). */
  candidates: string[];
  /** Active-task load per agent (agentActiveLoads); missing = 0 = free. */
  loads: Record<string, number>;
  /** The agent routing prefers for this task type, if any. */
  routingPick?: string | null;
  /** The current owner — never hand a task back to itself. */
  exclude?: string | null;
}

export interface HandoffPick {
  agent: string | null;
  reason: string;
}

/**
 * Pick the best agent to hand a task to: the least-loaded available agent,
 * breaking ties toward the routing pick (best fit AND free). When the routing
 * pick is busier than a free alternative, steer to the free one and say so.
 */
export function pickHandoffTarget(opts: PickHandoffOpts): HandoffPick {
  const load = (a: string) => opts.loads[a] ?? 0;
  const pool = [...new Set(opts.candidates)].filter((a) => a && a !== opts.exclude);
  if (!pool.length) return { agent: null, reason: 'no other agent is available to take this' };

  const minLoad = Math.min(...pool.map(load));
  const freest = pool.filter((a) => load(a) === minLoad);
  const pick = opts.routingPick && freest.includes(opts.routingPick) ? opts.routingPick : freest[0];

  const busyPick = opts.routingPick && pool.includes(opts.routingPick) && load(opts.routingPick) > minLoad;
  const loadWord = minLoad === 0 ? 'idle' : `${minLoad} active task${minLoad === 1 ? '' : 's'}`;
  const reason = busyPick
    ? `routing preferred ${opts.routingPick} but it's on ${load(opts.routingPick!)} active task${load(opts.routingPick!) === 1 ? '' : 's'} — ${pick} is ${loadWord}`
    : opts.routingPick === pick
      ? `${pick} fits the task and is ${loadWord}`
      : `${pick} has the lightest load (${loadWord})`;
  return { agent: pick, reason };
}
