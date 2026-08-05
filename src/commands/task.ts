/**
 * `baton task add "<what>"` — queue one task without writing a plan file.
 *
 * The plan file is the right tool for a body of work with phases. This is for
 * the thing you noticed halfway through: same queued row, same barrier, no
 * ceremony. It creates NOTHING on disk — no branch, no worktree — so adding a
 * task you may never start costs a JSON row.
 */
import { activeBatonRoot, batonDir, isMaterialized, mutateTasks, slugify, type Task } from '../store.js';
import { overlappingPair } from '../plan.js';
import { phaseOf, stateOf } from '../pipeline.js';
import { join } from 'node:path';

export interface TaskAddOpts {
  phase?: string;
  after?: string;
  assignee?: string;
  scope?: string;
  expects?: string;
}

const list = (v?: string): string[] =>
  (v ?? '').split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);

export async function taskAddCmd(text: string, opts: TaskAddOpts = {}): Promise<void> {
  const root = await activeBatonRoot();

  const phase = opts.phase === undefined ? 0 : Number(opts.phase);
  if (!Number.isInteger(phase) || phase < 0) {
    console.error(`--phase must be a non-negative whole number (got '${opts.phase}')`);
    process.exitCode = 1;
    return;
  }
  const dependsOn = list(opts.after);
  const scope = list(opts.scope);
  const expects = (opts.expects ?? '').split(';').map((s) => s.trim()).filter(Boolean);

  const problems: string[] = [];
  const warnings: string[] = [];

  const created = await mutateTasks(root, (tasks) => {
    const bySlug = new Map(tasks.map((t) => [t.slug, t]));

    for (const d of dependsOn) {
      const dep = bySlug.get(d);
      // Unsatisfiable either way, and unsatisfiable is never what someone meant:
      // a missing dependency never arrives, and one in a later phase is waiting
      // on the barrier that is waiting on it.
      if (!dep) problems.push(`no task '${d}' to depend on`);
      else if (phase >= 1 && phaseOf(dep) > phase) {
        problems.push(`'${d}' is in phase ${phaseOf(dep)}, later than ${phase} — that can never be satisfied`);
      }
    }

    // Scope overlap only WARNS here, unlike in a plan. Same rule, different
    // room: a plan is applied unattended, while this command has a human in
    // front of it who may know the two tasks will not really collide.
    if (phase >= 1 && scope.length) {
      for (const t of tasks) {
        if (phaseOf(t) !== phase || stateOf(t) === 'done' || stateOf(t) === 'cancelled') continue;
        const hit = overlappingPair(scope, t.scope ?? []);
        if (hit) warnings.push(`scope ${hit[0]} overlaps '${t.slug}' (${hit[1]}) in the same phase — they run in parallel`);
      }
    }

    if (problems.length) return { tasks: null, result: null };

    const slug = slugify(text, tasks.map((t) => t.slug));
    const task: Task = {
      slug,
      task: text.trim(),
      branch: `baton/${slug}`,
      worktreePath: join(batonDir(root), 'wt', slug),
      baseBranch: 'HEAD',
      baseCommit: null,
      createdAt: new Date().toISOString(),
      phase,
      dependsOn,
      assignee: opts.assignee ?? null,
      scope,
      expects,
      state: 'queued',
    };
    return { tasks: [...tasks, task], result: task };
  });

  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (!created) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ queued ${created.slug}${created.phase ? ` in phase ${created.phase}` : ''}`);
  if (created.assignee) console.log(`  assigned to ${created.assignee}`);
  if (created.dependsOn?.length) console.log(`  after ${created.dependsOn.join(', ')}`);
  if (created.scope?.length) console.log(`  scope ${created.scope.join(', ')}`);
  console.log('  nothing created on disk yet — the worktree appears when an agent takes it.');
}

/** `baton task rm <slug>` — drop a queued task that never started. */
export async function taskRmCmd(slug: string): Promise<void> {
  const root = await activeBatonRoot();
  const outcome = await mutateTasks(root, (tasks) => {
    const t = tasks.find((x) => x.slug === slug);
    if (!t) return { tasks: null, result: 'missing' as const };
    // Anything with a worktree behind it goes through `baton rm`, which knows how
    // to take a branch and a directory away. Deleting the row here would leave
    // both on disk with nothing pointing at them.
    if (isMaterialized(t) || stateOf(t) !== 'queued') return { tasks: null, result: 'started' as const };
    return { tasks: tasks.filter((x) => x.slug !== slug), result: 'gone' as const };
  });

  if (outcome === 'missing') {
    console.error(`No task '${slug}'. See: baton ls`);
    process.exitCode = 1;
  } else if (outcome === 'started') {
    console.error(`'${slug}' has work behind it — remove its worktree and branch with: baton rm ${slug}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ removed ${slug}`);
  }
}
