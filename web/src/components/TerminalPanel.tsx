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
  const canType = writeEnabled && !demo;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setExited(false);

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
      if (url) {
        es = new EventSource(url);
        es.addEventListener("terminal.snapshot", (e) => {
          try {
            const msg = JSON.parse((e as MessageEvent).data as string) as { data: string };
            term.reset();
            if (msg.data) term.write(b64decode(msg.data));
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
