// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Install skills into an agent's config directory, and import skills from a
 * path or URL. Mirrors the scope/safety model of agents/connect.ts: everything
 * lives inside the repo, writes are non-destructive, and each agent CLI gets the
 * on-disk format it understands.
 *
 * Supported install targets:
 *   claude      → <repo>/.claude/skills/<id>/SKILL.md  (+ references/ alongside)
 *   cursor      → <repo>/.cursor/rules/<id>.mdc         (+ <id>/references/ alongside)
 *   antigravity → <repo>/.agents/skills/<id>/SKILL.md   (+ references/ alongside)
 *   others (codex, gemini, aider, opencode) → no standard skill dir (unsupported)
 *
 * Multi-file skills: a skill may ship reference files (checklists, templates).
 * Claude reads them from its own skill dir; for Cursor (single-file rules) we
 * copy them next to the rule under <id>/ and the rendered rule points at them.
 *
 * Where a user's own skills live, and why there are two places:
 *
 *   ~/.baton/skills/<id>.md    'global'   — uploaded skills, shared by EVERY
 *                                           project on this machine. This is
 *                                           the one users add to now.
 *   <repo>/.baton/skills/<id>.md 'imported' — legacy per-repo imports. Still
 *                                           read so nobody's existing skills
 *                                           vanish; nothing new writes here.
 *
 * Global is the default because the per-repo layout quietly broke the promise
 * users assume: a skill added in project A was invisible in project B, and
 * `baton setup` on a new project offered only bundled skills, so the library
 * did not survive the one moment it most needed to.
 *
 * Both are FLAT <id>.md files on purpose — one reader serves both dirs.
 *
 * Stored bytes are VERBATIM, with only the frontmatter `name:` line normalised
 * to the id (see withSkillName). That is what lets `raw` always be set, which
 * in turn makes Claude installs byte-for-byte and export a plain file read
 * instead of a lossy re-render.
 */
import { parseFrontmatter } from '../util/frontmatter.js';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { bundledSkills, type SkillCategory, type SkillDef, type SkillSource } from './catalog.js';
import { loadBookmarks, setBookmark } from './bookmarks.js';
import { clearOrigin, getOrigin, hashSkillFiles, setOrigin } from './origins.js';
import { gitExcludeLocal, gitUnexcludeLocal } from '../git.js';
import { fetchGitHubSkill, parseGitHubUrl, parseSkillSource,
  type RemoteSkillFile, type SkillCandidate } from './github.js';

/** Agent CLIs that have a skill/rule directory Baton can write. */
export const SKILL_AGENTS = ['claude', 'cursor', 'antigravity'] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

export interface SkillTarget {
  /** Everything installing writes, as repo-relative paths to git-exclude.
   *  A directory covers its references; SKILL.md alone does not. */
  excludes: string[];
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
  source: SkillSource;
  /** What the skill is for — the axis the Skills screen filters on. */
  category: SkillCategory;
  /** 3-line human explainer (what / how / win); absent for imported skills. */
  explain?: { what: string; how: string; win: string };
  /** Relative paths of the skill's reference files (content omitted). */
  references: string[];
  installs: SkillInstallState[];
  /** Pinned by the user (src/skills/bookmarks.ts). */
  bookmarked: boolean;
}

/** A skill the user owns — exportable and deletable, unlike a bundled one. */
export function isUserSkill(source: SkillSource): boolean {
  return source === 'global' || source === 'imported';
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
/** A skill of theirs already owns this shortcut. Distinct from SkillImportError
 *  so the caller can offer "replace it" instead of just reporting a failure. */
export class SkillExistsError extends Error {
  constructor(public readonly id: string) {
    super(`you already have a skill called '${id}'`);
    this.name = 'SkillExistsError';
  }
}
/** Asked to export something that ships with Baton. Its own type so the route
 *  answers 403 rather than a generic 400. */
export class SkillExportRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SkillExportRefused'; }
}

/**
 * The user's library: one place per machine, so a skill uploaded once is there
 * in every project — including a project set up months later. `~/.baton` is
 * already Baton's machine-wide root regardless of branding (see
 * electron/cli-install.ts), so this adds a directory, not a convention.
 */
export const globalSkillsDir = (): string => join(homedir(), '.baton', 'skills');

/** Legacy per-repo imports. Read, never written to any more. */
export const projectSkillsDir = (root: string): string => join(root, '.baton', 'skills');

export function isSkillAgent(agent: string): agent is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(agent);
}

/** Where a skill installs for an agent, or null if Baton can't write it. */
/**
 * Where an install is allowed to land (Q22).
 *
 * The requested path arrives over HTTP and decides where files are WRITTEN, so
 * it is honoured only when git itself lists it as a worktree of the served
 * repo. Everything else is refused, including an empty worktree list — that
 * means the question could not be answered, and honouring the path then would
 * make the check decorative exactly when it matters.
 *
 * Comparison is `resolve()`d and case-folded on win32. Two real checkouts that
 * differ only by a symlink (macOS `/var` → `/private/var`) will not match and
 * the install is refused; a refusal is an inconvenience, a write outside the
 * repo is not.
 */
export type SkillRootChoice = { ok: true; root: string } | { ok: false; reason: string };

export function resolveSkillRoot(
  servedRoot: string,
  requested: string | undefined,
  worktrees: readonly { path: string }[],
): SkillRootChoice {
  const want = (requested ?? '').trim();
  if (!want) return { ok: true, root: servedRoot };

  const norm = (p: string): string => {
    const abs = resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const target = norm(want);
  const match = worktrees.find((w) => norm(w.path) === target);
  if (match) return { ok: true, root: match.path };

  const known = worktrees.map((w) => w.path).join(', ');
  return {
    ok: false,
    reason: known
      ? `'${want}' is not a worktree of this repo. Known worktrees: ${known}`
      : `'${want}' cannot be checked — git listed no worktrees for this repo.`,
  };
}

export function skillTargetFor(agent: string, id: string, root: string): SkillTarget | null {
  if (agent === 'claude') {
    const dir = join('.claude', 'skills', id);
    return { agent, path: join(root, dir, 'SKILL.md'), rel: join(dir, 'SKILL.md'), refsDir: join(root, dir), excludes: [dir] };
  }
  if (agent === 'cursor') {
    const rel = join('.cursor', 'rules', `${id}.mdc`);
    // Single-file rule; references travel in a sibling <id>/ folder — so two
    // patterns, not one, and the sibling is the half that is easy to forget.
    return { agent, path: join(root, rel), rel, refsDir: join(root, '.cursor', 'rules', id), excludes: [rel, join('.cursor', 'rules', id)] };
  }
  if (agent === 'antigravity') {
    // Antigravity reads .agents/skills/<id>/SKILL.md — same layout as Claude
    // (verified on a live Antigravity workspace, references/ included).
    const dir = join('.agents', 'skills', id);
    return { agent, path: join(root, dir, 'SKILL.md'), rel: join(dir, 'SKILL.md'), refsDir: join(root, dir), excludes: [dir] };
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
    const parsed = parseFrontmatter(text);
    data = parsed.data;
    content = parsed.content;
  } catch {
    // The YAML parser refused. Before giving up and calling the whole file a
    // body, try to salvage it — see salvageFrontmatter for why this is the
    // common case rather than an exotic one.
    const salvaged = salvageFrontmatter(text);
    if (salvaged) { data = salvaged.data; content = salvaged.content; }
  }

  const name = String(data.name ?? data.title ?? '').trim();
  const description = String(data.description ?? '').replace(/\s+/g, ' ').trim();
  const id = slugifySkillId(name || fallbackId);
  return {
    id,
    name: name || titleCase(fallbackId),
    description: description || firstHeadingOrLine(content) || 'Imported skill.',
    tags: [],
    produces: [],
    // A skill the user brought in says nothing about what it is for, and guessing
    // from its text would mis-file it confidently. 'code' is the honest default.
    category: 'code',
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

/**
 * Frontmatter a YAML parser refused, read back line by line.
 *
 * Overwhelmingly the common case: `description: Our release ritual: migrations
 * dry-run` — a plain scalar with a colon in it. That is invalid YAML and it is
 * also exactly what a person writes. Rejecting the whole block made the
 * description come out as the literal "---", leaked the fence into the body,
 * and left the skill looking broken over one piece of punctuation.
 *
 * Deliberately dumb: `key: rest-of-line`, quotes trimmed, no nesting, no lists.
 * It runs only after real YAML has already failed, so the bar is "better than
 * discarding everything", not "a second YAML implementation".
 */
function salvageFrontmatter(text: string): { data: Record<string, unknown>; content: string } | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const data: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, content: text.slice(m[0].length) };
}

function firstHeadingOrLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    // A bare `---` is a frontmatter fence or a horizontal rule, never a
    // description — taking it was how a skill ended up described as "---".
    if (line && !/^-{3,}$/.test(line)) return line.slice(0, 160);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Catalog (bundled + imported on disk)                                */
/* ------------------------------------------------------------------ */

/**
 * Read one flat directory of <id>.md skills.
 *
 * `taken` is threaded through rather than filtered afterwards so precedence is
 * decided in one place: bundled wins over global, global wins over a legacy
 * per-repo copy of the same id. A shadowed file is skipped, never merged —
 * two half-applied definitions of one skill is worse than either alone.
 *
 * `raw` is normalised on the way out, NOT trusted as-is. Files written by older
 * Baton versions carry `name: <display name>` (the pre-1.x importSkill wrote the
 * display name, not the id), and a file with no frontmatter carries no name at
 * all. Installing those verbatim would hand Claude a SKILL.md whose declared
 * name contradicts its own directory. withSkillName is idempotent, so this is a
 * no-op for anything this version wrote.
 */
async function readSkillDir(dir: string, source: SkillSource, taken: Set<string>): Promise<SkillDef[]> {
  if (!existsSync(dir)) return [];
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: SkillDef[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const skill = e.isDirectory()
        ? await readSkillFolder(join(dir, e.name), e.name, source)
        : e.name.endsWith('.md')
          ? await readSkillFile(join(dir, e.name), e.name.replace(/\.md$/, ''), source)
          : null;
      if (!skill || taken.has(skill.id)) continue;
      taken.add(skill.id);
      out.push(skill);
    } catch { /* one unreadable entry must not cost the rest of the library */ }
  }
  return out;
}

/** A flat <id>.md skill: one file, no companions. The original shape. */
async function readSkillFile(path: string, fallbackId: string, source: SkillSource): Promise<SkillDef> {
  const text = await readFile(path, 'utf-8');
  const skill = parseSkillMarkdown(text, fallbackId);
  return { ...skill, source, raw: withSkillName(text, skill.id) };
}

/**
 * A directory-shaped skill: <id>/SKILL.md plus everything beside it.
 *
 * The shape bundled skills already use, now available to the user's own
 * library — because a skill fetched from a repo brings a references/ folder, a
 * scripts/ folder and its data, and a lone SKILL.md that tells the agent to run
 * a script it does not have is worse than no skill at all.
 */
async function readSkillFolder(dir: string, fallbackId: string, source: SkillSource): Promise<SkillDef | null> {
  const main = join(dir, 'SKILL.md');
  if (!existsSync(main)) return null;
  const text = await readFile(main, 'utf-8');
  const skill = parseSkillMarkdown(text, fallbackId);
  const references = await readCompanionFiles(dir);
  return { ...skill, source, references, raw: withSkillName(text, skill.id) };
}

/** Every file beside SKILL.md, as skill-relative paths. Depth-capped: a skill
 *  directory is a payload, not a checkout, and a symlink loop is not our bug to
 *  discover at catalog-load time. */
async function readCompanionFiles(dir: string, prefix = '', depth = 0): Promise<{ rel: string; content: string }[]> {
  if (depth > SKILL_DIR_MAX_DEPTH) return [];
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: { rel: string; content: string }[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      out.push(...await readCompanionFiles(join(dir, e.name), `${rel}/`, depth + 1));
      continue;
    }
    if (!e.isFile() || rel === 'SKILL.md') continue;
    try { out.push({ rel, content: await readFile(join(dir, e.name), 'utf-8') }); }
    catch { /* skip an unreadable companion rather than lose the skill */ }
  }
  return out;
}

/** All skills: bundled, then the machine-wide library, then legacy per-repo imports. */
export async function loadCatalog(root: string): Promise<SkillDef[]> {
  const bundled = await bundledSkills();
  const taken = new Set(bundled.map((s) => s.id));
  const global = await readSkillDir(globalSkillsDir(), 'global', taken);
  const imported = await readSkillDir(projectSkillsDir(root), 'imported', taken);
  return [...bundled, ...global, ...imported];
}

export async function findSkill(root: string, id: string): Promise<SkillDef | null> {
  return (await loadCatalog(root)).find((s) => s.id === id) ?? null;
}

/** Catalog with per-agent install state. Reference content is dropped here. */
export async function listSkillStatus(root: string): Promise<SkillStatus[]> {
  const catalog = await loadCatalog(root);
  // Read once for the whole listing, not once per skill.
  const bookmarked = await loadBookmarks();
  return catalog.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    produces: skill.produces,
    body: skill.body,
    source: skill.source,
    category: skill.category,
    explain: skill.explain,
    references: skill.references.map((r) => r.rel),
    bookmarked: bookmarked.has(skill.id),
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
  /**
   * Whether Baton git-excluded what it wrote. False outside a git repo (a
   * folder workspace), where there is nothing to exclude from.
   *
   * Reported rather than assumed because a client updates separately from the
   * daemon: an Orca panel newer than its Baton must be able to tell "excluded"
   * from "this daemon does not do that yet", and an absent field reads as the
   * latter.
   */
  excluded: boolean;
}

export async function installSkill(root: string, id: string, agent: string): Promise<InstallResult> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  const target = skillTargetFor(agent, id, root)!;

  await mkdir(dirname(target.path), { recursive: true });
  // Claude + Antigravity share the SKILL.md format — hand-authored files go verbatim.
  const main = (agent === 'claude' || agent === 'antigravity') && skill.raw ? skill.raw : renderSkill(agent, skill);
  await writeFile(target.path, main, 'utf-8');

  let references = 0;
  for (const ref of skill.references) {
    const dest = join(target.refsDir, ref.rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, ref.content, 'utf-8');
    references++;
  }
  // Q22. Baton's own scaffolding must not become the agent's diff: every
  // untracked file here reaches `baton done` as a dirtyFile, where one entry is
  // a hard refusal. Done HERE rather than at each call site, because
  // dispatch-resolve remembered and the CLI and HTTP route did not.
  // No-ops outside a git repo, which is the folder-workspace case.
  let excluded = false;
  for (const rel of target.excludes) {
    excluded = (await gitExcludeLocal(root, rel)) || excluded;
  }
  return { skill: id, agent, rel: target.rel, path: target.path, wrote: true, references, excluded };
}

/**
 * Install one skill into EVERY agent Baton can write (SKILL_AGENTS), in one
 * shot. Backs `baton skills install <id> --all` and the dashboard's install-
 * everywhere action. Validates the skill once up front so an unknown id writes
 * nothing.
 */
export async function installSkillEverywhere(root: string, id: string): Promise<InstallResult[]> {
  if (!(await findSkill(root, id))) throw new SkillNotFoundError(id);
  const results: InstallResult[] = [];
  for (const agent of SKILL_AGENTS) results.push(await installSkill(root, id, agent));
  return results;
}

export async function uninstallSkill(root: string, id: string, agent: string): Promise<{ removed: boolean; rel: string }> {
  if (!isSkillAgent(agent)) throw new SkillAgentUnsupportedError(agent);
  const target = skillTargetFor(agent, id, root)!;
  const had = existsSync(target.path);
  if (agent === 'claude' || agent === 'antigravity') {
    // The whole skills/<id>/ dir (SKILL.md + references) is ours.
    await rm(target.refsDir, { recursive: true, force: true });
  } else {
    await rm(target.path, { force: true });                 // the .mdc rule
    await rm(target.refsDir, { recursive: true, force: true }); // sibling <id>/ references
  }
  // Symmetric with install. A pattern that outlives what it was for makes a
  // hand-written file at the same path invisible to git, and silently.
  for (const rel of target.excludes) await gitUnexcludeLocal(root, rel);
  return { removed: had, rel: target.rel };
}

const MAX_IMPORT_BYTES = 256 * 1024;
/** Caps for a restored skill, mirroring the ones the GitHub fetch applies. */
const MAX_BUNDLE_FILES = 200;
const MAX_BUNDLE_SKILL_BYTES = 8 * 1024 * 1024;
/** How deep a skill directory may nest before we stop walking it. */
const SKILL_DIR_MAX_DEPTH = 4;
const IMPORT_FETCH_TIMEOUT_MS = 10_000;
const IMPORT_MAX_REDIRECTS = 4;

/**
 * SSRF guard: refuse to fetch private / loopback / link-local / reserved hosts.
 * `fetch` from the daemon would otherwise let a caller (or a redirect target)
 * reach cloud-metadata (169.254.169.254), internal services, or other loopback
 * ports — the response is unreadable cross-origin, but the request still lands.
 * Literal-IP based; hostnames are checked as-is (DNS rebinding is a residual,
 * lower risk for a tool a user points at a URL they chose). Pure; unit-tested.
 */
export function isBlockedFetchHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  // IPv6 loopback / unspecified / unique-local / link-local
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;          // unspecified / loopback / private
    if (a === 169 && b === 254) return true;                    // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  }
  return false;
}

/** Read a fetch Response body, aborting if it exceeds `max` bytes (no full buffer first). */
async function readBodyCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new SkillImportError(`too large (over ${Math.round(max / 1024)}KB)`);
    return t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new SkillImportError(`too large (over ${Math.round(max / 1024)}KB)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Fetch skill text over http(s) with SSRF blocking, a timeout, manual redirect
 *  re-validation, and a streamed size cap. */
async function fetchSkillText(startUrl: string, max: number = MAX_IMPORT_BYTES): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop <= IMPORT_MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { throw new SkillImportError(`invalid URL: ${current}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SkillImportError('only http(s) URLs can be imported');
    if (isBlockedFetchHost(u.hostname)) throw new SkillImportError(`refusing to fetch a private/loopback address (${u.hostname})`);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS) });
    } catch (e) {
      throw new SkillImportError(`couldn't fetch ${current}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SkillImportError(`couldn't fetch ${current}: HTTP ${res.status} with no redirect target`);
      current = new URL(loc, current).toString(); // re-validate the hop on the next iteration
      continue;
    }
    if (!res.ok) throw new SkillImportError(`couldn't fetch ${current}: HTTP ${res.status}`);
    return readBodyCapped(res, max);
  }
  throw new SkillImportError('too many redirects while importing skill');
}

/**
 * Import a skill from a local file path or http(s) URL into <repo>/.baton/skills.
 * Returns the parsed skill; it then appears in the catalog and is installable
 * like a bundled one. (Imported skills are single-file — references are a
 * bundled-skill feature.)
 */
/** Extensions a skill may arrive with. Anything else is a wrong-file mistake. */
const SKILL_EXTENSIONS = /\.(md|mdc|markdown|txt)$/i;

export interface SaveSkillOpts {
  /** The shortcut the user chose. Falls back to the file's frontmatter name. */
  id?: string;
  /** Overwrite an existing skill of theirs. Never overwrites a bundled one. */
  replace?: boolean;
}

/**
 * Rewrite a skill's frontmatter `name:` to `id`, touching nothing else.
 *
 * The alternative — rebuilding frontmatter from parsed fields, which is what
 * import used to do — silently discarded `tags`, `produces` and anything else
 * the author wrote. Preserving the bytes is both less code and less lossy, and
 * it is what makes `raw` safe to set everywhere.
 *
 * Handles the three shapes a file actually arrives in: no frontmatter at all,
 * frontmatter without a name, and frontmatter with one.
 */
export function withSkillName(text: string, id: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!fm) return `---\nname: ${id}\n---\n\n${text.trim()}\n`;
  const block = /^name:.*$/m.test(fm[1])
    ? fm[1].replace(/^name:.*$/m, `name: ${id}`)
    : `name: ${id}\n${fm[1]}`;
  return `---\n${block}\n---\n${text.slice(fm[0].length)}`;
}

/**
 * Validate text that is about to become a skill file.
 *
 * A trust boundary: the bytes came from a browser upload, an arbitrary URL, or
 * a path the user typed. Size is checked before anything is parsed, and the NUL
 * scan catches the common wrong-file mistake (a PDF or an image renamed .md)
 * that would otherwise be written to disk and then fail confusingly at install.
 */
function assertUsableSkillText(text: string, what: string): void {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new SkillImportError(`${what} is ${Math.round(text.length / 1024)}KB — the limit is 256KB`);
  }
  if (!text.trim()) throw new SkillImportError(`${what} is empty`);
  if (text.includes('\0')) throw new SkillImportError(`${what} is not text — a skill is a markdown file`);
}

/** Extensions that are code a coding agent will plausibly RUN, not prose it reads. */
const EXECUTABLE_EXT = /\.(py|sh|bash|zsh|fish|ps1|rb|pl|js|mjs|cjs|ts|tsx|php|lua|r|jar|bat|cmd)$/i;

/**
 * Executable files a skill brought with it.
 *
 * Baton never runs any of this — it only writes files — but the agent the skill
 * is installed for very well might, because the SKILL.md usually tells it to.
 * Adding a skill from a URL is therefore not just "read these instructions", it
 * is "and here is some code to run", and those are different consents. Naming
 * the files at import time is the difference between a decision and a surprise.
 */
export function executableFiles(refs: { rel: string }[]): string[] {
  return refs.filter((r) => EXECUTABLE_EXT.test(r.rel)).map((r) => r.rel).sort();
}

/**
 * Reference files a skill's text points at but that did not come with it.
 *
 * A single .md upload cannot carry a references/ folder, so a skill that says
 * "see references/checklist.md" installs fine and then sends the agent looking
 * for a file that is not there. Reporting it beats both silence and refusing an
 * upload that is otherwise perfectly usable.
 */
export function danglingReferences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/references\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g)) found.add(m[0]);
  return [...found].slice(0, 10);
}

/**
 * The one write path for every user skill, whatever door it came in by.
 *
 * Import (path/URL), upload (browser) and bundle-restore all land here so the
 * collision rules, the id normalisation and the storage location cannot drift
 * apart between them.
 */
async function saveSkill(text: string, fallbackId: string, opts: SaveSkillOpts): Promise<SkillDef> {
  const parsed = parseSkillMarkdown(text, fallbackId);
  // An explicit shortcut always wins over whatever the file declared: the user
  // saw the field and typed in it. Re-slugified rather than trusted, because it
  // arrives over HTTP and becomes a FILENAME two lines later.
  // Checked on the RAW input, not on slugify's output: slugifySkillId falls
  // back to the literal 'skill' for unusable input, so testing the result would
  // silently accept '!!!' and file it under a name the user never chose.
  if (opts.id !== undefined && opts.id !== '' && !/[a-z0-9]/i.test(opts.id)) {
    throw new SkillImportError(`'${opts.id}' has no letters or digits in it — pick another shortcut`);
  }
  const id = opts.id ? slugifySkillId(opts.id) : parsed.id;

  const bundledIds = new Set((await bundledSkills()).map((s) => s.id));
  if (bundledIds.has(id)) {
    throw new SkillImportError(`'${id}' is a Baton built-in — pick another shortcut`);
  }
  const dir = globalSkillsDir();
  const file = join(dir, `${id}.md`);
  if (skillIsStored(id) && !opts.replace) {
    throw new SkillExistsError(id);
  }

  const raw = withSkillName(text, id);
  try {
    await mkdir(dir, { recursive: true });
    // Replacing a directory-shaped skill with a flat one must not leave the old
    // directory behind: the reader would keep finding it and the new file would
    // never win.
    await rm(join(dir, id), { recursive: true, force: true });
    await writeFile(file, raw, 'utf-8');
  } catch (e) {
    throw new SkillImportError(`couldn't write to ${dir}: ${(e as Error).message}`);
  }
  return { ...parsed, id, source: 'global', raw };
}

/**
 * Import a skill from a local file path or http(s) URL into the user's library.
 *
 * The path form reads from the DAEMON's filesystem, which is why the browser
 * uses uploadSkill instead — a path typed in a browser means nothing here.
 */
export async function importSkill(root: string, source: string, opts: SaveSkillOpts = {}): Promise<SkillDef> {
  const src = source.trim();
  if (!src) throw new SkillImportError('pass a file path or http(s) URL');

  let text: string;
  let fallbackId = 'imported-skill';
  if (/^https?:\/\//i.test(src)) {
    text = await fetchSkillText(src);
    fallbackId = slugifySkillId(new URL(src).pathname.split('/').filter(Boolean).pop()?.replace(SKILL_EXTENSIONS, '') || 'imported-skill');
  } else {
    if (!existsSync(src)) throw new SkillImportError(`no such file: ${src}`);
    try {
      text = await readFile(src, 'utf-8');
    } catch (e) {
      throw new SkillImportError(`couldn't read ${src}: ${(e as Error).message}`);
    }
    fallbackId = slugifySkillId(src.split(/[/\\]/).pop()?.replace(SKILL_EXTENSIONS, '') || 'imported-skill');
  }
  assertUsableSkillText(text, 'that file');
  return saveSkill(text, fallbackId, opts);
}

/** Is this shortcut already taken in the user's library, in either shape? */
function skillIsStored(id: string): boolean {
  const dir = globalSkillsDir();
  return existsSync(join(dir, `${id}.md`)) || existsSync(join(dir, id, 'SKILL.md'));
}

/**
 * Write a multi-file skill into the library as <id>/SKILL.md plus companions.
 *
 * Every relative path is re-resolved under the skill directory and checked to
 * still be inside it before anything is written: the paths came from a remote
 * repo's file list, so `../../.ssh/authorized_keys` is exactly the input this
 * has to refuse.
 */
async function saveSkillFolder(files: RemoteSkillFile[], fallbackId: string, opts: SaveSkillOpts): Promise<SkillDef> {
  const main = files.find((f) => /^SKILL\.md$/i.test(f.rel));
  if (!main) throw new SkillImportError('that skill has no SKILL.md');
  assertUsableSkillText(main.content, 'that skill');

  if (opts.id !== undefined && opts.id !== '' && !/[a-z0-9]/i.test(opts.id)) {
    throw new SkillImportError(`'${opts.id}' has no letters or digits in it — pick another shortcut`);
  }
  const parsed = parseSkillMarkdown(main.content, fallbackId);
  const id = opts.id ? slugifySkillId(opts.id) : parsed.id;
  if ((await bundledSkills()).some((b) => b.id === id)) {
    throw new SkillImportError(`'${id}' is a Baton built-in — pick another shortcut`);
  }
  if (skillIsStored(id) && !opts.replace) throw new SkillExistsError(id);

  const root = join(globalSkillsDir(), id);
  const raw = withSkillName(main.content, id);
  const references: { rel: string; content: string }[] = [];
  try {
    // Replace wholesale rather than merge: a stale file from the previous
    // version left in place is a file the agent will still read.
    await rm(root, { recursive: true, force: true });
    await rm(join(globalSkillsDir(), `${id}.md`), { force: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'SKILL.md'), raw, 'utf-8');
    for (const f of files) {
      if (/^SKILL\.md$/i.test(f.rel)) continue;
      const dest = resolve(root, f.rel);
      if (dest !== root && !dest.startsWith(root + sep)) {
        throw new SkillImportError(`refusing to write outside the skill folder: ${f.rel}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.content, 'utf-8');
      references.push({ rel: f.rel, content: f.content });
    }
  } catch (e) {
    if (e instanceof SkillImportError) throw e;
    throw new SkillImportError(`couldn't write ${root}: ${(e as Error).message}`);
  }
  return { ...parsed, id, source: 'global', references, raw };
}

export interface ImportFromSourceResult {
  /** Set when one skill was resolved and stored. */
  skill?: SkillDef;
  /** Set instead when the repo holds several and none was named. */
  choices?: SkillCandidate[];
  /** Files the fetch deliberately left behind, e.g. binaries and oversized data. */
  skipped?: string[];
  /** Where it came from, for the confirmation message. */
  origin?: string;
}

/**
 * The front door for "add this skill" — whatever the user pasted.
 *
 * A GitHub repo/folder/blob URL fetches the whole skill directory; anything
 * else (a raw file URL, a local path) stays on the single-file path it always
 * used. A pasted `npx skills add … --skill …` line is unwrapped first, because
 * that is what people copy out of a README rather than the bare URL.
 */
export async function importSkillFromSource(
  root: string,
  input: string,
  opts: SaveSkillOpts = {},
): Promise<ImportFromSourceResult> {
  const parsedSource = parseSkillSource(input);
  // No URL in it at all: a local path, which importSkill already handles.
  if (!parsedSource) return { skill: await importSkill(root, input, opts) };

  const gh = parseGitHubUrl(parsedSource.url);
  if (!gh) {
    const skill = await importSkill(root, parsedSource.url, opts);
    await recordOrigin(skill, { url: parsedSource.url });
    return { skill };
  }

  const wanted = opts.id || parsedSource.skill;
  const res = await fetchGitHubSkill(gh, wanted, fetchSkillText, MAX_IMPORT_BYTES);
  if ('choices' in res) return { choices: res.choices };
  // A single-file skill gains nothing from a folder, and a flat file is the
  // shape export and restore already understand.
  const only = res.skill.files.length === 1;
  const skill = only
    ? await saveSkill(res.skill.files[0].content, res.skill.id, opts)
    : await saveSkillFolder(res.skill.files, res.skill.id, opts);
  // Recorded only once the bytes are safely on disk, so a failed import never
  // leaves an origin pointing at a skill that is not there. The hash is of what
  // was WRITTEN (SKILL.md normalised to the id), not of what was fetched —
  // otherwise every skill would read as locally edited the moment it landed.
  await recordOrigin(skill, { url: parsedSource.url, ref: gh.ref, skill: wanted });
  return { skill, skipped: res.skill.skipped, origin: res.skill.origin };
}

/**
 * Note where a skill came from, hashing exactly what landed on disk.
 *
 * Bookkeeping must never sink an import that otherwise worked, so a failure
 * here is swallowed: the cost is one skill without an update button, which is
 * strictly better than an import that reports failure after writing the files.
 */
async function recordOrigin(
  skill: SkillDef,
  where: { url: string; ref?: string; skill?: string },
): Promise<void> {
  try {
    await setOrigin(skill.id, {
      url: where.url,
      ...(where.ref ? { ref: where.ref } : {}),
      ...(where.skill ? { skill: where.skill } : {}),
      fetchedAt: new Date().toISOString(),
      contentHash: hashSkillFiles(skillFileList(skill)),
    });
  } catch { /* an unwritable origins file must not fail the import */ }
}

/** A skill as a flat file list — the form the hash and the writers both want. */
function skillFileList(skill: SkillDef): { rel: string; content: string }[] {
  return [
    { rel: 'SKILL.md', content: skill.raw ?? skill.body },
    ...skill.references.map((r) => ({ rel: r.rel, content: r.content })),
  ];
}

export class SkillLocallyEditedError extends Error {
  constructor(public id: string) {
    super(`'${id}' has local edits — updating would overwrite them`);
    this.name = 'SkillLocallyEditedError';
  }
}

export interface UpdateSkillResult {
  id: string;
  /** No origin recorded: added before provenance existed, or uploaded by hand. */
  status: 'updated' | 'already-current' | 'no-origin';
  /** Files that differ from the copy you had. Empty when already current. */
  changed?: string[];
  origin?: string;
}

/**
 * Re-fetch a skill from where it came from.
 *
 * Refuses by default when the local copy no longer matches what was written at
 * import: people tune skills, and silently replacing an edited file is the one
 * behaviour that would make this feature something users learn to fear. `force`
 * is the deliberate override.
 */
export async function updateSkill(
  root: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<UpdateSkillResult> {
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  if (!isUserSkill(skill.source)) {
    throw new SkillImportError(`'${id}' is a Baton built-in — it updates when Baton does`);
  }
  const origin = await getOrigin(id);
  if (!origin) return { id, status: 'no-origin' };

  const before = skillFileList(skill);
  if (!opts.force && hashSkillFiles(before) !== origin.contentHash) {
    throw new SkillLocallyEditedError(id);
  }

  const gh = parseGitHubUrl(origin.url);
  const fetched = gh
    ? await fetchGitHubSkill(
        { ...gh, ...(origin.ref ? { ref: origin.ref } : {}) },
        origin.skill ?? id, fetchSkillText, MAX_IMPORT_BYTES,
      )
    : { skill: { id, files: [{ rel: 'SKILL.md', content: await fetchSkillText(origin.url) }], skipped: [], origin: origin.url } };
  // A repo that grew a second skill since the import must not silently swap it.
  if ('choices' in fetched) throw new SkillImportError(`'${id}' now matches ${fetched.choices.length} skills in that repo — re-add it by name`);

  const after = fetched.skill.files;
  if (hashSkillFiles(after) === hashSkillFiles(before)) {
    return { id, status: 'already-current', changed: [], origin: fetched.skill.origin };
  }

  const wasBefore = new Map(before.map((f) => [f.rel, f.content]));
  const changed = [
    ...after.filter((f) => wasBefore.get(f.rel) !== f.content).map((f) => f.rel),
    ...before.filter((f) => !after.some((a) => a.rel === f.rel)).map((f) => `${f.rel} (removed)`),
  ].sort();

  const saved = after.length === 1
    ? await saveSkill(after[0].content, id, { id, replace: true })
    : await saveSkillFolder(after, id, { id, replace: true });
  await recordOrigin(saved, { url: origin.url, ref: origin.ref, skill: origin.skill });
  return { id, status: 'updated', changed, origin: fetched.skill.origin };
}

export interface UploadSkillInput {
  /** The name of the file the user picked, used for the default shortcut. */
  filename: string;
  /** The file's text, read in the browser. */
  content: string;
  id?: string;
  replace?: boolean;
}

/**
 * Add a skill from bytes the browser read, rather than a path only the daemon
 * can see. Deliberately JSON rather than multipart: a 256KB text file fits the
 * existing 1MB body cap, and a multipart parser would be a new dependency in a
 * daemon that has none.
 */
export async function uploadSkill(root: string, input: UploadSkillInput): Promise<SkillDef> {
  const name = (input.filename ?? '').trim();
  const text = input.content ?? '';
  if (!name) throw new SkillImportError('no filename — pick a file to upload');
  if (!SKILL_EXTENSIONS.test(name)) {
    throw new SkillImportError(`'${name}' is not a markdown file — upload a SKILL.md (.md, .mdc, .markdown or .txt)`);
  }
  assertUsableSkillText(text, `'${name}'`);
  const fallbackId = slugifySkillId(name.split(/[/\\]/).pop()!.replace(SKILL_EXTENSIONS, '')) || 'uploaded-skill';
  return saveSkill(text, fallbackId, { id: input.id, replace: input.replace });
}

/**
 * Delete a skill the user owns, from the catalog AND from every agent it was
 * installed into.
 *
 * Both halves, because removing only the catalog entry would leave a working
 * `/shortcut` in every agent with no way left to manage it — the confusing
 * half-state that `baton skills remove` (agents only, file untouched) has been
 * leaving behind in the other direction.
 */
/**
 * Pin or unpin a skill.
 *
 * Validated against the catalog rather than taking any id: the id arrives over
 * HTTP, and a bookmark file that accumulated typos would be a list nobody could
 * clean up from the UI that made it.
 */
export async function bookmarkSkill(root: string, id: string, on: boolean): Promise<{ id: string; bookmarked: boolean }> {
  if (!(await findSkill(root, id))) throw new SkillNotFoundError(id);
  const ids = await setBookmark(id, on);
  return { id, bookmarked: ids.has(id) };
}

export async function removeSkill(root: string, id: string): Promise<{ removed: boolean; source: SkillSource; unwired: string[] }> {
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  if (!isUserSkill(skill.source)) {
    throw new SkillImportError(`'${id}' is a Baton built-in — it ships with the package and can't be deleted`);
  }
  const dir = skill.source === 'global' ? globalSkillsDir() : projectSkillsDir(root);
  const unwired: string[] = [];
  for (const agent of SKILL_AGENTS) {
    try {
      if ((await uninstallSkill(root, id, agent)).removed) unwired.push(agent);
    } catch { /* an agent we can't write is not a reason to keep the file */ }
  }
  // Both shapes: the flat file and the directory a fetched skill lands in.
  await rm(join(dir, `${id}.md`), { force: true });
  await rm(join(dir, id), { recursive: true, force: true });
  // Drop the bookmark too. A pin pointing at a skill the user just deleted is
  // the one stale id that IS worth clearing, because we are already writing.
  await setBookmark(id, false).catch(() => undefined);
  // Same reasoning: an origin pointing at a skill the user just deleted is a
  // stale entry we are already in a position to clear.
  await clearOrigin(id).catch(() => undefined);
  return { removed: true, source: skill.source, unwired };
}

/**
 * The exact bytes of a user skill, for download.
 *
 * Bundled skills are refused rather than served: they ship inside the npm
 * package, so "exporting" one hands back a copy of what the user already
 * installed, and blurring the line is exactly what the ours/yours split in the
 * dashboard exists to keep clear.
 */
export async function exportSkillFile(root: string, id: string): Promise<{ id: string; text: string }> {
  const skill = await findSkill(root, id);
  if (!skill) throw new SkillNotFoundError(id);
  if (!isUserSkill(skill.source)) {
    throw new SkillExportRefused(`'${id}' is a Baton built-in — it ships with the package, so there is nothing to export`);
  }
  // Already in hand: readSkillDir loaded and normalised it a moment ago, so
  // re-reading the file would be a second read of the same bytes — and would
  // hand back a legacy `name:` that the install path no longer uses.
  // Checked rather than asserted so a future source that forgets to set `raw`
  // fails loudly instead of exporting an empty file.
  if (!skill.raw) throw new SkillExportRefused(`'${id}' has no readable content on disk`);
  return { id, text: skill.raw };
}

/**
 * 2 adds `files` so a directory-shaped skill survives the round trip.
 *
 * Bumped rather than added silently: a v2 bundle restored by a Baton that only
 * knows v1 would drop every companion file and hand back a skill whose SKILL.md
 * tells the agent to run a script that is not there. Refusing loudly beats
 * restoring lossily. v1 bundles are still read — nothing a user exported
 * before today stops working.
 */
export const SKILL_BUNDLE_VERSION = 2;
const READABLE_BUNDLE_VERSIONS = new Set([1, 2]);

export interface SkillBundle {
  version: number;
  exportedAt: string;
  skills: {
    id: string;
    name: string;
    description: string;
    /** SKILL.md, verbatim. */
    content: string;
    /** Companions, skill-relative. Absent for a flat single-file skill. */
    files?: { rel: string; content: string }[];
  }[];
}

/** Every skill the user owns, as one restorable file. Bundled ones are excluded. */
export async function exportSkills(root: string): Promise<SkillBundle> {
  // ONE catalog load for the whole bundle. Calling exportSkillFile per skill
  // re-ran findSkill -> loadCatalog each time, so exporting 20 skills meant 21
  // full catalog loads — every bundled skill dir re-read, twenty times over.
  const skills: SkillBundle['skills'] = [];
  for (const s of await loadCatalog(root)) {
    if (!isUserSkill(s.source) || !s.raw) continue;
    // A backup that drops 69 of a skill's 70 files is not a backup.
    skills.push({
      id: s.id, name: s.name, description: s.description, content: s.raw,
      ...(s.references.length ? { files: s.references.map((r) => ({ rel: r.rel, content: r.content })) } : {}),
    });
  }
  return { version: SKILL_BUNDLE_VERSION, exportedAt: new Date().toISOString(), skills };
}

export interface BundleImportResult {
  imported: string[];
  skipped: { id: string; why: string }[];
}

/**
 * Vet the companion files in a bundle before any of them reach disk.
 *
 * A bundle arrives as a file from wherever — a colleague, a download, a backup
 * of unknown age — so its `files` array gets the same treatment a fetched repo
 * tree gets. saveSkillFolder refuses paths that escape the skill directory on
 * its own; this catches the rest (wrong types, absolute paths, a runaway count)
 * with a message naming the skill, so a bad entry is skipped and reported
 * rather than throwing the whole restore.
 */
function sanitizeBundleFiles(raw: unknown, who: string): { rel: string; content: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SkillImportError(`${who} has a malformed file list`);
  if (raw.length > MAX_BUNDLE_FILES) {
    throw new SkillImportError(`${who} carries ${raw.length} files — the limit is ${MAX_BUNDLE_FILES}`);
  }
  const out: { rel: string; content: string }[] = [];
  let total = 0;
  for (const f of raw) {
    const rel = typeof (f as { rel?: unknown })?.rel === 'string' ? (f as { rel: string }).rel : '';
    const content = typeof (f as { content?: unknown })?.content === 'string' ? (f as { content: string }).content : null;
    if (!rel || content === null) throw new SkillImportError(`${who} has a malformed entry in its file list`);
    if (/^SKILL\.md$/i.test(rel)) continue;                       // the main file is carried separately
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split(/[/\\]/).includes('..')) {
      throw new SkillImportError(`${who} wants to write outside its folder (${rel})`);
    }
    total += Buffer.byteLength(content);
    if (total > MAX_BUNDLE_SKILL_BYTES) {
      throw new SkillImportError(`${who} is over the ${MAX_BUNDLE_SKILL_BYTES / 1024 / 1024}MB limit`);
    }
    out.push({ rel, content });
  }
  return out;
}

/**
 * Restore a bundle into the library.
 *
 * Validated whole before anything is written: a bundle from the wrong version
 * or with a malformed shape is refused outright rather than half-applied. Once
 * past that, one bad entry is skipped and reported instead of failing the
 * restore — the user is trying to get their library back, and losing nine
 * skills because the tenth is broken is the wrong trade.
 */
export async function importSkillBundle(root: string, raw: unknown, opts: { replace?: boolean } = {}): Promise<BundleImportResult> {
  const b = raw as Partial<SkillBundle> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.skills)) {
    throw new SkillImportError('that file is not a Baton skills bundle');
  }
  if (typeof b.version !== 'number' || !READABLE_BUNDLE_VERSIONS.has(b.version)) {
    throw new SkillImportError(`bundle version ${String(b.version)} — this Baton reads ${[...READABLE_BUNDLE_VERSIONS].join(' and ')}`);
  }
  const result: BundleImportResult = { imported: [], skipped: [] };
  for (const entry of b.skills) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    try {
      if (typeof entry?.content !== 'string') throw new SkillImportError('no content');
      assertUsableSkillText(entry.content, `'${id || 'a skill'}'`);
      // The bundle is a file someone can hand you, so its companion list is
      // untrusted input in exactly the way a fetched repo's is.
      const files = sanitizeBundleFiles(entry.files, id || 'a skill');
      const saved = files.length
        ? await saveSkillFolder(
            [{ rel: 'SKILL.md', content: entry.content }, ...files],
            id || 'imported-skill', { id, replace: opts.replace },
          )
        : await saveSkill(entry.content, id || 'imported-skill', { id, replace: opts.replace });
      result.imported.push(saved.id);
    } catch (e) {
      result.skipped.push({ id: id || '(unnamed)', why: (e as Error).message });
    }
  }
  return result;
}
