// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton skills import` must go through the SAME front door as the dashboard.
 *
 * It did not. The CLI called `importSkill` — the raw single-file path — so a
 * GitHub URL was never recognised as a repo: Baton just fetched github.com's
 * web page. The repo page (295KB) tripped the 256KB cap and reported "too
 * large"; the directory page (230KB) fit, and was stored as a skill whose
 * description read `<!DOCTYPE html>`. The dashboard route was never affected,
 * because it has always called `importSkillFromSource`.
 *
 * This file pins the wiring itself. A regression here silently restores both
 * symptoms, and no other test in the suite touches the skills CLI layer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const importSkill = vi.fn();
const importSkillFromSource = vi.fn();

vi.mock('../src/skills/install.js', async (orig) => ({
  ...await orig<typeof import('../src/skills/install.js')>(),
  importSkill: (...a: unknown[]) => importSkill(...a),
  importSkillFromSource: (...a: unknown[]) => importSkillFromSource(...a),
}));

vi.mock('../src/store.js', async (orig) => ({
  ...await orig<typeof import('../src/store.js')>(),
  activeBatonRoot: async () => '/tmp/baton-cli-test-repo',
}));

const { skillsImportCmd } = await import('../src/commands/skills.js');

const STORED = {
  id: 'brag', name: 'brag', description: 'Turn the project into a launch video.',
  body: '# brag', raw: '# brag', tags: [], source: 'global' as const,
  references: [{ rel: 'references/audio.md', content: '' }],
};

let out: string[];
let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  importSkill.mockReset();
  importSkillFromSource.mockReset();
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('baton skills import', () => {
  it('routes a GitHub repo URL through the GitHub-aware front door', async () => {
    importSkillFromSource.mockResolvedValue({ skill: STORED, findings: [], held: true });
    await skillsImportCmd('https://github.com/latent-spaces/brag');

    expect(importSkillFromSource).toHaveBeenCalledOnce();
    expect(importSkillFromSource.mock.calls[0][1]).toBe('https://github.com/latent-spaces/brag');
    // The bug: the raw single-file path fetched github.com's HTML page instead.
    expect(importSkill).not.toHaveBeenCalled();
  });

  it('routes a local path through the same front door', async () => {
    importSkillFromSource.mockResolvedValue({ skill: STORED, findings: [], held: true });
    await skillsImportCmd('./my-skill.md');
    expect(importSkillFromSource).toHaveBeenCalledOnce();
    expect(importSkill).not.toHaveBeenCalled();
  });

  it('says the skill is held rather than telling the user to install it', async () => {
    importSkillFromSource.mockResolvedValue({ skill: STORED, findings: [], held: true });
    await skillsImportCmd('https://github.com/latent-spaces/brag');

    const text = out.join('\n');
    expect(text).toMatch(/held|review/i);
    // Printing a bare "install it with: …" on a held skill is advice that fails.
    expect(text).not.toMatch(/^\s*install it with: baton skills install brag$/m);
  });

  it('lists the candidates when a repo holds more than one skill', async () => {
    importSkillFromSource.mockResolvedValue({
      choices: [{ id: 'brag', dir: 'skills/brag' }, { id: 'ship', dir: 'skills/ship' }],
    });
    await skillsImportCmd('https://github.com/owner/many');

    const text = [...out, ...err].join('\n');
    expect(text).toContain('brag');
    expect(text).toContain('skills/brag');
    expect(text).toContain('ship');
    expect(text).toMatch(/--as/);
    expect(process.exitCode).toBe(1);
  });

  it('reports what the fetch left behind and what the scan noticed', async () => {
    importSkillFromSource.mockResolvedValue({
      skill: STORED,
      origin: 'github.com/latent-spaces/brag@main',
      skipped: ['assets/a.ogg (binary)', 'assets/b.mp3 (binary)'],
      findings: [{
        category: 'permission-bypass', severity: 'high', file: 'SKILL.md',
        line: 12, excerpt: 'runs curl | sh', context: 'prose', matched: 'curl | sh',
      }],
      held: true,
    });
    await skillsImportCmd('https://github.com/latent-spaces/brag');

    const text = out.join('\n');
    expect(text).toContain('github.com/latent-spaces/brag@main');
    expect(text).toContain('assets/a.ogg (binary)');
    expect(text).toContain('runs curl | sh');
  });
});
