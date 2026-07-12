/**
 * `baton skills` — list, install, import, and remove reusable agent skills from
 * the terminal (the same catalog the dashboard Skills screen shows). Install
 * defaults to EVERY writable agent so one command wires a skill into all of them.
 */
import { gitRoot } from '../git.js';
import {
  listSkillStatus, installSkill, installSkillEverywhere, uninstallSkill, importSkill,
  SKILL_AGENTS, SkillNotFoundError, SkillAgentUnsupportedError, SkillImportError,
} from '../skills/install.js';

export async function skillsListCmd(): Promise<void> {
  const root = await gitRoot();
  const skills = await listSkillStatus(root);
  if (!skills.length) {
    console.log('no skills — import one with `baton skills import <path|url>`');
    return;
  }
  for (const s of skills) {
    const where = s.installs.filter((i) => i.installed).map((i) => i.agent);
    const badge = where.length ? `✓ ${where.join(', ')}` : '·';
    console.log(`${badge}  [${s.source}] ${s.id} — ${s.description.slice(0, 80)}`);
  }
  console.log(`\n${skills.length} skill${skills.length === 1 ? '' : 's'} · install with: baton skills install <id>  (all agents unless --agent)`);
}

export async function skillsInstallCmd(id: string, opts: { agent?: string; all?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
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
  const root = await gitRoot();
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

export async function skillsImportCmd(source: string): Promise<void> {
  const root = await gitRoot();
  try {
    const s = await importSkill(root, source);
    console.log(`✓ imported ${s.id} — ${s.description.slice(0, 80)}\n  install it with: baton skills install ${s.id}`);
  } catch (e) {
    fail(e);
  }
}

function otherAgents(): string {
  return ['codex', 'gemini'].join(', ');
}

function fail(e: unknown): void {
  if (e instanceof SkillNotFoundError || e instanceof SkillAgentUnsupportedError || e instanceof SkillImportError) {
    console.error(`✗ ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  throw e;
}
