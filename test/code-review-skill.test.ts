import { describe, expect, it } from 'vitest';
import { bundledSkills } from '../src/skills/catalog.js';

/**
 * The `code-review` skill's whole value is the two axes staying separate. These
 * tests pin the structure that guarantees it, so a future edit can't quietly
 * collapse the axes back into one ranked list.
 */
describe('code-review skill', () => {
  it('is discovered as a file-backed bundled skill with catalog metadata', async () => {
    const skills = await bundledSkills();
    const cr = skills.find((s) => s.id === 'code-review');
    expect(cr, 'missing bundled skill: code-review').toBeTruthy();

    // name matches id → Claude installs the hand-authored SKILL.md verbatim
    expect(cr!.raw).toContain('name: code-review');
    // folded multi-line YAML description flattened to one searchable line
    expect(cr!.description).not.toContain('\n');
    expect(cr!.description.length).toBeGreaterThan(80);
    // tags/produces come from BUNDLED_META (frontmatter stays name+description only)
    expect(cr!.tags.length).toBeGreaterThan(0);
    expect(cr!.produces.length).toBeGreaterThan(0);
  });

  it('ships a baseline per heuristic axis (smells for Standards, vuln classes for Security)', async () => {
    const cr = (await bundledSkills()).find((s) => s.id === 'code-review')!;
    expect(cr.references.map((r) => r.rel).sort()).toEqual([
      'references/security-baseline.md', 'references/smell-baseline.md',
    ]);

    const sec = cr.references.find((r) => r.rel.endsWith('security-baseline.md'))!.content;
    for (const cls of ['Injection', 'Path traversal', 'SSRF', 'Secret handling', 'Authz']) {
      expect(sec, `security baseline missing '${cls}'`).toContain(cls);
    }
    // the rules that keep it from turning into a wishlist
    expect(sec).toContain('introduces or worsens');
    expect(sec).toMatch(/source .*sink|Source → sink/i);
    expect(sec).toContain('Defence-in-depth');

    const baseline = cr.references.find((r) => r.rel.endsWith('smell-baseline.md'))!.content;
    // all twelve Fowler smells the Standards axis falls back on
    for (const smell of [
      'Mysterious Name', 'Duplicated Code', 'Feature Envy', 'Data Clumps',
      'Primitive Obsession', 'Repeated Switches', 'Shotgun Surgery', 'Divergent Change',
      'Speculative Generality', 'Message Chains', 'Middle Man', 'Refused Bequest',
    ]) {
      expect(baseline, `smell baseline missing '${smell}'`).toContain(smell);
    }
    // the two rules that keep the baseline safe
    expect(baseline).toContain('The repo overrides');
    expect(baseline).toContain('judgement call');
  });

  it('keeps the three axes separate and never ranks across them', async () => {
    const cr = (await bundledSkills()).find((s) => s.id === 'code-review')!;
    const body = cr.body;
    expect(body).toContain('## Standards');
    expect(body).toContain('## Spec');
    expect(body).toContain('## Security');
    // the defining rule
    expect(body).toMatch(/never merge|Do not\s+\*\*?merge|two axes never merge/i);
    // fail fast on the ref, before spawning sub-agents
    expect(body).toContain('git rev-parse');
    // parallel, isolated contexts
    expect(body).toMatch(/parallel/i);
    // no invented requirements when there is no spec
    expect(body).toContain('no spec available');
  });

  it('draws an explicit boundary against verify-before-done, in both skills', async () => {
    const skills = await bundledSkills();
    const cr = skills.find((s) => s.id === 'code-review')!;
    const verify = skills.find((s) => s.id === 'verify-before-done')!;
    expect(cr.body).toContain('verify-before-done');
    expect(cr.description).toContain('verify-before-done');
    expect(verify.body).toContain('code-review');
  });

  it('refutes findings before reporting, and routes each one somewhere', async () => {
    const cr = (await bundledSkills()).find((s) => s.id === 'code-review')!;
    const body = cr.body;
    // the verify gate — an unverified finding costs the human more than it saves
    expect(body).toMatch(/refute/i);
    expect(body).toContain('95%');
    // a Spec "implemented but wrong" is a BUG — root-cause it, don't patch from a review comment
    expect(body).toContain('systematic-debugging');
    expect(body).toContain('bug-fix');
    // findings must outlive the session
    expect(body).toContain('baton review save');
    // partial coverage is never silent
    expect(body).toMatch(/partial/i);
  });

  it('credits the MIT source it adapts the two-axis structure from', async () => {
    const cr = (await bundledSkills()).find((s) => s.id === 'code-review')!;
    expect(cr.body).toContain('mattpocock/skills');
    expect(cr.body).toContain('MIT');
  });
});
