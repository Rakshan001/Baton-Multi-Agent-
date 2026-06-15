/**
 * Install skills into an agent's config directory, and import skills from a
 * path or URL. Mirrors the scope/safety model of agents/connect.ts: everything
 * lives inside the repo, writes are non-destructive (we never clobber a file we
 * didn't author), and each agent CLI gets the on-disk format it understands.
 *
 * Supported install targets:
 *   claude → <repo>/.claude/skills/<id>/SKILL.md   (Claude Code native skill)
 *   cursor → <repo>/.cursor/rules/<id>.mdc         (Cursor project rule, agent-requested)
 *   others (codex, gemini, aider, opencode) → no standard skill dir (surfaced as unsupported)
 *
 * Imported skills are written to <repo>/.baton/skills/<id>.md (frontmatter +
 * body) so they survive restarts and appear in the catalog alongside bundled
 * ones; catalog listing merges BUNDLED_SKILLS with whatever is on disk there.
 */
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_SKILLS, type SkillDef } from './catalog.js';

/** Agent CLIs that have a skill/rule directory Baton can write. */
export const SKILL_AGENTS = ['claude', 'cursor'] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

export interface SkillTarget {
  agent: SkillAgent;
  /** Absolute path of the file we'd write. */
  path: string;
  /** Repo-relative path, for display. */
  rel: string;
}

export interface SkillInstallState {
  agent: SkillAgent;
  rel: string;
  installed: boolean;
}

/** A catalog entry plus where it is (and isn't) installed. */
export interface SkillStatus extends SkillDef {
  installs: SkillInstallState[];
}

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`no skill '${id}'`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillAgentUnsupportedError extends Error {
  constructor(agent: string) {
    super(`'${agent}' has no skill directory Baton can write (supported: ${SKILL_AGENTS.join(', ')})`);
    this.name = 'SkillAgentUnsupportedError';
  }
}

export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillImportError';
  }
}

const SKILLS_DIR = (root: string) => join(root, '.baton', 'skills');

function isSkillAgent(agent: string): agent is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(agent);
}

/** Where a skill file lives for an agent, or null if Baton can't write it. */
export function skillTargetFor(agent: string, id: string, root: string): SkillTarget | null {
  if (agent === 'claude') {
    const rel = join('.claude', 'skills', id, 'SKILL.md');
    return { agent, path: join(root, rel), rel };
  }
  if (agent === 'cursor') {
    const rel = join('.cursor', 'rules', `${id}.mdc`);
    return { agent, path: join(root, rel), rel };
  }
  return null; // codex, gemini, aider, opencode — no standard skill dir
}

/* ------------------------------------------------------------------ */
/* Pure render + parse helpers (unit-tested)                           */
/* ------------------------------------------------------------------ */

/** Render a skill into the file body for a given agent format. */
export function renderSkill(agent: SkillAgent, skill: SkillDef): string {
  if (agent === 'cursor') {
    // Cursor project rule: agent-requested (alwaysApply:false → applied when the
    // description matches the task). https://docs.cursor.com/context/rules
    return `---\ndescription: ${frontmatterValue(skill.description)}\nalwaysApply: false\n---\n\n${skill.body.trimEnd()}\n`;
  }
  // Claude Code skill: name + description frontmatter, then the playbook.
  return `---\nname: ${skill.id}\ndescription: ${frontmatterValue(skill.description)}\n---\n\n${skill.body.trimEnd()}\n`;
}

/** YAML-safe single-line scalar (quote if it contains a colon or leading special char). */
function frontmatterValue(s: string): string {
  const v = s.replace(/\n+/g, ' ').trim();
  return /[:#]|^[-?&*!|>%@`"']/.test(v) ? JSON.stringify(v) : v;
}

/** Parse a markdown skill file (frontmatter name/description + body) into a SkillDef. */
export function parseSkillMarkdown(text: string, fallbackId: string): SkillDef {
  let name = '';
  let description = '';
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(name|description|title):\s*(.*)$/);
      if (!m) continue;
      const val = unquote(m[2].trim());
      if (m[1] === 'description') description = val;
      else name = val; // name or title
    }
  }
  const id = slugifySkillId(name || fallbackId);
  return {
    id,
    name: name || titleCase(fallbackId),
    description: description || firstHeadingOrLine(body) || 'Imported skill.',
    tags: [],
    produces: [],
    body: body.trim() + '\n',
    source: 'imported',
  };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1).replace(/"/g, '\\"')}"` : s); } catch { return s.slice(1, -1); }
  }
  return s;
}

export function slugifySkillId(s: string): string {
  return (s || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

function titleCase(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstHeadingOrLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, 160);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Catalog (bundled + imported on disk)                                */
/* ------------------------------------------------------------------ */

/** All skills: bundled, plus any imported into <repo>/.baton/skills. */
export async function loadCatalog(root: string): Promise<SkillDef[]> {
  const imported: SkillDef[] = [];
  const dir = SKILLS_DIR(root);
  if (existsSync(dir)) {
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { entries = []; }
    for (const file of entries.filter((f) => f.endsWith('.md'))) {
      try {
        const text = await readFile(join(dir, file), 'utf-8');
        imported.push(parseSkillMarkdown(text, file.replace(/\.md$/, '')));
      } catch { /* skip unreadable imported skill */ }
    }
  }
  // Imported skills can't shadow a bundled id.
  const bundledIds = new Set(BUNDLED_SKILLS.map((s) => s.id));
  return [...BUNDLED_SKILLS, ...imported.filter((s) => !bundledIds.has(s.id))];
}

export async function findSkill(root: string, id: string): Promise<SkillDef | null> {
  return (await loadCatalog(root)).find((s) => s.id === id) ?? null;
}

/** Catalog with per-agent install state for every supported agent. */
export async function listSkillStatus(root: string): Promise<SkillStatus[]> {
  const catalog = await loadCatalog(root);
  return catalog.map((skill) => ({
    ...skill,
    installs: SKILL_AGENTS.map((agent) => {
      const target = skillTargetFor(agent, skill.id, root)!;
      return { agent, rel: target.rel, installed: existsSync(target.path) };
    }),
  }));
}

/* ------------------------------------------------------------------ */
/* Install / uninstall / import                                        */
/* ------------------------------------------------------------------ */

export interface InstallResult {
  skill: string;
  agent: SkillAgent;
  rel: string;
  path: string;
  wrote: boolean;
}

export async function installSkill(root: string, id: string, agent: string): Promise<InstallResult> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  const target = skillTargetFor(agent, id, root)!;
  await mkdir(join(target.path, '..'), { recursive: true });
  await writeFile(target.path, renderSkill(agent, skill), 'utf-8');
  return { skill: id, agent, rel: target.rel, path: target.path, wrote: true };
}

export async function uninstallSkill(root: string, id: string, agent: string): Promise<{ removed: boolean; rel: string }> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const target = skillTargetFor(agent, id, root)!;
  if (!existsSync(target.path)) return { removed: false, rel: target.rel };
  // Claude skills live in their own <id>/ dir — remove the dir, not just the file.
  await rm(agent === 'claude' ? join(target.path, '..') : target.path, { recursive: true, force: true });
  return { removed: true, rel: target.rel };
}

const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * Import a skill from a local file path or http(s) URL into
 * <repo>/.baton/skills. Returns the parsed skill; it then appears in the
 * catalog and is installable like a bundled one.
 */
export async function importSkill(root: string, source: string): Promise<SkillDef> {
  const src = source.trim();
  if (!src) throw new SkillImportError('pass a file path or http(s) URL');

  let text: string;
  let fallbackId = 'imported-skill';
  if (/^https?:\/\//i.test(src)) {
    let res: Response;
    try {
      res = await fetch(src, { redirect: 'follow' });
    } catch (e) {
      throw new SkillImportError(`couldn't fetch ${src}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new SkillImportError(`couldn't fetch ${src}: HTTP ${res.status}`);
    text = await res.text();
    fallbackId = slugifySkillId(new URL(src).pathname.split('/').filter(Boolean).pop()?.replace(/\.(md|mdc|txt)$/i, '') || 'imported-skill');
  } else {
    if (!existsSync(src)) throw new SkillImportError(`no such file: ${src}`);
    try {
      text = await readFile(src, 'utf-8');
    } catch (e) {
      throw new SkillImportError(`couldn't read ${src}: ${(e as Error).message}`);
    }
    fallbackId = slugifySkillId(src.split(/[/\\]/).pop()?.replace(/\.(md|mdc|txt)$/i, '') || 'imported-skill');
  }
  if (text.length > MAX_IMPORT_BYTES) throw new SkillImportError('skill file is too large (256KB max)');
  if (!text.trim()) throw new SkillImportError('skill file is empty');

  const skill = parseSkillMarkdown(text, fallbackId);
  if (BUNDLED_SKILLS.some((s) => s.id === skill.id)) {
    throw new SkillImportError(`'${skill.id}' collides with a bundled skill — rename its frontmatter name`);
  }
  const dir = SKILLS_DIR(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${skill.id}.md`), `---\nname: ${skill.name}\ndescription: ${frontmatterValue(skill.description)}\n---\n\n${skill.body.trimEnd()}\n`, 'utf-8');
  return skill;
}
