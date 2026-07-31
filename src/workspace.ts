/**
 * Workspace manifest — the description of a hub's folder layout, so a second
 * machine can reproduce it exactly.
 *
 * Why exact layout matters: Baton's coordination is anchored to REPO-RELATIVE
 * paths. Memory facts anchor to `api-server/src/x.ts`; edit signals and (later)
 * federated claims key on the same string. If your teammate's clone puts that
 * repo at `backend/` instead, every anchor and every claim silently refers to a
 * path that does not exist on their disk — no error, just coordination that
 * quietly does nothing. The manifest is what makes those strings mean the same
 * thing on both machines.
 *
 * A manifest is UNTRUSTED INPUT. It arrives from another person and it drives
 * `git clone` into your filesystem, so every field is validated before use:
 * `path` must stay inside the target directory, `remote` must be a scheme we
 * are willing to hand to git, and `defaultBranch` must not be able to pose as a
 * command-line flag. See `cleanManifest`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, posix, isAbsolute, normalize } from 'node:path';
import { batonDir } from './store.js';
import { gitTry } from './util/exec.js';

/** Bumped only on a breaking shape change; `cleanManifest` refuses anything else. */
export const WORKSPACE_VERSION = 1;

/** Sane ceilings — a manifest is a layout description, never a payload. */
const MAX_PROJECTS = 50;
const MAX_FIELD = 400;

export interface WorkspaceProject {
  /** Stable slug, matching the hub's kb project id where one exists. */
  id: string;
  /** Clone URL, with any embedded credentials stripped. */
  remote: string;
  /** Where the repo sits relative to the hub root, POSIX separators. */
  path: string;
  /** Branch to check out. Omitted = whatever the remote's HEAD points at. */
  defaultBranch?: string;
}

export interface WorkspaceManifest {
  version: number;
  /** Display name for the hub (the root directory's name). */
  name?: string;
  createdAt: string;
  projects: WorkspaceProject[];
}

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

export function manifestPath(root: string): string {
  return join(batonDir(root), 'workspace.json');
}

/* ------------------------------------------------------------------ */
/* Pure validation (exported for tests)                                */
/* ------------------------------------------------------------------ */

/**
 * Strip credentials embedded in a clone URL (`https://user:token@host/repo`).
 *
 * A manifest is made to be handed to other people, and a personal access token
 * pasted into a remote is the single easiest way to leak one. The host and path
 * are kept so the entry still identifies the repo — the joiner authenticates
 * with their OWN credentials, which is the intended behaviour anyway.
 */
export function redactRemote(url: string): string {
  // Only the userinfo segment of an authority is touched; scp-like `git@host:p`
  // has no password component and is left alone (it is a username, not a secret).
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*:[^/@]*)@/i, '$1');
}

/** True when a clone URL carries what looks like an embedded password. */
export function hasEmbeddedCredentials(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url);
}

/**
 * Schemes we are willing to hand to `git clone`.
 *
 * `ext::` is the one that matters: it makes git run an arbitrary command, so a
 * manifest carrying `ext::sh -c ...` would be remote code execution on the
 * joiner's machine. `src/util/exec.ts` already pins `protocol.ext.allow=never`,
 * but defence in depth is warranted when the input is a file a stranger sent
 * you — this check is the one a reader can actually see.
 *
 * `git://` is refused as well: it is unauthenticated and unencrypted, so it
 * cannot establish that the code you cloned is the code that was published.
 */
const REMOTE_SCHEME_RE = /^(https?|ssh|file):\/\//i;
const SCP_LIKE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

export function isSafeRemote(url: string): boolean {
  if (!url || url.length > MAX_FIELD) return false;
  // A value that could be read as a flag, or that carries a newline / control
  // character, never reaches git.
  if (url.startsWith('-')) return false;
  if (/\p{Cc}/u.test(url)) return false;
  if (REMOTE_SCHEME_RE.test(url)) return true;
  if (SCP_LIKE_RE.test(url)) return true;
  // A plain absolute local path (a mirror on the same machine, or a test fixture).
  return isAbsolute(url) && !url.includes('..');
}

/**
 * Where a repo may be placed, relative to the target root.
 *
 * The threat is a manifest that says `path: "../../.ssh"` and quietly clones
 * over something outside the folder the user pointed at. Rejecting `..`
 * outright — rather than resolving and comparing prefixes — keeps the rule
 * simple enough to be obviously correct.
 */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.length > MAX_FIELD) return false;
  if (/\p{Cc}/u.test(p)) return false;
  if (isAbsolute(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;          // Windows drive-relative
  if (p.startsWith('\\') || p.startsWith('//')) return false; // UNC
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((s) => s === '..' || s === '.')) return false;
  // normalize() must not climb out (belt to the braces above).
  return !normalize(p).startsWith('..');
}

/** Branch names that cannot be mistaken for a flag or break out of an argv slot. */
export function isSafeBranch(b: string): boolean {
  return !!b && b.length <= MAX_FIELD && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) && !b.includes('..');
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function field(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_FIELD) : '';
}

/**
 * Validate an arbitrary parsed object into a manifest, or throw. Every rejection
 * names the offending entry: a joiner staring at "invalid manifest" cannot fix
 * anything, and the most likely cause is an honest typo, not an attack.
 */
export function cleanManifest(raw: unknown): WorkspaceManifest {
  if (!raw || typeof raw !== 'object') throw new WorkspaceValidationError('manifest is not a JSON object');
  const m = raw as Partial<WorkspaceManifest>;
  if (m.version !== WORKSPACE_VERSION) {
    throw new WorkspaceValidationError(
      `unsupported manifest version ${String(m.version)} — this Baton understands version ${WORKSPACE_VERSION}`,
    );
  }
  if (!Array.isArray(m.projects) || m.projects.length === 0) {
    throw new WorkspaceValidationError('manifest lists no projects');
  }
  if (m.projects.length > MAX_PROJECTS) {
    throw new WorkspaceValidationError(`manifest lists ${m.projects.length} projects (max ${MAX_PROJECTS})`);
  }

  const projects: WorkspaceProject[] = [];
  const seenId = new Set<string>();
  const seenPath = new Set<string>();

  for (const [i, p] of m.projects.entries()) {
    const where = `project ${i + 1}`;
    const id = field((p as WorkspaceProject)?.id).toLowerCase();
    const remote = field((p as WorkspaceProject)?.remote);
    const path = field((p as WorkspaceProject)?.path).replace(/\\/g, '/').replace(/\/+$/, '');
    const branch = field((p as WorkspaceProject)?.defaultBranch);

    if (!ID_RE.test(id)) throw new WorkspaceValidationError(`${where}: invalid id '${id}'`);
    if (!isSafeRemote(remote)) throw new WorkspaceValidationError(`${where} (${id}): refusing remote '${remote}'`);
    if (!isSafeRelPath(path)) throw new WorkspaceValidationError(`${where} (${id}): unsafe path '${path}'`);
    if (branch && !isSafeBranch(branch)) throw new WorkspaceValidationError(`${where} (${id}): invalid branch '${branch}'`);

    // Two entries writing the same directory means the second silently wins, or
    // collides mid-clone. Caught here rather than halfway through the network.
    const key = posix.normalize(path).toLowerCase();
    if (seenId.has(id)) throw new WorkspaceValidationError(`duplicate project id '${id}'`);
    if (seenPath.has(key)) throw new WorkspaceValidationError(`two projects share the path '${path}'`);
    seenId.add(id);
    seenPath.add(key);

    projects.push({ id, remote, path, ...(branch ? { defaultBranch: branch } : {}) });
  }

  return {
    version: WORKSPACE_VERSION,
    ...(field(m.name) ? { name: field(m.name) } : {}),
    createdAt: field(m.createdAt) || new Date(0).toISOString(),
    projects,
  };
}

/* ------------------------------------------------------------------ */
/* Building + persisting                                               */
/* ------------------------------------------------------------------ */

/** The `origin` URL of a repo, credentials stripped, or '' when it has none. */
export async function remoteOf(repoPath: string): Promise<string> {
  const r = await gitTry(['-C', repoPath, 'config', '--get', 'remote.origin.url']);
  return r.ok ? redactRemote(r.stdout.trim()) : '';
}

/** The repo's current branch, or '' when unborn/detached. */
export async function branchOf(repoPath: string): Promise<string> {
  const r = await gitTry(['-C', repoPath, 'symbolic-ref', '--short', 'HEAD']);
  const b = r.ok ? r.stdout.trim() : '';
  return isSafeBranch(b) ? b : '';
}

export async function readManifest(file: string): Promise<WorkspaceManifest> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    throw new WorkspaceValidationError(`cannot read manifest at ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceValidationError(`manifest at ${file} is not valid JSON`);
  }
  return cleanManifest(parsed);
}

export async function writeManifest(root: string, m: WorkspaceManifest): Promise<string> {
  const path = manifestPath(root);
  await mkdir(batonDir(root), { recursive: true });
  await writeFile(path, `${JSON.stringify(cleanManifest(m), null, 2)}\n`, 'utf-8');
  return path;
}
