/**
 * Sub-project detection for `baton kb init`. A folder holding several servers
 * (api/, web/, worker/ ...) gets one graph per sub-project plus a merged view;
 * a plain single-project repo gets exactly one graph at its root.
 */
import { readdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.baton', 'graphify-out', 'dist', 'build', '.next',
  '.venv', 'venv', '__pycache__', 'vendor', '.refs',
]);
const MAX_DEPTH = 3;

export interface SubProject {
  id: string;   // slug-ish, unique
  name: string; // display name (directory basename, or repo name at root)
  path: string; // absolute
}

const isGitDir = (dir: string): boolean => existsSync(join(dir, '.git'));
function isProjectDir(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) || isGitDir(dir);
}

/**
 * A linked git worktree — `.git` is a file pointing into the real repo's
 * `.git/worktrees/<name>`. Baton's own `baton new` creates these by the dozen,
 * and they carry both `.git` and a package.json, so without this they get
 * indexed as separate projects: N near-duplicates of a repo already in the KB.
 * A submodule's `.git` file points at `.git/modules/<name>` instead and stays a
 * project of its own.
 */
function isGitWorktree(dir: string): boolean {
  const dotGit = join(dir, '.git');
  try {
    if (!statSync(dotGit).isFile()) return false;
    return /^gitdir:.*[\\/]worktrees[\\/]/m.test(readFileSync(dotGit, 'utf-8'));
  } catch {
    return false;
  }
}

/** Depth-limited DFS collecting directories where `isStop` holds (and not descending into them). */
async function walk(dir: string, depth: number, found: string[], isStop: (d: string) => boolean): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const child = join(dir, e.name);
    // A worktree mirrors a repo we already index — skip it AND its subtree.
    if (isGitWorktree(child)) continue;
    if (isStop(child)) {
      found.push(child);
      // Don't descend into a detected project — its own nested packages belong to it.
      continue;
    }
    await walk(child, depth + 1, found, isStop);
  }
}

/**
 * A project id is not cosmetic — it is interpolated into a TOML table header in
 * the user's GLOBAL `~/.codex/config.toml` and into the daemon's proxy route,
 * whose regex is `[A-Za-z0-9._-]+`. A directory name is neither charset. Two
 * concrete failures this closes:
 *
 *  - a name containing a newline produced a TOML basic string with a literal
 *    newline in it, which is illegal — `baton mcp connect codex --confirm`
 *    appends that and leaves the file unparseable, breaking EVERY MCP server
 *    the user has configured, not just Baton's.
 *  - a name with a space (`my app`) produced an id that can never match its own
 *    route, so the graph server was silently dead with no error anywhere.
 *
 * Sanitizing here fixes both at the source, where the id is minted, rather than
 * at each of the places it is rendered.
 */
const ID_SAFE = /[^a-z0-9._-]+/g;

/** Assign stable, unique slug ids to discovered project paths (relative to `root`). */
function toSubProjects(root: string, paths: string[]): SubProject[] {
  const taken = new Set<string>();
  return paths.map((p) => {
    const raw = relative(root, p).replace(/[\\/]+/g, '-').toLowerCase() || basename(p);
    // Collapse runs of unsafe chars to one dash, then trim dashes/dots from the
    // ends: a leading dot would hide the id, and `.`/`..` must never be one.
    let id = raw.replace(ID_SAFE, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';
    while (taken.has(id)) id = `${id}-2`;
    taken.add(id);
    return { id, name: basename(p), path: p };
  });
}

/**
 * Find separate git repositories nested under `root` (depth-limited), regardless
 * of whether `root` itself carries a project marker. `detectProjects` and
 * `baton setup` use this so a container that holds several repos AND a root
 * `package.json` (shared workspace tooling) is still recognised as a multi-repo
 * hub instead of being collapsed into one project.
 */
export async function findNestedGitRepos(root: string): Promise<SubProject[]> {
  const found: string[] = [];
  await walk(root, 1, found, isGitDir);
  return toSubProjects(root, found);
}

/**
 * Detect sub-projects under `root`. Returns the root itself as the single
 * project when no nested projects exist (or when the root is itself the only
 * marker-bearing directory).
 */
export async function detectProjects(root: string): Promise<SubProject[]> {
  // A container holding ≥2 separate git repos is split per-repo even when the
  // container ALSO has its own marker (a shared root package.json / workspace
  // config) — those repos are independent projects, not one monorepo. This must
  // be checked before the root-marker short-circuit below.
  const gitRepos = await findNestedGitRepos(root);
  if (gitRepos.length >= 2) return gitRepos;

  // A marker at the root means the folder IS a project (possibly a monorepo) —
  // index it as one graph. Per-sub-project splitting is for plain container
  // folders holding several independent servers/repos side by side.
  if (PROJECT_MARKERS.some((m) => existsSync(join(root, m)))) {
    return [{ id: basename(root), name: basename(root), path: root }];
  }
  const found: string[] = [];
  await walk(root, 1, found, isProjectDir);
  if (found.length === 0) {
    return [{ id: basename(root), name: basename(root), path: root }];
  }
  return toSubProjects(root, found);
}
