// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two write verbs behind `GET /api/worktrees` — the plan's `wt-write-verbs`.
 *
 * `src/worktrees.ts` answers "which worktrees exist, who holds them, and is
 * that holder still alive". Until these routes existed there was nothing a
 * human could DO about the answer: `src/server.ts` imports only
 * `cancelTasks, claim, releaseClaim` from the lifecycle module, `POST
 * /api/pipeline/claim` refuses a task that is already `active`, and MCP is
 * stdio-only (`src/mcp.ts:675`) so a browser cannot reach `take_task
 * {resume:true}` either. "Hand this worktree to another agent" was unreachable
 * from any HTTP client.
 *
 * Both handlers are thin on purpose. The DECISIONS all belong to the pure
 * functions in `src/lifecycle.ts`, run inside `mutateTasks` so the check and
 * the write happen against the same list under the same lock. A second copy of
 * the barrier here would be worse than none: two implementations that disagree
 * both report success.
 *
 * What that means for `takeover`: its refusal at `src/lifecycle.ts:165-168` —
 * *"Two agents in one worktree is the failure this prevents"* — is carried out
 * VERBATIM as a 409 and never softened. A stall guard that a button can talk
 * its way past is not a guard, and the thing on the other side of it is
 * somebody's dirty worktree: handing it over is a data-loss operation, not a
 * retry.
 *
 * No Origin check lives here. The anti-CSRF gate in `src/server.ts` covers
 * every mutating `/api/` request centrally and deliberately, and a per-endpoint
 * copy is the drift the CSRF decision record (docs/decisions.md) forbids. The
 * `--write` gate stays in the route table too, beside every other write, so
 * these verbs are refused by the same `read-only` error as the rest.
 */
import { randomBytes } from 'node:crypto';
import { pause, takeover, type Refusal, type Who } from '../lifecycle.js';
import { livenessProbe } from '../liveness.js';
import { mutateTasks } from '../store.js';
import type { Task } from '../store.js';

/** What the route layer sends. Status is chosen here so the two verbs cannot
 *  drift apart on what a refusal costs. */
export interface VerbReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A refusal, as JSON.
 *
 * 409 rather than 400 for everything but a name that does not exist: the
 * request was well-formed and the STATE said no, which is the same distinction
 * `/api/pipeline/claim` draws (server.ts:1624). `missing` is the one honest
 * 404 — a caller typing a slug that no task owns needs to tell "no such thing"
 * apart from "exists, but not yours to take".
 */
function refuse(refusal: Refusal): VerbReply {
  return {
    status: refusal.code === 'missing' ? 404 : 409,
    // `error` is the pipeline's own wording, passed through untouched. The
    // human reading the dashboard gets the sentence the CLI would have given
    // them, not a second vocabulary invented in front of it.
    body: { ok: false, code: refusal.code, error: refusal.message },
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface TakeoverBody {
  agent?: unknown;
  sessionSlug?: unknown;
}

/**
 * `POST /api/worktrees/:slug/takeover` — adopt work that went quiet.
 *
 * The caller names the agent that is taking over; the session is minted here
 * when they cannot name one, because an HTTP client has no session of its own
 * and `takeover` compares sessions to catch "this is already yours"
 * (lifecycle.ts:162). A minted value is random, so it can never collide with
 * the displaced holder's and silently turn a takeover into a no-op.
 */
export async function takeoverWorktree(
  root: string,
  slug: string,
  body: TakeoverBody | null,
): Promise<VerbReply> {
  const agent = str(body?.agent);
  if (!agent) return { status: 400, body: { error: 'pass agent — the agent adopting this worktree' } };
  const who: Who = { agent, sessionSlug: str(body?.sessionSlug) || `takeover-${randomBytes(4).toString('hex')}` };

  /*
   * Built BEFORE the mutation, like `resolveGate` is at server.ts:1600:
   * `livenessProbe` reads the presence table once and then walks each
   * worktree's mtimes, and slow work has no business inside the tasks lock.
   * The walk itself is capped at 2000 entries / depth 6 (liveness.ts:33-37),
   * and the cap can only make liveness look OLDER — so the failure direction
   * is refusing a takeover we might have allowed, which is the safe one.
   */
  const stall = { now: Date.now(), livenessOf: livenessProbe(root) };
  const outcome = await mutateTasks(root, (tasks: readonly Task[]) => {
    const out = takeover(tasks, slug, who, new Date().toISOString(), stall);
    return { tasks: out.ok ? out.tasks : null, result: out };
  });
  if (!outcome.ok) return refuse(outcome.refusal);
  return { status: 200, body: { ok: true, task: outcome.task } };
}

export interface PauseBody {
  reason?: unknown;
  agent?: unknown;
}

/**
 * `POST /api/worktrees/:slug/pause` — hand the task back deliberately.
 *
 * `reason` is recorded as `stoppedReason` so the row says WHY it stopped. An
 * interruption with no stated cause is indistinguishable from a crash, which is
 * the confusion this whole plan exists to remove — but it is not required,
 * because refusing to record a stop at all would leave the task looking live,
 * and that is the worse of the two outcomes.
 *
 * `agent` defaults to the current holder. `pause` refuses to let one agent hand
 * back another's task (lifecycle.ts:192), and that rule is about AGENTS racing
 * each other; the caller here is a human at a loopback-bound daemon pausing on
 * the holder's behalf. Pass `agent` explicitly to get the guard back — a
 * mismatch then refuses with `not-yours`, exactly as the CLI would.
 */
export async function pauseWorktree(
  root: string,
  slug: string,
  body: PauseBody | null,
): Promise<VerbReply> {
  const reason = str(body?.reason);
  const asked = str(body?.agent);
  const outcome = await mutateTasks(root, (tasks: readonly Task[]) => {
    const held = tasks.find((t) => t.slug === slug);
    const who: Who = {
      agent: asked || held?.claimedBy?.agent || '',
      // Unused by `pause` — it decides on the agent handle, not the session —
      // but `Who` is one shape across the lifecycle and faking a session here
      // would invent an identity nothing asked for.
      sessionSlug: held?.claimedBy?.sessionSlug ?? '',
    };
    const out = pause(tasks, slug, who, new Date().toISOString(), reason || undefined);
    return { tasks: out.ok ? out.tasks : null, result: out };
  });
  if (!outcome.ok) return refuse(outcome.refusal);
  return { status: 200, body: { ok: true, task: outcome.task } };
}
