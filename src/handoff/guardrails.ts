/**
 * ISS-07 — the critical continuation guardrails, in ONE place, phrased as
 * POSITIVE requirements ("do this") rather than prohibitions ("do NOT that").
 *
 * A 4,416-trial study measured omission-instruction compliance falling 73% → 33%
 * by turn 16 while requirement-type instructions held. So the rules are worded
 * as requirements, and — because a one-shot injection decays anyway — the edit
 * guard re-injects them mid-session on a debounce (a "safe turn depth" proxy).
 *
 * Every surface that shows these rules draws from here: the continuation head
 * (continuation.ts), the handoff brief (brief.ts), and the guard's mid-session
 * reminder (guard.ts) — so the wording never drifts between them.
 */

/** The canonical rules, lowercase-fragment form so they compose into a
 *  middot one-line OR capitalized bullets without the wording drifting. */
function ruleFragments(doneCmd: string): string[] {
  return [
    'stay inside this worktree',
    `run the project tests before ${doneCmd}`,
    'execute the existing plan and flag blockers instead of restarting it',
  ];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Middot one-line for terse, char-budgeted surfaces (continuation head, guard). */
export function guardrailOneLine(doneCmd: string): string {
  const [first, ...rest] = ruleFragments(doneCmd);
  return [cap(first), ...rest].join(' · ') + '.';
}

/** Capitalized bullet lines (no leading dash) for the fuller handoff brief. */
export function guardrailLines(doneCmd: string): string[] {
  return ruleFragments(doneCmd).map((r) => cap(r) + '.');
}

/** Mid-session re-injection window (ms) — a practical "safe turn depth" proxy. */
export const GUARDRAIL_REINJECT_MS = 20 * 60_000;

/** Pure: is a guardrail re-injection due, given the last one's epoch-ms (null = never)? */
export function guardrailReminderDue(lastMs: number | null, nowMs: number): boolean {
  return lastMs === null || nowMs - lastMs >= GUARDRAIL_REINJECT_MS;
}

/** The short reminder block the edit guard injects mid-session. */
export function formatGuardrailReminder(doneCmd: string): string {
  return `↻ baton: still on this task — ${guardrailOneLine(doneCmd)}`;
}
