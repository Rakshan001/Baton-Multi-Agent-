// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundledSkills } from '../src/skills/catalog.js';

/**
 * The `llm-council` skill's value is a real gate before spending tokens, and a
 * verdict the user is never let act on unasked. These tests pin the structure
 * that guarantees both, plus the third-party credits the skill's footer and
 * NOTICE carry.
 */
describe('llm-council skill', () => {
  it('is discovered as a file-backed bundled skill with catalog metadata', async () => {
    const skills = await bundledSkills();
    const lc = skills.find((s) => s.id === 'llm-council');
    expect(lc, 'missing bundled skill: llm-council').toBeTruthy();

    // name matches id → Claude installs the hand-authored SKILL.md verbatim
    expect(lc!.raw).toContain('name: llm-council');
    // folded multi-line YAML description flattened to one searchable line
    expect(lc!.description).not.toContain('\n');
    expect(lc!.description.length).toBeGreaterThan(80);
    // tags/produces come from BUNDLED_META (frontmatter stays name+description only)
    expect(lc!.tags.length).toBeGreaterThan(0);
    expect(lc!.produces.length).toBeGreaterThan(0);
  });

  it('ships all four reference files', async () => {
    const lc = (await bundledSkills()).find((s) => s.id === 'llm-council')!;
    expect(lc.references.map((r) => r.rel).sort()).toEqual([
      'references/external-seats.md', 'references/lenses.md',
      'references/prompts.md', 'references/transcript-template.md',
    ]);
  });

  it('contains every phase heading', async () => {
    const lc = (await bundledSkills()).find((s) => s.id === 'llm-council')!;
    const body = lc.body;
    for (const heading of [
      '## Phase 0 — Gate', '## Phase 1 — Frame', '## Phase 2 — Seat',
      '## Phase 3 — Answer', '## Phase 4 — Diversity check',
      '## Phase 5 — Peer review', '## Phase 6 — Chairman', '## Phase 7 — Persist',
    ]) {
      expect(body, `missing phase heading: ${heading}`).toContain(heading);
    }
  });

  it('grounds claims and persists the verdict where the next session finds it', async () => {
    const lc = (await bundledSkills()).find((s) => s.id === 'llm-council')!;
    const body = lc.body;
    expect(body).toContain('FINAL RANKING:');
    expect(body).toContain('[unverified]');
    expect(body).toContain('.baton/council/');
    expect(body).toContain('save_memory');
    expect(body).toContain('recall_memory');
    // the three budget tiers, as table rows (a bare word would match prose)
    for (const row of ['| quick | 3 |', '| **standard** | 4 | 3 |', '| deep | 5 | 4 |']) {
      expect(body, `missing budget tier row: ${row}`).toContain(row);
    }
    expect(body).toContain('⛔ Never pick quick yourself');
  });

  it('keeps the real gate and never lets the verdict be acted on unasked', async () => {
    const body = (await bundledSkills()).find((s) => s.id === 'llm-council')!.body;
    expect(body).toContain('The gate is real.');
    expect(body).toContain('⛔ **Stop.**');
    expect(body).toContain('Never edit code, open a PR');
  });

  it('never lets a rejected re-run touch the prior decided fact', async () => {
    // prose wraps across lines, so compare with whitespace collapsed
    const body = (await bundledSkills()).find((s) => s.id === 'llm-council')!.body.replace(/\s+/g, ' ');
    expect(body.match(/a rejected re-run saves nothing and never removes the prior decided fact/g)?.length,
      'every re-run description (Phase 0, Phase 7 step 4, Definition of done) says it the same way').toBe(3);
  });

  it('credits every upstream source in the SKILL.md footer', async () => {
    const lc = (await bundledSkills()).find((s) => s.id === 'llm-council')!;
    for (const needle of ['Karpathy', 'gcpdev', 'tenfoldmarc', 'Txnishkk93']) {
      expect(lc.body, `credits footer missing: ${needle}`).toContain(needle);
    }
  });

  it('keeps the MIT permission notice for the adapted external-seats content', () => {
    const notice = readFileSync(
      fileURLToPath(new URL('../src/skills/bundled/llm-council/NOTICE', import.meta.url)), 'utf-8',
    );
    expect(notice).toContain('MIT');
    expect(notice).toContain('Gustavo Publio');
  });
});
