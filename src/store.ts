/**
 * Tiny JSON store for Baton tasks, kept at <repo>/.baton/tasks.json (gitignored).
 * One file, no database — sufficient at this scale.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Task {
  slug: string;
  task: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string | null;
  createdAt: string; // ISO
}

/** Thrown when a slug doesn't resolve to a recorded task. */
export class TaskNotFoundError extends Error {
  slug: string;
  constructor(slug: string) {
    super(`No task '${slug}'`);
    this.name = 'TaskNotFoundError';
    this.slug = slug;
  }
}

export function batonDir(gitRoot: string): string {
  return join(gitRoot, '.baton');
}

export function tasksFile(gitRoot: string): string {
  return join(batonDir(gitRoot), 'tasks.json');
}

export async function loadTasks(gitRoot: string): Promise<Task[]> {
  try {
    const raw = await readFile(tasksFile(gitRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  } catch {
    return []; // missing/empty/corrupt → start fresh
  }
}

export async function saveTasks(gitRoot: string, tasks: Task[]): Promise<void> {
  const file = tasksFile(gitRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(tasks, null, 2) + '\n', 'utf-8');
}

export async function getTask(gitRoot: string, slug: string): Promise<Task | undefined> {
  return (await loadTasks(gitRoot)).find((t) => t.slug === slug);
}

export async function addTask(gitRoot: string, task: Task): Promise<void> {
  const tasks = await loadTasks(gitRoot);
  tasks.push(task);
  await saveTasks(gitRoot, tasks);
}

export async function removeTask(gitRoot: string, slug: string): Promise<void> {
  const tasks = (await loadTasks(gitRoot)).filter((t) => t.slug !== slug);
  await saveTasks(gitRoot, tasks);
}

/** kebab-case slug from free text, made unique against `taken`. */
export function slugify(text: string, taken: string[] = []): string {
  let base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (!base) base = 'task';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
