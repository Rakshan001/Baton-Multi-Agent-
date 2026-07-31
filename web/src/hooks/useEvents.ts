/* ============================================================
   BATON — SSE hook
   Subscribes to GET /api/events (the daemon's push stream). On any
   event it pokes the BatonAPI listener bus, so every usePoll-driven
   screen refetches instantly; polling stays as the safety net when
   the stream is down.

   The transport is fetch(), not EventSource, because EventSource cannot
   send an Authorization header and a dashboard reached over `--host`
   has no other way to identify itself (lib/sse.ts explains the choice
   and what had to be reimplemented). ONE transport is used for both
   local and remote so the local dashboard — the one anybody notices
   breaking — exercises exactly the path a teammate depends on.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { BatonAPI } from "../lib/api";
import { openSse } from "../lib/sse";

export interface BatonEventMsg {
  type: string;
  [key: string]: unknown;
}

type Handler = (e: BatonEventMsg) => void;

const EVENT_TYPES = new Set([
  "status.changed", "task.created", "task.removed", "task.merged",
  "commit.created", "agent.started", "agent.stopped", "agent.output",
  "file.edited", "signal.overlap", "kb.rebuilt", "handoff.created",
  "agent.connected", "terminal.started", "terminal.exited", "memory.updated",
  // Team plane (src/federation.ts). Listed so the Team screen refetches the
  // moment someone joins, claims a file or is acted on, rather than up to one
  // poll interval later — during a collision that gap is the whole point.
  "member.joined", "member.left", "member.presence", "member.warned",
  "member.disconnected", "member.revoked",
  "claim.opened", "claim.released", "claim.conflict", "claim.cleared",
  // Grouping changes are rarer than the rest of this list, but they reorder the
  // whole roster — a screen that redrew a poll interval later would look like
  // it had ignored the click.
  "team.changed",
]);

export function useEvents({ enabled = true, baseUrl = "" }: { enabled?: boolean; baseUrl?: string } = {}): {
  live: boolean;
  reconnecting: boolean;
  subscribe: (type: string, fn: Handler) => () => void;
} {
  const [live, setLive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const everLive = useRef(false);
  /** Mirrors `live` for use inside the SSE callbacks, which close over the
   *  first render's state and would otherwise always read `false`. */
  const liveRef = useRef(false);
  const handlersRef = useRef(new Map<string, Set<Handler>>());
  // Re-open the stream when the credential changes: signing in must bring the
  // live feed up without a reload, and signing out must take it down.
  const token = BatonAPI.token;

  useEffect(() => {
    // Demo mode has no daemon; forced-offline means we shouldn't try.
    if (!enabled || BatonAPI.demo || BatonAPI.forcedOffline) {
      setLive(false);
      setReconnecting(false);
      return;
    }
    const close = openSse({
      url: `${baseUrl || BatonAPI.baseUrl}/api/events`,
      token,
      onOpen: () => {
        const wasDown = everLive.current && !liveRef.current;
        everLive.current = true;
        liveRef.current = true;
        setLive(true);
        setReconnecting(false);
        // The stream coming back is the earliest proof the daemon is reachable
        // again, and it is proof the pollers do not have — they are sitting in
        // a backoff window precisely because they could not get an answer. Wake
        // them, or the dashboard keeps saying "not connected" for up to 30 s
        // after it demonstrably is.
        if (wasDown) BatonAPI.notify();
      },
      // Only call it "reconnecting" if the stream has ever been open — a daemon
      // that was never up is just offline. A terminal failure is never
      // "reconnecting" either; the shell shows the sign-in gate instead.
      onError: ({ willRetry }) => {
        liveRef.current = false;
        setLive(false);
        setReconnecting(willRetry && everLive.current);
      },
      onAuthFailure: () => { BatonAPI.notifyAuthRequired(); },
      onFrame: (frame) => {
        if (!EVENT_TYPES.has(frame.event)) return;
        let msg: BatonEventMsg;
        try {
          msg = JSON.parse(frame.data) as BatonEventMsg;
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
      },
    });

    return () => {
      close();
      liveRef.current = false;
      setLive(false);
      setReconnecting(false);
      everLive.current = false;
    };
  }, [enabled, baseUrl, token, BatonAPI.demo]);

  const subscribe = useCallback((type: string, fn: Handler) => {
    const map = handlersRef.current;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
    return () => { map.get(type)?.delete(fn); };
  }, []);

  return { live, reconnecting, subscribe };
}
