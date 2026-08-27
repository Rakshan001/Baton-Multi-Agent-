// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import matter from 'gray-matter'; // writer only (matter.stringify) — reads go through parseFrontmatter
import { parseFrontmatter } from './util/frontmatter.js';
import { git, gitTry } from './util/exec.js';
import { readAuthor, resolveAuthor, UNKNOWN_AUTHOR } from './identity.js';
import { escapeRegExp } from './util/regex.js';
import { rankFacts } from './memory-rank.js';
import { classifyDurability } from './memory-durability.js';

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
  /** WHO claimed this, as opposed to `agent` (WHAT wrote it down). Two people on
   *  a shared KB both run "claude", so agent alone cannot attribute a fact — and
   *  an unattributable fact is one nobody can challenge. Always present:
   *  pre-author facts read as `unknown` rather than being migrated. */
  author: string;
  task: string | null;
  createdAt: string;
  anchors: { commit: string | null; files: FileAnchor[] };
  supersedes: string | null;
  fingerprint: string;
  /**
   * Which area this was read from. DERIVED at read time, never written into the
   * file — a fact that is moved between areas must not carry a stale claim
   * about where it lives, and the directory it sits in is the only honest
   * answer. Absent on a fact that was parsed rather than listed.
   */
  area?: MemoryArea;
  /**
   * "Never put this in git", as stated by whoever saved it. PERSISTED, unlike
   * `area` — and the distinction is the point. `area` is where the fact is now;
   * this is what its author asked for, and a migration that ignored it would
   * publish the one fact someone explicitly said not to publish. Intent has to
   * outlive the location, so it lives in the file.
   */
  localOnly?: boolean;
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

/**
 * The anti-capture gate specifically (memory-durability.ts). A subclass, not a
 * flag, so every existing `instanceof MemoryValidationError` catch keeps
 * working — while the one caller that echoes the rejected text back
 * (session-brief.ts) can tell "restate this durably" apart from "this had a
 * credential in it", which must never be quoted back.
 */
export class UndurableFactError extends MemoryValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'UndurableFactError';
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

/** Min body-similarity to HINT a possible duplicate (M8). Below auto-supersede
 *  confidence on purpose: the saving agent judges, Baton never guesses. */
export const DUPLICATE_HINT_MIN = 0.4;

/**
 * Refuse to store anything that looks like a credential. Memories are plain
 * files read by every agent — a pasted key would replicate into every session.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, what: 'API secret key (sk-…)' },
  { re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/, what: 'Stripe secret key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{28,}\b/, what: 'GitHub token' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/, what: 'npm token' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/, what: 'Google API key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: 'Slack token' },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: 'JWT' },
  { re: /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/i, what: 'bearer token' },
  // scheme://user:password@host — the shape that leaks a database password.
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@/i, what: 'connection string with a password' },
  /*
   * The old rule required the value to be QUOTED, which meant it caught a
   * credential pasted from source and missed one pasted from a .env file or a
   * shell line — the far likelier way a key reaches a memory:
   *     AWS_SECRET_ACCESS_KEY=EXAMPLE/NOTAREAL/SECRETVALUE
   * Quotes are now optional, but the VALUE must look like a credential rather
   * than like prose or code: 12+ chars of key alphabet only. That is what keeps
   * `apiKey: z.string().describe(...)` and `token: string` from tripping it —
   * dots, parens and spaces are not in the class. A fact refused wrongly is a
   * fact lost, so the value shape carries the weight, not the label alone.
   */
  {
    // The keyword must be allowed to end an IDENTIFIER, not just stand alone:
    // `_` is a word character, so `\bpassword\b` never matches inside
    // DATABASE_PASSWORD or AWS_SECRET_ACCESS_KEY — which is exactly how these
    // arrive. Hence the optional identifier prefix instead of a leading \b.
    re: /(?:^|[\s"'`,;({[])[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}/i,
    what: 'inline credential assignment',
  },
  /*
   * Deliberately NOT here: a generic high-entropy rule (e.g. 64 hex chars).
   * Commit shas, sha256 file hashes and content digests are all legitimate
   * things for a memory to discuss — Baton anchors facts to file hashes itself.
   * A wrongly refused fact is knowledge lost, and this gate has no override, so
   * every pattern above names a specific credential shape rather than guessing
   * from entropy.
   */
];

/**
 * Credentials resolved at runtime — a gateway key from `endpoints.keyRef`.
 * Pattern matching cannot recognise an arbitrary key someone's gateway issued,
 * so the launcher registers the VALUE it is about to put in a child's
 * environment (P16-E5). Registered, never logged.
 */
const runtimeSecrets = new Set<string>();

/** Short values are ignored: redacting a 3-character "key" would black out
 *  ordinary prose everywhere it happened to appear. */
export function registerRuntimeSecret(value: string): void {
  const v = value.trim();
  if (v.length >= 8) runtimeSecrets.add(v);
}

export function detectSecret(text: string): string | null {
  for (const secret of runtimeSecrets) if (text.includes(secret)) return 'endpoint credential';
  for (const { re, what } of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

/**
 * Caller-supplied anchor paths, reduced to safe repo-relative form (max 8).
 * Anything absolute, escaping, or not a string is DROPPED rather than repaired
 * — a path we had to rewrite is not evidence the caller vouched for.
 *
 * The parameter is `unknown` even though `SaveMemoryInput.files` is declared
 * `string[]`, because that declaration is a runtime lie on one path: server.ts
 * hands `saveMemory` an unvalidated JSON body, so `files` arrives with whatever
 * shape the request had (`{"files":[5]}` used to reach `fileHash` and 500).
 */
export function normalizeAnchorPaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim().replace(/^\.\//, ''))
    .filter((f) => f && !isAbsolute(f) && !f.includes('..'))
    .slice(0, 8);
}

/** Word-boundary relevance scoring against a topic (same approach as routing.ts). */
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
    // `|| UNKNOWN_AUTHOR` is not belt-and-braces: js-yaml THROWS on an
    // undefined value (it dumps null happily), so one missing label would
    // abort the write and lose the whole fact. Losing the fact is strictly
    // worse than losing the attribution.
    author: f.author || UNKNOWN_AUTHOR,
    task: f.task,
    created: f.createdAt,
    commit: f.anchors.commit,
    files: f.anchors.files.map((a) => `${a.path}@${a.hash}`),
    supersedes: f.supersedes,
    fingerprint: f.fingerprint,
    // Only when set: `local_only: false` on every other fact would be noise in
    // every diff, and js-yaml throws outright on an undefined value.
    ...(f.localOnly ? { local_only: true } : {}),
  });
}

/** Monotonic within the process — `process.pid` alone does NOT make a temp file
 *  unique, because repair runs concurrently from three places inside the SAME
 *  daemon process (the periodic sweep, the recall-time pass, and
 *  POST /api/memory/repair). Two passes on one fact then wrote the same temp
 *  path, and the loser's rename hit ENOENT once the winner moved it away. */
let tmpSeq = 0;

/** Write a fact file atomically: render to a temp name unique to THIS write,
 *  then rename over the target. Concurrent writers may race to be last, but a
 *  reader never sees a partial file and no writer ever fails. */
async function writeFactFile(dir: string, id: string, body: string): Promise<void> {
  const tmp = join(dir, `.${id}.${process.pid}.${tmpSeq++}.tmp`);
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, join(dir, `${id}.md`));
}

export function parseFactFile(raw: string): MemoryFact | null {
  try {
    const { data, content } = parseFrontmatter(raw);
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
      author: readAuthor(data.author),
      task: typeof data.task === 'string' ? data.task : null,
      createdAt: typeof data.created === 'string' ? data.created : new Date(0).toISOString(),
      anchors: { commit: typeof data.commit === 'string' ? data.commit : null, files },
      supersedes: typeof data.supersedes === 'string' ? data.supersedes : null,
      fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : fingerprintOf(content),
      ...(data.local_only === true ? { localOnly: true } : {}),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Root + store resolution                                             */
/* ------------------------------------------------------------------ */

/**
 * Memory was asked for somewhere that is not a git repository.
 *
 * Typed, because callers need to tell it apart from a real failure: a read
 * treats it as "there is nothing here" and returns empty, a write refuses and
 * says so. The message names the directory and nothing else — the raw git
 * error reprints the whole hardened argv, which tells an agent (or a user)
 * nothing they can act on.
 */
export class NotAGitRepoError extends Error {
  constructor(public readonly dir: string) {
    super(`${dir} is not a git repository — Baton stores memory per repo, so run this inside one`);
    this.name = 'NotAGitRepoError';
  }
}

/**
 * The MAIN repository root, even when called from inside a task worktree
 * (`gitRoot()` would return the worktree). Memory must be shared, so all
 * paths resolve through the git common dir.
 *
 * `gitTry`, not `git`: every other `--git-common-dir` call in the codebase
 * already uses the non-throwing form, and the raw exit-128 dump used to escape
 * through every public function below — an agent calling `save_memory` over
 * MCP outside a repo got the hardened argv back instead of a sentence.
 */
export async function mainRepoRoot(cwd?: string): Promise<string> {
  const dir = cwd ?? process.cwd();
  const r = await gitTry(['rev-parse', '--git-common-dir'], cwd);
  if (!r.ok) throw new NotAGitRepoError(dir);
  const abs = isAbsolute(r.stdout) ? r.stdout : resolve(dir, r.stdout);
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

/**
 * The same resolution for READ paths, which answer "nothing" instead of
 * throwing. Outside a repo there is genuinely no memory to return, and a
 * dashboard panel or an MCP recall should render empty rather than surface an
 * exception. Writes keep using resolveRoot: refusing to save has to be loud,
 * because the alternative is an agent believing it stored something.
 */
async function resolveRootForRead(root: string): Promise<string | null> {
  try {
    return await resolveRoot(root);
  } catch (e) {
    if (e instanceof NotAGitRepoError) return null;
    throw e;
  }
}

/**
 * Where a fact lives, and the whole of §12's memory migration.
 *
 * - `tracked` → `baton/memory/facts`, in git. The default, and the point of the
 *   exercise: a fact one agent learns should reach the next clone, not die with
 *   one laptop.
 * - `local` → `.baton/memory/facts`, gitignored. Where memory has always lived,
 *   and where anything that must not be pushed stays.
 *
 * Both are READ, always and from day one. Nothing is invisible while a repo is
 * part-migrated, and a fact never has to be found before it can be recalled.
 * Only the write target moved.
 *
 * §7.1 is why the local area survives the migration rather than being retired:
 * tracking turns a stored credential from a file on one disk into a push, and a
 * leak discovered after a push is a key rotation, not a file deletion. The
 * secret scan in `saveMemory` refuses key-shaped facts outright; `--local-only`
 * is the pressure valve, so a FALSE positive costs a flag rather than the fact.
 */
export type MemoryArea = 'tracked' | 'local';

export function trackedMemoryDir(mainRoot: string): string {
  return join(mainRoot, 'baton', 'memory', 'facts');
}

export function localMemoryDir(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'facts');
}

/** Both areas, in READ precedence order: tracked shadows local on a clashing id. */
export function memoryAreas(mainRoot: string): Array<{ area: MemoryArea; dir: string }> {
  return [
    { area: 'tracked', dir: trackedMemoryDir(mainRoot) },
    { area: 'local', dir: localMemoryDir(mainRoot) },
  ];
}

export function memoryDirFor(mainRoot: string, area: MemoryArea): string {
  return area === 'tracked' ? trackedMemoryDir(mainRoot) : localMemoryDir(mainRoot);
}

/**
 * Superseded/removed facts move HERE instead of being destroyed, so a fact's
 * lineage survives for a future repair queue. It is a SIBLING of facts/, so
 * `listMemoryFacts` (a non-recursive readdir over facts/) never sees it — recall
 * is unchanged at zero cost. Both live under gitignored `.baton/memory/`: an
 * on-disk audit substrate, not a committed-across-clones history.
 */
export function archiveDir(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'archive');
}

function journalFile(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'journal.jsonl');
}

/** One append-only line per lifecycle op — the KB's change history. */
export interface JournalEntry {
  op: 'supersede' | 'remove' | 'reanchor';
  id: string;
  supersededBy: string | null;
  reason: string;
  at: string;
}

async function appendJournal(mainRoot: string, entry: JournalEntry): Promise<void> {
  const file = journalFile(mainRoot);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Retire a fact: move its file into the archive and append a journal line.
 * Replaces every hard-delete in the module. Returns false if the file was
 * already gone (idempotent). The move overwrites any same-id archive file so a
 * reused slug re-archives cleanly.
 */
async function archiveFact(
  mainRoot: string,
  id: string,
  op: JournalEntry['op'],
  reason: string,
  supersededBy: string | null = null,
): Promise<boolean> {
  const safeId = id.replace(/[^a-z0-9-]/gi, '');
  // Whichever area holds it. Retiring a TRACKED fact deletes it from the
  // working tree, which is what removal has to mean once memory is in git —
  // leaving the file behind would keep serving it to every other clone.
  const from = areaOf(mainRoot, safeId);
  if (!from) return false;
  const src = join(memoryDirFor(mainRoot, from), `${safeId}.md`);
  // The archive stays under gitignored `.baton/` for both areas. It is an
  // on-disk audit substrate, not history to replicate across clones — and a
  // retired fact that travelled in git would be a fact removal did not remove.
  const dir = archiveDir(mainRoot);
  await mkdir(dir, { recursive: true });
  await rename(src, join(dir, `${safeId}.md`));
  factCache.delete(src);
  await appendJournal(mainRoot, { op, id: safeId, supersededBy, reason, at: new Date().toISOString() });
  return true;
}

/** The KB change log, newest first. Drives `baton memory log` (no agent-token cost). */
export async function readJournal(root: string): Promise<JournalEntry[]> {
  const mainRoot = await resolveRootForRead(root);
  if (mainRoot === null) return [];
  const file = journalFile(mainRoot);
  if (!existsSync(file)) return [];
  const out: JournalEntry[] = [];
  for (const line of (await readFile(file, 'utf-8')).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as JournalEntry); } catch { /* skip a torn line */ }
  }
  return out.reverse();
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
    // FIFO single-entry eviction (Map keeps insertion order) — a blanket clear()
    // would force the next /api/memory poll to cold re-hash every anchored file.
    if (hashCache.size >= 4096) hashCache.delete(hashCache.keys().next().value!);
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
  /**
   * Keep this fact out of git — store it in the gitignored area instead.
   *
   * The escape hatch §7.1 asks for. The secret scan refuses key-shaped facts
   * outright and has no override, which is right when the cost of being wrong
   * is a pushed credential; this is the other side of that trade, for the fact
   * that is genuinely private rather than genuinely a secret — a note about one
   * machine's setup, a hunch not worth publishing to the team.
   */
  localOnly?: boolean;
}

export type SaveMemoryResult = MemoryStatus & {
  /** Existing facts that look like the same knowledge phrased differently —
   *  write-time reconciliation hints (the Mem0 ADD/UPDATE pattern, agent as
   *  judge). The auto-superseded fact is never repeated here. */
  similarExisting?: Array<{ id: string; preview: string }>;
};

export async function saveMemory(root: string, input: SaveMemoryInput): Promise<SaveMemoryResult> {
  const mainRoot = await resolveRoot(root);
  const fact = (input.fact ?? '').trim();
  if (fact.length < 10) throw new MemoryValidationError('fact too short — write 1–3 full sentences (why + how to apply)');
  if (fact.length > FACT_MAX_CHARS) throw new MemoryValidationError(`fact too long (${fact.length} > ${FACT_MAX_CHARS} chars) — store the insight, not the artifact`);
  const secret = detectSecret(fact);
  if (secret) throw new MemoryValidationError(`refusing to store what looks like a ${secret} — describe where the credential lives instead of pasting it`);

  // Evidence anchors are resolved BEFORE the durability gate, because evidence
  // is what waives two of its four classes: a claim tied to files in THIS repo
  // is a claim the staleness sweep can police from here on.
  const relFiles = normalizeAnchorPaths(input.files);
  const files: FileAnchor[] = [];
  for (const path of relFiles) files.push({ path, hash: await fileHash(mainRoot, path) });
  // Truth is re-checked on every read (anchors); this is the question that
  // comes first — should this ever have been saved? See memory-durability.ts.
  //
  // The waiver requires an anchor that RESOLVED. An absent file hashes to ''
  // and stays '' forever, so it never trips the staleness check (empty equals
  // empty) — accepting it as evidence would hand out a waiver that also opts
  // the fact out of the verification the waiver is justified by.
  const undurable = classifyDurability(fact, { anchored: files.some((f) => f.hash !== '') });
  if (undurable) {
    throw new UndurableFactError(
      `not durable knowledge (${undurable.kind}: "${undurable.matched}") — ${undurable.instead}`,
    );
  }
  const type: MemoryType = MEMORY_TYPES.includes(input.type as MemoryType) ? (input.type as MemoryType) : 'reference';

  // Tracked by default (§12) — a fact one agent learns should reach the next
  // clone rather than dying with one laptop.
  const area: MemoryArea = input.localOnly ? 'local' : 'tracked';
  const dir = memoryDirFor(mainRoot, area);
  await mkdir(dir, { recursive: true });
  const existing = await listMemoryFacts(mainRoot);
  if (existing.length >= FACT_CAP) {
    throw new MemoryValidationError(`memory is at its cap (${FACT_CAP} facts) — run \`baton memory gc\` to clear stale/superseded facts`);
  }

  let commit: string | null = null;
  try {
    commit = await git(['rev-parse', 'HEAD'], mainRoot);
  } catch { /* empty repo — commit anchor unavailable */ }
  // No files given → anchor to any real files the fact's own text names.
  // Without this, the fact bypasses staleness verification permanently.
  if (files.length === 0) files.push(...(await deriveFileAnchors(mainRoot, fact)));

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
    author: await resolveAuthor(mainRoot),
    task: input.task?.trim() || null,
    createdAt: new Date().toISOString(),
    anchors: { commit, files },
    supersedes: dup?.id ?? null,
    fingerprint,
    area,
    ...(input.localOnly ? { localOnly: true } : {}),
  };

  // Atomic write; remove the superseded fact after the new one lands.
  const target = join(dir, `${id}.md`);
  await writeFactFile(dir, id, renderFactFile(record));
  // Superseded knowledge is archived (not destroyed) with its successor recorded.
  if (dup && dup.id !== id) {
    await archiveFact(mainRoot, dup.id, 'supersede', 'superseded by newer knowledge', id);
  }

  // M8: same knowledge phrased differently escapes the fingerprint gate (it
  // only sees the first 6 words) — surface high-similarity survivors so the
  // SAVING agent reconciles. Cheaper and safer than auto-merging.
  const similarExisting = existing
    .filter((f) => f.id !== dup?.id)
    .map((f) => ({ f, s: factSimilarity(f.fact, fact) }))
    .filter((x) => x.s >= DUPLICATE_HINT_MIN)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => ({ id: x.f.id, preview: x.f.fact.split('\n')[0].slice(0, 140) }));

  return {
    ...record, freshness: 'fresh', staleReason: null, commitsBehind: 0, project: null,
    ...(similarExisting.length ? { similarExisting } : {}),
  };
}

export interface MigrationEntry {
  id: string;
  /** Why it is staying put, when it is. */
  keptLocal?: string;
}

export interface MigrationReport {
  moved: MigrationEntry[];
  kept: MigrationEntry[];
  /** True when nothing was written (a dry run, or nothing left to move). */
  dryRun: boolean;
}

/**
 * §12: move existing facts out of the gitignored area into the tracked one.
 *
 * Explicit, never automatic. Moving files into git's view changes what a
 * following `git commit -a` publishes, and that is a decision to make on
 * purpose rather than to inherit from an unrelated `memory save`. Reads already
 * merge both areas, so a repo that never runs this loses nothing — the only
 * thing waiting is whether the facts travel.
 *
 * Every fact is re-scanned on the way through, and this is not belt-and-braces:
 * the gate has grown patterns over time and facts predate it, so the store can
 * hold key-shaped text that no live code path would accept today. Locally that
 * was a file on one disk. Tracked it is a push, and a leak found after a push
 * is a key rotation rather than a deletion — so a fact that trips the scan
 * STAYS local. It is neither published nor destroyed, and the report names it.
 */
export async function migrateMemory(
  root: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  const mainRoot = await resolveRoot(root);
  const from = localMemoryDir(mainRoot);
  const to = trackedMemoryDir(mainRoot);
  const report: MigrationReport = { moved: [], kept: [], dryRun: Boolean(opts.dryRun) };
  if (!existsSync(from)) return report;

  for (const name of (await readdir(from)).filter((n) => n.endsWith('.md'))) {
    const src = join(from, name);
    const id = name.slice(0, -3);
    let raw: string;
    try {
      raw = await readFile(src, 'utf-8');
    } catch {
      continue; // raced with a delete — nothing to move
    }
    const parsed = parseFactFile(raw);
    if (!parsed) {
      report.kept.push({ id, keptLocal: 'unreadable — not a fact file' });
      continue;
    }
    // Asked for, not inferred. Migrating this would publish the one fact
    // somebody explicitly said to keep off the remote — and they would find out
    // from `git log`.
    if (parsed.localOnly) {
      report.kept.push({ id, keptLocal: 'saved with --local-only' });
      continue;
    }
    const secret = detectSecret(parsed.fact);
    if (secret) {
      report.kept.push({ id, keptLocal: `looks like a ${secret} — publishing it would be a key rotation, not a deletion` });
      continue;
    }
    // An id already tracked is left alone rather than overwritten: the tracked
    // copy is the one every other clone has, and clobbering it from one machine
    // would be a silent, unreviewable edit to shared knowledge.
    if (existsSync(join(to, name))) {
      report.kept.push({ id, keptLocal: 'a tracked fact already has this id' });
      continue;
    }
    if (!opts.dryRun) {
      await mkdir(to, { recursive: true });
      await rename(src, join(to, name));
      factCache.delete(src);
    }
    report.moved.push({ id });
  }
  return report;
}

/** Parsed facts cached by file mtime — repeated polls re-parse only changes. */
const factCache = new Map<string, { mtimeMs: number; fact: MemoryFact | null }>();

/**
 * Every fact, from BOTH areas.
 *
 * Reading both unconditionally is what makes the migration safe to leave
 * half-done: a repo mid-move recalls exactly what it recalled before, and no
 * fact is hidden because nobody has run a command yet. A tracked fact shadows a
 * local one of the same id — after a move the two can coexist for one moment,
 * and the tracked copy is the one that was moved TO.
 */
async function listMemoryFacts(mainRoot: string): Promise<MemoryFact[]> {
  const out: MemoryFact[] = [];
  const byId = new Set<string>();
  for (const { area, dir } of memoryAreas(mainRoot)) {
    if (!existsSync(dir)) continue;
    const seen = new Set<string>();
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      seen.add(file);
      try {
        const st = await stat(file);
        const hit = factCache.get(file);
        let fact = hit && hit.mtimeMs === st.mtimeMs ? hit.fact : undefined;
        if (fact === undefined) {
          fact = parseFactFile(await readFile(file, 'utf-8'));
          factCache.set(file, { mtimeMs: st.mtimeMs, fact });
        }
        if (fact && !byId.has(fact.id)) {
          byId.add(fact.id);
          out.push({ ...fact, area });
        }
      } catch {
        factCache.delete(file); // raced with a delete — skip
      }
    }
    // Drop cache entries for deleted files so memory stays bounded.
    for (const key of factCache.keys()) {
      if (key.startsWith(dir) && !seen.has(key)) factCache.delete(key);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Which area holds `id` right now, or null if nothing does. */
function areaOf(mainRoot: string, id: string): MemoryArea | null {
  for (const { area, dir } of memoryAreas(mainRoot)) {
    if (existsSync(join(dir, `${id}.md`))) return area;
  }
  return null;
}

/**
 * Commit distance past which an UNANCHORED fact stops being served as truth.
 * Generous on purpose: a genuinely file-independent convention should survive
 * normal churn, but "50 commits and nothing ever verified it" is the point
 * where confidently serving it becomes the hallucination vector.
 */
const UNANCHORED_STALE_BEHIND = 50;

/** rev-list counts cached per (anchor, HEAD) — stable until a new commit lands. */
const behindCache = new Map<string, number | null>();

/** Re-check every fact's evidence anchors and report freshness.
 *  `projects` (kb sub-projects, paths relative to the main root) enable per-server
 *  scoping in a hub; omit for a plain single-repo (every fact is unscoped). */
export async function listMemories(root: string, opts: { projects?: ProjectRel[] } = {}): Promise<MemoryStatus[]> {
  const mainRoot = await resolveRootForRead(root);
  if (mainRoot === null) return [];
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
      // Scoped to the anchored paths: in a multi-agent hub, unrelated commits
      // land constantly, and a global count would flip every fact to "aging"
      // within hours — "N commits touched what this fact is about" is the
      // signal that means something. Anchorless facts keep the global count
      // (there is nothing to scope to; distance is their only aging signal).
      const paths = f.anchors.files.map((a) => a.path);
      const range = `${f.anchors.commit}..${head}`;
      const key = paths.length ? `${range} -- ${paths.join(',')}` : range;
      if (!behindCache.has(key)) {
        // FIFO single-entry eviction — clear() here would re-spawn up to FACT_CAP
        // `git rev-list` subprocesses on the next poll (a re-scan stampede).
        if (behindCache.size >= 2048) behindCache.delete(behindCache.keys().next().value!);
        try {
          const argv = ['rev-list', '--count', range, ...(paths.length ? ['--', ...paths] : [])];
          behindCache.set(key, Number(await git(argv, mainRoot)));
        } catch {
          behindCache.set(key, null); // unknown anchor (gc'd / rewritten history)
        }
      }
      commitsBehind = behindCache.get(key) ?? null;
    }
    // A fact with no file anchors has nothing to re-hash — the stale check
    // above is blind to it, so without this it would be served as fresh
    // forever, however wrong the repo has made it. Age it out on commit
    // distance instead: far enough behind, it is withheld like any other
    // stale fact (and surfaced as a re-grounding pointer, not silently gone).
    if (!staleReason && f.anchors.files.length === 0 && commitsBehind !== null && commitsBehind > UNANCHORED_STALE_BEHIND) {
      staleReason = `saved with no file anchors ${commitsBehind} commits ago — nothing verifies it still holds; re-check and re-save with files`;
    }
    const freshness: Freshness = staleReason ? 'stale' : commitsBehind && commitsBehind > 0 ? 'aging' : 'fresh';
    statuses.push({ ...f, freshness, staleReason, commitsBehind, project: deriveProject(f.anchors.files.map((a) => a.path), projects) });
  }
  return statuses;
}

export interface RecallResult {
  facts: MemoryStatus[];
  /** Facts keyword scoring missed but whose file anchors overlap the recalled
   *  facts' anchors — the memory graph's edges, derived free from existing
   *  anchor data (no graph construction cost). Capped small; topic mode only. */
  related?: MemoryStatus[];
  /** ids-mode only: requested facts that could NOT be served, with why —
   *  a stale fact hydrated by id must fail loudly, never arrive as truth. */
  withheld?: Array<{ id: string; reason: string }>;
  /** ONE stale fact anchored to the same files as the hits, offered for
   *  opportunistic verification — the recalling agent is already in-context
   *  on those files, so re-confirming (or discarding) it is nearly free. */
  review?: { id: string; preview: string; reason: string };
  /** ISS-04: withheld stale facts surfaced as re-grounding POINTERS, not just a
   *  count. A bare "N withheld" reads as a gap and invites a confident wrong
   *  re-derivation; a pointer says what the fact claimed, the commit it was true
   *  at, and which file to re-check — so the agent verifies instead of guessing.
   *  Topic-scoped and capped (ISS-08); `staleDropped` remains the full count. */
  staleGrounding: Regrounding[];
  total: number;
  staleDropped: number;
}

/** A pointer back to a withheld stale fact so the agent can re-ground it. */
export interface Regrounding {
  id: string;
  /** First line of the fact — what it claimed. */
  was: string;
  /** Short commit the fact was last verified true at (null in an empty repo). */
  trueAsOf: string | null;
  /** Anchor files to re-check before trusting it again. */
  verify: string[];
  /** Why it went stale (which anchor changed). */
  reason: string;
}

const REGROUND_CAP = 5;
const REGROUND_PREVIEW = 100;

function toRegrounding(f: MemoryStatus): Regrounding {
  return {
    id: f.id,
    was: f.fact.split('\n')[0].slice(0, REGROUND_PREVIEW),
    trueAsOf: f.anchors.commit ? f.anchors.commit.slice(0, 8) : null,
    verify: f.anchors.files.map((a) => a.path).slice(0, 3),
    reason: f.staleReason ?? 'anchored evidence changed',
  };
}

/**
 * Rank withheld stale facts for re-grounding: topic-scoped when a topic is given
 * (only facts relevant to what the agent is doing), else most-recently-valid
 * first (fewest commits behind). Excludes `reviewId` to avoid duplicating the
 * opportunistic review pick. Capped for context budget (ISS-08).
 */
function groundStale(staleAll: MemoryStatus[], topic: string | undefined, reviewId?: string): Regrounding[] {
  const ranked = topic?.trim()
    ? rankFacts(staleAll, topic)
    : [...staleAll].sort(
        (a, b) => (a.commitsBehind ?? Infinity) - (b.commitsBehind ?? Infinity) || b.createdAt.localeCompare(a.createdAt),
      );
  return ranked.filter((f) => f.id !== reviewId).slice(0, REGROUND_CAP).map(toRegrounding);
}

const RELATED_CAP = 3;

/** Rank candidate facts by how many anchor files they share with the picked set. */
export function relatedByAnchors(picked: MemoryStatus[], candidates: MemoryStatus[], cap = RELATED_CAP): MemoryStatus[] {
  const pickedIds = new Set(picked.map((f) => f.id));
  const anchorPaths = new Set(picked.flatMap((f) => f.anchors.files.map((a) => a.path)));
  if (!anchorPaths.size) return [];
  return candidates
    .filter((f) => !pickedIds.has(f.id))
    .map((f) => ({ f, overlap: f.anchors.files.filter((a) => anchorPaths.has(a.path)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.f.createdAt.localeCompare(a.f.createdAt))
    .slice(0, cap)
    .map((x) => x.f);
}

/**
 * What an agent should read: fresh + aging facts, relevance-ranked when a
 * topic is given. Stale facts are EXCLUDED from the bodies (counted, named in
 * the caller's summary) — a stale "fact" presented as truth is how models
 * hallucinate.
 */
/**
 * ISS-05: `repairMemories` is the self-heal pass, but it only ran inside the
 * daemon (server.ts) — a terminal-first user with no `baton serve` never got
 * stale-but-still-true facts re-anchored, so recall withheld them forever.
 * Run repair opportunistically at recall time, debounced to at most once per
 * window (mirrors the daemon's 10-min cadence) so back-to-back recalls don't
 * each pay the file-read cost. Marker lives beside facts/ (not inside it, so
 * the `.md`-only fact reader never sees it). Best-effort throughout: any
 * failure leaves recall to fall back to plain withholding — repair is an
 * enhancement, never a blocker.
 */
const RECALL_REPAIR_DEBOUNCE_MS = 10 * 60_000;

/** The shared "last repair pass" clock, beside facts/ (not inside it, so the
 *  `.md`-only fact reader never sees it). Every repair — daemon, CLI, or the
 *  recall-time pass below — stamps it, so all three share one debounce window.
 *  Deliberately under gitignored `.baton/` even though facts are tracked: it is
 *  one machine's timer, and committing it would make every clone's debounce
 *  window a merge conflict. */
function repairMarker(mainRoot: string): string {
  return join(dirname(localMemoryDir(mainRoot)), '.repair-check');
}
async function stampRepair(mainRoot: string): Promise<void> {
  const marker = repairMarker(mainRoot);
  await mkdir(dirname(marker), { recursive: true }).catch(() => undefined);
  await writeFile(marker, '', 'utf-8').catch(() => undefined);
}

async function maybeRepairOnRecall(root: string): Promise<void> {
  try {
    const mainRoot = await resolveRoot(root);
    try {
      const st = await stat(repairMarker(mainRoot));
      if (Date.now() - st.mtimeMs < RECALL_REPAIR_DEBOUNCE_MS) return; // within window — skip
    } catch { /* no marker yet — first recall heals */ }
    // Pre-stamp BEFORE repairing so a concurrent recall debounces against this
    // attempt rather than piling on. A failed repair still holds the window —
    // no worse than the daemon skipping a tick.
    await stampRepair(mainRoot);
    await repairMemories(root);
  } catch { /* repair is an enhancement — never block recall */ }
}

export async function recallMemories(
  root: string,
  opts: { topic?: string; limit?: number; ids?: string[] } = {},
): Promise<RecallResult> {
  // Heal first so any stale-but-still-true fact is re-anchored and recallable
  // in THIS call — the terminal-first self-heal (ISS-05). Debounced internally.
  await maybeRepairOnRecall(root);
  const all = await listMemories(root);
  const usable = all.filter((f) => f.freshness !== 'stale');
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  // Hydration mode (M2): exact facts by id, full bodies. A stale or unknown id
  // is reported in `withheld` — silence would read as "that fact is gone".
  if (opts.ids?.length) {
    const byId = new Map(all.map((f) => [f.id, f]));
    const facts: MemoryStatus[] = [];
    const withheld: Array<{ id: string; reason: string }> = [];
    for (const id of [...new Set(opts.ids)].slice(0, 50)) {
      const f = byId.get(id);
      if (!f) withheld.push({ id, reason: 'no such fact' });
      else if (f.freshness === 'stale') withheld.push({ id, reason: f.staleReason ?? 'anchored evidence changed' });
      else facts.push(f);
    }
    // ids mode already fails loud via `withheld`; grounding is for the topic/
    // default gap, so leave it empty here.
    return { facts: facts.slice(0, limit), withheld, staleGrounding: [], total: all.length, staleDropped: all.length - usable.length };
  }
  let picked = usable;
  let related: MemoryStatus[] | undefined;
  let review: RecallResult['review'];
  if (opts.topic?.trim()) {
    // BM25 (FTS5) with synonym/identifier expansion; scoreMemory is its fallback.
    picked = rankFacts(usable, opts.topic);
    // The anchor graph: facts the keyword score missed but that live on the
    // same files as the hits. Computed only against the served slice so a
    // broad topic can't fan out.
    related = relatedByAnchors(picked.slice(0, limit), usable);
    // Repair queue, opportunistic half (M3): one stale fact on the same files.
    const hitPaths = new Set(picked.slice(0, limit).flatMap((f) => f.anchors.files.map((a) => a.path)));
    const staleHit = all.find((f) => f.freshness === 'stale' && f.anchors.files.some((a) => hitPaths.has(a.path)));
    if (staleHit) {
      review = {
        id: staleHit.id,
        preview: staleHit.fact.split('\n')[0].slice(0, 140),
        reason: staleHit.staleReason ?? 'anchored evidence changed',
      };
    }
  }
  const staleAll = all.filter((f) => f.freshness === 'stale');
  const staleGrounding = groundStale(staleAll, opts.topic, review?.id);
  return { facts: picked.slice(0, limit), related, review, staleGrounding, total: all.length, staleDropped: all.length - usable.length };
}

export async function removeMemory(root: string, id: string, reason = 'manual removal'): Promise<boolean> {
  const mainRoot = await resolveRoot(root);
  return archiveFact(mainRoot, id, 'remove', reason);
}

/* ------------------------------------------------------------------ */
/* Stale repair (M3): re-anchor instead of losing knowledge            */
/* ------------------------------------------------------------------ */

/**
 * The mechanically checkable parts of a fact: backticked spans, identifiers
 * (camelCase / SNAKE_CASE / snake_case), and dotted or slashed paths. Plain
 * hyphenated prose ("zero-dependency") is NOT one — it wouldn't be found in
 * code verbatim, so treating it as evidence would block honest re-anchors.
 */
export function extractVerifiableTerms(fact: string): string[] {
  const out = new Set<string>();
  for (const m of fact.matchAll(/`([^`\n]{2,80})`/g)) out.add(m[1].trim());
  // Paths and dotted names: src/server.ts, retention.json, foo.bar.baz
  for (const m of fact.matchAll(/\b[\w-]+(?:[./][\w-]+)+\b/g)) out.add(m[0]);
  // camelCase and anything_with_underscores
  for (const m of fact.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b\w+_\w+\b/g)) out.add(m[0]);
  return [...out].filter((t) => t.length >= 3).slice(0, 12);
}

/**
 * Derive file anchors from the fact's own text: path-shaped verifiable terms
 * that name a file which actually exists. This is what stands between an
 * agent that skipped `files:` and a fact the withholding pipeline can never
 * see go stale — no anchors means nothing to re-hash, means served as truth
 * forever. Only real files count: `foo.bar.baz` is path-shaped but hashes
 * to nothing, so it is skipped rather than anchored.
 */
export async function deriveFileAnchors(mainRoot: string, fact: string): Promise<FileAnchor[]> {
  const anchors: FileAnchor[] = [];
  for (const term of extractVerifiableTerms(fact)) {
    if (!term.includes('/') && !/\.[a-z][a-z0-9]{0,4}$/i.test(term)) continue;
    const path = term.replace(/^\.\//, '');
    if (isAbsolute(path) || path.includes('..')) continue;
    const hash = await fileHash(mainRoot, path);
    if (hash) anchors.push({ path, hash });
    if (anchors.length >= 8) break;
  }
  return anchors;
}

/** Exact-token survival: `ORIGIN_GUARD` must NOT count as present when the
 *  file only has `ORIGIN_GUARD_V2` — a rename is exactly the change that can
 *  make the fact false, so a substring check would false-pass the repair. */
function termSurvives(hay: string, term: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`).test(hay);
}

export interface RepairResult {
  /** Facts whose verifiable terms all survived — anchors refreshed, fresh again. */
  reanchored: string[];
  /** Facts that need an agent/human to re-verify — kept stale, never deleted here. */
  needsReview: string[];
}

/**
 * The repair queue: for every stale fact, re-anchor mechanically when every
 * verifiable term still appears in the current anchored files (the change
 * didn't touch what the fact asserts); otherwise queue it for review. This is
 * what stops "a file changed" from meaning "the knowledge is gone".
 */
export async function repairMemories(root: string): Promise<RepairResult> {
  const mainRoot = await resolveRoot(root);
  const all = await listMemories(root);
  let head: string | null = null;
  try {
    head = await git(['rev-parse', 'HEAD'], mainRoot);
  } catch { /* empty repo — keep the old commit anchor */ }

  const reanchored: string[] = [];
  const needsReview: string[] = [];
  for (const f of all) {
    if (f.freshness !== 'stale') continue;
    const terms = extractVerifiableTerms(f.fact);
    // An anchorless fact went stale on commit distance alone (there was never a
    // file to invalidate it). Try to give it the anchors it should have had:
    // real files its own text names. No derivable evidence → review queue.
    const anchorFiles = f.anchors.files.length > 0 ? f.anchors.files : await deriveFileAnchors(mainRoot, f.fact);
    let verified = terms.length > 0 && anchorFiles.length > 0;
    if (verified) {
      // Haystack: the anchor paths themselves + current contents of every
      // anchored file. A deleted anchor is unverifiable by definition.
      let hay = anchorFiles.map((a) => a.path).join('\n');
      for (const a of anchorFiles) {
        try {
          hay += '\n' + (await readFile(join(mainRoot, a.path), 'utf-8'));
        } catch {
          verified = false;
          break;
        }
      }
      if (verified) verified = terms.every((t) => termSurvives(hay, t));
    }
    if (!verified) {
      needsReview.push(f.id);
      continue;
    }
    const files: FileAnchor[] = [];
    for (const a of anchorFiles) files.push({ path: a.path, hash: await fileHash(mainRoot, a.path) });
    // `author` is carried over deliberately: re-anchoring is a mechanical
    // refresh of evidence, not a new claim. Restamping it with whoever's daemon
    // happened to run repair would quietly reassign authorship of every fact on
    // a shared hub to its most active machine.
    const updated: MemoryFact = {
      id: f.id, type: f.type, fact: f.fact, agent: f.agent, author: f.author, task: f.task,
      createdAt: f.createdAt, anchors: { commit: head ?? f.anchors.commit, files },
      supersedes: f.supersedes, fingerprint: f.fingerprint,
    };
    // Back into the area it came from. Re-anchoring is a mechanical refresh of
    // evidence, and a repair pass must not be how a local-only fact silently
    // becomes a tracked one.
    const dir = memoryDirFor(mainRoot, f.area ?? areaOf(mainRoot, f.id) ?? 'local');
    const target = join(dir, `${f.id}.md`);
    await writeFactFile(dir, f.id, renderFactFile(updated));
    factCache.delete(target);
    await appendJournal(mainRoot, {
      op: 'reanchor', id: f.id, supersededBy: null,
      reason: 'verifiable terms survived the anchored-file change', at: new Date().toISOString(),
    });
    reanchored.push(f.id);
  }
  // Stamp the shared debounce clock so the recall-time pass (maybeRepairOnRecall)
  // stays dormant while a daemon/CLI repair is keeping memory healed.
  await stampRepair(mainRoot);
  return { reanchored, needsReview };
}

/** Drop stale facts (changed/removed anchors). Returns removed ids. */
export async function gcMemories(root: string): Promise<string[]> {
  const all = await listMemories(root);
  const removed: string[] = [];
  for (const f of all) {
    if (f.freshness === 'stale') {
      if (await removeMemory(root, f.id, 'gc: stale anchor')) removed.push(f.id);
    }
  }
  return removed;
}

/** Archive many facts by id at once. Returns the ids actually removed. */
export async function bulkRemoveMemory(root: string, ids: string[], reason = 'manual removal'): Promise<string[]> {
  const removed: string[] = [];
  for (const id of [...new Set(ids)]) {
    if (await removeMemory(root, id, reason)) removed.push(id);
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
  return bulkRemoveMemory(root, ids, 'retention policy');
}

/* ---- persisted retention policy (.baton/memory/retention.json) ---- */

function retentionFile(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'retention.json');
}

export async function loadRetention(root: string): Promise<RetentionPolicy> {
  const mainRoot = await resolveRootForRead(root);
  if (mainRoot === null) return {};
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

/* ------------------------------------------------------------------ */
/* Progressive-disclosure serving (M2)                                 */
/* ------------------------------------------------------------------ */

export interface RecallRow {
  id: string;
  type: MemoryType;
  freshness: Freshness;
  /** Full body — only the top RECALL_FULL_BODIES rows carry it. */
  fact?: string;
  task?: string | null;
  commitsBehind?: number | null;
  /** Index rows: first line only. Hydrate with recall_memory({ ids }). */
  preview?: string;
  files?: string[];
}

/** Full bodies served per recall; everything after arrives as an index row. */
export const RECALL_FULL_BODIES = 3;
const PREVIEW_MAX = 140;

/**
 * The claude-mem 3-layer read pattern: top hits full, the rest as ~50–100
 * token index rows (id + one line + anchors) the agent hydrates by id only
 * when actually needed. Pure — the MCP layer serves this verbatim.
 */
export function recallRows(facts: MemoryStatus[], fullCount = RECALL_FULL_BODIES): RecallRow[] {
  return facts.map((f, i) =>
    i < fullCount
      ? { id: f.id, type: f.type, freshness: f.freshness, fact: f.fact, task: f.task, commitsBehind: f.commitsBehind }
      : {
          id: f.id,
          type: f.type,
          freshness: f.freshness,
          preview: f.fact.split('\n')[0].slice(0, PREVIEW_MAX),
          files: f.anchors.files.map((a) => a.path).slice(0, 3),
        },
  );
}

/** How many re-grounding pointers to inline in a brief before deferring the
 *  rest to `recall_memory` — kept tiny so the anti-gap warning doesn't itself
 *  become context rot (ISS-08). */
const BRIEF_GROUNDING_CAP = 2;

/**
 * Compact index block for handoff briefs (~token-cheap, fresh facts only). When
 * `grounding` pointers are supplied (ISS-04), withheld stale facts are shown as
 * "was true @ commit — verify <file>" lines instead of a bare count, so the
 * receiving agent re-checks rather than re-derives. Falls back to the count note
 * when no grounding is passed (back-compat).
 */
export function memoryBriefSection(
  facts: MemoryStatus[],
  staleDropped: number,
  grounding: Regrounding[] = [],
): string {
  if (!facts.length && !grounding.length) return '';
  const lines = facts.slice(0, 6).map((f) => {
    const age = f.commitsBehind ? ` (${f.commitsBehind} commits old)` : '';
    return `- [${f.type}] ${f.fact.split('\n')[0]}${age}`;
  });
  let note = '';
  if (grounding.length) {
    const shown = grounding.slice(0, BRIEF_GROUNDING_CAP).map((g) => {
      const when = g.trueAsOf ? ` @ ${g.trueAsOf}` : '';
      const file = g.verify[0] ? ` — verify \`${g.verify[0]}\`` : '';
      return `- ⚠ was true${when}: ${g.was}${file}`;
    });
    const more = staleDropped - shown.length;
    const tail = more > 0 ? `\n- _+${more} more withheld — \`recall_memory\` to inspect_` : '';
    note = `\n\n_Stale — re-ground before trusting (do not re-derive blind):_\n${shown.join('\n')}${tail}`;
  } else if (staleDropped > 0) {
    note = `\n\n_${staleDropped} stale memor${staleDropped === 1 ? 'y was' : 'ies were'} withheld (their anchored files changed) — use \`recall_memory\` to inspect._`;
  }
  const body = lines.length ? `\n\n${lines.join('\n')}` : '';
  return `## Project memory (evidence-checked)${body}${note}`;
}
