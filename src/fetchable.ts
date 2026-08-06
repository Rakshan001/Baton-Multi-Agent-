/**
 * Team mode: is a dependency's work actually reachable from this machine?
 *
 * `done` on a teammate's laptop does not mean the commits exist here. Starting
 * a task against a dependency that was finished but never pushed means building
 * on code that exists nowhere this machine can see — and the failure arrives
 * later, as a merge, in someone else's task.
 *
 * `src/pipeline.ts` asks the question through an injected `isFetchable(sha)`.
 * This module answers it, and answers it CHEAPLY, which is the whole difficulty
 * (spec §13, open question 2): the naive shape is a network call per task per
 * query, and `baton next` runs on every agent's turn while the board polls
 * every two seconds.
 *
 * So: fetch at most once per TTL, then answer every task locally.
 *
 *   fetch   — one subprocess per repo per 30s, shared by every task in the query
 *   answer  — `git branch -r --contains <sha>`, purely local, memoised per sha
 *
 * Solo mode never pays any of it: a repo with no remote yields no probe at all,
 * and `eligibleFor` without `isFetchable` behaves exactly as it always has.
 */
import { defaultRemote, fetchRemote, remoteContains } from './git.js';

/** How long a fetch is considered fresh enough to answer from. */
export const FETCH_TTL_MS = 30_000;

interface RepoCache {
  fetchedAt: number;
  /** shas known to be on the remote. Positive answers only — see below. */
  known: Set<string>;
}

const cache = new Map<string, RepoCache>();

/** Test seam, and the escape hatch after a push: forget what we think we know. */
export function clearFetchableCache(repo?: string): void {
  if (repo) cache.delete(repo);
  else cache.clear();
}

/**
 * A synchronous `isFetchable` for the pure pipeline, or null in solo mode.
 *
 * Every sha the caller might ask about is resolved up front, because the pure
 * layer cannot await. Callers pass the shas from the task records they are
 * about to gate, which is a handful, and all of them are answered from one
 * fetch.
 *
 * Only POSITIVE answers are memoised across calls. A commit that is on the
 * remote stays on the remote, so caching yes is safe and permanent; caching no
 * would mean a teammate's push stayed invisible for the rest of the process's
 * life, which is the difference between "wait a moment" and "wedged".
 * (Force-pushing a branch away is the one case that could make a cached yes
 * wrong. It is also the case that breaks every other consumer of a sha, so
 * matching git's own assumption is the right trade.)
 */
export async function fetchableProbe(
  repo: string,
  shas: readonly (string | undefined)[],
  now = Date.now(),
): Promise<((sha: string | undefined) => boolean) | null> {
  const remote = await defaultRemote(repo);
  if (!remote) return null;                       // solo: nothing to be unreachable

  let entry = cache.get(repo);
  if (!entry || now - entry.fetchedAt > FETCH_TTL_MS) {
    // Offline is normal. A failed fetch still lets us answer from whatever
    // remote refs we already have — stale, but never a crash and never a lie
    // in the dangerous direction: unknown shas simply stay unfetchable.
    await fetchRemote(remote, repo);
    entry = { fetchedAt: now, known: entry?.known ?? new Set() };
    cache.set(repo, entry);
  }

  const wanted = [...new Set(shas.filter((s): s is string => Boolean(s)))];
  for (const sha of wanted) {
    if (entry.known.has(sha)) continue;
    if (await remoteContains(sha, repo)) entry.known.add(sha);
  }

  const known = entry.known;
  // A task with no recorded pushedSha has never been pushed — not "unknown".
  return (sha: string | undefined) => Boolean(sha) && known.has(sha!);
}
