import { describe, expect, it } from 'vitest';
import {
  parseSkillMarkdown, renderSkill, skillTargetFor, slugifySkillId,
} from '../src/skills/install.js';
import { bundledSkills, type SkillDef } from '../src/skills/catalog.js';

describe('skillTargetFor', () => {
  it('maps each supported agent to its skill file + references dir', () => {
    expect(skillTargetFor('claude', 'bug-fix', '/repo')).toMatchObject({
      agent: 'claude', rel: '.claude/skills/bug-fix/SKILL.md',
      path: '/repo/.claude/skills/bug-fix/SKILL.md', refsDir: '/repo/.claude/skills/bug-fix',
    });
    expect(skillTargetFor('cursor', 'bug-fix', '/repo')).toMatchObject({
      agent: 'cursor', rel: '.cursor/rules/bug-fix.mdc',
      path: '/repo/.cursor/rules/bug-fix.mdc', refsDir: '/repo/.cursor/rules/bug-fix',
    });
  });

  it('returns null for agents with no skill directory', () => {
    for (const a of ['codex', 'gemini', 'aider', 'opencode']) {
      expect(skillTargetFor(a, 'x', '/repo')).toBeNull();
    }
  });
});

const sampleSkill = (over: Partial<SkillDef> = {}): SkillDef => ({
  id: 'demo-skill', name: 'Demo', description: 'Does a thing', tags: [], produces: [],
  body: '# Demo\n\nsteps', references: [], source: 'bundled', ...over,
});

describe('renderSkill', () => {
  it('renders Claude skills with name + description frontmatter', () => {
    const out = renderSkill('claude', sampleSkill());
    expect(out).toMatch(/^---\nname: demo-skill\ndescription: /);
    expect(out).toContain('# Demo');
    expect(out).not.toContain('alwaysApply');
  });

  it('renders Cursor rules with description + alwaysApply:false', () => {
    const out = renderSkill('cursor', sampleSkill());
    expect(out).toMatch(/^---\ndescription: /);
    expect(out).toContain('alwaysApply: false');
  });

  it('quotes frontmatter values that would break YAML', () => {
    const out = renderSkill('claude', sampleSkill({ description: 'fix: things, including #1' }));
    expect(out).toContain('description: "fix: things, including #1"');
  });

  it('appends a references pointer for multi-file Cursor rules only', () => {
    const skill = sampleSkill({ references: [{ rel: 'references/check.md', content: 'x' }] });
    expect(renderSkill('cursor', skill)).toContain('demo-skill/references/check.md');
    expect(renderSkill('claude', skill)).not.toContain('## Reference files');
  });
});

describe('bundledSkills (file-backed)', () => {
  it('loads bug-fix from src/skills/bundled with its references, and keeps raw faithful', async () => {
    const skills = await bundledSkills();
    const bug = skills.find((s) => s.id === 'bug-fix');
    expect(bug).toBeTruthy();
    expect(bug!.references.map((r) => r.rel).sort()).toEqual([
      'references/blast-radius-checklist.md', 'references/report-template.md', 'references/status-template.json',
    ]);
    // folded multi-line YAML description flattened to one line
    expect(bug!.description).not.toContain('\n');
    expect(bug!.description.length).toBeGreaterThan(80);
    // name matches id → installed verbatim for Claude
    expect(bug!.raw).toContain('name: bug-fix');
    // inline skills still present
    expect(skills.some((s) => s.id === 'map-codebase')).toBe(true);
    // the old lightweight skill was replaced
    expect(skills.some((s) => s.id === 'common-bug-fix')).toBe(false);
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

  it('flattens a folded (>-) multi-line description to one line', () => {
    const md = '---\nname: folded\ndescription: >-\n  line one\n  line two\n---\nbody\n';
    const s = parseSkillMarkdown(md, 'x');
    expect(s.description).toBe('line one line two');
    expect(s.id).toBe('folded');
  });
});

describe('slugifySkillId', () => {
  it('kebab-cases and trims', () => {
    expect(slugifySkillId('Common Bug Fix!')).toBe('common-bug-fix');
    expect(slugifySkillId('  --weird__name--  ')).toBe('weird-name');
    expect(slugifySkillId('')).toBe('skill');
  });
});
