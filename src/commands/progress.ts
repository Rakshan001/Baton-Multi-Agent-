/**
 * `baton progress "<note>"` — report what this session is working on, for
 * shell-driven / interactive agents that aren't calling the MCP tool. Surfaced
 * to siblings via check_files/list_signals; expires in 30 min, clears on commit.
 */
import { resolveMcpRoot } from '../store.js';
import { gitRoot } from '../git.js';
import { setProgress } from '../signals.js';
import { slugFromWorktreePath } from './guard.js';

export async function progressCmd(note: string): Promise<void> {
  const text = note.trim();
  if (!text) {
    console.error('nothing to report — pass a one-line note, e.g. baton progress "refactoring auth, ~2 commits left"');
    process.exitCode = 1;
    return;
  }
  const slug = process.env.BATON_SLUG?.trim() || slugFromWorktreePath(await gitRoot().catch(() => ''));
  if (!slug) {
    console.error('no task identity — run this inside a baton worktree (or set BATON_SLUG).');
    process.exitCode = 1;
    return;
  }
  setProgress(await resolveMcpRoot(), slug, text.slice(0, 200));
  console.log(`✓ reported for ${slug}: ${text}`);
}
