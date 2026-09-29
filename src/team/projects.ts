// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team project identity (Team Sync v2 §4.3, fixes review finding E-1).
 *
 * Solo Baton names projects after folders (`src/kb/projects.ts`), so `api`,
 * `acme-api` and `backend` on three machines are three projects and team tasks
 * never meet. Here a project is a random key defined once by a lead with the
 * repo's remotes and root commits, and every device maps that key onto its own
 * checkout by matching those — never by folder name.
 *
 * Match order per key:
 *   1. any remote of the repo (not only `origin`, so a fork's `upstream` counts)
 *      equals a defined remote after normalisation;
 *   2. otherwise a shared root commit — flagged for human confirmation, since
 *      repos generated from one template share root commits;
 *   3. otherwise unmatched ("Locate repo…").
 * Several matching clones are all reported and none is picked: the human
 * chooses the primary. Likewise one checkout matched by several keys is never
 * silently claimed by all of them: each such key needs a human choice, unless
 * every key names a different monorepo `subpath`.
 *
 * All git calls go through `util/exec.ts`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { gitTry } from '../util/exec.js';
import { SKIP_DIRS } from '../kb/projects.js';
import { isSafeRelPath } from '../workspace.js';

/* ------------------------------------------------------------------ */
/* Remote normalisation                                                */
/* ------------------------------------------------------------------ */

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
/** Network transports only: a local path or `file://` identifies a disk, not a project. */
const NETWORK_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git']);
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/;

/**
 * Canonical `host/owner/repo` for a git remote, or null when it is not a
 * network remote we can identify (local path, `file://`, `ext::`, malformed).
 *
 * Lowercases the host only; drops scheme, userinfo (SSH login or an HTTPS
 * token), port, query/fragment, trailing slashes and `.git`. Owner/repo keep
 * their case: some hosts treat paths case-sensitively, and a false merge of
 * two projects is worse than a miss the human can fix with "Locate repo…".
 */
export function normalizeRemote(url: string): string | null {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s || s.length > 2048 || /[\s\p{Cc}]/u.test(s)) return null;

  let authority: string;
  let path: string;
  const m = URL_RE.exec(s);
  if (m) {
    if (!NETWORK_SCHEMES.has(m[1].toLowerCase())) return null;
    const rest = m[2];
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    // scp-like `[user@]host:path`. Git reads it that way only when no slash
    // precedes the first colon; anything else is a local path.
    const colon = s.indexOf(':');
    const slash = s.indexOf('/');
    if (colon <= 0 || (slash !== -1 && slash < colon)) return null;
    authority = s.slice(0, colon);
    path = s.slice(colon + 1);
    if (/^[A-Za-z]$/.test(authority)) return null; // Windows drive letter, `C:\repos`
  }

  // `https://evil.com#@github.com/acme/api` has authority `evil.com` to a URL
  // parser but `github.com` after the last `@` below. Git, curl and a browser
  // disagree on these characters, so an authority carrying any of them never
  // identifies a project.
  if (/[#?\\%]/.test(authority)) return null;
  let host = authority.slice(authority.lastIndexOf('@') + 1); // userinfo never survives
  host = host.replace(/:\d*$/, '').toLowerCase(); // port
  if (!HOST_RE.test(host)) return null;

  path = path.replace(/[?#].*$/, '');
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const segs = path.split('/');
  if (segs.length < 2 || segs.some((p) => !p || p === '.' || p === '..')) return null;
  return `${host}/${segs.join('/')}`;
}

/* ------------------------------------------------------------------ */
/* Git inspection                                                      */
/* ------------------------------------------------------------------ */

export interface RemoteEntry {
  name: string;
  url: string;
  /** null when the URL could not be normalised (local path, malformed) — flagged, never matched. */
  normalized: string | null;
}

export interface RepoInfo {
  gitToplevel: string;
  remotes: RemoteEntry[];
  rootCommits: string[];
}

/** Every remote (fetch and push URLs), deduplicated, in `git remote -v` order. */
export async function listRemotes(repoDir: string): Promise<RemoteEntry[]> {
  const r = await gitTry(['-C', repoDir, 'remote', '-v']);
  if (!r.ok || !r.stdout) return [];
  const seen = new Set<string>();
  const out: RemoteEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\t(.+?)(?: \((?:fetch|push)\))?$/.exec(line);
    if (!m) continue;
    const id = `${m[1]}\0${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name: m[1], url: m[2], normalized: normalizeRemote(m[2]) });
  }
  return out;
}

/** Parentless commits reachable from HEAD (usually one); [] for an empty repo. */
export async function rootCommits(repoDir: string): Promise<string[]> {
  const r = await gitTry(['-C', repoDir, 'rev-list', '--max-parents=0', 'HEAD']);
  if (!r.ok || !r.stdout) return [];
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)))].sort();
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const BATON_WT = `${sep}.baton${sep}wt${sep}`;

/**
 * The main checkout's toplevel for `dir`, or null when `dir` is not in a git
 * work tree, is a linked worktree (git-dir ≠ git-common-dir), or lives under
 * Baton's own `.baton/wt/`. Submodules count as repos: their git-dir is their
 * common dir.
 */
export async function repoToplevel(dir: string): Promise<string | null> {
  const top = await gitTry(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return null;
  const toplevel = real(top.stdout);
  if (`${toplevel}${sep}`.includes(BATON_WT)) return null;
  // Run from the toplevel so relative output has one unambiguous base.
  const dirs = await gitTry(['-C', toplevel, 'rev-parse', '--git-dir', '--git-common-dir']);
  if (!dirs.ok) return null;
  const [gitDir, commonDir] = dirs.stdout.split('\n').map((l) => l.trim());
  if (!gitDir || !commonDir) return null;
  const abs = (p: string) => real(isAbsolute(p) ? p : join(toplevel, p));
  if (abs(gitDir) !== abs(commonDir)) return null;
  return toplevel;
}

/** Remotes and root commits for the main checkout containing `dir`, or null (see repoToplevel). */
export async function inspectRepo(dir: string): Promise<RepoInfo | null> {
  const gitToplevel = await repoToplevel(dir);
  if (!gitToplevel) return null;
  const [remotes, roots] = await Promise.all([listRemotes(gitToplevel), rootCommits(gitToplevel)]);
  return { gitToplevel, remotes, rootCommits: roots };
}

/* ------------------------------------------------------------------ */
/* Scanning Baton roots                                                */
/* ------------------------------------------------------------------ */

/** Nested repos are searched this many directory levels below a Baton root. */
export const SCAN_DEPTH = 3;

async function walk(dir: string, depth: number, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Dirent.isDirectory() is false for symlinks, so link cycles are never followed.
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const child = join(dir, e.name);
    if (existsSync(join(child, '.git'))) {
      found.push(child); // a repo: its own subtree belongs to it
      continue;
    }
    if (depth < SCAN_DEPTH) await walk(child, depth + 1, found);
  }
}

/**
 * Candidate repo toplevels under the given Baton roots: the repo a root sits in
 * (single-repo root, or any folder inside one) plus separate repos nested up to
 * SCAN_DEPTH levels below it (multi-repo hub). Linked worktrees and
 * `.baton/wt/*` are excluded. Sorted and deduplicated.
 */
export async function scanRoots(batonRoots: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of batonRoots) {
    dirs.push(root);
    await walk(root, 1, dirs);
  }
  const tops = new Set<string>();
  for (const d of dirs) {
    const top = await repoToplevel(d);
    if (top) tops.add(top);
  }
  return [...tops].sort();
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/** A team project as defined by `project.define` (§4.3). `key` is random, never a folder name. */
export interface ProjectDef {
  key: string;
  name?: string;
  remotes: string[];
  rootCommits: string[];
  /** Monorepo package path, relative to the repo toplevel. */
  subpath?: string;
}

export type ProjectMatch = 'remote' | 'root-commit-needs-confirm' | 'unmatched';

export interface ProjectResolution {
  match: ProjectMatch;
  /** The resolved checkout; null when unmatched OR when several clones match (see candidates). */
  gitToplevel: string | null;
  subpath?: string;
  /** Every matching checkout, sorted. More than one means the human picks the primary clone. */
  candidates: string[];
  /** True for a root-commit match or several candidates: a human must confirm or choose. */
  needsChoice: boolean;
}

const UNMATCHED: ProjectResolution = { match: 'unmatched', gitToplevel: null, candidates: [], needsChoice: false };

/** A definition may carry a clone URL or an already-canonical `host/owner/repo`. */
function defRemote(r: string): string | null {
  const n = normalizeRemote(r);
  if (n !== null) return n;
  return typeof r === 'string' && normalizeRemote(`https://${r}`) === r ? r : null;
}

/**
 * Pure resolution of project definitions against inspected repos. Returned as
 * a null-prototype record keyed by project key, since keys arrive from peers.
 */
export function matchProjects(defs: ProjectDef[], repos: RepoInfo[]): Record<string, ProjectResolution> {
  const out: Record<string, ProjectResolution> = Object.create(null);
  const usable = defs.filter((d) => d.subpath === undefined || isSafeRelPath(d.subpath));
  for (const d of defs) if (!usable.includes(d)) out[d.key] ??= { ...UNMATCHED };

  // Pass 1: remotes. Any remote of the repo, not just origin.
  const byRemote = new Map<ProjectDef, string[]>();
  const claimed = new Set<string>();
  for (const d of usable) {
    const want = new Set(d.remotes.map(defRemote).filter((x): x is string => x !== null));
    const hits = repos
      .filter((r) => r.remotes.some((x) => x.normalized !== null && want.has(x.normalized)))
      .map((r) => r.gitToplevel);
    byRemote.set(d, hits);
    for (const h of hits) claimed.add(h);
  }

  for (const d of usable) {
    if (d.key in out) continue; // first definition of a key wins
    let match: ProjectMatch = 'remote';
    let hits = byRemote.get(d) ?? [];
    if (hits.length === 0) {
      // Pass 2: root commit, only among repos no project claimed by remote.
      const roots = new Set(d.rootCommits);
      hits = repos
        .filter((r) => !claimed.has(r.gitToplevel) && r.rootCommits.some((c) => roots.has(c)))
        .map((r) => r.gitToplevel);
      match = 'root-commit-needs-confirm';
    }
    const candidates = [...new Set(hits)].sort();
    if (candidates.length === 0) {
      out[d.key] = { ...UNMATCHED };
      continue;
    }
    out[d.key] = {
      match,
      gitToplevel: candidates.length === 1 ? candidates[0] : null,
      ...(d.subpath !== undefined ? { subpath: d.subpath } : {}),
      candidates,
      needsChoice: candidates.length > 1 || match === 'root-commit-needs-confirm',
    };
  }

  /*
   * One checkout, several keys: a double claim. Two definitions that share a
   * remote (a copy-pasted define, or a hostile one) would otherwise both map
   * onto the same repo and tasks from either would land in it. The only
   * legitimate shape is a monorepo — every key names its own package — so
   * anything else goes to the human.
   */
  const keysByTop = new Map<string, string[]>();
  for (const key of Object.keys(out)) {
    for (const top of out[key].candidates) keysByTop.set(top, [...(keysByTop.get(top) ?? []), key]);
  }
  for (const keys of keysByTop.values()) {
    if (keys.length < 2) continue;
    const subpaths = keys.map((k) => out[k].subpath);
    const distinctPackages = subpaths.every((p) => p !== undefined) && new Set(subpaths).size === subpaths.length;
    if (distinctPackages) continue;
    for (const k of keys) out[k] = { ...out[k], gitToplevel: null, needsChoice: true };
  }
  return out;
}

/**
 * Resolve project definitions against candidate repo directories (typically
 * from scanRoots). Directories that are not repos, linked worktrees or
 * `.baton/wt/*` are ignored; two paths into one repo count once.
 */
export async function resolveProjects(
  defs: ProjectDef[],
  candidateRepoDirs: string[],
): Promise<Record<string, ProjectResolution>> {
  const repos = new Map<string, RepoInfo>();
  for (const dir of candidateRepoDirs) {
    const info = await inspectRepo(dir);
    if (info && !repos.has(info.gitToplevel)) repos.set(info.gitToplevel, info);
  }
  return matchProjects(defs, [...repos.values()]);
}
