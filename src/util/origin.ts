/**
 * Loopback-origin / anti-CSRF helpers for the local daemon. Pure; unit-tested.
 *
 * The daemon binds 127.0.0.1 only and its CORS policy echoes loopback origins,
 * so a third-party site can never READ a response. But a browser still SENDS a
 * cross-origin "simple" request (a text/plain POST that skips the CORS
 * preflight) — and the server's side effect runs before CORS blocks the
 * unreadable reply. Every state-changing endpoint must therefore verify the
 * request's Origin is loopback (or absent, i.e. curl / same-origin) before
 * acting. This is the single source of truth for both checks.
 */

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * True when the Origin header is absent (curl / same-origin navigations) or
 * points at a loopback host. A present, non-loopback Origin is the only case
 * we refuse — that is exactly the cross-site (CSRF) request.
 */
export function isLoopbackOrigin(origin: string | undefined | null): boolean {
  return !origin || LOOPBACK_ORIGIN_RE.test(origin);
}

/** HTTP methods that mutate server state and therefore need the anti-CSRF check. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}
