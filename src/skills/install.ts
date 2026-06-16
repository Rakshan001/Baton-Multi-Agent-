/**
 * Install skills into an agent's config directory, and import skills from a
 * path or URL. Mirrors the scope/safety model of agents/connect.ts: everything
 * lives inside the repo, writes are non-destructive, and each agent CLI gets the
 * on-disk format it understands.
 *
 * Supported install targets:
 *   claude → <repo>/.claude/skills/<id>/SKILL.md   (+ references/ alongside)
 *   cursor → <repo>/.cursor/rules/<id>.mdc         (+ <id>/references/ alongside)
 *   others (codex, gemini, aider, opencode) → no standard skill dir (unsupported)
 *
 * Multi-file skills: a skill may ship reference files (checklists, templates).
 * Claude reads them from its own skill dir; for Cursor (single-file rules) we
 * copy them next to the rule under <id>/ and the rendered rule points at them.
 *
 * Imported skills are written to <repo>/.baton/skills/<id>.md so they survive
 * restarts and appear in the catalog alongside bundled ones.
 */
import matter from 'gray-matter';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundledSkills, type SkillDef } from './catalog.js';

/** Agent CLIs that have a skill/rule directory Baton can write. */
export const SKILL_AGENTS = ['claude', 'cursor'] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

export interface SkillTarget {
  agent: SkillAgent;
  /** Absolute path of the main skill file. */
  path: string;
  /** Repo-relative path of the main skill file, for display. */
  rel: string;
  /** Absolute dir reference files are copied into (the skill's own folder). */
  refsDir: string;
}

export interface SkillInstallState {
  agent: SkillAgent;
  rel: string;
  installed: boolean;
}

/** A catalog entry plus where it is (and isn't) installed. Reference *content* is
 *  never serialized here — only the relative paths, to keep the listing light. */
export interface SkillStatus {
  id: string;
  name: string;
  description: string;
  tags: string[];
  produces: string[];
  body: string;
  source: 'bundled' | 'imported';
  /** Relative paths of the skill's reference files (content omitted). */
  references: string[];
  installs: SkillInstallState[];
}

export class SkillNotFoundError extends Error {
  constructor(id: string) { super(`no skill '${id}'`); this.name = 'SkillNotFoundError'; }
}
export class SkillAgentUnsupportedError extends Error {
  constructor(agent: string) {
    super(`'${agent}' has no skill directory Baton can write (supported: ${SKILL_AGENTS.join(', ')})`);
    this.name = 'SkillAgentUnsupportedError';
  }
}
export class SkillImportError extends Error {
  constructor(message: string) { super(message); this.name = 'SkillImportError'; }
}

const SKILLS_DIR = (root: string) => join(root, '.baton', 'skills');

function isSkillAgent(agent: string): agent is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(agent);
}

/** Where a skill installs for an agent, or null if Baton can't write it. */
export function skillTargetFor(agent: string, id: string, root: string): SkillTarget | null {
  if (agent === 'claude') {
    const dir = join('.claude', 'skills', id);
    return { agent, path: join(root, dir, 'SKILL.md'), rel: join(dir, 'SKILL.md'), refsDir: join(root, dir) };
  }
  if (agent === 'cursor') {
    const rel = join('.cursor', 'rules', `${id}.mdc`);
    // Single-file rule; references travel in a sibling <id>/ folder.
    return { agent, path: join(root, rel), rel, refsDir: join(root, '.cursor', 'rules', id) };
  }
  return null; // codex, gemini, aider, opencode — no standard skill dir
}

/* ------------------------------------------------------------------ */
/* Pure render + parse helpers (unit-tested)                           */
/* ------------------------------------------------------------------ */

/** Render a skill into the main file body for a given agent format. */
export function renderSkill(agent: SkillAgent, skill: SkillDef): string {
  if (agent === 'cursor') {
    // Cursor project rule: agent-requested (alwaysApply:false → applied when the
    // description matches the task). https://docs.cursor.com/context/rules
    let out = `---\ndescription: ${frontmatterValue(skill.description)}\nalwaysApply: false\n---\n\n${skill.body.trimEnd()}\n`;
    if (skill.references.length) {
      out += `\n---\n\n## Reference files\n\nThis skill ships supporting files, copied next to this rule under \`${skill.id}/\`:\n`
        + skill.references.map((r) => `- \`${join(skill.id, r.rel)}\``).join('\n') + '\n';
    }
    return out;
  }
  // Claude Code skill: name + description frontmatter, then the playbook.
  return `---\nname: ${skill.id}\ndescription: ${frontmatterValue(skill.description)}\n---\n\n${skill.body.trimEnd()}\n`;
}

/** YAML-safe single-line scalar (quote if it contains a colon or leading special char). */
function frontmatterValue(s: string): string {
  const v = s.replace(/\s+/g, ' ').trim();
  return /[:#]|^[-?&*!|>%@`"']/.test(v) ? JSON.stringify(v) : v;
}

/** Parse a markdown skill file (frontmatter + body) into a SkillDef. Uses
 *  gray-matter, so folded/multiline descriptions and quoted values just work. */
export function parseSkillMarkdown(text: string, fallbackId: string): SkillDef {
  let data: Record<string, unknown> = {};
  let content = text;
  try {
    const parsed = matter(text);
    data = parsed.data as Record<string, unknown>;
    content = parsed.content;
  } catch { /* not frontmatter — treat whole text as body */ }

  const name = String(data.name ?? data.title ?? '').trim();
  const description = String(data.description ?? '').replace(/\s+/g, ' ').trim();
  const id = slugifySkillId(name || fallbackId);
  return {
    id,
    name: name || titleCase(fallbackId),
    description: description || firstHeadingOrLine(content) || 'Imported skill.',
    tags: [],
    produces: [],
    body: content.trim() + '\n',
    references: [],
    source: 'imported',
  };
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

/** All skills: bundled (file-backed + inline), plus any imported into .baton/skills. */
export async function loadCatalog(root: string): Promise<SkillDef[]> {
  const bundled = await bundledSkills();
  const bundledIds = new Set(bundled.map((s) => s.id));
  const imported: SkillDef[] = [];
  const dir = SKILLS_DIR(root);
  if (existsSync(dir)) {
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { entries = []; }
    for (const file of entries.filter((f) => f.endsWith('.md'))) {
      try {
        const skill = parseSkillMarkdown(await readFile(join(dir, file), 'utf-8'), file.replace(/\.md$/, ''));
        if (!bundledIds.has(skill.id)) imported.push(skill); // imported can't shadow a bundled id
      } catch { /* skip unreadable imported skill */ }
    }
  }
  return [...bundled, ...imported];
}

export async function findSkill(root: string, id: string): Promise<SkillDef | null> {
  return (await loadCatalog(root)).find((s) => s.id === id) ?? null;
}

/** Catalog with per-agent install state. Reference content is dropped here. */
export async function listSkillStatus(root: string): Promise<SkillStatus[]> {
  const catalog = await loadCatalog(root);
  return catalog.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    produces: skill.produces,
    body: skill.body,
    source: skill.source,
    references: skill.references.map((r) => r.rel),
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
  /** Number of reference files written alongside the skill. */
  references: number;
}

export async function installSkill(root: string, id: string, agent: string): Promise<InstallResult> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  const target = skillTargetFor(agent, id, root)!;

  await mkdir(dirname(target.path), { recursive: true });
  // Claude gets the hand-authored SKILL.md verbatim when faithful; otherwise render.
  const main = agent === 'claude' && skill.raw ? skill.raw : renderSkill(agent, skill);
  await writeFile(target.path, main, 'utf-8');

  let references = 0;
  for (const ref of skill.references) {
    const dest = join(target.refsDir, ref.rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, ref.content, 'utf-8');
    references++;
  }
  return { skill: id, agent, rel: target.rel, path: target.path, wrote: true, references };
}

export async function uninstallSkill(root: string, id: string, agent: string): Promise<{ removed: boolean; rel: string }> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const target = skillTargetFor(agent, id, root)!;
  const had = existsSync(target.path);
  if (agent === 'claude') {
    // The whole .claude/skills/<id>/ dir (SKILL.md + references) is ours.
    await rm(target.refsDir, { recursive: true, force: true });
  } else {
    await rm(target.path, { force: true });                 // the .mdc rule
    await rm(target.refsDir, { recursive: true, force: true }); // sibling <id>/ references
  }
  return { removed: had, rel: target.rel };
}

const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * Import a skill from a local file path or http(s) URL into <repo>/.baton/skills.
 * Returns the parsed skill; it then appears in the catalog and is installable
 * like a bundled one. (Imported skills are single-file — references are a
 * bundled-skill feature.)
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
  const bundledIds = new Set((await bundledSkills()).map((s) => s.id));
  if (bundledIds.has(skill.id)) {
    throw new SkillImportError(`'${skill.id}' collides with a bundled skill — rename its frontmatter name`);
  }
  const dir = SKILLS_DIR(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${skill.id}.md`), `---\nname: ${skill.name}\ndescription: ${frontmatterValue(skill.description)}\n---\n\n${skill.body.trimEnd()}\n`, 'utf-8');
  return skill;
}
