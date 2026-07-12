/**
 * `baton orient [--auto]` — print a budgeted project-orientation brief.
 *
 * Interactive: prints the brief to stdout for a human or any agent.
 * --auto (the Claude SessionStart hook): emits the brief as
 * hookSpecificOutput.additionalContext, UNLESS this session was baton-spawned
 * into a worktree that already carries a HANDOFF brief — the spawn path
 * (src/spawn.ts) already injected orientation, so re-serving it would just burn
 * tokens on a duplicate.
 */
import { orientForCwd } from '../kb/orient.js';
import { readBrief } from '../handoff/brief.js';
import { gitRoot } from '../git.js';

export async function orientCmd(opts: { auto?: boolean } = {}): Promise<void> {
  const brief = await orientForCwd();

  if (!opts.auto) {
    console.log(brief);
    return;
  }

  // --auto dedup: skip when a fresh HANDOFF brief already oriented this session.
  try {
    const wt = await gitRoot();
    const handoff = await readBrief(wt);
    if (handoff && handoff.meta.status !== 'done') return; // already oriented by the spawn path
  } catch { /* not in a worktree — fall through and emit */ }

  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } }));
}
