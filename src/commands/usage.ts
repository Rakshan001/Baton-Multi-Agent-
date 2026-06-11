/**
 * `baton usage` — real token usage per Claude Code session, mapped to tasks.
 * Costs are estimates from a static price table (always labelled est).
 */
import { gitRoot } from '../git.js';
import { loadTasks } from '../store.js';
import { usageForRepo } from '../usage.js';

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export async function usageCmd(): Promise<void> {
  const root = await gitRoot();
  const { sessions, totals, byModel } = await usageForRepo(root, await loadTasks(root));
  if (!sessions.length) {
    console.log('no Claude Code sessions found for this repo or its worktrees');
    return;
  }
  console.log('SESSION                    TASK                        MODEL                IN       OUT      CACHE→   EST$');
  for (const s of sessions.slice(0, 25)) {
    console.log(
      `${s.sessionId.slice(0, 8).padEnd(26)} ${(s.slug ?? '(repo root)').slice(0, 26).padEnd(27)} ${(s.model ?? '?').slice(0, 20).padEnd(20)} ${fmt(s.inputTokens).padStart(8)} ${fmt(s.outputTokens).padStart(8)} ${fmt(s.cacheReadTokens).padStart(8)} ${('$' + s.estCostUsd.toFixed(2)).padStart(7)}`,
    );
  }
  if (sessions.length > 25) console.log(`… +${sessions.length - 25} older sessions`);
  console.log('');
  console.log(`TOTAL  ${totals.sessions} sessions · ${totals.turns} turns · in ${fmt(totals.inputTokens)} · out ${fmt(totals.outputTokens)} · cache-read ${fmt(totals.cacheReadTokens)} · ≈ $${totals.estCostUsd.toFixed(2)} (est)`);
  for (const [model, t] of Object.entries(byModel)) {
    console.log(`  ${model.padEnd(28)} ${String(t.sessions).padStart(3)} sessions · ≈ $${t.estCostUsd.toFixed(2)}`);
  }
  console.log('\nnote: claude sessions only (codex/gemini session formats not parsed yet); costs are estimates.');
}
