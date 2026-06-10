/**
 * `baton status [--watch]` — central view of all sessions:
 * task · live agent · git status · ahead/behind · likely conflicts.
 */
import { basename } from 'node:path';
import { collectStatus } from '../board.js';
import { gitRoot } from '../git.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function buildTable(): Promise<string> {
  const root = await gitRoot();
  const rows = await collectStatus(root);
  if (rows.length === 0) {
    return 'No tasks. Create one: baton new "<task>"';
  }

  const display = rows.map((r) => ({
    slug: r.slug,
    agent: r.agent ? `${r.agent}●` : '–',
    // An in-progress git op (merging/rebasing) is more actionable than "dirty".
    status: r.repoState === 'clean' ? r.status : r.repoState,
    sync: r.ahead || r.behind ? `+${r.ahead}/-${r.behind}` : '·',
    changes:
      r.filesChanged === 0 && r.insertions === 0 && r.deletions === 0
        ? '·'
        : `${r.filesChanged}f +${r.insertions}/-${r.deletions}`,
    conflict:
      r.conflictFiles.length === 0
        ? '–'
        : `⚠ ${r.conflictFiles.map((f) => basename(f)).slice(0, 3).join(', ')}${r.conflictFiles.length > 3 ? '…' : ''}`,
  }));

  const w = {
    slug: Math.max(4, ...display.map((r) => r.slug.length)),
    agent: Math.max(5, ...display.map((r) => r.agent.length)),
    status: Math.max(6, ...display.map((r) => r.status.length)),
    sync: Math.max(4, ...display.map((r) => r.sync.length)),
    changes: Math.max(7, ...display.map((r) => r.changes.length)),
  };

  const lines = [
    `${pad('TASK', w.slug)}  ${pad('AGENT', w.agent)}  ${pad('STATUS', w.status)}  ${pad('SYNC', w.sync)}  ${pad('CHANGES', w.changes)}  CONFLICT`,
  ];
  for (const r of display) {
    lines.push(
      `${pad(r.slug, w.slug)}  ${pad(r.agent, w.agent)}  ${pad(r.status, w.status)}  ${pad(r.sync, w.sync)}  ${pad(r.changes, w.changes)}  ${r.conflict}`,
    );
  }
  return lines.join('\n');
}

export async function statusCmd(opts: { watch?: boolean } = {}): Promise<void> {
  if (!opts.watch) {
    console.log(await buildTable());
    return;
  }

  const tick = async () => {
    const table = await buildTable();
    console.clear();
    console.log(table);
    console.log('\n(watching every 2s — Ctrl+C to exit)');
  };

  await tick();
  const interval = setInterval(() => {
    void tick().catch((e) => console.error(`error: ${(e as Error).message}`));
  }, 2000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('');
    process.exit(0);
  });
}
