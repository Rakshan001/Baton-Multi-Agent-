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

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * True when the Host header names a loopback address — the anti-DNS-rebinding
 * check, and the reason it must exist ALONGSIDE isLoopbackOrigin rather than
 * inside it.
 *
 * The Origin guard cannot see a rebinding attack. evil.com re-points its DNS at
 * 127.0.0.1, so the browser believes the daemon is same-origin: it sends no
 * cross-origin Origin, CORS never engages, and isLoopbackOrigin(undefined) — a
 * deliberate `true`, so curl and same-origin navigations work — waves it through.
 * A live daemon handed over the full task list to `Host: evil.attacker.com`.
 *
 * Host is what closes it: the browser sets it to the hostname it actually
 * dialled, and script cannot override it. A real browser reaching this daemon
 * always says localhost/127.0.0.1; a rebound one says the attacker's name.
 *
 * Absent Host is REFUSED, inverting the Origin rule: HTTP/1.1 mandates Host and
 * browsers always send it, so its absence means a hand-rolled client — exactly
 * what would be used to sidestep this. curl is unaffected (it sets Host itself).
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  return !!host && LOOPBACK_HOST_RE.test(host);
}

/** HTTP methods that mutate server state and therefore need the anti-CSRF check. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}
