/**
 * Knowledge-base state: which sub-projects have graphs, where they live, and
 * an in-process build queue so two graphify runs never race on one project.
 * Persisted at <repo>/.baton/kb.json (gitignored, same as tasks.json).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

export async function loadKb(root: string): Promise<KbState | null> {
  try {
    const raw = await readFile(kbFile(root), 'utf-8');
    return JSON.parse(raw) as KbState;
  } catch {
    return null;
  }
}

export async function saveKb(root: string, state: KbState): Promise<void> {
  const file = kbFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
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
