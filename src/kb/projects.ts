/**
 * Sub-project detection for `baton kb init`. A folder holding several servers
 * (api/, web/, worker/ ...) gets one graph per sub-project plus a merged view;
 * a plain single-project repo gets exactly one graph at its root.
 */
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    if (isStop(child)) {
      found.push(child);
      // Don't descend into a detected project — its own nested packages belong to it.
      continue;
    }
    await walk(child, depth + 1, found, isStop);
  }
}

/** Assign stable, unique slug ids to discovered project paths (relative to `root`). */
function toSubProjects(root: string, paths: string[]): SubProject[] {
  const taken = new Set<string>();
  return paths.map((p) => {
    let id = relative(root, p).replace(/[\\/]+/g, '-').toLowerCase() || basename(p);
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
