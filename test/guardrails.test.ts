import { describe, it, expect } from 'vitest';
import {
  guardrailOneLine, guardrailLines, guardrailReminderDue,
  formatGuardrailReminder, GUARDRAIL_REINJECT_MS,
} from '../src/handoff/guardrails.js';

/**
 * ISS-07 — one source of positive-phrased guardrails, and a debounce for the
 * edit guard's mid-session re-injection.
 */
describe('guardrails (ISS-07)', () => {
  it('one-line form keeps the continuation-head wording (capital first, lowercase rest, no prohibitions)', () => {
    const line = guardrailOneLine('`baton done sales-hourly`');
    expect(line).toContain('Stay inside this worktree');
    expect(line).toContain('run the project tests before `baton done sales-hourly`');
    expect(line).toContain('execute the existing plan and flag blockers');
    expect(line).not.toMatch(/do not/i);
  });

  it('bullet form capitalizes each rule and carries the finish command', () => {
    const lines = guardrailLines('`baton done x`');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Stay inside this worktree.');
    expect(lines[1]).toContain('Run the project tests before `baton done x`');
    expect(lines.every((l) => !/do not/i.test(l))).toBe(true);
  });

  it('reminder is due when never sent, and again only after the window', () => {
    const now = 1_000_000_000_000;
    expect(guardrailReminderDue(null, now)).toBe(true);
    expect(guardrailReminderDue(now, now)).toBe(false);
    expect(guardrailReminderDue(now - GUARDRAIL_REINJECT_MS + 1, now)).toBe(false);
    expect(guardrailReminderDue(now - GUARDRAIL_REINJECT_MS, now)).toBe(true);
  });

  it('the reminder block carries the guardrail and the finish command', () => {
    const r = formatGuardrailReminder('`baton done x`');
    expect(r).toContain('Stay inside this worktree');
    expect(r).toContain('baton done x');
  });
});
