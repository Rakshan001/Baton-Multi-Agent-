/**
 * Real token usage, parsed from Claude Code's session JSONLs — input/output/
 * cache tokens + an estimated cost per session, mapped back to baton tasks.
 * This replaces guesswork with the numbers the agent actually burned, so you
 * can see what the knowledge base is saving you.
 *
 * Schema/approach adapted from Orca's claude-usage fetcher (MIT) — concept
 * only, no code vendored. See NOTICE. Claude only for now; codex/gemini
 * session formats are different and deferred.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { listSessionFiles } from './handoff/claude-session.js';
import type { Task } from './store.js';

export interface SessionUsage {
  sessionId: string;
  /** Task slug when the session ran inside a baton worktree; null = main repo. */
  slug: string | null;
  agent: 'claude';
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface UsageTotals {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

export interface RepoUsage {
  sessions: SessionUsage[];
  totals: UsageTotals;
  byModel: Record<string, UsageTotals>;
}

/**
 * USD per million tokens by model family — estimates for the cost display
 * only, always labelled "est". Cache reads are ~10% of input; cache writes
 * ~125% of input (5-minute tier).
 */
const PRICES: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 1, out: 5 },
];
const DEFAULT_PRICE = { in: 3, out: 15 };

export function estimateCostUsd(model: string | null, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = PRICES.find((x) => model && x.match.test(model)) ?? DEFAULT_PRICE;
  const usd =
    (u.inputTokens / 1e6) * p.in +
    (u.outputTokens / 1e6) * p.out +
    (u.cacheReadTokens / 1e6) * p.in * 0.1 +
    (u.cacheWriteTokens / 1e6) * p.in * 1.25;
  return Math.round(usd * 100) / 100;
}

interface UsageLine {
  type?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Parse one session transcript. Defensive: unknown lines are skipped. */
export async function parseSessionUsage(file: string): Promise<Omit<SessionUsage, 'slug'>> {
  const out = {
    sessionId: basename(file, '.jsonl'),
    agent: 'claude' as const,
    model: null as string | null,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estCostUsd: 0,
    firstAt: null as string | null,
    lastAt: null as string | null,
  };
  const rl = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      let m: UsageLine;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== 'assistant') continue;
      const u = m.message?.usage;
      if (!u) continue;
      out.turns++;
      out.inputTokens += u.input_tokens ?? 0;
      out.outputTokens += u.output_tokens ?? 0;
      out.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      out.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      if (m.message?.model) out.model = m.message.model;
      if (m.timestamp) {
        out.firstAt ??= m.timestamp;
        out.lastAt = m.timestamp;
      }
    }
  } catch {
    /* truncated/locked transcript — keep what we have */
  } finally {
    rl.close();
  }
  out.estCostUsd = estimateCostUsd(out.model, out);
  return out;
}

/** mtime-keyed cache: a session file is only re-parsed after it changes. */
const cache = new Map<string, { mtimeMs: number; usage: Omit<SessionUsage, 'slug'> }>();

async function cachedSessionUsage(file: string): Promise<Omit<SessionUsage, 'slug'> | null> {
  try {
    const st = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.usage;
    const usage = await parseSessionUsage(file);
    cache.set(file, { mtimeMs: st.mtimeMs, usage });
    return usage;
  } catch {
    return null;
  }
}

const emptyTotals = (): UsageTotals => ({
  sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0,
});

function addTo(t: UsageTotals, s: Omit<SessionUsage, 'slug'>): void {
  t.sessions++;
  t.turns += s.turns;
  t.inputTokens += s.inputTokens;
  t.outputTokens += s.outputTokens;
  t.cacheReadTokens += s.cacheReadTokens;
  t.cacheWriteTokens += s.cacheWriteTokens;
  t.estCostUsd = Math.round((t.estCostUsd + s.estCostUsd) * 100) / 100;
}

/** Usage for the repo root + every task worktree, mapped to slugs. */
export async function usageForRepo(root: string, tasks: Task[]): Promise<RepoUsage> {
  const targets: Array<{ cwd: string; slug: string | null }> = [
    { cwd: root, slug: null },
    ...tasks.map((t) => ({ cwd: t.worktreePath, slug: t.slug })),
  ];
  const sessions: SessionUsage[] = [];
  for (const { cwd, slug } of targets) {
    for (const file of await listSessionFiles(cwd)) {
      const usage = await cachedSessionUsage(file);
      if (usage && usage.turns > 0) sessions.push({ ...usage, slug });
    }
  }
  sessions.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  const totals = emptyTotals();
  const byModel: Record<string, UsageTotals> = {};
  for (const s of sessions) {
    addTo(totals, s);
    const key = s.model ?? 'unknown';
    byModel[key] ??= emptyTotals();
    addTo(byModel[key], s);
  }
  return { sessions, totals, byModel };
}
