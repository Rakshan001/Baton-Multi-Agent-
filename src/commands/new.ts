/**
 * `baton new "<task>"` — scaffold a branch + worktree for a task, record it,
 * and print the path to cd into and launch your own agent.
 *
 * Branch/base-commit recording pattern adapted from rover's TaskSetup.initial()
 * (.refs/rover/packages/cli/src/lib/task-setup.ts, Apache-2.0). See NOTICE.
 */
import { join } from 'node:path';
import { branchExists, createWorktree, currentBranch, headCommit, isGitRepo } from '../git.js';
import { recordTask } from '../history.js';
import { addTask, batonDir, loadTasks, resolveBatonRoot, slugify, type Task } from '../store.js';
import { loadKb } from '../kb/state.js';
import { bus } from '../events.js';

/**
 * Core create logic, shared by the CLI (`baton new`) and the HTTP API
 * (`POST /api/tasks`). Scaffolds a branch + worktree, records the task, and
 * returns it. Throws `EmptyTaskError` when the description is blank.
 */
export class EmptyTaskError extends Error {
  constructor() {
    super('Task description is required');
    this.name = 'EmptyTaskError';
  }
}

/** The Baton root is a multi-repo hub (not a git repo) but no sub-project was chosen. */
export class ProjectRequiredError extends Error {
  projects: string[];
  constructor(projects: string[]) {
    super(
      projects.length
        ? `This is a multi-repo hub — choose a project for the task (one of: ${projects.join(', ')})`
        : 'This is a multi-repo hub with no indexed projects — run `baton kb init` first',
    );
    this.name = 'ProjectRequiredError';
    this.projects = projects;
  }
}

/** A projectId was given that doesn't match any sub-project in kb.json. */
export class UnknownProjectError extends Error {
  projectId: string;
  constructor(projectId: string) {
    super(`No sub-project '${projectId}' in this hub — see: baton kb status`);
    this.name = 'UnknownProjectError';
    this.projectId = projectId;
  }
}

/**
 * @param root      the Baton root (owns `.baton/`); a single repo or a hub folder.
 * @param projectId in a hub, which sub-project's git repo the worktree branches off.
 */
export async function createTask(taskText: string, root?: string, projectId?: string): Promise<Task> {
  const text = taskText?.trim();
  if (!text) throw new EmptyTaskError();

  const batonRoot = root ?? (await resolveBatonRoot());

  // Resolve the git repo the worktree/branch lives in. In a hub that's the
  // chosen sub-project; in a single repo it's the Baton root itself.
  let gitRepo = batonRoot;
  let resolvedProjectId: string | undefined;
  if (projectId) {
    const kb = await loadKb(batonRoot);
    const proj = kb?.projects.find((p) => p.id === projectId);
    if (!proj) throw new UnknownProjectError(projectId);
    gitRepo = proj.path;
    resolvedProjectId = proj.id;
  } else if (!(await isGitRepo(batonRoot))) {
    // A hub root isn't a git repo — a worktree needs a real repo to branch from.
    const kb = await loadKb(batonRoot);
    throw new ProjectRequiredError(kb?.projects.map((p) => p.id) ?? []);
  }

  const existing = await loadTasks(batonRoot);
  // Dedupe against recorded tasks first, then against actual git branches so we
  // never collide with a `baton/<slug>` branch baton didn't record.
  const taken = existing.map((t) => t.slug);
  let slug = slugify(text, taken);
  while (await branchExists(`baton/${slug}`, gitRepo)) {
    taken.push(slug);
    slug = slugify(text, taken);
  }
  const branch = `baton/${slug}`;
  const worktreePath = join(batonDir(batonRoot), 'wt', slug);
  const baseBranch = await currentBranch(gitRepo);

  await createWorktree(worktreePath, branch, 'HEAD', gitRepo);
  const baseCommit = await headCommit(worktreePath);

  const task: Task = {
    slug,
    task: text,
    branch,
    worktreePath,
    baseBranch,
    baseCommit,
    projectId: resolvedProjectId,
    repoRoot: gitRepo,
    createdAt: new Date().toISOString(),
  };
  await addTask(batonRoot, task);
  recordTask(batonRoot, { slug, task: text, branch, baseBranch, createdAt: task.createdAt });
  bus.publish({ type: 'task.created', slug, task: text });
  return task;
}

export async function newCmd(taskText: string, opts: { project?: string } = {}): Promise<void> {
  if (!taskText?.trim()) {
    console.error('Usage: baton new "<task description>" [--project <id>]');
    process.exitCode = 1;
    return;
  }

  let task;
  try {
    task = await createTask(taskText, undefined, opts.project);
  } catch (e) {
    // In a hub the task must name a sub-project — guide the user instead of a raw throw.
    if (e instanceof ProjectRequiredError || e instanceof UnknownProjectError) {
      console.error(`✗ ${e.message}`);
      if (e instanceof ProjectRequiredError && e.projects.length) {
        console.error(`  e.g. baton new "${taskText.trim()}" --project ${e.projects[0]}`);
      }
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  console.log(`✓ created ${task.branch}${task.projectId ? ` in ${task.projectId}` : ''}`);
  console.log(`  worktree: ${task.worktreePath}`);
  console.log('');
  console.log('  Launch your agent there:');
  console.log(`    cd ${task.worktreePath}`);
}
