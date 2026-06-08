/**
 * `baton history [<file>]` — cheap bug-tracing/attribution from the local index.
 *
 * With a file path: shows which task/agent/commits touched it (newest first).
 * Without: lists tasks and their commit counts. Designed for low token cost —
 * an agent reads a few rows instead of scanning the whole git log.
 */
import { gitRoot } from '../git.js';
import { listHistory, queryFile } from '../history.js';

export async function historyCmd(file?: string): Promise<void> {
  const root = await gitRoot();

  if (file) {
    const hits = queryFile(root, file);
    if (hits.length === 0) {
      console.log(`No recorded changes to '${file}'. (Only merged tasks are indexed.)`);
      return;
    }
    console.log(`Changes to ${file}:`);
    for (const h of hits) {
      const when = h.at ? h.at.slice(0, 10) : '';
      console.log(
        `  ${h.sha.slice(0, 8)}  ${when}  [${h.agent ?? '?'} · ${h.slug}]  ${h.message}`,
      );
    }
    return;
  }

  const tasks = listHistory(root);
  if (tasks.length === 0) {
    console.log('No history yet. (Tasks are indexed on creation; commits on merge.)');
    return;
  }
  for (const t of tasks) {
    const status = t.mergedAt ? `merged ${t.mergedAt.slice(0, 10)}` : 'open';
    console.log(`${t.slug}  [${t.agent ?? '?'}]  ${t.commits.length} commits  (${status})  ${t.task}`);
  }
}
