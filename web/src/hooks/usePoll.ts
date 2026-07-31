/* ============================================================
   BATON — polling hook (ported from api.jsx usePoll)
   Pauses when the tab is hidden, tracks lastUpdated, exposes a
   manual refetch, and re-runs when the API store emits.

   Backs off while the daemon is unreachable. Found by dropping a
   port-forward under a live dashboard and counting requests: the SSE
   stream backed off correctly to 5 attempts, while /api/status fired
   21 times in the same 40 seconds — and because `useStatus` stretches
   its interval only when SSE is live, losing the link made the client
   poll FIFTEEN TIMES FASTER at the exact moment nothing could answer.
   Over a metered or rate-limited tunnel that is a request storm aimed
   at a dead endpoint.
   ============================================================ */
import { useState, useRef, useCallback, useEffect } from "react";
import { BatonAPI } from "../lib/api";
import type { StatusRow, TaskHistory, TaskDetail } from "../types";

/** Never wait longer than this between polls, however long the outage. A
 *  dashboard that took minutes to notice the daemon was back would be its own
 *  bug — the point is to stop hammering, not to stop watching. */
const MAX_POLL_DELAY = 30_000;

/** How long to wait before the next poll, given consecutive failures. */
export function pollDelay(interval: number, failures: number): number {
  if (failures <= 0) return interval;
  return Math.min(MAX_POLL_DELAY, interval * 2 ** Math.min(failures, 5));
}

export interface PollState<T> {
  data: T | null;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  lastUpdated: number | null;
  refetch: () => void;
}

export function usePoll<T>(
  fetcher: () => Promise<T>,
  { interval = 2000, deps = [] as unknown[], enabled = true }: { interval?: number; deps?: unknown[]; enabled?: boolean } = {},
): PollState<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; isLoading: boolean; isFetching: boolean }>({
    data: null, error: null, isLoading: true, isFetching: false,
  });
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0); // bumped per run + per effect re-run; stale responses are discarded
  const failures = useRef(0);   // consecutive; drives the backoff, reset by any success
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    if (!mounted.current) return;
    const gen = ++generation.current;
    setState((s) => ({ ...s, isFetching: true }));
    try {
      const data = await fetcherRef.current();
      if (!mounted.current || gen !== generation.current) return;
      failures.current = 0;
      setState({ data, error: null, isLoading: false, isFetching: false });
      setLastUpdated(Date.now());
    } catch (error) {
      if (!mounted.current || gen !== generation.current) return;
      failures.current++;
      setState((s) => ({ data: s.data, error, isLoading: false, isFetching: false }));
    }
  }, []);

  /** Manual refetch — a click means "try now", so it clears the backoff first.
   *  Making someone wait out a 30 s window they can see is a button that lies. */
  const refetch = useCallback(() => { failures.current = 0; void run(); }, [run]);

  useEffect(() => {
    mounted.current = true;
    generation.current++; // invalidate any response still in flight from the previous deps
    if (!enabled) return;
    failures.current = 0;
    void run();
    // A self-scheduling timeout, not setInterval: the delay has to be able to
    // change between ticks, which a fixed interval cannot do.
    let id: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (id != null) { clearTimeout(id); id = null; } };
    const schedule = () => {
      stop();
      id = setTimeout(tick, pollDelay(interval, failures.current));
    };
    async function tick(): Promise<void> {
      id = null;
      if (!document.hidden) await run();
      if (mounted.current) schedule();
    }
    schedule();
    const onVis = () => {
      if (document.hidden) { stop(); return; }
      // Coming back to the tab is an explicit "show me now", same as a click.
      failures.current = 0;
      void run();
      schedule();
    };
    document.addEventListener("visibilitychange", onVis);
    // A store notify is a deliberate "refetch now" — an SSE push, a reconnect,
    // a connection switch. It clears the backoff, because the thing the backoff
    // was waiting to find out has just been answered from somewhere better.
    // Without this the dashboard sits reading "not connected" for up to 30 s
    // after the link is already back, which is the fix causing its own bug.
    const unsub = BatonAPI.subscribe(() => {
      failures.current = 0;
      void run();
      schedule();
    });
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, enabled, ...deps]);

  return { ...state, lastUpdated, refetch };
}

/** When SSE is live, polling is only a safety net — stretch the intervals. */
export const useStatus = (live = false) => usePoll<StatusRow[]>(() => BatonAPI.getStatus(), { interval: live ? 30000 : 2000 });
/** Agents at a hub/repo root or kb sub-project — outside any task worktree. */
export const useRootAgents = () => usePoll<Array<{ agent: string; count: number }>>(() => BatonAPI.getRootAgents(), { interval: 5000 });
export const useHistory = (live = false) => usePoll<TaskHistory[]>(() => BatonAPI.getHistory(), { interval: live ? 60000 : 10000 });
export const useTask = (slug: string) =>
  usePoll<TaskDetail>(() => BatonAPI.getTask(slug), { interval: 2000, deps: [slug] });
