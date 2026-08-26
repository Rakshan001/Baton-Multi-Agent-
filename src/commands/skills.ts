// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton skills` — list, install, import, and remove reusable agent skills from
 * the terminal (the same catalog the dashboard Skills screen shows). Install
 * defaults to EVERY writable agent so one command wires a skill into all of them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { activeBatonRoot } from '../store.js';
import { askYesNo } from './setup-prompts.js';
import {
  listSkillStatus, installSkill, installSkillEverywhere, uninstallSkill, importSkill,
  removeSkill, exportSkills, importSkillBundle, globalSkillsDir, isUserSkill, danglingReferences,
  findSkill, bookmarkSkill, updateSkill, loadCatalog,
  SKILL_AGENTS, SkillNotFoundError, SkillAgentUnsupportedError, SkillImportError, SkillExistsError,
  SkillLocallyEditedError,
} from '../skills/install.js';

export async function skillsListCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const skills = await listSkillStatus(root);
  if (!skills.length) {
    console.log('no skills — import one with `baton skills import <path|url>`');
    return;
  }
  // Grouped rather than flat: "which of these are mine?" is the question this
  // list is most often opened to answer, and a source column made the reader
  // do the grouping themselves.
  const line = (s: (typeof skills)[number]): string => {
    const where = s.installs.filter((i) => i.installed).map((i) => i.agent);
    return `${s.bookmarked ? '★' : ' '} ${where.length ? `✓ ${where.join(', ')}` : '·'}  ${s.id} — ${s.description.slice(0, 80)}`;
  };
  const mine = skills.filter((s) => isUserSkill(s.source));
  const built = skills.filter((s) => !isUserSkill(s.source));
  if (mine.length) {
    console.log(`\nYour skills (${mine.length}) — ${globalSkillsDir()}`);
    for (const s of mine) console.log(`  ${line(s)}${s.source === 'imported' ? '  [this project only]' : ''}`);
  }
  if (built.length) {
    console.log(`\nBaton skills (${built.length})`);
    for (const s of built) console.log(`  ${line(s)}`);
  }
  console.log(`\n${skills.length} skill${skills.length === 1 ? '' : 's'} · install with: baton skills install <id>  (all agents unless --agent)`);
  if (mine.length) console.log(`  back them up with: baton skills export --out my-skills.json`);
}

export async function skillsInstallCmd(id: string, opts: { agent?: string; all?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  try {
    if (opts.agent) {
      const r = await installSkill(root, id, opts.agent);
      console.log(`✓ installed ${id} → ${opts.agent} (${r.rel}${r.references ? `, +${r.references} refs` : ''})`);
      return;
    }
    const results = await installSkillEverywhere(root, id); // default + --all
    console.log(`✓ installed ${id} into ${results.length} agent${results.length === 1 ? '' : 's'}:`);
    for (const r of results) console.log(`  • ${r.agent} — ${r.rel}${r.references ? ` (+${r.references} refs)` : ''}`);
    console.log(`  (agents without a skill dir — ${otherAgents()} — read project instructions via AGENTS.md instead)`);
  } catch (e) {
    fail(e);
  }
}

export async function skillsUninstallCmd(id: string, opts: { agent?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const agents = opts.agent ? [opts.agent] : [...SKILL_AGENTS];
  try {
    for (const agent of agents) {
      const r = await uninstallSkill(root, id, agent);
      console.log(r.removed ? `✓ removed ${id} from ${agent}` : `· ${id} was not installed for ${agent}`);
    }
  } catch (e) {
    fail(e);
  }
}

export async function skillsImportCmd(source: string, opts: { as?: string; replace?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  try {
    const s = await importSkill(root, source, { id: opts.as, replace: opts.replace });
    console.log(`✓ imported ${s.id} — ${s.description.slice(0, 80)}`);
    console.log(`  saved to ${globalSkillsDir()} — it is in every project on this machine`);
    for (const r of danglingReferences(s.body)) console.log(`  ! this skill mentions ${r}, which did not come with it`);
    console.log(`  install it with: baton skills install ${s.id}`);
  } catch (e) {
    fail(e);
  }
}

/**
 * Delete a skill of the user's own, from the library and from every agent.
 *
 * Confirmed by default, because this is the one command here that destroys
 * something the user made and nothing can put back — the dashboard has always
 * asked, and a CLI that silently obeyed `baton skills remove` on a typo'd id
 * would be the sharper edge of the two.
 */
export async function skillsRemoveCmd(id: string, opts: { yes?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  try {
    if (!opts.yes) {
      // Validate BEFORE prompting: "delete this?" about a skill that does not
      // exist, or one we would refuse anyway, is a question worth nobody's time.
      const skill = await findSkill(root, id);
      if (!skill) throw new SkillNotFoundError(id);
      if (!isUserSkill(skill.source)) {
        throw new SkillImportError(`'${id}' is a Baton built-in — it ships with the package and can't be deleted`);
      }
      // A pipe or a CI job cannot answer, and askYesNo would take the safe
      // default silently — which reads as "it worked" to a script. Say so.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(`✗ not a terminal, so '${id}' was NOT deleted — re-run with --yes if you meant it`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n  ${id} — ${skill.description.slice(0, 100)}`);
      console.log('  This deletes it permanently and unwires it from every agent.');
      console.log('  Keep a copy first:  baton skills export --out my-skills.json');
      if (!(await askYesNo(`\n  Delete '${id}' for good?`, false))) {
        console.log('  Nothing deleted.');
        return;
      }
    }
    const r = await removeSkill(root, id);
    console.log(`✓ deleted ${id}`);
    if (r.unwired.length) console.log(`  also unwired from: ${r.unwired.join(', ')}`);
  } catch (e) {
    fail(e);
  }
}

/** Pin a skill to the top of the list, or unpin it with --remove. */
/**
 * Re-fetch skills from where they came from.
 *
 * Refuses on local edits by default rather than silently replacing them: people
 * tune the skills they use most, and a command that eats those edits is one
 * they stop running. `--force` is the deliberate override, and the refusal
 * names the flag so the way forward is visible from the error itself.
 */
export async function skillsUpdateCmd(id: string | undefined, opts: { force?: boolean; all?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  try {
    const targets = opts.all
      ? (await loadCatalog(root)).filter((s) => isUserSkill(s.source)).map((s) => s.id)
      : id ? [id] : [];
    if (!targets.length) {
      console.error(opts.all ? 'you have no skills of your own to update' : 'pass a skill id, or --all');
      process.exitCode = 1;
      return;
    }
    let updated = 0, current = 0, blocked = 0, unknown = 0;
    for (const target of targets) {
      try {
        const r = await updateSkill(root, target, { force: opts.force });
        if (r.status === 'updated') {
          updated++;
          console.log(`✓ ${target} — updated from ${r.origin ?? 'its source'}`);
          for (const f of (r.changed ?? []).slice(0, 8)) console.log(`    ${f}`);
          if ((r.changed ?? []).length > 8) console.log(`    …and ${(r.changed ?? []).length - 8} more`);
        } else if (r.status === 'already-current') {
          current++;
          if (!opts.all) console.log(`· ${target} is already current`);
        } else {
          unknown++;
          // Not a failure: an uploaded file has no source to go back to.
          if (!opts.all) console.log(`· ${target} was not fetched from a URL, so there is nothing to update from`);
        }
      } catch (e) {
        if (e instanceof SkillLocallyEditedError) {
          blocked++;
          console.error(`✗ ${target} has local edits — re-run with --force to overwrite them`);
        } else {
          blocked++;
          console.error(`✗ ${target} — ${(e as Error).message}`);
        }
      }
    }
    if (opts.all) {
      console.log(`\n${updated} updated · ${current} already current · ${unknown} with no source · ${blocked} skipped`);
    }
    if (blocked) process.exitCode = 1;
  } catch (e) {
    fail(e);
  }
}

export async function skillsBookmarkCmd(id: string, opts: { remove?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  try {
    const r = await bookmarkSkill(root, id, !opts.remove);
    console.log(r.bookmarked ? `★ bookmarked ${id}` : `☆ removed the bookmark on ${id}`);
  } catch (e) {
    fail(e);
  }
}

/**
 * Write the user's own skills to a file. Bundled skills are excluded — they
 * ship in the package, so exporting them hands back what npm already delivered.
 */
export async function skillsExportCmd(opts: { out?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const bundle = await exportSkills(root);
  if (!bundle.skills.length) {
    console.log('no skills of your own yet — add one with `baton skills import <path|url>`');
    console.log('  (Baton\'s bundled skills ship with the package and are not exported.)');
    return;
  }
  const json = JSON.stringify(bundle, null, 2);
  if (!opts.out) {
    console.log(json);
    return;
  }
  const dest = resolve(opts.out);
  await writeFile(dest, json, 'utf-8');
  console.log(`✓ exported ${bundle.skills.length} skill${bundle.skills.length === 1 ? '' : 's'} → ${dest}`);
  console.log(`  restore on another machine with: baton skills restore ${opts.out}`);
}

/** Restore a bundle written by `baton skills export`. */
export async function skillsRestoreCmd(file: string, opts: { replace?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(file), 'utf-8'));
  } catch (e) {
    console.error(`✗ couldn't read ${file}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const r = await importSkillBundle(root, parsed, { replace: opts.replace });
    console.log(`✓ restored ${r.imported.length} skill${r.imported.length === 1 ? '' : 's'}${r.imported.length ? `: ${r.imported.join(', ')}` : ''}`);
    for (const s of r.skipped) console.error(`  · skipped ${s.id} — ${s.why}`);
    if (r.skipped.length) console.error('    (re-run with --replace to overwrite skills you already have)');
  } catch (e) {
    fail(e);
  }
}

function otherAgents(): string {
  return ['codex', 'gemini'].join(', ');
}

function fail(e: unknown): void {
  if (e instanceof SkillExistsError) {
    console.error(`✗ ${e.message} — pick another shortcut with --as <name>, or overwrite it with --replace`);
    process.exitCode = 1;
    return;
  }
  if (e instanceof SkillNotFoundError || e instanceof SkillAgentUnsupportedError || e instanceof SkillImportError) {
    console.error(`✗ ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  throw e;
}
