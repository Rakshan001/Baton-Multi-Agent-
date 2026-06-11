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

function isProjectDir(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) || existsSync(join(dir, '.git'));
}

async function walk(dir: string, root: string, depth: number, found: string[]): Promise<void> {
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
    if (isProjectDir(child)) {
      found.push(child);
      // Don't descend into a detected project — its own nested packages belong to it.
      continue;
    }
    await walk(child, root, depth + 1, found);
  }
}

/**
 * Detect sub-projects under `root`. Returns the root itself as the single
 * project when no nested projects exist (or when the root is itself the only
 * marker-bearing directory).
 */
export async function detectProjects(root: string): Promise<SubProject[]> {
  // A marker at the root means the folder IS a project (possibly a monorepo) —
  // index it as one graph. Per-sub-project splitting is for plain container
  // folders holding several independent servers/repos side by side.
  if (PROJECT_MARKERS.some((m) => existsSync(join(root, m)))) {
    return [{ id: basename(root), name: basename(root), path: root }];
  }
  const found: string[] = [];
  await walk(root, root, 1, found);
  if (found.length === 0) {
    return [{ id: basename(root), name: basename(root), path: root }];
  }
  const taken = new Set<string>();
  return found.map((p) => {
    let id = relative(root, p).replace(/[\\/]+/g, '-').toLowerCase();
    while (taken.has(id)) id = `${id}-2`;
    taken.add(id);
    return { id, name: basename(p), path: p };
  });
}
