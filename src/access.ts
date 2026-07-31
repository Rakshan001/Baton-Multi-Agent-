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
}

export type AccessDecision =
  | { allow: true; local: boolean; member: Member | null }
  | { allow: false; status: 401 | 403; error: string; hint?: string; challenge?: boolean };

/** Terminal endpoints, which never leave this machine. */
export function isTerminalPath(path: string): boolean {
  return path === '/api/terminals' || /^\/api\/tasks\/[^/]+\/terminal(\/|$)/.test(path);
}

export function decideAccess(req: AccessRequest, registry: MemberRegistry): AccessDecision {
  const local = isLoopbackAddr(req.remoteAddr);
  if (local) return { allow: true, local: true, member: null };

  if (isTerminalPath(req.path)) {
    return {
      allow: false,
      status: 403,
      error: 'terminals are loopback-only',
      hint: 'use SSH port-forwarding to reach a terminal from another machine',
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
