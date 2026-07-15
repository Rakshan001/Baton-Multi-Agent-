import { describe, it, expect } from 'vitest';
import { TOOL_HELP, TOOL_HELP_BUDGET } from '../src/mcp-help.js';

/**
 * T1 — every agent session pays for the MCP tool descriptions in its context
 * window before doing any work (measured: 2,799 chars ≈ 700 tokens before this
 * round). This test is the regression lock: total and per-tool budgets, plus
 * the behavioral trigger phrases that make agents actually use each tool at
 * the right moment. Fat creep or trigger loss both fail loudly.
 */
const EXPECTED_TOOLS = [
  'orient', 'check_files', 'list_signals', 'get_report', 'who_touched',
  'list_tasks', 'report_progress', 'touch_files', 'save_memory', 'recall_memory',
  'create_handoff', 'search_history', 'save_progress',
] as const;

describe('TOOL_HELP — slim, budgeted MCP tool descriptions', () => {
  it('covers exactly the served tools', () => {
    expect(Object.keys(TOOL_HELP).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('stays inside the total budget (the whole point of T1)', () => {
    const total = Object.values(TOOL_HELP).reduce((n, d) => n + d.length, 0);
    expect(total).toBeLessThanOrEqual(TOOL_HELP_BUDGET);
    // 13 tools now (save_progress joined for ISS-06 agent-agnostic capture).
    // Raising this needs a deliberate edit — keep every new tool lean.
    expect(TOOL_HELP_BUDGET).toBeLessThanOrEqual(2100);
  });

  it('keeps every tool description individually lean', () => {
    for (const [tool, desc] of Object.entries(TOOL_HELP)) {
      expect(desc.length, `${tool} description too long`).toBeLessThanOrEqual(300);
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
  });
});
