// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The authorization boundary, as ONE pure function.
 *
 * This lives apart from `server.ts` on purpose. Access control that is spread
 * across a request handler as inline branches is control nobody can review and
 * nobody can test without a socket; as a pure function it is both. `server.ts`
 * calls `decideAccess` once and does what it says.
 *
 * The rules, in order:
 *
 * 1. A LOOPBACK connection keeps the historical behaviour exactly — no
 *    credential. Baton is local-first and that is the normal way to run it.
 *    UNLESS the operator ran `--behind-proxy`: a reverse proxy on this machine
 *    dials the daemon over loopback, so once one exists, a loopback peer
 *    address stops meaning "a person at this keyboard" (see `trustLoopback`).
 * 2. A non-loopback connection may not touch a terminal at all. A terminal is an
 *    interactive shell on the host; exposing it deserves its own decision, not
 *    an accidental consequence of `--host`.
 * 3. A non-loopback connection to `/api/*` must carry a valid, non-revoked
 *    member token.
 * 4. Anything else (static dashboard assets) is served. They hold no repo data,
 *    and a browser cannot attach an Authorization header to a navigation — so
 *    gating them would break the page while protecting nothing.
 *
 * "Loopback" is decided from the SOCKET's peer address, never from Host or
 * Origin: those are client-supplied, and a caller must not be able to name
 * itself local.
 */
import { isLoopbackAddr } from './util/origin.js';
import { bearerFrom, verifyToken, type Member, type MemberRegistry } from './members.js';

export interface AccessRequest {
  /** `req.socket.remoteAddress` — unforgeable by the client. */
  remoteAddr: string | undefined | null;
  path: string;
  authorization: string | undefined | null;
  /**
   * May a loopback peer address be taken as proof the caller is at this machine?
   *
   * Absent = yes, the local-first default. `baton serve --behind-proxy` sets it
   * false, because a reverse proxy (a Cloudflare tunnel, nginx, ssh -R) running
   * on this host connects to the daemon FROM loopback — so every public request
   * arrives wearing 127.0.0.1 and rule 1 would hand the whole internet owner
   * rights with no token. When false, a loopback caller is treated exactly like
   * a remote one: token required, no terminals, no agent launches.
   */
  trustLoopback?: boolean;
}

export type AccessDecision =
  | { allow: true; local: boolean; member: Member | null }
  | { allow: false; status: 401 | 403; error: string; hint?: string; challenge?: boolean };

/** Terminal endpoints, which never leave this machine. */
export function isTerminalPath(path: string): boolean {
  return path === '/api/terminals' || /^\/api\/tasks\/[^/]+\/terminal(\/|$)/.test(path);
}

/**
 * Endpoints that START a process on this machine — rule 2 by capability rather
 * than by name.
 *
 * `POST /api/tasks/:slug/agent/start` execas an agent CLI in the host's
 * worktree with the host's credentials, from a caller-supplied prompt. That is
 * the capability rule 2 refuses for terminals, reached through a different
 * door: it was write-gated but neither owner- nor loopback-gated, so any
 * authenticated member of a `--host --write` daemon could run one. The team
 * plan enumerates terminals and the daemon fleet as member-forbidden and simply
 * did not consider this route.
 *
 * `stop` is deliberately not here. Ending a run is not starting one.
 */
export function isHostProcessPath(path: string): boolean {
  return /^\/api\/tasks\/[^/]+\/agent\/start$/.test(path);
}

export function decideAccess(req: AccessRequest, registry: MemberRegistry): AccessDecision {
  // One `&&` carries the whole --behind-proxy mode: every rule below keys off
  // `local`, so withdrawing it here tightens terminals, agent launches, the
  // token requirement and requiresOwner together, with no second code path.
  const local = isLoopbackAddr(req.remoteAddr) && req.trustLoopback !== false;
  if (local) return { allow: true, local: true, member: null };

  if (isTerminalPath(req.path)) {
    return {
      allow: false,
      status: 403,
      error: 'terminals are loopback-only',
      hint: 'use SSH port-forwarding to reach a terminal from another machine',
    };
  }

  if (isHostProcessPath(req.path)) {
    return {
      allow: false,
      status: 403,
      error: 'starting an agent is accepted from this machine only',
      hint: 'use SSH port-forwarding, the same as a terminal',
    };
  }

  if (!req.path.startsWith('/api/')) return { allow: true, local: false, member: null };

  const member = verifyToken(registry, bearerFrom(req.authorization));
  if (!member) {
    return {
      allow: false,
      status: 401,
      error: 'a member token is required',
      hint: 'Authorization: Bearer baton_…',
      challenge: true,
    };
  }
  return { allow: true, local: false, member };
}

/**
 * Owner-only gate for endpoints that manage members or override another
 * member's state. A local caller is always allowed: they already have shell
 * access to the machine, so there is nothing left to protect against.
 *
 * Exists now, before any such endpoint does, so Phase 6's owner controls have
 * one place to call rather than each re-deriving the rule — and so it is
 * enforced on the SERVER. A button the dashboard declines to render is not a
 * control; client code is untrusted.
 */
export function requiresOwner(decision: AccessDecision): boolean {
  if (!decision.allow) return true;
  if (decision.local) return false;
  return decision.member?.role !== 'owner';
}

/**
 * May this viewer read the warnings attached to `memberId`'s roster row?
 *
 * Warnings are owner↔member correspondence, not roster data. The roster itself
 * is deliberately visible to every member — but "you're touching billing/
 * again, stop" is a private reprimand naming one person, and serving it to the
 * whole hub turns a moderation tool into a pillory. Owner sees all; a member
 * sees only their own; everyone else sees none.
 */
export function canSeeWarnings(decision: AccessDecision, memberId: string): boolean {
  if (!requiresOwner(decision)) return true;
  return decision.allow && decision.member?.id === memberId;
}
