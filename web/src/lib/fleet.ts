/**
 * The pure half of the Daemons card (features/Settings.tsx) — ordering and
 * formatting, with no React in it — plus the demo fixtures, kept here rather
 * than a separate demoFleet file because the two must agree on shape and this
 * file is small enough to read whole.
 */
import type { FleetDaemon } from "../types";

/** Last path segment — the name someone knows their project by. */
export function folderName(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

/** `~/…/name` style middle truncation: keeps the start and the end, drops the
 *  middle — the two ends are how people recognise a path. */
export function middleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${path.slice(0, keep)}…${path.slice(-keep)}`;
}

export function uptimeLabel(startedAt: string, now = Date.now()): string {
  const t = Date.parse(startedAt);
  // t <= 0 is the epoch sentinel a record missing startedAt falls back to —
  // "up 20661d" would be a confident lie about a file we know nothing about.
  if (!Number.isFinite(t) || t <= 0) return "—";
  const ms = now - t;
  if (ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just started";
  if (m < 60) return `up ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `up ${h}h ${m % 60}m`;
  return `up ${Math.floor(h / 24)}d`;
}

/** Self first (it's the row the viewer orients by), then live daemons by
 *  port, then stale leftovers last — a corpse should never sit above a
 *  living daemon. */
export function fleetOrder(rows: FleetDaemon[]): FleetDaemon[] {
  return [...rows].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.status !== b.status) return a.status === "live" ? -1 : 1;
    return a.port - b.port;
  });
}

/* ---- demo fixtures (four daemons, TWO stale — the showcase must show the
   stale path too, because "Clean up" is half the feature, and the bulk
   "Clean up all" control only appears once corpses outnumber one) ---- */

const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

export const DEMO_FLEET: FleetDaemon[] = [
  {
    pid: 41283, port: 7077, root: "/Users/you/dev/fatfox", startedAt: mins(214),
    version: "0.0.1", writeEnabled: true, host: false, status: "live", self: true,
  },
  {
    pid: 40911, port: 7080, root: "/Users/you/dev/orbit-api", startedAt: mins(96),
    version: "0.0.1", writeEnabled: false, host: false, status: "live", self: false,
  },
  {
    pid: 38122, port: 7091, root: "/Users/you/dev/scratch/spike-old", startedAt: mins(2890),
    version: "0.0.1", writeEnabled: true, host: false, status: "stale", self: false,
  },
  {
    pid: 37544, port: 7092, root: "/Users/you/dev/scratch/spike-older", startedAt: mins(4120),
    version: "0.0.1", writeEnabled: true, host: false, status: "stale", self: false,
  },
];
