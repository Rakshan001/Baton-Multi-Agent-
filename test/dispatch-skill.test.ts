// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P5 — the skill that teaches an agent to write a plan and hand it over.
 *
 * Most of a playbook is prose and testing prose is brittle, so this asserts
 * only what must never be edited away: the safety rules. An agent that reads
 * this skill and concludes it may dispatch itself has read a broken copy.
 */
import { describe, it, expect } from 'vitest';
import { bundledSkills } from '../src/skills/catalog.js';
import { SKILL_AGENTS, findSkill, skillTargetFor, renderSkill } from '../src/skills/install.js';

const ID = 'dispatch-plan';

async function skill() {
  const found = (await bundledSkills()).find((s) => s.id === ID);
  if (!found) throw new Error(`'${ID}' is not in the bundled catalog`);
  return found;
}

describe('the dispatch-plan skill exists and is installable', () => {
  it('is in the bundled catalog', async () => {
    expect((await skill()).id).toBe(ID);
  });

  it('installs into every agent Baton can write skills for', () => {
    // A dispatched agent is whichever one the plan named, so a skill only
    // Claude can read teaches nobody else the ritual.
    for (const agent of SKILL_AGENTS) {
      expect(skillTargetFor(agent, ID, '/repo'), agent).not.toBeNull();
    }
  });

  it('renders for each of them without throwing', async () => {
    const def = await skill();
    for (const agent of SKILL_AGENTS) {
      expect(renderSkill(agent, def).length, agent).toBeGreaterThan(200);
    }
  });

  it('carries the three-line explainer the Skills screen renders', async () => {
    const { explain } = await skill();
    expect(explain?.what).toBeTruthy();
    expect(explain?.how).toBeTruthy();
    expect(explain?.win).toBeTruthy();
  });

  it('is findable by id the way `baton skills install` looks it up', async () => {
    expect((await findSkill(process.cwd(), ID))?.id).toBe(ID);
  });
});

describe('the rules that must never be edited away', () => {
  const body = async () => (await skill()).raw ?? '';

  it('says the agent writes the plan and a human approves it', async () => {
    // The one hard rule. An agent that approves its own plan has removed the
    // only human checkpoint between a markdown file and paid processes.
    const text = (await body()).toLowerCase();
    expect(text).toContain('never dispatch');
    expect(text).toMatch(/human|the user|a person/);
  });

  it('says plan prose is data, not instructions', async () => {
    const text = (await body()).toLowerCase();
    expect(text).toContain('data');
  });

  it('says Baton never adds permission-bypass flags', async () => {
    // The boundary is the worktree plus the user's own CLI defaults. An agent
    // that "helpfully" adds --dangerously-skip-permissions has removed it.
    expect((await body()).toLowerCase()).toMatch(/never add|do not add/);
  });

  it('teaches the ritual in the order that has a gate in it', async () => {
    // Ordered inside the command block, not across the whole document: the hard
    // rule above it names `plan approve` first on purpose, and a first-occurrence
    // check would read that as the ritual being out of order.
    const block = (await body()).split('```').find((b) => b.includes('baton plan check'));
    expect(block, 'no command block teaching the ritual').toBeTruthy();
    const at = (s: string) => block!.indexOf(s);
    expect(at('plan check')).toBeLessThan(at('plan apply'));
    expect(at('plan apply')).toBeLessThan(at('plan approve'));
    expect(at('plan approve')).toBeLessThan(at('dispatch'));
  });

  it('teaches that `@agent` beats routing', async () => {
    expect((await body()).toLowerCase()).toContain('routing');
  });

  it('documents the refusal codes an agent will actually see', async () => {
    const text = await body();
    for (const code of ['at-capacity', 'no-route', 'needs-agent', 'not-installed', 'no-mode']) {
      expect(text, code).toContain(code);
    }
  });

  it('documents every plan field the parser accepts', async () => {
    const text = await body();
    for (const field of ['**scope:**', '**expects:**', '**skills:**', '**model:**', '**after:**']) {
      expect(text, field).toContain(field);
    }
  });
});
