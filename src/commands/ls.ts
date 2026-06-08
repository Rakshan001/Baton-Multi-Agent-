/**
 * `baton ls` — list tasks with their branch, git status, ahead/behind, and age.
 */
import { aheadBehind, gitRoot, worktreeStatus } from '../git.js';
import { loadTasks } from '../store.js';

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

export async function lsCmd(): Promise<void> {
  const root = await gitRoot();
  const tasks = await loadTasks(root);

  if (tasks.length === 0) {
    console.log('No tasks. Create one: baton new "<task>"');
    return;
  }

  const rows = await Promise.all(
    tasks.map(async (t) => {
      const status = await worktreeStatus(t.worktreePath);
      const { ahead, behind } = await aheadBehind(t.branch, t.baseBranch, root);
      const sync = ahead || behind ? `+${ahead}/-${behind}` : '·';
      return {
        slug: t.slug,
        status: status.state,
        sync,
        age: age(t.createdAt),
        task: t.task,
      };
    }),
  );

  const w = {
    slug: Math.max(4, ...rows.map((r) => r.slug.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    sync: Math.max(4, ...rows.map((r) => r.sync.length)),
  };

  console.log(
    `${pad('SLUG', w.slug)}  ${pad('STATUS', w.status)}  ${pad('SYNC', w.sync)}  AGE   TASK`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.slug, w.slug)}  ${pad(r.status, w.status)}  ${pad(r.sync, w.sync)}  ${pad(r.age, 4)}  ${r.task}`,
    );
  }
}
