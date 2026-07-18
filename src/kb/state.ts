/**
 * Knowledge-base state: which sub-projects have graphs, where they live, and
 * an in-process build queue so two graphify runs never race on one project.
 * Persisted at <repo>/.baton/kb.json (gitignored, same as tasks.json).
 */
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { batonDir } from '../store.js';
import { readStats, type GraphStats } from './graphify.js';

export interface KbProject {
  id: string;
  name: string;
  path: string;      // absolute project dir
  graphPath: string; // <path>/graphify-out/graph.json
  /** ≈ tokens to read CODEBASE.md (the map) — set by refreshCodebaseDocs. */
  mapTokens?: number;
  /** ≈ tokens to read the whole project's files — the cost the map avoids. */
  repoTokens?: number;
}

export interface KbState {
  root: string;
  projects: KbProject[];
  mergedGraphPath: string | null; // .baton/kb/merged-graph.json when >1 project
  lastBuiltAt: string | null;
  /** Git-share mode: mirror shareable artifacts into a committed kb/ directory. */
  share?: boolean;
}

export function kbFile(root: string): string {
  return join(batonDir(root), 'kb.json');
}

export function mergedGraphFile(root: string): string {
  return join(batonDir(root), 'kb', 'merged-graph.json');
}

export function graphPathFor(projectPath: string): string {
  return join(projectPath, 'graphify-out', 'graph.json');
}

// Warn once per bad path — loadKb runs on 2s poll paths and must not spam.
const invalidWarned = new Set<string>();

/** Test-only: clear the warn-once memory between test cases. */
export function resetKbValidationWarnings(): void {
  invalidWarned.clear();
}

/**
 * A kb.json project entry is trusted only if its path realpath-resolves to the
 * Baton root or below AND is a directory containing `.git` (dir for a repo,
 * file for a git worktree). kb.json is plain JSON on disk — a tampered or
 * stale entry must not steer graphify spawns or stats reads elsewhere.
 */
async function isValidProject(root: string, p: KbProject): Promise<boolean> {
  try {
    const [realRoot, realProj] = await Promise.all([realpath(root), realpath(p.path)]);
    if (realProj !== realRoot && !realProj.startsWith(realRoot + sep)) throw new Error('outside the Baton root');
    if (!(await stat(p.path)).isDirectory()) throw new Error('not a directory');
    await stat(join(p.path, '.git')); // repo dir or worktree file — either is fine
    return true;
  } catch (e) {
    if (!invalidWarned.has(p.path)) {
      invalidWarned.add(p.path);
      console.warn(`[baton] kb.json: skipping project '${p.id}' — ${p.path}: ${(e as Error).message}`);
    }
    return false;
  }
}

export async function loadKb(root: string): Promise<KbState | null> {
  try {
    const raw = await readFile(kbFile(root), 'utf-8');
    const state = JSON.parse(raw) as KbState;
    const checks = await Promise.all(state.projects.map((p) => isValidProject(root, p)));
    state.projects = state.projects.filter((_, i) => checks[i]);
    return state;
  } catch {
    return null;
  }
}

export async function saveKb(root: string, state: KbState): Promise<void> {
  const file = kbFile(root);
  await mkdir(dirname(file), { recursive: true });
  // tmp + rename, like saveTasks: a torn kb.json is worse than a stale one —
  // loadKb() falling back to null makes hubClaimsProject() deny every checkout,
  // which silently re-enables shadow-.baton adoption (the P1 misrouting bug).
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  await rename(tmp, file);
}

export interface KbProjectStat extends KbProject {
  stats: GraphStats | null;
  building: boolean;
}

/** Project list + graph stats + live build flags, for /api/kb and `baton kb status`. */
export async function kbStatus(root: string): Promise<{
  state: KbState | null;
  projects: KbProjectStat[];
  merged: { stats: GraphStats | null; building: boolean } | null;
}> {
  const state = await loadKb(root);
  if (!state) return { state: null, projects: [], merged: null };
  const projects = await Promise.all(
    state.projects.map(async (p) => ({
      ...p,
      stats: await readStats(p.graphPath),
      building: buildQueue.isBuilding(p.id),
    })),
  );
  const merged = state.mergedGraphPath
    ? { stats: await readStats(state.mergedGraphPath), building: buildQueue.isBuilding('merged') }
    : null;
  return { state, projects, merged };
}

/**
 * Serialized build queue: at most one graphify process per project id, and
 * builds for the same id queue behind each other instead of racing.
 */
class BuildQueue {
  private chains = new Map<string, Promise<void>>();
  private active = new Set<string>();

  isBuilding(id: string): boolean {
    return this.active.has(id);
  }

  buildingIds(): string[] {
    return [...this.active];
  }

  enqueue(id: string, job: () => Promise<void>, onDone?: (err: Error | null) => void): void {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        this.active.add(id);
        try {
          await job();
          onDone?.(null);
        } catch (e) {
          onDone?.(e as Error);
        } finally {
          this.active.delete(id);
        }
      });
    this.chains.set(id, next.catch(() => undefined));
  }
}

export const buildQueue = new BuildQueue();
