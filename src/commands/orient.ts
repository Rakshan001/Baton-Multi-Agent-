/**
 * `baton orient [--auto]` — print a budgeted project-orientation brief.
 *
 * Interactive: prints the brief to stdout for a human or any agent.
 * --auto (the Claude SessionStart hook): emits durable orientation as
 * hookSpecificOutput.additionalContext. When the worktree carries an active
 * HANDOFF brief, orientation is MERGED with a tiny continuation head (ISS-01/
 * ISS-02) so a manually-launched agent picks up the task instead of starting
 * blind — the two used to be mutually exclusive, which left manual launches with
 * neither. A baton-SPAWNED session already has the full brief in its prompt
 * (BATON_SLUG is set), so it gets orientation only — no duplicate head.
 */
import { orientForCwd } from '../kb/orient.js';
import { readBrief } from '../handoff/brief.js';
import { renderContinuationHead } from '../handoff/continuation.js';
import { gitRoot } from '../git.js';

export async function orientCmd(opts: { auto?: boolean } = {}): Promise<void> {
  const brief = await orientForCwd();

  if (!opts.auto) {
    console.log(brief);
    return;
  }

  const context = await withContinuationHead(brief);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}

/**
 * Append the continuation head to orientation when an active handoff exists AND
 * this is a manual launch (not baton-spawned — a spawned session already carries
 * the full brief in its prompt). Best-effort: any failure falls back to plain
 * orientation, never blocking session start.
 */
async function withContinuationHead(orientation: string): Promise<string> {
  // A baton-spawned session got the whole brief as its prompt already.
  if (process.env.BATON_SLUG) return orientation;
  try {
    const wt = await gitRoot();
    const handoff = await readBrief(wt);
    if (!handoff || handoff.meta.status === 'done') return orientation;
    const head = renderContinuationHead(handoff.meta, handoff.body);
    return head ? `${orientation}\n\n---\n\n${head}` : orientation;
  } catch {
    return orientation; // not in a worktree, or no readable brief — orient only
  }
}
