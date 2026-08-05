/**
 * The bridge that makes federated claims reach AGENTS, not just people.
 *
 * `src/federation.ts` pools "who is editing what" on the host, and the Team
 * screen renders it. But the tool agents actually call before editing —
 * `check_files` — runs in the `baton mcp` process, which is not the daemon and
 * has no access to that store. Until something asks the host, a claim published
 * by a teammate is visible to a human watching a dashboard and invisible to the
 * agent about to overwrite their work, which is the wrong way round.
 *
 * Three properties matter more than speed here:
 *
 * 1. **"I could not ask" is never reported as "nobody is there."** This is the
 *    same invariant the memory plane rests on: a stale fact is withheld rather
 *    than served as fresh. Every answer carries a `reachable` flag, and callers
 *    surface it. Silently degrading to "not busy" would make the tool most
 *    misleading exactly when the network is worst.
 * 2. **It never blocks the agent.** `check_files` is on the critical path of
 *    every edit. A host that is asleep, tunnelled, or gone must cost a short
 *    timeout once, not on every call — hence the cache, which is deliberately
 *    kept for failures too.
 * 3. **No host link means no network call at all.** The overwhelmingly common
 *    case is a solo machine, and it must behave exactly as it always has.
 */
import { loadHostLink, type HostLink } from './host-link.js';

/** How long one answer (success OR failure) is reused. Heartbeats are 30 s, so
 *  the host's own picture is no fresher than this anyway. */
const CACHE_MS = 10_000;
/** Hard ceiling on how long an agent waits for the host. */
const TIMEOUT_MS = 2000;

/** One remote holder of a path, as the host reports it. */
export interface RemoteHolder {
  memberId: string;
  memberName: string;
  agent: string | null;
  branch: string | null;
  /** Which sub-project the claim is in; null from a single-repo publisher. */
  projectId: string | null;
  /** Host-assigned; when they opened the claim. */
  since: string;
}

export interface RemoteClaimsView {
  /** Is this machine pointed at a host at all? */
  linked: boolean;
  /**
   * Did we get an answer? When false with `linked` true, the remote picture is
   * UNKNOWN — not empty. Callers must not present it as "nobody else is here".
   */
  reachable: boolean;
  /** Repo-relative path → holders on other machines. Empty when unreachable. */
  byPath: Record<string, RemoteHolder[]>;
  /** Phrased for a human/agent to read verbatim when something is off. */
  note?: string;
}

const emptyPaths = (): Record<string, RemoteHolder[]> => Object.create(null) as Record<string, RemoteHolder[]>;

const UNLINKED: RemoteClaimsView = { linked: false, reachable: false, byPath: emptyPaths() };

interface Cached { at: number; view: RemoteClaimsView }
let cache: Cached | null = null;

/** Test seam — the cache is process-lifetime otherwise. */
export function resetRemoteClaimsCache(): void {
  cache = null;
}

interface PresencePayload {
  /** The host's answer to "who am I?", resolved from the bearer token. */
  you?: { memberId?: string | null };
  claims?: Array<{
    projectId?: string | null;
    relPath?: string;
    memberId?: string;
    memberName?: string;
    agent?: string | null;
    branch?: string | null;
    openedAt?: string;
  }>;
}

/**
 * Which member id on the host is US, so our own claims can be dropped.
 *
 * Three cases, and the difference between the last two is the whole reason this
 * is a function:
 *
 * - `you.memberId` is a string → the host authenticated us; that is our id.
 * - `you` is PRESENT with a null id → we reached the host over loopback, so it
 *   never checked our token and filed us under `local` (the id it gives every
 *   loopback heartbeat). We are that member. Missing this case means a daemon
 *   linked to a host on the same machine reads its own claims back as a
 *   teammate's — which is the bug this feature exists to avoid, inverted.
 * - `you` is ABSENT → an older host that cannot tell us. Filter NOTHING: over-
 *   reporting a conflict costs a wasted check, under-reporting costs a
 *   collision, and only one of those is recoverable.
 */
function selfId(body: PresencePayload): string {
  if (typeof body.you?.memberId === 'string' && body.you.memberId) return body.you.memberId;
  return body.you ? 'local' : '';
}

async function fetchClaims(link: HostLink): Promise<RemoteClaimsView> {
  try {
    const res = await fetch(`${link.url}/api/presence`, {
      headers: { Authorization: `Bearer ${link.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { linked: true, reachable: false, byPath: emptyPaths(), note: 'the host rejected this machine\'s token (revoked?) — remote claims unavailable' };
    }
    if (!res.ok) {
      return { linked: true, reachable: false, byPath: emptyPaths(), note: `the host replied ${res.status} — remote claims unavailable` };
    }
    const body = (await res.json()) as PresencePayload;
    /*
     * Drop this machine's OWN claims before anything else sees them.
     *
     * We publish our claims to the host every 30 s and then read the pooled
     * picture straight back, so without this every file our own agents are
     * editing would be reported to them as "a teammate is on this" — the tool
     * would manufacture the exact conflict it exists to prevent. The id comes
     * from the host (resolved from our token), because it is the only party
     * that can say who we are.
     */
    const me = selfId(body);
    // Null-prototype: these keys are file paths chosen by a REMOTE teammate,
    // and `{}` inherits from Object.prototype, so `byPath['__proto__'] ??= []`
    // finds a truthy inherited object, skips the assignment, and throws on
    // .push — the catch below then reports the whole host unreachable, every
    // 10s for the claim's TTL. One member silently blinds every teammate's
    // check_files. The read side needs no host at all: `?files=constructor`
    // reached a function's .filter and 500'd. `isClaimablePath` accepts both,
    // and should: they are legal file names. The map is what must be inert.
    const byPath: Record<string, RemoteHolder[]> = Object.create(null) as Record<string, RemoteHolder[]>;
    for (const c of body.claims ?? []) {
      const relPath = typeof c?.relPath === 'string' ? c.relPath : '';
      const memberId = typeof c?.memberId === 'string' ? c.memberId : '';
      if (!relPath || !memberId) continue;
      if (me && memberId === me) continue;
      (byPath[relPath] ??= []).push({
        memberId,
        memberName: typeof c.memberName === 'string' ? c.memberName : memberId,
        agent: typeof c.agent === 'string' ? c.agent : null,
        branch: typeof c.branch === 'string' ? c.branch : null,
        // Kept, not dropped: the host keys claims by (projectId, relPath) —
        // without it a teammate's `src/index.ts` in another sub-project reads
        // as a hold on ours, which is the conflict this tool exists to avoid.
        projectId: typeof c.projectId === 'string' ? c.projectId : null,
        since: typeof c.openedAt === 'string' ? c.openedAt : '',
      });
    }
    return { linked: true, reachable: true, byPath };
  } catch (e) {
    // Asleep, tunnel down, DNS gone — all routine, none of them an error the
    // agent should see as a failure. It is a gap in knowledge, and it says so.
    return { linked: true, reachable: false, byPath: emptyPaths(), note: `could not reach the host (${(e as Error).message}) — remote claims unavailable` };
  }
}

/**
 * The host's current claim picture, cached.
 *
 * Failures are cached too, on purpose: without that, a dead host would cost
 * every single `check_files` call a full timeout, and the tool agents are told
 * to call before every edit would become the slowest thing they do.
 */
export async function remoteClaims(root: string, now = Date.now()): Promise<RemoteClaimsView> {
  const link = await loadHostLink(root);
  if (!link) return UNLINKED;
  if (cache && now - cache.at < CACHE_MS) return cache.view;
  const view = await fetchClaims(link);
  cache = { at: now, view };
  return view;
}

/**
 * Remote holders for specific paths, excluding this machine's own member id
 * where the caller knows it. Paths are matched exactly: claims are repo-relative
 * by contract (see federation.ts), so normalising here would only paper over a
 * publisher that got it wrong.
 *
 * `projectId` is the ASKER's sub-project, when known. A path is only
 * repo-relative, so across a hub the same string names different files; the
 * host already keys its claims by (projectId, relPath) and this is where the
 * local side stops throwing that half away. A holder whose projectId is null
 * came from a single-repo publisher and still matches — unknown pairs with
 * anything, exactly as `canCollide` does locally.
 */
export function remoteHoldersFor(
  view: RemoteClaimsView,
  paths: string[],
  exceptMemberId?: string,
  projectId?: string | null,
): Record<string, RemoteHolder[]> {
  const out: Record<string, RemoteHolder[]> = Object.create(null) as Record<string, RemoteHolder[]>;
  for (const p of paths) {
    const holders = (view.byPath[p] ?? []).filter(
      (h) => (!exceptMemberId || h.memberId !== exceptMemberId)
        && (!projectId || !h.projectId || h.projectId === projectId),
    );
    if (holders.length) out[p] = holders;
  }
  return out;
}

/**
 * One sentence describing the remote picture, or null when there is nothing
 * worth saying (no host linked — the solo case, which should read exactly as it
 * always has).
 */
export function remoteNote(view: RemoteClaimsView): string | null {
  if (!view.linked) return null;
  if (!view.reachable) return view.note ?? 'the host is unreachable — remote claims unavailable';
  return null;
}
