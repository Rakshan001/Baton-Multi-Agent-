/**
 * Portable work bundle — everything needed to continue a task somewhere else.
 *
 * `baton pass` already writes a HANDOFF.md that explains the work. What it
 * cannot carry is the work itself: the uncommitted diff lives in one worktree on
 * one machine. So "continue this on my desktop / after the quota resets / on a
 * teammate's box" still meant re-deriving the half-finished change from a prose
 * description. This module closes that gap — brief, progress ledger, open review
 * findings, relevant memory, the HEAD it was all true at, AND the working-tree
 * diff, in one JSON file.
 *
 * Two rules shape the design:
 *
 * 1. **The patch is applied only against the sha it was cut from.** A diff is
 *    meaningless without its base; applying one to a moved HEAD produces either
 *    a rejected hunk or, far worse, a silently mis-applied one. On mismatch we
 *    report how far apart the two are and apply nothing.
 * 2. **A patch cannot be redacted.** It has to apply byte-exact, so unlike a
 *    memory fact or a review finding there is no "keep the record, scrub the
 *    secret" option. Export therefore REFUSES when a credential is detected in
 *    the diff, rather than shipping it. Prose (progress notes) is redacted,
 *    because prose survives redaction.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { gitTry } from '../util/exec.js';
import { detectSecret, recallMemories } from '../memory.js';
import { loadReview, openFindings, type ReviewFinding } from '../reviews.js';
import { loadProgress, type ProgressLedger } from './progress-ledger.js';
import { handoffPath } from './brief.js';
import { resolveAuthor } from '../identity.js';
import { batonDir, type Task } from '../store.js';

export const BUNDLE_VERSION = 1;

/* A bundle is a handoff, not a repository dump. */
const MAX_PATCH_BYTES = 2_000_000;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_BYTES = 256_000;
const NOTE_MAX = 600;

/** An untracked file, carried whole because `git diff HEAD` cannot see it. */
export interface BundleFile {
  path: string; // repo-relative, POSIX
  content: string;
}

export interface WorkBundle {
  version: number;
  createdAt: string;
  /** Who exported it (src/identity.ts) — a bundle is handed between people. */
  author: string;
  slug: string;
  task: string;
  branch: string;
  baseBranch: string;
  /** The sha the patch was cut against. Import refuses unless HEAD matches. */
  head: string | null;
  /** `git diff HEAD` output; '' when the tree was clean. */
  patch: string;
  untracked: BundleFile[];
  /** Raw HANDOFF.md, when one exists. */
  brief?: string;
  progress?: ProgressLedger;
  /** Open findings only — a resolved one is noise to whoever picks this up. */
  findings: ReviewFinding[];
  /** Carried for READING, never re-saved on import (see importBundle). */
  memory: Array<{ id: string; type: string; fact: string; files: string[] }>;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/**
 * The FULL HEAD sha. Deliberately not `git.ts`'s `headCommit`, which returns the
 * abbreviated form: an abbreviation is only guaranteed unambiguous in the repo
 * that produced it, and a bundle is by definition read somewhere else.
 */
async function fullHead(dir: string): Promise<string | null> {
  const r = await gitTry(['-C', dir, 'rev-parse', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/** A path that may be written inside the target repo. Same rule as workspace.ts. */
export function isSafeBundlePath(p: string): boolean {
  if (!p || p.length > 400) return false;
  if (/\p{Cc}/u.test(p)) return false;
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((s) => s === '..' || s === '.')) return false;
  return !normalize(p).startsWith('..');
}

/** Heuristic: a control character outside tab/CR/LF means this is not text we
 *  can carry in a JSON string. Cheap and deliberately conservative — a false
 *  positive only costs one skipped-and-reported file. */
export function looksBinary(content: string): boolean {
  return /\p{Cc}/u.test(content.replace(/[\r\n\t]/g, ''));
}

/**
 * Scan the parts of a bundle that cannot be redacted. Returns a human-readable
 * location for the first credential found, or null.
 */
export function scanBundleSecrets(patch: string, untracked: BundleFile[]): string | null {
  const inPatch = detectSecret(patch);
  if (inPatch) return `the working-tree diff contains what looks like a ${inPatch}`;
  for (const f of untracked) {
    const what = detectSecret(f.content);
    if (what) return `${f.path} contains what looks like a ${what}`;
  }
  return null;
}

/** Redact prose. Safe here precisely because prose survives it — a patch does not. */
function redactNote(s: string): string {
  const what = detectSecret(s);
  return what ? `[redacted: ${what}]` : s;
}

export function cleanBundle(raw: unknown): WorkBundle {
  if (!raw || typeof raw !== 'object') throw new BundleError('bundle is not a JSON object');
  const b = raw as Partial<WorkBundle>;
  if (b.version !== BUNDLE_VERSION) {
    throw new BundleError(`unsupported bundle version ${String(b.version)} — this Baton understands ${BUNDLE_VERSION}`);
  }
  const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const patch = typeof b.patch === 'string' ? b.patch : '';
  if (patch.length > MAX_PATCH_BYTES) throw new BundleError('bundle patch exceeds the size cap');

  const untracked: BundleFile[] = [];
  for (const f of Array.isArray(b.untracked) ? b.untracked : []) {
    const path = str((f as BundleFile)?.path).replace(/\\/g, '/');
    const content = typeof (f as BundleFile)?.content === 'string' ? (f as BundleFile).content : '';
    if (!isSafeBundlePath(path)) throw new BundleError(`bundle carries an unsafe file path '${path}'`);
    if (content.length > MAX_UNTRACKED_BYTES) throw new BundleError(`bundled file '${path}' exceeds the size cap`);
    untracked.push({ path, content });
  }
  if (untracked.length > MAX_UNTRACKED_FILES) throw new BundleError('bundle carries too many untracked files');

  const slug = str(b.slug, 80);
  if (!slug) throw new BundleError('bundle has no slug');

  return {
    version: BUNDLE_VERSION,
    createdAt: str(b.createdAt, 40) || new Date(0).toISOString(),
    author: str(b.author, 120) || 'unknown',
    slug,
    task: str(b.task, 500),
    branch: str(b.branch, 200),
    baseBranch: str(b.baseBranch, 200),
    head: typeof b.head === 'string' && /^[0-9a-f]{7,40}$/i.test(b.head) ? b.head : null,
    patch,
    untracked,
    ...(typeof b.brief === 'string' ? { brief: b.brief.slice(0, 200_000) } : {}),
    ...(b.progress && typeof b.progress === 'object' ? { progress: b.progress as ProgressLedger } : {}),
    findings: Array.isArray(b.findings) ? (b.findings as ReviewFinding[]).slice(0, 60) : [],
    memory: Array.isArray(b.memory) ? b.memory.slice(0, 20) : [],
  };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface ExportOpts {
  /** Ship even when a credential is detected in the diff. */
  allowSecrets?: boolean;
}

/** Read the untracked files git would not put in `diff HEAD`. */
async function collectUntracked(workdir: string): Promise<{ files: BundleFile[]; skipped: string[] }> {
  const r = await gitTry(['-C', workdir, 'ls-files', '--others', '--exclude-standard']);
  if (!r.ok || !r.stdout.trim()) return { files: [], skipped: [] };
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  const files: BundleFile[] = [];
  const skipped: string[] = [];
  for (const name of names.slice(0, MAX_UNTRACKED_FILES * 4)) {
    if (files.length >= MAX_UNTRACKED_FILES) {
      skipped.push(`${name} (untracked file cap reached)`);
      continue;
    }
    if (!isSafeBundlePath(name)) { skipped.push(`${name} (unsafe path)`); continue; }
    let content: string;
    try {
      content = await readFile(join(workdir, name), 'utf-8');
    } catch {
      skipped.push(`${name} (unreadable)`);
      continue;
    }
    // Binary can't ride in a JSON string; carrying it base64 would bloat the
    // bundle for something the receiver can usually regenerate.
    if (looksBinary(content)) { skipped.push(`${name} (binary)`); continue; }
    if (content.length > MAX_UNTRACKED_BYTES) { skipped.push(`${name} (too large)`); continue; }
    files.push({ path: name, content });
  }
  return { files, skipped };
}

export interface ExportResult {
  bundle: WorkBundle;
  /** Untracked files deliberately left out, with the reason — never silent. */
  skipped: string[];
}

/**
 * Build a bundle for `task`. Throws BundleError when the diff carries a
 * credential and `allowSecrets` is not set.
 */
export async function buildBundle(root: string, task: Task, opts: ExportOpts = {}): Promise<ExportResult> {
  const workdir = task.worktreePath;
  if (!existsSync(workdir)) throw new BundleError(`worktree is gone: ${workdir}`);

  const head = await fullHead(workdir);
  const diff = await gitTry(['-C', workdir, 'diff', 'HEAD']);
  const patch = diff.ok ? diff.stdout : '';
  if (patch.length > MAX_PATCH_BYTES) {
    throw new BundleError(
      `working-tree diff is ${Math.round(patch.length / 1000)} KB (cap ${MAX_PATCH_BYTES / 1000} KB) — commit some of it first`,
    );
  }

  const { files: untracked, skipped } = await collectUntracked(workdir);

  const found = scanBundleSecrets(patch, untracked);
  if (found && !opts.allowSecrets) {
    throw new BundleError(
      `refusing to export: ${found}.\n` +
      '  A patch must apply byte-exact, so unlike a memory fact it cannot be redacted without\n' +
      '  breaking it. Remove the credential (or move it to an env var) and re-run.\n' +
      '  If this is a false positive, re-run with --allow-secrets.',
    );
  }

  let brief: string | undefined;
  try {
    brief = await readFile(handoffPath(workdir), 'utf-8');
  } catch { /* no brief written for this task */ }

  const progress = await loadProgress(root, task.slug);
  if (progress) {
    progress.notes = progress.notes.map((n) => redactNote(n).slice(0, NOTE_MAX));
    if (progress.next) progress.next = redactNote(progress.next);
  }

  const recalled = await recallMemories(root, { topic: task.task, limit: 8 });

  return {
    bundle: {
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      author: await resolveAuthor(root),
      slug: task.slug,
      task: task.task,
      branch: task.branch,
      baseBranch: task.baseBranch,
      head,
      patch,
      untracked,
      ...(brief ? { brief } : {}),
      ...(progress ? { progress } : {}),
      findings: openFindings(await loadReview(root, task.slug)),
      memory: recalled.facts.map((f) => ({
        id: f.id, type: f.type, fact: f.fact, files: f.anchors.files.map((a) => a.path),
      })),
    },
    skipped,
  };
}

export async function writeBundle(file: string, bundle: WorkBundle): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
}

export async function readBundle(file: string): Promise<WorkBundle> {
  let raw: string;
  try {
    raw = await readFile(resolve(file), 'utf-8');
  } catch {
    throw new BundleError(`cannot read bundle at ${file}`);
  }
  try {
    return cleanBundle(JSON.parse(raw));
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError(`bundle at ${file} is not valid JSON`);
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export type ImportStatus = 'applied' | 'nothing-to-apply' | 'head-mismatch' | 'would-conflict';

export interface ImportResult {
  status: ImportStatus;
  /** What the caller should be told — already phrased for a human. */
  detail: string;
  filesWritten: string[];
  /** Set on head-mismatch: how far the target is from the bundle's base. */
  drift?: { localHead: string | null; behind: number | null; baseKnown: boolean };
}

/**
 * How far the target repo has moved from the sha the patch was cut at.
 * `baseKnown` is false when the bundle's base sha does not exist here at all —
 * a different repo, or one that has not fetched yet.
 */
async function measureDrift(dir: string, base: string): Promise<ImportResult['drift']> {
  const localHead = await fullHead(dir);
  const known = await gitTry(['-C', dir, 'cat-file', '-e', `${base}^{commit}`]);
  if (!known.ok) return { localHead, behind: null, baseKnown: false };
  const count = await gitTry(['-C', dir, 'rev-list', '--count', `${base}..HEAD`]);
  const n = Number(count.stdout.trim());
  return { localHead, behind: Number.isFinite(n) ? n : null, baseKnown: true };
}

export interface ImportOpts {
  /** Apply even though HEAD is not the sha the patch was cut from. */
  force?: boolean;
}

/**
 * Apply a bundle's working state into `dir`.
 *
 * Memory facts are deliberately NOT re-saved. They are anchored to the exporting
 * machine's commit + file hashes; re-saving them here would either duplicate
 * facts already present or mint ones anchored to a history this clone does not
 * share. They travel in the bundle to be READ. The staleness checker is the
 * mechanism for deciding whether a fact still holds, and it works from the
 * reader's own HEAD — importing would bypass exactly that.
 */
export async function importBundle(dir: string, b: WorkBundle, opts: ImportOpts = {}): Promise<ImportResult> {
  const filesWritten: string[] = [];

  if (b.head && !opts.force) {
    const localHead = await fullHead(dir);
    if (localHead !== b.head) {
      const drift = await measureDrift(dir, b.head);
      const where = drift?.baseKnown
        ? `this checkout is ${drift.behind ?? '?'} commit(s) ahead of it`
        : 'that commit does not exist in this checkout at all';
      return {
        status: 'head-mismatch',
        detail:
          `the patch was cut against ${b.head.slice(0, 8)} and ${where}.\n` +
          `  Nothing was applied. Check out ${b.head.slice(0, 8)} (or fetch it) and re-run,\n` +
          '  or pass --force to apply anyway and resolve the fallout by hand.',
        filesWritten,
        drift,
      };
    }
  }

  const hasPatch = b.patch.trim().length > 0;
  const newFiles = b.untracked.filter((f) => !existsSync(join(dir, f.path)));
  const blocked = b.untracked.filter((f) => existsSync(join(dir, f.path)));

  if (!hasPatch && !newFiles.length) {
    return {
      status: 'nothing-to-apply',
      // Name them. "1 file was left untouched" tells you a decision was made
      // but not which file, which is the half of the message that is actionable.
      detail: blocked.length
        ? `no diff to apply; ${blocked.length} bundled file(s) already exist here and were left untouched: ${
            blocked.map((f) => f.path).join(', ')}.`
        : 'the bundle carries no uncommitted work — the brief and ledger are all there is.',
      filesWritten,
    };
  }

  // `git apply --check` first: a partially-applied patch is far worse than a
  // refused one, and this is the only way to know before touching the tree.
  let patchFile = '';
  if (hasPatch) {
    patchFile = join(tmpdir(), `baton-bundle-${process.pid}-${randomBytes(6).toString('hex')}.patch`);
    await writeFile(patchFile, b.patch.endsWith('\n') ? b.patch : `${b.patch}\n`, 'utf-8');
    const check = await gitTry(['-C', dir, 'apply', '--check', patchFile]);
    if (!check.ok) {
      await rm(patchFile, { force: true });
      return {
        status: 'would-conflict',
        detail:
          `the patch does not apply cleanly here — nothing was changed.\n  git said: ${
            (check.stderr.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200)}`,
        filesWritten,
      };
    }
    const applied = await gitTry(['-C', dir, 'apply', patchFile]);
    await rm(patchFile, { force: true });
    if (!applied.ok) {
      return {
        status: 'would-conflict',
        detail: `git apply failed after passing --check: ${applied.stderr.split('\n')[0]?.slice(0, 200) ?? ''}`,
        filesWritten,
      };
    }
    filesWritten.push('(working-tree diff applied)');
  }

  // Never overwrite a file that already exists — the bundle's copy is not
  // automatically the newer one, and clobbering local work is unrecoverable.
  for (const f of newFiles) {
    const dest = join(dir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, f.content, 'utf-8');
    filesWritten.push(f.path);
  }

  const note = blocked.length
    ? ` ${blocked.length} bundled file(s) already existed and were left untouched: ${blocked.map((f) => f.path).join(', ')}.`
    : '';
  return {
    status: 'applied',
    detail: `working state restored.${note}`,
    filesWritten,
  };
}

/** Write the bundle's brief + progress ledger so `baton resume` sees them here. */
export async function restoreContext(root: string, dir: string, b: WorkBundle): Promise<string[]> {
  const written: string[] = [];
  if (b.brief) {
    await writeFile(handoffPath(dir), b.brief, 'utf-8');
    written.push('HANDOFF.md');
  }
  if (b.progress) {
    const target = join(batonDir(root), 'progress', `${b.slug}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(b.progress, null, 2)}\n`, 'utf-8');
    written.push(`.baton/progress/${b.slug}.json`);
  }
  return written;
}
