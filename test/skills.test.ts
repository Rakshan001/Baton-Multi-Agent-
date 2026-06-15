import { describe, expect, it } from 'vitest';
import {
  parseSkillMarkdown, renderSkill, skillTargetFor, slugifySkillId,
} from '../src/skills/install.js';
import { BUNDLED_SKILLS } from '../src/skills/catalog.js';

describe('skillTargetFor', () => {
  it('maps each supported agent to its skill file', () => {
    expect(skillTargetFor('claude', 'common-bug-fix', '/repo')).toMatchObject({
      agent: 'claude', rel: '.claude/skills/common-bug-fix/SKILL.md', path: '/repo/.claude/skills/common-bug-fix/SKILL.md',
    });
    expect(skillTargetFor('cursor', 'common-bug-fix', '/repo')).toMatchObject({
      agent: 'cursor', rel: '.cursor/rules/common-bug-fix.mdc', path: '/repo/.cursor/rules/common-bug-fix.mdc',
    });
  });

  it('returns null for agents with no skill directory', () => {
    for (const a of ['codex', 'gemini', 'aider', 'opencode']) {
      expect(skillTargetFor(a, 'x', '/repo')).toBeNull();
    }
  });
});

describe('renderSkill', () => {
  const skill = BUNDLED_SKILLS[0]; // common-bug-fix

  it('renders Claude skills with name + description frontmatter', () => {
    const out = renderSkill('claude', skill);
    expect(out).toMatch(/^---\nname: common-bug-fix\ndescription: /);
    expect(out).toContain(skill.body.trimEnd());
    expect(out).not.toContain('alwaysApply');
  });

  it('renders Cursor rules with description + alwaysApply:false', () => {
    const out = renderSkill('cursor', skill);
    expect(out).toMatch(/^---\ndescription: /);
    expect(out).toContain('alwaysApply: false');
  });

  it('quotes frontmatter values that would break YAML', () => {
    const tricky = { ...skill, description: 'fix: things, including #1' };
    const out = renderSkill('claude', tricky);
    expect(out).toContain('description: "fix: things, including #1"');
  });
});

describe('parseSkillMarkdown', () => {
  it('reads name + description out of frontmatter', () => {
    const md = '---\nname: My Skill\ndescription: Does a thing\n---\n\n# Body\n\nsteps here\n';
    const s = parseSkillMarkdown(md, 'fallback');
    expect(s).toMatchObject({ id: 'my-skill', name: 'My Skill', description: 'Does a thing', source: 'imported' });
    expect(s.body).toContain('# Body');
  });

  it('falls back to the file name + first heading when frontmatter is absent', () => {
    const s = parseSkillMarkdown('# Cool Playbook\n\ndo stuff\n', 'cool-playbook');
    expect(s.id).toBe('cool-playbook');
    expect(s.name).toBe('Cool Playbook');
    expect(s.description).toBe('Cool Playbook');
  });

  it('handles quoted frontmatter values', () => {
    const md = '---\ntitle: Edge\ndescription: "has: a colon"\n---\nbody\n';
    expect(parseSkillMarkdown(md, 'x').description).toBe('has: a colon');
  });
});

describe('slugifySkillId', () => {
  it('kebab-cases and trims', () => {
    expect(slugifySkillId('Common Bug Fix!')).toBe('common-bug-fix');
    expect(slugifySkillId('  --weird__name--  ')).toBe('weird-name');
    expect(slugifySkillId('')).toBe('skill');
  });
});
