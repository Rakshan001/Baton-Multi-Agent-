import { describe, expect, it } from 'vitest';
import { bundledSkills } from '../src/skills/catalog.js';

/**
 * S2 — the restraint skill. A bundled, installable skill that brings Ponytail's
 * "lazy senior developer" discipline into Baton: climb a ladder before writing
 * code, but never simplify away the safety-critical parts. Invariant-guarded so
 * the ladder rungs and the safety carve-outs can't be quietly dropped.
 */
describe('bundled lean-code skill (S2)', () => {
  it('is discovered by the catalog with tags + produces', async () => {
    const skills = await bundledSkills();
    const lean = skills.find((s) => s.id === 'lean-code');
    expect(lean, 'lean-code must be bundled').toBeTruthy();
    expect(lean!.raw).toContain('name: lean-code'); // name==id → installs byte-faithful
    expect(lean!.description.length).toBeGreaterThan(40);
    expect(lean!.tags.length).toBeGreaterThan(0);
    expect(lean!.produces.length).toBeGreaterThan(0);
  });

  it('carries the ladder, the safety carve-outs, and Ponytail attribution', async () => {
    const lean = (await bundledSkills()).find((s) => s.id === 'lean-code')!;
    const body = lean.body.toLowerCase();

    const required: Array<[string, string]> = [
      ['the restraint ladder', 'ladder'],
      ['rung: does it need to exist (YAGNI)', 'yagni'],
      ['rung: reuse what already exists in the repo', 'already'],
      ['rung: stdlib / standard library', 'stdlib'],
      ['rung: native platform feature', 'native'],
      ['rung: can it be one line', 'one line'],
      ['understand the problem before climbing', 'understand'],
      // safety carve-outs — never simplify these away
      ['never simplify away safety', 'never simplify'],
      ['input validation at trust boundaries', 'validation'],
      ['security', 'security'],
      ['accessibility', 'accessibility'],
      ['leave one runnable check behind', 'runnable check'],
      // attribution (Ponytail is MIT)
      ['credits Ponytail', 'ponytail'],
      // G1 — a stale graph is how duplicate functions get born
      ['heed the graph freshness warning', 'freshness warning'],

      // v2 — the Ponytail pieces the first adaptation dropped (verified against
      // .refs/ponytail/skills/ponytail/SKILL.md): persistence, the hard rules,
      // and the output discipline that keeps explanations from smuggling
      // complexity back in as prose.
      ['stays active every response once invoked', 'every response'],
      ['no unrequested abstractions', 'unrequested abstraction'],
      ['deletion over addition', 'deletion over addition'],
      ['boring over clever', 'boring over clever'],
      ['deliberate shortcuts name their ceiling + upgrade path', 'ceiling'],
      ['output pattern: code → skipped X, add when Y', 'skipped:'],
    ];
    for (const [why, needle] of required) {
      expect(body.includes(needle), `missing: ${why} (looked for "${needle}")`).toBe(true);
    }
  });

  it('is discoverable by the words people actually say (the "what is lean-code?" fix)', async () => {
    const lean = (await bundledSkills()).find((s) => s.id === 'lean-code')!;
    const desc = lean.description.toLowerCase();
    // An agent (or human) hears "yagni", "be lazy", "over-engineered", "ponytail" —
    // the description must catch those, or the skill is never invoked.
    for (const trigger of ['yagni', 'lazy', 'over-engineer', 'ponytail', 'simplest']) {
      expect(desc, `description missing trigger word: ${trigger}`).toContain(trigger);
    }
  });
});
