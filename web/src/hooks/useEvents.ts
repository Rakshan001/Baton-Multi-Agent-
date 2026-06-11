/* ============================================================
   BATON — SSE hook
   Subscribes to GET /api/events (the daemon's push stream). On any
   event it pokes the BatonAPI listener bus, so every usePoll-driven
   screen refetches instantly; polling stays as the safety net when
   the stream is down. EventSource reconnects natively.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { BatonAPI } from "../lib/api";

export interface BatonEventMsg {
  type: string;
  [key: string]: unknown;
}

type Handler = (e: BatonEventMsg) => void;

const EVENT_TYPES = [
  "status.changed", "task.created", "task.removed", "task.merged",
  "commit.created", "agent.started", "agent.stopped", "file.edited",
  "signal.overlap", "kb.rebuilt", "handoff.created",
] as const;

export function useEvents({ enabled = true, baseUrl = "" }: { enabled?: boolean; baseUrl?: string } = {}): {
  live: boolean;
  subscribe: (type: string, fn: Handler) => () => void;
} {
  const [live, setLive] = useState(false);
  const handlersRef = useRef(new Map<string, Set<Handler>>());

  useEffect(() => {
    // Demo mode has no daemon; forced-offline means we shouldn't try.
    if (!enabled || BatonAPI.demo || BatonAPI.forcedOffline) {
      setLive(false);
      return;
    }
    const es = new EventSource(`${baseUrl || BatonAPI.baseUrl}/api/events`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // EventSource retries on its own

    const dispatch = (raw: MessageEvent) => {
      let msg: BatonEventMsg;
      try {
        msg = JSON.parse(raw.data as string) as BatonEventMsg;
      } catch {
        return;
      }
      for (const fn of handlersRef.current.get(msg.type) ?? []) fn(msg);
      for (const fn of handlersRef.current.get("*") ?? []) fn(msg);
      // Any change on the daemon → refetch everything that polls.
      BatonAPI.notify();
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, dispatch);

    return () => {
      es.close();
      setLive(false);
    };
  }, [enabled, baseUrl, BatonAPI.demo]);

  const subscribe = (type: string, fn: Handler) => {
    const map = handlersRef.current;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
    return () => { map.get(type)?.delete(fn); };
  };

  return { live, subscribe };
}
