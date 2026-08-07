/**
 * Who decides a task claim, when there is more than one machine.
 *
 * `.baton/tasks.lock` makes the claim a compare-and-swap, which settles every
 * race between agents on ONE machine. It settles nothing between two. Two
 * laptops each hold their own lock, each read their own `tasks.json`, and each
 * conclude they won — and the pipeline's entire reason for existing is that
 * exactly one agent works a task at a time.
 *
 * So §1.1 names one arbiter per mode: the lock when solo, **the hub when team**.
 * This module is the member half of that.
 *
 * ## Fail closed, and only here
 *
 * §7.6 splits the two directions deliberately, and the asymmetry is the point:
 *
 * - **Reads degrade open.** `src/remote-claims.ts` answers "I could not ask"
 *   rather than "nobody is there", and work continues. Withholding a read would
 *   stop an agent that has every right to proceed.
 * - **Claims fail closed.** A claim we could not put to the hub is a claim
 *   nobody arbitrated. Granting it locally is precisely the double-claim this
 *   design exists to prevent, and the cost of being wrong is asymmetric: a
 *   refused claim is a retry, a double claim is two agents writing one worktree
 *   and one of them losing work.
 *
 * A machine with no `.baton/host.json` is SOLO and makes no network call at all
 * — not a fast one, none. That is the overwhelmingly common case and it must
 * behave exactly as it always has.
 */
import { loadHostLink } from './host-link.js';
import type { Task } from './store.js';
import type { Who } from './lifecycle.js';

/** A claim is on the critical path of `baton take`, so the wait is short. */
const TIMEOUT_MS = 5000;

export interface Arbitration {
  /**
   * True when no hub was asked because none is linked. The local lock is the
   * arbiter, exactly as it was before team mode existed.
   */
  solo: boolean;
  /** The hub's own row for the task, when it granted the claim. */
  task?: Task;
}

/**
 * The hub said no, or could not be asked. Carries the hub's refusal code when
 * there is one; `unreachable` is ours.
 */
export class ArbiterRefused extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ArbiterRefused';
    this.code = code;
  }
}

interface ClaimReply {
  ok?: boolean;
  task?: Task;
  code?: string;
  error?: string;
}

/** Is this machine a member of a hub? Team mode is exactly "a host link exists". */
export async function isTeamMode(root: string): Promise<boolean> {
  return (await loadHostLink(root)) !== null;
}

/**
 * Ask the hub to claim `slug` for `who`.
 *
 * Returns `{ solo: true }` on an unlinked machine — the caller then claims
 * locally as before. Otherwise it either returns the hub's granted row or
 * throws: there is no third answer, because "we are not sure" is the one
 * outcome that must not become a worktree.
 */
export async function claimUpstream(root: string, slug: string, who: Who): Promise<Arbitration> {
  const link = await loadHostLink(root);
  if (!link) return { solo: true };

  let res: Response;
  try {
    res = await fetch(`${link.url}/api/pipeline/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.token}` },
      // Identity is NOT taken from this body by the hub — it resolves the member
      // from the token. `agent` and `sessionSlug` describe which of this
      // machine's sessions is asking, which the hub cannot know and does not
      // authorize on.
      body: JSON.stringify({ slug, agent: who.agent, sessionSlug: who.sessionSlug }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ArbiterRefused(
      `the hub at ${link.url} could not be reached (${(e as Error).message}), so '${slug}' was not claimed.\n`
      + '  In team mode the hub is the only thing that can say nobody else is already on this task.\n'
      + '  Retry when it is back, or work solo here with: baton host clear',
      'hub-unreachable',
    );
  }

  const body = await res.json().catch(() => ({})) as ClaimReply;
  if (res.ok && body.ok && body.task) return { solo: false, task: body.task };

  // 409 is the hub applying the pipeline's own rules — held, not eligible, no
  // such task. Its message is already phrased for whoever typed the command, so
  // it is passed through rather than re-worded into something vaguer.
  if (res.status === 409 && body.error) throw new ArbiterRefused(body.error, body.code ?? 'held');
  if (res.status === 401 || res.status === 403) {
    throw new ArbiterRefused(
      `the hub at ${link.url} rejected this machine (${res.status}) — '${slug}' was not claimed.\n`
      + '  The member token may have been revoked. Ask the operator, or: baton host clear',
      'hub-rejected',
    );
  }
  throw new ArbiterRefused(
    `the hub at ${link.url} replied ${res.status}${body.error ? ` — ${body.error}` : ''}, so '${slug}' was not claimed.`,
    'hub-error',
  );
}

/**
 * Give a claim back to the hub. Best effort, and deliberately silent.
 *
 * Called when the hub granted a claim the member could not then act on — the
 * worktree failed to build, say. Leaving the hub's row held would take the task
 * out of circulation for everyone with nothing running behind it. But this is
 * the ERROR path: the caller already has a real failure to report, and burying
 * it under a second one about the network helps nobody. The claim TTLs into a
 * stalled task the operator can see either way.
 */
export async function releaseUpstream(root: string, slug: string, who: Who): Promise<void> {
  const link = await loadHostLink(root);
  if (!link) return;
  try {
    await fetch(`${link.url}/api/pipeline/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.token}` },
      body: JSON.stringify({ slug, sessionSlug: who.sessionSlug }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { /* see above — the caller's own error is the one worth reporting */ }
}
