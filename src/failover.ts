// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Automatic failover for headless agent runs.
 *
 * `baton failover <slug> --agents claude,codex,gemini` starts the first agent,
 * watches its output for a provider limit/overload signal, and — when one
 * appears — stops that agent, writes a HANDOFF.md brief, and starts the next
 * agent on the same worktree.
 *
 * This is a foreground supervisor, not a daemon. Nothing here looks for new
 * work; it only supervises the run the user just started, and every launch is
 * printed. That is the same contract `baton start` and `baton dispatch` have,
 * and it keeps the "a machine that starts paid agents on its own schedule"
 * decision out of this feature.
 */
import type { AgentExit } from './spawn.js';
import type { BatonEvent } from './events.js';

export interface FailoverOptions {
  slug: string;
  /** Ordered chain. The first entry runs first. */
  agents: string[];
  /** Maximum agents to try. Defaults to the whole chain. */
  maxAttempts?: number;
  /** Extra user-supplied patterns, already compiled by the CLI. */
  patterns?: RegExp[];
  /** Lines from the task/brief that must never be treated as provider errors.
   *  The next agent commonly echoes the brief it just read, and that brief can
   *  contain the previous agent's limit line. */
  ignore?: readonly string[];
}

export interface FailoverDeps {
  /** Claim/prepare the task for the first agent, or throw when it is held. */
  prepare(slug: string, agent: string): Promise<void>;
  start(slug: string, agent: string): Promise<unknown>;
  wait(slug: string): Promise<AgentExit | null>;
  stop(slug: string): boolean;
  /** Subscribe to this slug's output; returns an unsubscribe function. Must be
   *  called before start() so the first lines are not missed. */
  watch(slug: string, onLine: (line: string, stream: 'out' | 'err') => void): () => void;
  /** Commit pending work and write the handoff brief. */
  pass(slug: string, from: string, to: string, note: string): Promise<void>;
  /** Move the task claim from one agent to the next. */
  reassign(slug: string, from: string, to: string): Promise<void>;
  /** Record a blocked task with a reason. Best effort for plain tasks. */
  block(slug: string, reason: string): Promise<void>;
  publish(event: BatonEvent): void;
  log(line: string): void;
}

export interface FailoverResult {
  outcome: 'finished' | 'failed' | 'exhausted';
  attempts: number;
  lastAgent: string;
  /** The limit line that ended the chain, when outcome is exhausted. */
  reason?: string;
}

/**
 * Provider limit signals, deliberately narrow. A bare "error" is not enough:
 * the point is to distinguish "this account is throttled" from "the agent hit a
 * bug", because only the former is worth spending another agent on.
 */
const DEFAULT_PATTERNS: RegExp[] = [
  /rate[\s_-]*limit(?:ed|ing|s)?\b/i,
  /usage[\s_-]*limit\b/i,
  /quota[\s_-]*(?:exceeded|exhausted|reached|limit)/i,
  /too[\s_-]*many[\s_-]*requests/i,
  /\b429\b/,
  /resource[\s_-]*exhausted/i,
  /overloaded|over capacity/i,
];

/** Return the matching line, or null. Pure so the detector is cheap to test. */
export function matchLimit(line: string, extra: RegExp[] = []): string | null {
  const text = line.trim();
  if (!text) return null;
  for (const re of DEFAULT_PATTERNS) if (re.test(text)) return text;
  for (const re of extra) if (re.test(text)) return text;
  return null;
}

/** Compile `--pattern` values up front, so a bad regex fails before launch. */
export function compilePatterns(sources: readonly string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (e) {
      throw new Error(`invalid --pattern '${source}': ${(e as Error).message}`);
    }
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run the chain until an agent finishes, or until every eligible agent has hit
 * a limit. Handoffs are sequential: the next agent starts only after the
 * current one has exited, so two agents never edit the same worktree at once.
 */
export async function runFailover(opts: FailoverOptions, deps: FailoverDeps): Promise<FailoverResult> {
  const chain = opts.agents.map((a) => a.trim()).filter(Boolean);
  if (chain.length < 2) {
    throw new Error('failover needs at least two agents — e.g. --agents claude,codex');
  }
  const duplicate = chain.find((agent, i) => chain.indexOf(agent) !== i);
  if (duplicate) throw new Error(`duplicate agent '${duplicate}' in the failover chain`);

  const max = Math.max(1, Math.min(opts.maxAttempts ?? chain.length, chain.length));
  const patterns = opts.patterns ?? [];

  await deps.prepare(opts.slug, chain[0]!);

  for (let attempt = 0; attempt < max; attempt += 1) {
    const agent = chain[attempt]!;
    const next = attempt + 1 < max ? chain[attempt + 1]! : null;

    let hit: string | null = null;
    let stopping = false;
    const unsub = deps.watch(opts.slug, (line) => {
      if (hit || stopping) return;
      const text = line.trim();
      if (text && opts.ignore?.some((entry) => {
        const ignored = entry.trim();
        return ignored.length > 0 && (text === ignored || text.includes(ignored));
      })) {
        return;
      }
      const reason = matchLimit(line, patterns);
      if (!reason) return;
      hit = reason;
      stopping = true;
      deps.log(`! ${agent} hit a provider limit: ${reason}`);
      deps.stop(opts.slug);
    });

    try {
      try {
        await deps.start(opts.slug, agent);
      } catch (e) {
        const reason = `could not start ${agent}: ${errorMessage(e)}`;
        deps.log(`✗ ${reason}`);
        await deps.block(opts.slug, reason);
        return { outcome: 'failed', attempts: attempt + 1, lastAgent: agent };
      }

      deps.log(`▶ ${agent} started on '${opts.slug}'${next ? ` (next: ${next})` : ' (last in chain)'}`);
      const exit = await deps.wait(opts.slug);
      if (!exit) {
        const reason = `the ${agent} run could not be observed; nothing was handed off`;
        deps.log(`✗ ${reason}`);
        await deps.block(opts.slug, reason);
        return { outcome: 'failed', attempts: attempt + 1, lastAgent: agent };
      }

      if (hit) {
        if (!next) {
          const reason = `all agents in the failover chain hit a limit; last was ${agent} (${hit})`;
          deps.log(`✗ ${reason}`);
          await deps.block(opts.slug, reason);
          return { outcome: 'exhausted', attempts: attempt + 1, lastAgent: agent, reason: hit };
        }

        deps.log(`↷ handing '${opts.slug}' from ${agent} to ${next}`);
        try {
          await deps.pass(opts.slug, agent, next, `Automatic failover from ${agent} (provider limit).`);
        } catch (e) {
          const reason = `could not write a handoff to ${next}: ${errorMessage(e)}`;
          deps.log(`✗ ${reason}`);
          await deps.block(opts.slug, reason);
          return { outcome: 'failed', attempts: attempt + 1, lastAgent: agent };
        }
        try {
          await deps.reassign(opts.slug, agent, next);
        } catch (e) {
          const reason = `could not move the task claim to ${next}: ${errorMessage(e)}`;
          deps.log(`✗ ${reason}`);
          await deps.block(opts.slug, reason);
          return { outcome: 'failed', attempts: attempt + 1, lastAgent: agent };
        }

        deps.publish({ type: 'agent.failover', slug: opts.slug, from: agent, to: next, reason: hit, attempt: attempt + 1 });
        continue;
      }

      if (exit.code === 0) {
        deps.log(`✓ ${agent} finished '${opts.slug}'`);
        return { outcome: 'finished', attempts: attempt + 1, lastAgent: agent };
      }

      const reason = exit.stopped
        ? `stopped before it finished — still claimed, so nothing else will pick it up; \`baton start ${opts.slug}\` runs it again on the same brief`
        : `the agent ${exit.code === null ? 'ended without an exit code' : `exited ${exit.code}`} without completing the task — read its output, then \`baton start ${opts.slug}\` to run it again on the same brief`;
      deps.log(`✗ ${reason}`);
      await deps.block(opts.slug, reason);
      return { outcome: 'failed', attempts: attempt + 1, lastAgent: agent };
    } finally {
      unsub();
    }
  }

  // max is clamped to at least 1, and every path through the loop returns, so
  // this is a guard against a future refactor rather than a reachable state.
  throw new Error('unreachable: failover loop returned without an outcome');
}
