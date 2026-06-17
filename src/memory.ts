/**
 * Project memory: facts agents learn while working (decisions, gotchas,
 * conventions, references) persisted across sessions so the next agent does
 * not re-discover them by re-reading the repo.
 *
 * Anti-hallucination core: every fact is ANCHORED to evidence — the commit it
 * was learned at plus content hashes of the files it describes. On every read
 * the anchors are re-checked: if an anchored file changed, the fact is served
 * as `stale` with the reason, never as fresh truth. Facts never silently rot.
 *
 * Storage is one markdown file per fact under <main repo>/.baton/memory/facts
 * (gray-matter frontmatter), written atomically (tmp + rename) so 5 parallel
 * sessions can write without clobbering. Memory is ALWAYS stored in the main
 * repository, never per-worktree — that is the whole point.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import matter from 'gray-matter';
import { git } from './util/exec.js';

export type MemoryType = 'decision' | 'gotcha' | 'convention' | 'reference' | 'preference';
export const MEMORY_TYPES: MemoryType[] = ['decision', 'gotcha', 'convention', 'reference', 'preference'];

export interface FileAnchor {
  path: string; // repo-relative
  hash: string; // sha1 of content at save time ('' = file was absent)
}

export interface MemoryFact {
  id: string;
  type: MemoryType;
  fact: string;
  agent: string | null;
  task: string | null;
  createdAt: string;
  anchors: { commit: string | null; files: FileAnchor[] };
  supersedes: string | null;
  fingerprint: string;
}

export type Freshness = 'fresh' | 'aging' | 'stale';

/** A kb sub-project, path relative to the main root ('.' = the root itself). */
export interface ProjectRel { id: string; rel: string }

export interface MemoryStatus extends MemoryFact {
  freshness: Freshness;
  /** Why the fact is not fresh (file changed / commits behind). */
  staleReason: string | null;
  commitsBehind: number | null;
  /** Which sub-project this fact's files belong to (hub scoping); null = shared/unscoped. */
  project: string | null;
}

/**
 * Map a fact to ONE sub-project by its anchored file paths (pure, unit-tested).
 * Returns null when there are no sub-projects, no files, a file falls outside
 * every project, or the files span more than one project (i.e. shared/hub-level).
 */
export function deriveProject(files: string[], projects: ProjectRel[]): string | null {
  const scoped = projects.filter((p) => p.rel && p.rel !== '.');
  if (!scoped.length || !files.length) return null;
  let found: string | null = null;
  for (const f of files) {
    const owner = scoped.find((p) => f === p.rel || f.startsWith(`${p.rel}/`));
    if (!owner) return null;                       // outside every sub-project → unscoped
    if (found && found !== owner.id) return null;  // spans projects → unscoped
    found = owner.id;
  }
  return found;
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export const FACT_MAX_CHARS = 1200;
export const FACT_CAP = 500;

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** Near-duplicate detection: slug of the first significant words. */
export function fingerprintOf(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join('-') || 'fact';
}

export function slugifyId(fact: string): string {
  const base = fact.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'fact';
  return `mem-${base}`;
}

const sigWords = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));

/**
 * Jaccard similarity of two facts' significant-word sets (0..1). The
 * fingerprint (first 6 words) is only a cheap candidate filter for supersede;
 * this confirms the bodies are actually the same knowledge before we DELETE the
 * old fact — otherwise two distinct facts that merely open with the same words
 * would silently clobber each other.
 */
export function factSimilarity(a: string, b: string): number {
  const A = sigWords(a), B = sigWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Min body-similarity before a same-fingerprint save is treated as an update. */
export const SUPERSEDE_MIN_SIMILARITY = 0.5;

/**
 * Refuse to store anything that looks like a credential. Memories are plain
 * files read by every agent — a pasted key would replicate into every session.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, what: 'API secret key (sk-…)' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: 'Slack token' },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: 'JWT' },
  { re: /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['"][^'"]{8,}['"]/i, what: 'inline credential assignment' },
];

export function detectSecret(text: string): string | null {
  for (const { re, what } of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

/** Word-boundary relevance scoring against a topic (same approach as routing.ts). */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scoreMemory(fact: MemoryFact, topic: string): number {
  const words = [...new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
  if (!words.length) return 0;
  const hay = `${fact.fact} ${fact.type} ${fact.task ?? ''} ${fact.anchors.files.map((f) => f.path).join(' ')}`;
  let score = 0;
  for (const w of words) if (new RegExp(`\\b${escapeRegExp(w)}`, 'i').test(hay)) score += 1;
  return score;
}

export function renderFactFile(f: MemoryFact): string {
  return matter.stringify(`\n${f.fact.trim()}\n`, {
    id: f.id,
    type: f.type,
    agent: f.agent,
    task: f.task,
    created: f.createdAt,
    commit: f.anchors.commit,
    files: f.anchors.files.map((a) => `${a.path}@${a.hash}`),
    supersedes: f.supersedes,
    fingerprint: f.fingerprint,
  });
}

export function parseFactFile(raw: string): MemoryFact | null {
  try {
    const { data, content } = matter(raw);
    if (typeof data.id !== 'string' || !content.trim()) return null;
    const files: FileAnchor[] = Array.isArray(data.files)
      ? (data.files as unknown[]).flatMap((s) => {
          if (typeof s !== 'string') return [];
          const at = s.lastIndexOf('@');
          return at > 0 ? [{ path: s.slice(0, at), hash: s.slice(at + 1) }] : [];
        })
      : [];
    return {
      id: data.id,
      type: MEMORY_TYPES.includes(data.type as MemoryType) ? (data.type as MemoryType) : 'reference',
      fact: content.trim(),
      agent: typeof data.agent === 'string' ? data.agent : null,
      task: typeof data.task === 'string' ? data.task : null,
      createdAt: typeof data.created === 'string' ? data.created : new Date(0).toISOString(),
      anchors: { commit: typeof data.commit === 'string' ? data.commit : null, files },
      supersedes: typeof data.supersedes === 'string' ? data.supersedes : null,
      fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : fingerprintOf(content),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Root + store resolution                                             */
/* ------------------------------------------------------------------ */

/**
 * The MAIN repository root, even when called from inside a task worktree
 * (`gitRoot()` would return the worktree). Memory must be shared, so all
 * paths resolve through the git common dir.
 */
export async function mainRepoRoot(cwd?: string): Promise<string> {
  const common = await git(['rev-parse', '--git-common-dir'], cwd);
  const abs = isAbsolute(common) ? common : resolve(cwd ?? process.cwd(), common);
  return dirname(abs);
}

/**
 * Every public function below resolves the main root ITSELF (cached), so a
 * caller holding a worktree path — `baton pass` run from inside a worktree
 * via the Claude Stop hook, a daemon started in the wrong directory — can
 * never read or write a per-worktree shadow store.
 */
const rootCache = new Map<string, string>();
async function resolveRoot(root: string): Promise<string> {
  const hit = rootCache.get(root);
  if (hit) return hit;
  const main = await mainRepoRoot(root);
  rootCache.set(root, main);
  return main;
}

export function memoryDir(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'facts');
}

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex').slice(0, 12);

/** Content hash of an anchored file, cached by mtime (re-hash only on change). */
const hashCache = new Map<string, { mtimeMs: number; hash: string }>();
async function fileHash(mainRoot: string, relPath: string): Promise<string> {
  const abs = join(mainRoot, relPath);
  try {
    const st = await stat(abs);
    const hit = hashCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.hash;
    const hash = sha1(await readFile(abs));
    if (hashCache.size > 4096) hashCache.clear();
    hashCache.set(abs, { mtimeMs: st.mtimeMs, hash });
    return hash;
  } catch {
    hashCache.delete(abs);
    return ''; // absent
  }
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export interface SaveMemoryInput {
  fact: string;
  type?: string;
  files?: string[]; // repo-relative paths the fact is about (evidence anchors)
  agent?: string;
  task?: string;
}

export async function saveMemory(root: string, input: SaveMemoryInput): Promise<MemoryStatus> {
  const mainRoot = await resolveRoot(root);
  const fact = (input.fact ?? '').trim();
  if (fact.length < 10) throw new MemoryValidationError('fact too short — write 1–3 full sentences (why + how to apply)');
  if (fact.length > FACT_MAX_CHARS) throw new MemoryValidationError(`fact too long (${fact.length} > ${FACT_MAX_CHARS} chars) — store the insight, not the artifact`);
  const secret = detectSecret(fact);
  if (secret) throw new MemoryValidationError(`refusing to store what looks like a ${secret} — describe where the credential lives instead of pasting it`);
  const type: MemoryType = MEMORY_TYPES.includes(input.type as MemoryType) ? (input.type as MemoryType) : 'reference';

  const dir = memoryDir(mainRoot);
  await mkdir(dir, { recursive: true });
  const existing = await listMemoryFacts(mainRoot);
  if (existing.length >= FACT_CAP) {
    throw new MemoryValidationError(`memory is at its cap (${FACT_CAP} facts) — run \`baton memory gc\` to clear stale/superseded facts`);
  }

  // Evidence anchors: HEAD now + content hash of each referenced file.
  let commit: string | null = null;
  try {
    commit = await git(['rev-parse', 'HEAD'], mainRoot);
  } catch { /* empty repo — commit anchor unavailable */ }
  const relFiles = (input.files ?? [])
    .map((f) => f.trim().replace(/^\.\//, ''))
    .filter((f) => f && !isAbsolute(f) && !f.includes('..'))
    .slice(0, 8);
  const files: FileAnchor[] = [];
  for (const path of relFiles) files.push({ path, hash: await fileHash(mainRoot, path) });

  // Same fingerprint → CANDIDATE for supersede (updated knowledge). But the
  // fingerprint is only the first 6 words; confirm the bodies are actually the
  // same knowledge before replacing, so two distinct facts that merely share an
  // opening can't silently delete each other.
  const fingerprint = fingerprintOf(fact);
  const dup = existing.find(
    (f) => f.fingerprint === fingerprint && factSimilarity(f.fact, fact) >= SUPERSEDE_MIN_SIMILARITY,
  );
  let id = slugifyId(fact);
  if (existing.some((f) => f.id === id)) {
    id = `${id}-${sha1(fact).slice(0, 4)}`;
  }

  const record: MemoryFact = {
    id,
    type,
    fact,
    agent: input.agent?.trim() || null,
    task: input.task?.trim() || null,
    createdAt: new Date().toISOString(),
    anchors: { commit, files },
    supersedes: dup?.id ?? null,
    fingerprint,
  };

  // Atomic write; remove the superseded fact after the new one lands.
  const target = join(dir, `${id}.md`);
  const tmp = join(dir, `.${id}.${process.pid}.tmp`);
  await writeFile(tmp, renderFactFile(record), 'utf-8');
  await rename(tmp, target);
  if (dup && dup.id !== id) await rm(join(dir, `${dup.id}.md`), { force: true });

  return { ...record, freshness: 'fresh', staleReason: null, commitsBehind: 0, project: null };
}

/** Parsed facts cached by file mtime — repeated polls re-parse only changes. */
const factCache = new Map<string, { mtimeMs: number; fact: MemoryFact | null }>();

async function listMemoryFacts(mainRoot: string): Promise<MemoryFact[]> {
  const dir = memoryDir(mainRoot);
  if (!existsSync(dir)) return [];
  const out: MemoryFact[] = [];
  const seen = new Set<string>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    seen.add(file);
    try {
      const st = await stat(file);
      const hit = factCache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        if (hit.fact) out.push(hit.fact);
        continue;
      }
      const parsed = parseFactFile(await readFile(file, 'utf-8'));
      factCache.set(file, { mtimeMs: st.mtimeMs, fact: parsed });
      if (parsed) out.push(parsed);
    } catch {
      factCache.delete(file); // raced with a delete — skip
    }
  }
  // Drop cache entries for deleted files so memory stays bounded.
  for (const key of factCache.keys()) {
    if (key.startsWith(dir) && !seen.has(key)) factCache.delete(key);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** rev-list counts cached per (anchor, HEAD) — stable until a new commit lands. */
const behindCache = new Map<string, number | null>();

/** Re-check every fact's evidence anchors and report freshness.
 *  `projects` (kb sub-projects, paths relative to the main root) enable per-server
 *  scoping in a hub; omit for a plain single-repo (every fact is unscoped). */
export async function listMemories(root: string, opts: { projects?: ProjectRel[] } = {}): Promise<MemoryStatus[]> {
  const mainRoot = await resolveRoot(root);
  const facts = await listMemoryFacts(mainRoot);
  const projects = opts.projects ?? [];
  let head: string | null = null;
  try {
    head = await git(['rev-parse', 'HEAD'], mainRoot);
  } catch { /* empty repo — commit distance unavailable */ }

  const statuses: MemoryStatus[] = [];
  for (const f of facts) {
    let staleReason: string | null = null;
    for (const a of f.anchors.files) {
      const now = await fileHash(mainRoot, a.path);
      if (now !== a.hash) {
        staleReason = now === '' ? `${a.path} no longer exists` : `${a.path} changed since this was saved`;
        break;
      }
    }
    let commitsBehind: number | null = null;
    if (f.anchors.commit && head) {
      const key = `${f.anchors.commit}..${head}`;
      if (!behindCache.has(key)) {
        if (behindCache.size > 2048) behindCache.clear();
        try {
          behindCache.set(key, Number(await git(['rev-list', '--count', key], mainRoot)));
        } catch {
          behindCache.set(key, null); // unknown anchor (gc'd / rewritten history)
        }
      }
      commitsBehind = behindCache.get(key) ?? null;
    }
    const freshness: Freshness = staleReason ? 'stale' : commitsBehind && commitsBehind > 0 ? 'aging' : 'fresh';
    statuses.push({ ...f, freshness, staleReason, commitsBehind, project: deriveProject(f.anchors.files.map((a) => a.path), projects) });
  }
  return statuses;
}

export interface RecallResult {
  facts: MemoryStatus[];
  total: number;
  staleDropped: number;
}

/**
 * What an agent should read: fresh + aging facts, relevance-ranked when a
 * topic is given. Stale facts are EXCLUDED from the bodies (counted, named in
 * the caller's summary) — a stale "fact" presented as truth is how models
 * hallucinate.
 */
export async function recallMemories(root: string, opts: { topic?: string; limit?: number } = {}): Promise<RecallResult> {
  const all = await listMemories(root);
  const usable = all.filter((f) => f.freshness !== 'stale');
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  let picked = usable;
  if (opts.topic?.trim()) {
    picked = usable
      .map((f) => ({ f, s: scoreMemory(f, opts.topic!) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.f.createdAt.localeCompare(a.f.createdAt))
      .map((x) => x.f);
  }
  return { facts: picked.slice(0, limit), total: all.length, staleDropped: all.length - usable.length };
}

export async function removeMemory(root: string, id: string): Promise<boolean> {
  const mainRoot = await resolveRoot(root);
  const file = join(memoryDir(mainRoot), `${id.replace(/[^a-z0-9-]/gi, '')}.md`);
  if (!existsSync(file)) return false;
  await rm(file, { force: true });
  factCache.delete(file);
  return true;
}

/** Drop stale facts (changed/removed anchors). Returns removed ids. */
export async function gcMemories(root: string): Promise<string[]> {
  const all = await listMemories(root);
  const removed: string[] = [];
  for (const f of all) {
    if (f.freshness === 'stale') {
      if (await removeMemory(root, f.id)) removed.push(f.id);
    }
  }
  return removed;
}

/** Delete many facts by id at once. Returns the ids actually removed. */
export async function bulkRemoveMemory(root: string, ids: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const id of [...new Set(ids)]) {
    if (await removeMemory(root, id)) removed.push(id);
  }
  return removed;
}

export interface RetentionPolicy {
  /** Drop facts older than this many days (by createdAt). 0/undefined = off. */
  maxAgeDays?: number;
  /** Drop facts whose anchored files changed (same as gc). */
  dropStale?: boolean;
  /** Drop "aging" facts (repo moved on but files unchanged). */
  dropAging?: boolean;
}

/** Pure: which fact ids a policy would remove from `facts`, given `now` (ms). */
export function factsToPrune(facts: MemoryStatus[], policy: RetentionPolicy, now: number): string[] {
  const cutoff = policy.maxAgeDays && policy.maxAgeDays > 0 ? now - policy.maxAgeDays * 86_400_000 : null;
  const out: string[] = [];
  for (const f of facts) {
    const tooOld = cutoff !== null && Date.parse(f.createdAt) < cutoff;
    if (tooOld || (policy.dropStale && f.freshness === 'stale') || (policy.dropAging && f.freshness === 'aging')) {
      out.push(f.id);
    }
  }
  return out;
}

/** Apply a retention policy now. Returns removed ids. */
export async function pruneMemories(root: string, policy: RetentionPolicy, now = Date.now()): Promise<string[]> {
  const ids = factsToPrune(await listMemories(root), policy, now);
  return bulkRemoveMemory(root, ids);
}

/* ---- persisted retention policy (.baton/memory/retention.json) ---- */

function retentionFile(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'retention.json');
}

export async function loadRetention(root: string): Promise<RetentionPolicy> {
  const mainRoot = await resolveRoot(root);
  const file = retentionFile(mainRoot);
  if (!existsSync(file)) return {};
  try {
    const p = JSON.parse(await readFile(file, 'utf-8')) as RetentionPolicy;
    return {
      maxAgeDays: typeof p.maxAgeDays === 'number' && p.maxAgeDays > 0 ? Math.floor(p.maxAgeDays) : undefined,
      dropStale: p.dropStale === true,
      dropAging: p.dropAging === true,
    };
  } catch {
    return {};
  }
}

export async function saveRetention(root: string, policy: RetentionPolicy): Promise<RetentionPolicy> {
  const mainRoot = await resolveRoot(root);
  const clean: RetentionPolicy = {
    maxAgeDays: typeof policy.maxAgeDays === 'number' && policy.maxAgeDays > 0 ? Math.floor(policy.maxAgeDays) : undefined,
    dropStale: policy.dropStale === true,
    dropAging: policy.dropAging === true,
  };
  const file = retentionFile(mainRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  return clean;
}

/** True when a policy would actually remove something (used to gate auto-apply). */
export function retentionActive(p: RetentionPolicy): boolean {
  return !!(p.maxAgeDays || p.dropStale || p.dropAging);
}

/** Compact index block for handoff briefs (~token-cheap, fresh facts only). */
export function memoryBriefSection(facts: MemoryStatus[], staleDropped: number): string {
  if (!facts.length) return '';
  const lines = facts.slice(0, 6).map((f) => {
    const age = f.commitsBehind ? ` (${f.commitsBehind} commits old)` : '';
    return `- [${f.type}] ${f.fact.split('\n')[0]}${age}`;
  });
  const note = staleDropped > 0 ? `\n\n_${staleDropped} stale memor${staleDropped === 1 ? 'y was' : 'ies were'} withheld (their anchored files changed) — use \`recall_memory\` to inspect._` : '';
  return `## Project memory (evidence-checked)\n\n${lines.join('\n')}${note}`;
}
