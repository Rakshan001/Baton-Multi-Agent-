// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton usage` — real token usage per agent session, mapped to tasks.
 * Costs are estimates from a static price table (always labelled est).
 *
 * A dash is not a zero: it means that agent's log never reported the number
 * (Codex records no price, Antigravity records no tokens at all). Printing
 * those as 0 would make the table read as "spent nothing".
 */
import { loadTasks , activeBatonRoot } from '../store.js';
import { PRICES_AS_OF, usageForRepo, type SessionUsage, type UsageTotals } from '../usage.js';

/**
 * The TASK column for one session — an attribution claim, so it says which
 * kind it is. Antigravity's transcripts record no working directory, so those
 * sessions are placed from the paths their tool calls touched; printing that
 * deduction in the same column as a logged cwd, unmarked, reads as if somebody
 * had checked. See `attribution` in src/usage.ts.
 */
export const TASK_COL = 26;

export const taskCell = (s: Pick<SessionUsage, 'slug' | 'attribution'>): string => {
  // The marker is trimmed LAST, never first: clipping the cell as a whole would
  // drop it from exactly the long worktree slugs it matters most on.
  const mark = s.attribution === 'inferred' ? ' ≈inferred' : '';
  return `${(s.slug ?? '(repo root)').slice(0, TASK_COL - mark.length)}${mark}`;
};

export const fmt = (n: number | null) =>
  n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1_000_000 ?`${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const usd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);

/** Consumed tokens first; cache reads (usually the bulk) on their own; and a
 *  cost that says what it leaves out rather than quietly shrinking. */
export const totalLine = (t: UsageTotals): string =>
  `TOTAL  ${t.sessions} sessions · ${t.turns} turns · used ${fmt(t.consumedTokens)} · in ${fmt(t.inputTokens)} · out ${fmt(t.outputTokens)} · cache-read ${fmt(t.cacheReadTokens)} · ≈ ${usd(t.estCostUsd)} at API list prices (${PRICES_AS_OF})`
  + (t.unpricedSessions > 0 ? ` (excl. ${t.unpricedSessions} unpriced)` : '');

export async function usageCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const { sessions, totals, byModel, byAgent } = await usageForRepo(root, await loadTasks(root));
  if (!sessions.length) {
    console.log('no agent sessions found for this repo or its worktrees');
    return;
  }
  console.log('AGENT/SESSION              TASK                        MODEL                IN       OUT      CACHE→   EST$');
  for (const s of sessions.slice(0, 25)) {
    console.log(
      `${`${s.agent}:${s.sessionId.slice(0, 8)}`.slice(0, 26).padEnd(26)} ${taskCell(s).padEnd(TASK_COL + 1)} ${(s.model ?? '?').slice(0, 20).padEnd(20)} ${fmt(s.inputTokens).padStart(8)} ${fmt(s.outputTokens).padStart(8)} ${fmt(s.cacheReadTokens).padStart(8)} ${usd(s.estCostUsd).padStart(7)}`,
    );
  }
  if (sessions.length > 25) console.log(`… +${sessions.length - 25} older sessions`);
  console.log('');
  console.log(totalLine(totals));
  for (const [agent, t] of Object.entries(byAgent)) {
    console.log(`  ${agent.padEnd(28)} ${String(t.sessions).padStart(3)} sessions · used ${fmt(t.consumedTokens)} · cache-read ${fmt(t.cacheReadTokens)} · ≈ ${usd(t.estCostUsd)}`);
  }
  for (const [model, t] of Object.entries(byModel)) {
    console.log(`  ${model.padEnd(28)} ${String(t.sessions).padStart(3)} sessions · ≈ ${usd(t.estCostUsd)}`);
  }
  console.log('\nnote: claude + codex + antigravity sessions; “—” = the log never reported it, not zero. Costs are estimates at Anthropic API list prices and exist only for priced (Claude) models; “used” = input + output + cache writes (cache reads shown apart).');
  if (sessions.some((s) => s.attribution === 'inferred')) {
    console.log('      “≈inferred” = the task was deduced from the paths that session touched, not from a working directory its log recorded.');
  }
}
