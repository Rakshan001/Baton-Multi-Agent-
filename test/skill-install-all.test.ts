import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkillEverywhere, SkillNotFoundError, SKILL_AGENTS } from '../src/skills/install.js';

/**
 * S3 — install a skill into every agent Baton can write, in one call. Backs
 * `baton skills install <id> --all` and the dashboard "install everywhere"
 * action.
 */
describe('installSkillEverywhere (S3)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-skill-all-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('installs a bundled skill into every writable agent and writes each file', async () => {
    const results = await installSkillEverywhere(root, 'lean-code');
    expect(results.map((r) => r.agent).sort()).toEqual([...SKILL_AGENTS].sort());
    for (const r of results) {
      expect(r.wrote).toBe(true);
      expect(existsSync(r.path), `${r.agent} file should exist at ${r.rel}`).toBe(true);
    }
    // claude gets the multi-file skill with its references dir
    const claude = results.find((r) => r.agent === 'claude')!;
    expect(existsSync(join(root, '.claude', 'skills', 'lean-code', 'SKILL.md'))).toBe(true);
    expect(claude.references).toBeGreaterThan(0); // lean-code ships ladder-examples.md
  });

  it('throws SkillNotFoundError for an unknown skill (nothing written)', async () => {
    await expect(installSkillEverywhere(root, 'no-such-skill')).rejects.toBeInstanceOf(SkillNotFoundError);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });
});
