/* ============================================================
   BATON — interactive terminal panel (xterm.js)
   Real mode: renders the tmux-backed agent session. Output rides
   the per-session SSE stream (snapshot frame first, then live
   bytes); keystrokes POST back as base64 with a micro-queue so
   ordering survives in-flight requests. Demo mode: canned playback.

   Frontend patterns (FitAddon + ResizeObserver + deferred dispose)
   adapted from handler.dev's TerminalInstance (MIT). See NOTICE.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { BatonAPI } from "../lib/api";
import { buildDemoTerminal } from "../lib/demoTerminal";

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export function TerminalPanel({ slug, task, writeEnabled, demo }: {
  slug: string;
  task?: string;
  writeEnabled: boolean;
  demo: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  /** True briefly after the stream dropped and resynced — the screen below is
   *  current, but output produced while disconnected was never delivered. */
  const [resynced, setResynced] = useState(false);
  const canType = writeEnabled && !demo;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setExited(false);
    setResynced(false);

    const term = new Terminal({
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: canType,
      disableStdin: !canType,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: cssVar("--code-bg", "#0d1117"),
        foreground: cssVar("--text-primary", "#e6edf3"),
        cursor: cssVar("--accent", "#58a6ff"),
        selectionBackground: cssVar("--accent-soft", "rgba(88,166,255,.3)"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;
    let es: EventSource | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    if (demo) {
      // Scripted showcase playback — no daemon, no input.
      let at = 0;
      for (const frame of buildDemoTerminal(slug, task)) {
        at += frame.delay;
        timers.push(setTimeout(() => { if (!disposed) term.write(frame.text); }, at));
      }
    } else {
      const url = BatonAPI.terminalStreamUrl(slug);
      if (!url) {
        // Remote viewer: terminals never leave the host machine, so say so on
        // the screen where someone is waiting for output rather than leaving a
        // black rectangle that looks like a hang.
        term.write("\x1b[2m── terminals aren't served over the network ──\x1b[0m\r\n\r\n");
        term.write("This agent's terminal is running on the hub machine. Baton refuses\r\n");
        term.write("terminal streams to any remote viewer, with or without a token —\r\n");
        term.write("an interactive shell is not something a member token should carry.\r\n\r\n");
        term.write("\x1b[2mTo watch it: SSH to the host and port-forward the dashboard.\x1b[0m\r\n");
      }
      if (url) {
        es = new EventSource(url);
        // A mid-stream error means the connection broke — most often the
        // daemon's 4 MB slow-consumer drop, which cannot announce itself (by
        // then the socket holds the backlog, so a final frame is either
        // discarded or forces the very flush the cap exists to avoid). So the
        // gap is detected here: an error followed by a fresh snapshot means we
        // were disconnected and have just resynced. EventSource retries on its
        // own; nothing is permanently lost — the snapshot IS the current screen
        // — but bytes produced while we were away never arrive, and silently
        // showing a jumped-forward terminal is how people mistrust the panel.
        let lostConnection = false;
        es.onerror = () => { if (!disposed) lostConnection = true; };
        es.addEventListener("terminal.snapshot", (e) => {
          try {
            const msg = JSON.parse((e as MessageEvent).data as string) as { data: string };
            term.reset();
            if (msg.data) term.write(b64decode(msg.data));
            if (lostConnection) {
              lostConnection = false;
              setResynced(true);
              // Self-clearing: a warning about a gap that has stopped mattering
              // is noise, and this panel stays open for hours.
              timers.push(setTimeout(() => { if (!disposed) setResynced(false); }, 15_000));
            }
          } catch { /* malformed frame */ }
        });
        es.addEventListener("terminal.output", (e) => {
          try {
            const msg = JSON.parse((e as MessageEvent).data as string) as { data: string };
            term.write(b64decode(msg.data));
          } catch { /* malformed frame */ }
        });
        es.addEventListener("terminal.exited", () => {
          setExited(true);
          term.write("\r\n\x1b[2m── agent session ended ──\x1b[0m\r\n");
        });
      }

      if (canType) {
        // Micro-queue: keystrokes arriving while a POST is in flight are
        // concatenated and sent next, so byte order is preserved.
        let queue = "";
        let busy = false;
        const pump = async () => {
          if (busy || !queue) return;
          const chunk = queue;
          queue = "";
          busy = true;
          try {
            await BatonAPI.sendTerminalInput(slug, b64encode(chunk));
          } catch { /* daemon will surface errors; drop the chunk */ }
          busy = false;
          void pump();
        };
        term.onData((d) => { queue += d; void pump(); });
      }

      // Fit locally on container resize; tell tmux (debounced) so the TUI reflows.
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const syncSize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!disposed && canType) void BatonAPI.resizeTerminal(slug, term.cols, term.rows);
        }, 150);
      };
      term.onResize(syncSize);
      syncSize();
    }

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (!disposed) fit.fit(); });
    });
    ro.observe(host);

    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      ro.disconnect();
      es?.close();
      // xterm's Viewport schedules internal timeouts — dispose after this tick.
      setTimeout(() => term.dispose(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, demo, canType]);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--code-bg)" }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: "8px 4px 8px 10px" }} />
      {resynced && !exited && (
        <div role="status" style={{ flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", borderTop: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--dirty)", background: "var(--dirty-soft)" }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--dirty)", flex: "none" }} />
          Stream reconnected — the screen above is current, but output produced while disconnected was skipped.
        </div>
      )}
      {(!canType || exited) && (
        <div style={{ flex: "none", padding: "5px 12px", borderTop: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--text-tertiary)", background: "var(--bg-surface)" }}>
          {exited ? "Session ended — relaunch from the task to start a new one."
            : demo ? "Demo playback — for real interactive terminals run `baton serve --write` and open the daemon dashboard (default localhost:7077), or turn demo off in Tweaks."
            : "View-only — restart the daemon with `baton serve --write` to type."}
        </div>
      )}
    </div>
  );
}
