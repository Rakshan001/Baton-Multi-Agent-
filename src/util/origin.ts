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

/**
 * The anti-CSRF check widened for a deliberately exposed daemon — the Origin
 * counterpart to `isAllowedHostHeader`.
 *
 * A dashboard opened at `http://mac-mini.local:7077` sends that Origin on every
 * write, which `isLoopbackOrigin` refuses. Without this the page loads, reads
 * fine, and every single button fails — the worst kind of broken, because it
 * looks like it works.
 *
 * Widening is safe for exactly the same reason the Host allow-list is: only
 * names the operator DECLARED pass, never a wildcard. A page on evil.com still
 * arrives with `Origin: https://evil.com` and is still refused. And a remote
 * request needs a member token regardless — which a cross-site page cannot
 * obtain, because nothing here rides on ambient credentials (no cookies). This
 * is the tighter of the two checks, not the only one.
 */
export function isAllowedOrigin(origin: string | undefined | null, allowed: string[]): boolean {
  if (isLoopbackOrigin(origin)) return true;
  const name = originHostname(origin!);
  if (!name) return false;
  return allowed.some((a) => a && hostnameOf(a) === name);
}

/** Hostname of an Origin header, or '' if it is not a usable http(s) origin.
 *  `null` (sandboxed iframe, file://) parses to nothing and is refused. */
export function originHostname(origin: string): string {
  const m = /^https?:\/\/([^/?#]+)$/i.exec(origin.trim());
  return m ? hostnameOf(m[1]!) : '';
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

/** The name part of a Host header, without the port and without IPv6 brackets. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const colon = h.lastIndexOf(':');
  return colon > 0 && !h.slice(colon + 1).includes(':') ? h.slice(0, colon) : h;
}

/**
 * The anti-rebinding check widened for a deliberately exposed daemon.
 *
 * Loopback always passes (the local-first default). Beyond that, ONLY names the
 * operator declared pass — never a wildcard. That is what keeps `--host` from
 * silently re-opening the DNS-rebinding hole the loopback check exists to close:
 * an attacker who rebinds `evil.com` at the daemon's address still arrives with
 * `Host: evil.com`, which is not on the list.
 *
 * Note that binding `0.0.0.0` therefore does NOT make the daemon reachable by
 * name on its own — the operator must say which names they expect. Failing
 * closed on a misconfiguration is the intended behaviour.
 */
export function isAllowedHostHeader(host: string | undefined | null, allowed: string[]): boolean {
  if (isLoopbackHost(host)) return true;
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  return allowed.some((a) => a && hostnameOf(a) === name);
}

/**
 * True when the CONNECTION itself came from this machine.
 *
 * Distinct from `isLoopbackHost`, and the difference is the whole point:
 * - `isLoopbackHost` reads a client-supplied header and answers "what name did
 *   the browser dial?" — the anti-rebinding question.
 * - this reads the socket's peer address, which no client can forge, and answers
 *   "is this process local?" — the authorization question.
 *
 * Only the second is safe to decide access on, which is why the bearer-token
 * requirement keys on this and not on Host. Node reports an IPv4 peer on a
 * dual-stack listener as `::ffff:127.0.0.1`, so that form is matched too.
 */
export function isLoopbackAddr(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

/** HTTP methods that mutate server state and therefore need the anti-CSRF check. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}
