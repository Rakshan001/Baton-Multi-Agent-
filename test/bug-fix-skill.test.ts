import { describe, expect, it } from 'vitest';
import { bundledSkills } from '../src/skills/catalog.js';

/**
 * Invariant guard for the bundled bug-fix skill (S1 — bug-fix v2). Mirrors
 * Ponytail's check-rule-copies.js idea: the skill's load-bearing non-negotiables
 * must survive future edits. If someone trims the skill and drops one of these,
 * this test fails loudly rather than shipping a gutted playbook.
 *
 * v2 over v1 adds Baton-native coordination: check the shared tracker FIRST,
 * record the fix (with the fixing commit) to shared memory LAST, warn on live
 * collisions, and keep context hygiene — while preserving the v1 safety gates.
 */
describe('bundled bug-fix skill — v2 invariants', () => {
  it('carries every non-negotiable in its body', async () => {
    const skills = await bundledSkills();
    const bug = skills.find((s) => s.id === 'bug-fix');
    expect(bug, 'bug-fix skill must be bundled').toBeTruthy();
    const body = bug!.body.toLowerCase();

    const required: Array<[string, string]> = [
      // v1 safety gates (must be preserved)
      ['≥95% skeptic-corroborated confidence gate', '95%'],
      ['independent skeptic', 'skeptic'],
      ['reproduce before fixing', 'reproduce'],
      ['root cause, not symptom', 'root cause'],
      ['explicit approval gate', 'approval'],
      ['never auto-push', 'push only'],

      // v2 additions — Baton-native coordination
      ['Rule 0: check the shared tracker FIRST', 'shared tracker first'],
      ['record to the tracker LAST', 'record to it last'],
      ['live edit-collision awareness', 'editing these files right now'],
      ['concrete Baton coordination query', 'check_files'],
      ['record the fix to shared memory', 'save_memory'],
      ['store a fact, not a diary', 'fact, not a diary'],
      ['record the fixing commit so recurrence is recallable', 'fixed-in'],
      ['context/token hygiene (compact)', 'compact'],

      // G1 — graph-freshness golden rule
      ['the graph is only as fresh as its last build', 'only as fresh as its last build'],
      ['re-read files with uncommitted edits instead of trusting the graph', 're-read the file'],
    ];

    for (const [why, needle] of required) {
      expect(body.includes(needle.toLowerCase()), `missing invariant: ${why} (looked for "${needle}")`).toBe(true);
    }
  });

  it('still parses cleanly and ships its reference files', async () => {
    const skills = await bundledSkills();
    const bug = skills.find((s) => s.id === 'bug-fix')!;
    expect(bug.raw).toContain('name: bug-fix');
    expect(bug.description).not.toContain('\n');
    expect(bug.references.map((r) => r.rel).sort()).toEqual([
      'references/blast-radius-checklist.md',
      'references/report-template.md',
      'references/status-template.json',
    ]);
  });
});
