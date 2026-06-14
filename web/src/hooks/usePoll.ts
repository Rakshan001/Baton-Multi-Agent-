/* ============================================================
   BATON — polling hook (ported from api.jsx usePoll)
   Pauses when the tab is hidden, tracks lastUpdated, exposes a
   manual refetch, and re-runs when the API store emits.
   ============================================================ */
import { useState, useRef, useCallback, useEffect } from "react";
import { BatonAPI } from "../lib/api";
import type { StatusRow, TaskHistory, TaskDetail } from "../types";

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
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    if (!mounted.current) return;
    const gen = ++generation.current;
    setState((s) => ({ ...s, isFetching: true }));
    try {
      const data = await fetcherRef.current();
      if (!mounted.current || gen !== generation.current) return;
      setState({ data, error: null, isLoading: false, isFetching: false });
      setLastUpdated(Date.now());
    } catch (error) {
      if (!mounted.current || gen !== generation.current) return;
      setState((s) => ({ data: s.data, error, isLoading: false, isFetching: false }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    generation.current++; // invalidate any response still in flight from the previous deps
    if (!enabled) return;
    run();
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => { if (!document.hidden) run(); };
    const start = () => { if (id == null) id = setInterval(tick, interval); };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    start();
    const onVis = () => { if (document.hidden) stop(); else { run(); start(); } };
    document.addEventListener("visibilitychange", onVis);
    const unsub = BatonAPI.subscribe(run);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, enabled, ...deps]);

  return { ...state, lastUpdated, refetch: run };
}

/** When SSE is live, polling is only a safety net — stretch the intervals. */
export const useStatus = (live = false) => usePoll<StatusRow[]>(() => BatonAPI.getStatus(), { interval: live ? 30000 : 2000 });
export const useHistory = (live = false) => usePoll<TaskHistory[]>(() => BatonAPI.getHistory(), { interval: live ? 60000 : 10000 });
export const useTask = (slug: string) =>
  usePoll<TaskDetail>(() => BatonAPI.getTask(slug), { interval: 2000, deps: [slug] });
