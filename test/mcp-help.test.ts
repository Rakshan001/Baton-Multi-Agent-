// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { TOOL_HELP, TOOL_HELP_BUDGET } from '../src/mcp-help.js';

/**
 * T1 — every agent session pays for the MCP tool descriptions in its context
 * window before doing any work (measured: 2,799 chars ≈ 700 tokens before this
 * round). This test is the regression lock: total and per-tool budgets, plus
 * the behavioral trigger phrases that make agents actually use each tool at
 * the right moment. Fat creep or trigger loss both fail loudly.
 *
 * Everything below counts UTF-8 BYTES, not `String.length`.
 *
 * That was not a detail. `String.length` counts UTF-16 code units, and every
 * neighbouring budget in this repo — test/mcp-wire-budget.test.ts, the figures
 * in docs/mcp-tools.md — counts bytes, because bytes are what a session pays.
 * The two units had already diverged by 10: five descriptions carry an em dash,
 * 3 bytes each, and the char total (3,045) sat exactly on its budget while the
 * real cost was 3,055. Under the old count a curly quote or an ellipsis was
 * free; here it costs what it costs. The same correction the wire-budget test
 * records for the 10,672-vs-10,708 baseline, applied one level down.
 */
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const EXPECTED_TOOLS = [
  'orient', 'check_files', 'list_signals', 'get_report', 'who_touched',
  'list_tasks', 'report_progress', 'touch_files', 'save_memory', 'recall_memory',
  'create_handoff', 'search_history', 'save_progress',
  'my_tasks', 'take_task', 'complete_task', 'report_blocked',
  'next_handoff', 'resolve_handoff', 'suggest_skills',
  'list_worktrees',
] as const;

describe('TOOL_HELP — slim, budgeted MCP tool descriptions', () => {
  it('covers exactly the served tools', () => {
    expect(Object.keys(TOOL_HELP).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('stays inside the total budget (the whole point of T1)', () => {
    const total = Object.values(TOOL_HELP).reduce((n, d) => n + bytes(d), 0);
    expect(total).toBeLessThanOrEqual(TOOL_HELP_BUDGET);
    // 21 tools now. Four raises so far, each for a feature rather than a
    // convenience: the pipeline tools, the handoff relay's two ends,
    // suggest_skills, then list_worktrees.
    // Raising it again needs a deliberate edit — keep every new tool lean.
    expect(TOOL_HELP_BUDGET).toBeLessThanOrEqual(3300);
  });

  /**
   * The unit itself, pinned. A budget that silently means something other than
   * its neighbours drifts again the first time someone types a curly quote, and
   * the drift is invisible: `length` simply does not see the extra bytes.
   */
  it('is a BYTE budget, sitting on the measured value with no slack', () => {
    const wire = Object.values(TOOL_HELP).reduce((n, d) => n + bytes(d), 0);
    // Pin the UNIT, not anyone's punctuation. The previous assertion here was
    // `wire > chars`, which only says "someone typed a multi-byte character" —
    // it would fail if every em dash were legitimately replaced by a hyphen,
    // which is not a regression. What must never drift is that `bytes` counts
    // BYTES: if it silently became `.length`, the budget below would go on
    // matching while measuring the wrong thing entirely.
    expect(bytes('\u2014'), 'the budget must count bytes, not UTF-16 code units').toBe(3);
    expect(TOOL_HELP_BUDGET).toBe(wire);
  });

  it('keeps every tool description individually lean', () => {
    for (const [tool, desc] of Object.entries(TOOL_HELP)) {
      // Bytes here too, for the same reason: the per-tool ceiling and the total
      // have to be denominated in the same thing or one of them is decoration.
      expect(bytes(desc), `${tool} description too long`).toBeLessThanOrEqual(300);
      expect(desc.trim().length, `${tool} description empty`).toBeGreaterThan(20);
    }
  });

  it('keeps the behavioral triggers that make agents call tools at the right time', () => {
    expect(TOOL_HELP.check_files).toMatch(/BEFORE editing/);
    expect(TOOL_HELP.touch_files).toMatch(/start(ing)? editing/i);
    expect(TOOL_HELP.recall_memory).toMatch(/BEFORE exploring/);
    expect(TOOL_HELP.recall_memory).toMatch(/stale/i);
    expect(TOOL_HELP.save_memory).toMatch(/secrets/i);
    expect(TOOL_HELP.save_memory).toMatch(/files/i); // evidence anchors
    expect(TOOL_HELP.report_progress).toMatch(/30 min/);
    expect(TOOL_HELP.orient).toMatch(/session/i);
    expect(TOOL_HELP.get_report).toMatch(/already fixed/i);
    expect(TOOL_HELP.check_files).toMatch(/watcherActive|unproven/i);
    // The relay trigger: agents must reach for it near their usage/context limit.
    expect(TOOL_HELP.create_handoff).toMatch(/limit/i);
    expect(TOOL_HELP.create_handoff).toMatch(/resume|continue/i);
    // save_progress must justify itself by the artifact it feeds.
    expect(TOOL_HELP.save_progress).toMatch(/handoff|snapshot/i);
    // The pipeline triggers. my_tasks has to read as the answer to the question
    // an agent actually asks, or it never gets called at session start.
    expect(TOOL_HELP.my_tasks).toMatch(/pending task/i);
    expect(TOOL_HELP.my_tasks).toMatch(/session start/i);
    // Working outside the worktree is what breaks parallel agents.
    expect(TOOL_HELP.take_task).toMatch(/ONLY/);
    // The two failures the gate exists to catch, named where the agent reads them.
    expect(TOOL_HELP.complete_task).toMatch(/commit/i);
    expect(TOOL_HELP.report_blocked).toMatch(/instead of/i);
    // The relay's other end. next_handoff has to read as the answer to "what
    // now?", or the agent goes hunting through the handoff directory instead.
    expect(TOOL_HELP.next_handoff).toMatch(/next|pick up/i);
    expect(TOOL_HELP.next_handoff).toMatch(/blocked|parallel/i);
    // resolve_handoff is the step that was missing entirely: without the
    // trigger, briefs stay open forever and the pickup list stops being honest.
    expect(TOOL_HELP.resolve_handoff).toMatch(/finish|done|complete/i);
    expect(TOOL_HELP.resolve_handoff).toMatch(/report|what you did/i);
    // suggest_skills has to fire BEFORE the work: asked afterwards, the agent
    // has already improvised through a task a playbook covered. And it must say
    // what it returns, so nobody expects a playbook back.
    expect(TOOL_HELP.suggest_skills).toMatch(/before/i);
    expect(TOOL_HELP.suggest_skills).toMatch(/never bodies|summar/i);
  });
});
