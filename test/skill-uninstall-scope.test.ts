// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Uninstalling deletes a DIRECTORY, so the id it is handed decides what gets
 * removed — and unlike every other skill operation, uninstall never looks the
 * id up in the catalog first.
 *
 * `uninstallSkill(root, id, 'claude')` builds `<root>/.claude/skills/<id>` and
 * `rm`s it recursively. An id of `../../..` therefore names somewhere else
 * entirely, and the id is not Baton's: `DELETE /api/skills/:id/install` passes
 * `decodeURIComponent(...)` straight through, so `%2F` and `%2E%2E` in the path
 * segment become a real traversal, and `baton skills uninstall '../../x'` does
 * the same from the terminal.
 *
 * Install cannot be reached this way — it resolves the id against the catalog
 * first, and every catalog id is a slug — which is exactly why the guard has to
 * exist on this side too rather than being inherited.
 *
 * Measured before the fix: `uninstallSkill(repo, '../../victim', 'claude')`
 * removed `<repo>/victim` and everything under it, and reported
 * `{ removed: false }` while doing it.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usePrivateHome } from './helpers/private-home.js';
import {
  installSkill, uninstallSkill, globalSkillsDir, skillTargetFor, SkillNotFoundError,
} from '../src/skills/install.js';
import { hashSkillFiles } from '../src/skills/origins.js';
import { releaseSkill } from '../src/skills/quarantine.js';

usePrivateHome('baton-uninstall-home-');

const SKILL = '---\nname: keeper\ndescription: A real skill.\n---\n\n# Keeper\n';

async function repoWithBystander(): Promise<{ repo: string; bystander: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'baton-uninstall-repo-'));
  const bystander = join(repo, 'src');
  await mkdir(bystander, { recursive: true });
  await writeFile(join(bystander, 'index.ts'), 'export const real = true;\n', 'utf-8');
  return { repo, bystander };
}

describe('uninstallSkill refuses an id that is not a skill id', () => {
  it('does not delete a directory a traversal id points at', async () => {
    const { repo, bystander } = await repoWithBystander();
    // `.claude/skills/../../src` is `<repo>/src`.
    await expect(uninstallSkill(repo, '../../src', 'claude')).rejects.toThrow(SkillNotFoundError);
    expect(existsSync(join(bystander, 'index.ts')), 'a bystander directory was deleted').toBe(true);
  });

  it('does not reach outside the repo at all', async () => {
    const { repo } = await repoWithBystander();
    const outside = await mkdtemp(join(tmpdir(), 'baton-uninstall-outside-'));
    await writeFile(join(outside, 'precious.txt'), 'not yours\n', 'utf-8');
    const escape = join('..', '..', '..', outside.slice(1)); // .claude/skills/../../../<abs>
    await expect(uninstallSkill(repo, escape, 'claude')).rejects.toThrow(SkillNotFoundError);
    expect(existsSync(join(outside, 'precious.txt')), 'a directory outside the repo was deleted').toBe(true);
  });

  it('refuses the same shapes for cursor, whose refs dir is a sibling', async () => {
    const { repo, bystander } = await repoWithBystander();
    await expect(uninstallSkill(repo, '../../src', 'cursor')).rejects.toThrow(SkillNotFoundError);
    expect(existsSync(join(bystander, 'index.ts'))).toBe(true);
  });

  it('refuses an absolute id, a separator, a NUL, and the bare dot names', async () => {
    const { repo, bystander } = await repoWithBystander();
    for (const id of ['/etc', 'a/b', 'a\\b', '..', '.', '', '   ', 'x\0y']) {
      await expect(uninstallSkill(repo, id, 'claude'), id).rejects.toThrow(SkillNotFoundError);
    }
    expect(existsSync(join(bystander, 'index.ts'))).toBe(true);
  });

  it('still uninstalls a real skill, which is the whole point of the command', async () => {
    const { repo } = await repoWithBystander();
    await mkdir(globalSkillsDir(), { recursive: true });
    await writeFile(join(globalSkillsDir(), 'keeper.md'), SKILL, 'utf-8');
    await releaseSkill('keeper', hashSkillFiles([{ rel: 'SKILL.md', content: SKILL }]), 'test');
    await installSkill(repo, 'keeper', 'claude');
    expect(existsSync(skillTargetFor('claude', 'keeper', repo)!.path)).toBe(true);

    expect(await uninstallSkill(repo, 'keeper', 'claude')).toMatchObject({ removed: true });
    expect(existsSync(skillTargetFor('claude', 'keeper', repo)!.path)).toBe(false);
  });

  it('still reports "was not installed" for a well-formed id that is not there', async () => {
    const { repo } = await repoWithBystander();
    // Not an error: `baton skills uninstall` loops every agent, and a skill the
    // user never wired into cursor must not read as a failure.
    expect(await uninstallSkill(repo, 'never-installed', 'claude')).toMatchObject({ removed: false });
  });
});
