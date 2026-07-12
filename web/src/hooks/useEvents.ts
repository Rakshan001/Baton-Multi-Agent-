/* ============================================================
   BATON — SSE hook
   Subscribes to GET /api/events (the daemon's push stream). On any
   event it pokes the BatonAPI listener bus, so every usePoll-driven
   screen refetches instantly; polling stays as the safety net when
   the stream is down. EventSource reconnects natively.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { BatonAPI } from "../lib/api";

export interface BatonEventMsg {
  type: string;
  [key: string]: unknown;
}

type Handler = (e: BatonEventMsg) => void;

const EVENT_TYPES = [
  "status.changed", "task.created", "task.removed", "task.merged",
  "commit.created", "agent.started", "agent.stopped", "agent.output",
  "file.edited", "signal.overlap", "kb.rebuilt", "handoff.created",
  "agent.connected", "terminal.started", "terminal.exited", "memory.updated",
] as const;

export function useEvents({ enabled = true, baseUrl = "" }: { enabled?: boolean; baseUrl?: string } = {}): {
  live: boolean;
  reconnecting: boolean;
  subscribe: (type: string, fn: Handler) => () => void;
} {
  const [live, setLive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const everLive = useRef(false);
  const handlersRef = useRef(new Map<string, Set<Handler>>());

  useEffect(() => {
    // Demo mode has no daemon; forced-offline means we shouldn't try.
    if (!enabled || BatonAPI.demo || BatonAPI.forcedOffline) {
      setLive(false);
      setReconnecting(false);
      return;
    }
    const es = new EventSource(`${baseUrl || BatonAPI.baseUrl}/api/events`);
    es.onopen = () => { everLive.current = true; setLive(true); setReconnecting(false); };
    // EventSource retries on its own; only call it "reconnecting" if the
    // stream has ever been open — a daemon that was never up is just offline.
    es.onerror = () => { setLive(false); if (everLive.current) setReconnecting(true); };

    const dispatch = (raw: MessageEvent) => {
      let msg: BatonEventMsg;
      try {
        msg = JSON.parse(raw.data as string) as BatonEventMsg;
      } catch {
        return;
      }
      for (const fn of handlersRef.current.get(msg.type) ?? []) fn(msg);
      for (const fn of handlersRef.current.get("*") ?? []) fn(msg);
      // Any change on the daemon → refetch everything that polls. Skip the
      // high-frequency byte streams (agent output / terminal PTY) — notifying
      // on every chunk would refetch the whole dashboard per keystroke.
      if (msg.type === "agent.output" || msg.type.startsWith("terminal.")) return;
      BatonAPI.notify();
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, dispatch);

    return () => {
      es.close();
      setLive(false);
      setReconnecting(false);
      everLive.current = false;
    };
  }, [enabled, baseUrl, BatonAPI.demo]);

  const subscribe = useCallback((type: string, fn: Handler) => {
    const map = handlersRef.current;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
    return () => { map.get(type)?.delete(fn); };
  }, []);

  return { live, reconnecting, subscribe };
}
