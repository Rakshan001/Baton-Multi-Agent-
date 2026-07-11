import { describe, it, expect } from 'vitest';
import { AGENT_GUIDE } from '../src/commands/kb.js';

/**
 * T2 — the coordination guide is injected into AGENTS.md/CLAUDE.md and read by
 * EVERY session of every agent. Budget + trigger lock, like TOOL_HELP: it must
 * stay lean (was 1,681 chars) and must never lose the behaviors that make
 * coordination actually happen.
 */
describe('AGENT_GUIDE — budgeted coordination guide', () => {
  it('stays inside the budget', () => {
    // was 1,681 pre-T2; 1,073 after the cut; +1 line for the H-round relay
    // trigger (create_handoff). Still ~25% under the original.
    expect(AGENT_GUIDE.length).toBeLessThanOrEqual(1280);
  });

  it('keeps the managed-block markers (idempotent replace-on-change)', () => {
    expect(AGENT_GUIDE).toContain('<!-- baton:coordination -->');
    expect(AGENT_GUIDE).toContain('<!-- /baton:coordination -->');
  });

  it('keeps every behavioral trigger', () => {
    for (const trigger of [
      'check_files', 'touch_files', 'report_progress', 'get_report',
      'recall_memory', 'save_memory', 'CODEBASE.md', 'query_graph',
      'create_handoff',
    ]) {
      expect(AGENT_GUIDE, `guide lost trigger: ${trigger}`).toContain(trigger);
    }
    expect(AGENT_GUIDE.toLowerCase()).toContain('secrets'); // the memory safety rule
  });
});
