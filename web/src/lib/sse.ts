// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Server-Sent Events over fetch()

   Replaces EventSource for one reason: EventSource cannot send an
   Authorization header, and a dashboard reached over `--host` has no
   other way to identify itself.

   The alternative was a short-lived stream ticket in the query string.
   That was rejected: it puts a credential in a URL, where proxies log
   it and history keeps it, to work around a browser API limitation that
   fetch() simply does not have. Phase 4 refused a query-string token for
   the API; the event stream does not get an exception.

   What EventSource gave us for free and is reimplemented here:
   - reconnection, with exponential backoff and jitter (EventSource's own
     cadence is fixed and unknowable; ours is at least visible)
   - `Last-Event-ID` on reconnect, so the daemon replays what was missed
     rather than leaving a silent hole in the timeline

   What it deliberately does NOT do: retry after 401/403. A revoked or
   rotated token fails identically every time, and a client that hammers
   a dead credential turns one person's expired session into a load
   pattern. It reports `fatal` instead, and the UI asks for a new token.
   ============================================================ */

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

export interface SseOptions {
  url: string;
  /** Bearer token, or "" for a loopback daemon that needs no credential. */
  token?: string;
  onFrame: (frame: SseFrame) => void;
  onOpen?: () => void;
  /** Stream dropped; `willRetry` is false only when the failure is terminal. */
  onError?: (info: { status?: number; willRetry: boolean }) => void;
  /** Auth was refused — the token is bad, revoked, or rotated. Terminal. */
  onAuthFailure?: (status: number) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;

/** Backoff with jitter. Jitter matters here: a hub that restarts drops every
 *  member's stream at the same instant, and a fixed delay would bring them all
 *  back in the same instant too. */
function delayFor(attempt: number): number {
  const capped = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.min(attempt, 5));
  return capped / 2 + Math.random() * (capped / 2);
}

/**
 * Open an SSE stream. Returns a function that closes it for good — after
 * calling it, no further frames, retries or callbacks happen.
 */
export function openSse(opts: SseOptions): () => void {
  let stopped = false;
  let attempt = 0;
  let lastId = "";
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const retryLater = (status?: number) => {
    if (stopped) return;
    opts.onError?.({ status, willRetry: true });
    const wait = delayFor(attempt++);
    timer = setTimeout(() => { timer = null; void connect(); }, wait);
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    controller = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    // Resume where we left off, so a reconnect fills the gap instead of
    // pretending nothing happened while we were away.
    if (lastId) headers["Last-Event-ID"] = lastId;

    let res: Response;
    try {
      res = await fetch(opts.url, { headers, signal: controller.signal, cache: "no-store" });
    } catch {
      if (!stopped) retryLater(); // network down / daemon not listening
      return;
    }
    if (stopped) return;

    if (res.status === 401 || res.status === 403) {
      // Terminal by design: retrying a credential the daemon has already
      // rejected cannot start working, it can only make noise.
      opts.onAuthFailure?.(res.status);
      opts.onError?.({ status: res.status, willRetry: false });
      return;
    }
    if (!res.ok || !res.body) {
      retryLater(res.status);
      return;
    }

    attempt = 0;
    opts.onOpen?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line. A chunk can split anywhere,
        // including mid-frame, so only whole frames are consumed. The separator
        // is matched rather than assumed a fixed width — \n\n, \r\n\r\n and the
        // mixed forms are all legal and are all two different lengths.
        for (;;) {
          const sep = /\r?\n\r?\n/.exec(buffer);
          if (!sep) break;
          const raw = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          const frame = parseFrame(raw);
          if (!frame) continue; // comment-only (": ping") — the keep-alive
          if (frame.id) lastId = frame.id;
          if (!stopped) opts.onFrame(frame);
        }
      }
    } catch {
      /* aborted or the connection broke mid-read — handled below */
    }
    // A clean end is still an end: the daemon restarted or a proxy timed the
    // stream out. Reconnect exactly as for an error.
    if (!stopped) retryLater();
  }

  void connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}

/** One SSE frame → {id, event, data}. Returns null for a comment-only frame. */
export function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  let sawField = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // blank or comment (keep-alive)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per the spec a single leading space after the colon is part of the
    // delimiter, not the value — dropping more would corrupt JSON payloads.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") { id = value; sawField = true; }
    else if (field === "event") { event = value; sawField = true; }
    else if (field === "data") { data.push(value); sawField = true; }
    // `retry` is ignored: reconnect cadence is ours, not the server's.
  }
  if (!sawField) return null;
  return { ...(id ? { id } : {}), event, data: data.join("\n") };
}
