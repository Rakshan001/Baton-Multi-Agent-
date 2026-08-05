/**
 * `baton ls` — the board.
 *
 * Two shapes, chosen by the data rather than by a flag. With no phased tasks it
 * is the flat worktree table it has always been. Once a plan is applied it
 * groups by phase and says which phase is open, because "what may I start now"
 * is the only question a five-agent board is actually asked.
 */
import { aheadBehind, worktreeStatus } from '../git.js';
import { activeBatonRoot, isMaterialized, loadTasks, type Task } from '../store.js';
import { blockers, openPhase, phaseOf, stateOf } from '../pipeline.js';

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Git state, or `queued` for a task that has no worktree yet.
 *
 * The guard is load-bearing twice over. `worktreeStatus` reports a failed call
 * as `clean`, so without it every unclaimed task on the board reads as a tidy
 * checkout — and a 40-task plan would spawn 80 git subprocesses to say so.
 */
async function gitCells(t: Task, root: string): Promise<{ status: string; sync: string }> {
  // Not "clean" — there is no worktree to be clean. The state column already
  // says queued; this column is git's answer, and git has none.
  if (!isMaterialized(t)) return { status: '—', sync: '·' };
  const [status, { ahead, behind }] = await Promise.all([
    worktreeStatus(t.worktreePath),
    aheadBehind(t.branch, t.baseBranch, t.repoRoot ?? root),
  ]);
  return { status: status.state, sync: ahead || behind ? `+${ahead}/-${behind}` : '·' };
}

interface Row {
  slug: string; state: string; status: string; sync: string;
  age: string; task: string; who: string;
}

async function rowsFor(tasks: Task[], root: string): Promise<Row[]> {
  return Promise.all(tasks.map(async (t) => ({
    slug: t.slug,
    state: stateOf(t),
    ...(await gitCells(t, root)),
    age: age(t.createdAt),
    task: t.task,
    who: t.claimedBy?.agent ?? (t.assignee ? `${t.assignee} (assigned)` : ''),
  })));
}

function widths(rows: Row[]): { slug: number; state: number; status: number; sync: number; who: number } {
  return {
    slug: Math.max(4, ...rows.map((r) => r.slug.length)),
    state: Math.max(5, ...rows.map((r) => r.state.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    sync: Math.max(4, ...rows.map((r) => r.sync.length)),
    who: Math.max(0, ...rows.map((r) => r.who.length)),
  };
}

/** ✓ finished · ● someone has it · ○ free to start · ⊘ needs a human. */
function bullet(state: string): string {
  return state === 'done' ? '✓'
    : state === 'cancelled' ? '✗'
    : state === 'blocked' ? '⊘'
    : state === 'queued' ? '○'
    : '●';
}

function flatTable(rows: Row[]): void {
  const w = widths(rows);
  console.log(`${pad('SLUG', w.slug)}  ${pad('STATUS', w.status)}  ${pad('SYNC', w.sync)}  AGE   TASK`);
  for (const r of rows) {
    console.log(`${pad(r.slug, w.slug)}  ${pad(r.status, w.status)}  ${pad(r.sync, w.sync)}  ${pad(r.age, 4)}  ${r.task}`);
  }
}

export async function lsCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const tasks = await loadTasks(root);

  if (tasks.length === 0) {
    console.log('No tasks. Create one: baton new "<task>", or apply a plan: baton plan apply <name>');
    return;
  }

  const phased = tasks.filter((t) => phaseOf(t) >= 1);
  const rows = await rowsFor(tasks, root);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  if (phased.length === 0) {
    flatTable(rows);
    return;
  }

  const open = openPhase(tasks);
  const w = widths(rows);
  const numbers = [...new Set(tasks.map(phaseOf))].sort((a, b) => a - b);

  for (const n of numbers) {
    const inPhase = tasks.filter((t) => phaseOf(t) === n);
    // Phase 0 is the ungated bucket — hand-made tasks and anything recorded
    // before plans existed. It is never gated and never gates anything.
    const heading = n === 0 ? 'UNPHASED'
      : n < open ? `PHASE ${n}  ✓ complete`
      : n === open ? `PHASE ${n}  ← open`
      : `PHASE ${n}  locked behind phase ${open}`;
    console.log(`\n${heading}`);
    for (const t of inPhase) {
      const r = bySlug.get(t.slug);
      if (!r) continue;
      const dep = (t.dependsOn ?? []).length ? `  after ${(t.dependsOn ?? []).join(', ')}` : '';
      console.log(
        `  ${bullet(r.state)} ${pad(r.slug, w.slug)}  ${pad(r.state, w.state)}  ${pad(r.status, w.status)}  ${pad(r.sync, w.sync)}  ${pad(r.who, w.who)}  ${r.task}${dep}`,
      );
    }
  }

  // An agent — or a person — told only "nothing to do" cannot tell a finished
  // plan from a wedged one. Say which it is.
  const blocked = blockers(tasks);
  if (open === Infinity) {
    console.log('\n✓ every phase complete.');
  } else if (blocked.length) {
    const waiting = blocked.filter((b) => b.reason.startsWith('blocked'));
    if (waiting.length) {
      console.log(`\n⊘ ${waiting.length} task${waiting.length === 1 ? '' : 's'} waiting on a decision:`);
      for (const b of waiting) console.log(`    ${b.slug}: ${b.reason}`);
    }
  }
}
