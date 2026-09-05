// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bundledSkills } from '../src/skills/catalog.js';

/**
 * H2 — the bundled handoff skill teaches ANY agent the manual relay: write a
 * structured brief BEFORE dying at a usage limit, and execute (not re-plan) a
 * brief when resuming. Invariant-locked like bug-fix: trimming must never drop
 * the triggers that make the relay actually happen.
 */
describe('bundled handoff skill — invariants', () => {
  it('exists, parses, and carries every relay trigger', async () => {
    const skills = await bundledSkills();
    const skill = skills.find((s) => s.id === 'handoff');
    expect(skill, 'handoff skill must be bundled').toBeTruthy();
    const body = skill!.body.toLowerCase();

    const required: Array<[string, string]> = [
      ['the tool that writes the brief', 'create_handoff'],
      ['hand off BEFORE the limit kills the session', 'before'],
      ['usage/context-limit trigger', 'usage'],
      ['brief carries done items', 'done'],
      ['brief carries pending items', 'pending'],
      ['brief names the single next step', 'next step'],
      ['brief records decisions/gotchas git cannot show', 'decisions'],
      ['commit or checkpoint work in flight first', 'commit'],
      ['pickup command for the next agent', 'baton resume'],
      ['receiving side executes the plan instead of re-planning', 're-plan'],
      ['never store secrets in a brief', 'secrets'],
      // The relay's missing half: nothing ever closed a brief, so the pickup
      // list filled with shipped work and stopped meaning anything.
      ['the tool that asks what to pick up next', 'next_handoff'],
      ['the tool that closes a finished brief', 'resolve_handoff'],
      ['closing is what keeps the pickup list honest', 'pick'],
      ['the completion note is written for a reviewer', 'review'],
    ];
    for (const [why, needle] of required) {
      expect(body.includes(needle), `missing invariant: ${why} (looked for "${needle}")`).toBe(true);
    }
  });

  it('tells the agent what a completion report must contain', async () => {
    // "Done" with no evidence is the failure this section exists to prevent:
    // the reviewer cannot tell a verified fix from a hopeful one.
    const skills = await bundledSkills();
    const body = skills.find((s) => s.id === 'handoff')!.body.toLowerCase();
    expect(body).toMatch(/verified|tests? pass|evidence/);
    expect(body).toMatch(/parallel/);
  });

  it('stays lean — a relay playbook, not a novel', async () => {
    const skills = await bundledSkills();
    const skill = skills.find((s) => s.id === 'handoff')!;
    expect(skill.raw!.length).toBeLessThanOrEqual(6000);
    expect(skill.description).not.toContain('\n');
    expect(skill.tags.length).toBeGreaterThan(0);
  });
});
