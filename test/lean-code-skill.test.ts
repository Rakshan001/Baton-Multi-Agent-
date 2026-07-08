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
    ];
    for (const [why, needle] of required) {
      expect(body.includes(needle), `missing: ${why} (looked for "${needle}")`).toBe(true);
    }
  });
});
