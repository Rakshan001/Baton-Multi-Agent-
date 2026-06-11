/* ============================================================
   BATON — daemon connections
   One `baton serve` daemon per repo. The dashboard can register
   several and switch between them — that IS the real project
   switcher. The default connection is the same-origin daemon
   (or VITE_BATON_API in dev) and is always present.
   ============================================================ */
import type { Meta, Project } from "../types";
import { ls } from "./storage";

export interface Connection {
  id: string;
  name: string;
  /** API base, e.g. "http://localhost:7078". "" = same-origin / VITE_BATON_API. */
  baseUrl: string;
}

export const DEFAULT_CONNECTION: Connection = { id: "default", name: "This daemon", baseUrl: "" };

const KEY = "baton:connections";
const DEFAULT_URL_KEY = "baton:default-url"; // user override for the default connection

export function loadConnections(): Connection[] {
  const extra = ls.get<Connection[]>(KEY, []);
  const def = { ...DEFAULT_CONNECTION, baseUrl: ls.get<string>(DEFAULT_URL_KEY, "") };
  return [def, ...extra.filter((c) => c && c.id !== "default" && typeof c.baseUrl === "string")];
}

/** Point a connection at a different daemon URL ("" = same-origin for default). */
export function updateConnectionUrl(id: string, baseUrl: string): Connection {
  const normalized = baseUrl.trim() === "" ? "" : normalizeBaseUrl(baseUrl);
  if (id === "default") {
    ls.set(DEFAULT_URL_KEY, normalized);
  } else {
    saveExtra(loadConnections().filter((c) => c.id !== "default").map((c) => (c.id === id ? { ...c, baseUrl: normalized } : c)));
  }
  return loadConnections().find((c) => c.id === id)!;
}

function saveExtra(extra: Connection[]): void {
  ls.set(KEY, extra);
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) throw new Error("URL must start with http:// or https://");
  return trimmed;
}

export function addConnection(input: { name: string; baseUrl: string }): Connection {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const name = input.name.trim() || baseUrl.replace(/^https?:\/\//, "");
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;
  const conn: Connection = { id, name, baseUrl };
  saveExtra([...loadConnections().filter((c) => c.id !== "default"), conn]);
  return conn;
}

export function removeConnection(id: string): void {
  if (id === "default") return;
  saveExtra(loadConnections().filter((c) => c.id !== "default" && c.id !== id));
}

/** Probe a connection's daemon. Throws on unreachable/timeout. */
export async function fetchMeta(conn: Connection, timeoutMs = 3000): Promise<Meta> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${conn.baseUrl}/api/meta`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Meta;
  } finally {
    clearTimeout(timer);
  }
}

const PALETTE = ["#6ea8fe", "#f472b6", "#a3e635", "#f2a65a", "#46c2d6", "#9d7bf5", "#34c98e", "#ee7261"];
function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** UI project identity for a connection, from its live /api/meta (or null when unreachable). */
export function projectFromMeta(conn: Connection, meta: Meta | null): Project {
  return {
    id: conn.id,
    name: conn.id === "default" && meta ? basename(meta.repo) : conn.name,
    path: meta?.repo ?? (conn.baseUrl || "this origin"),
    branch: meta?.branch ?? "—",
    framework: meta ? `baton v${meta.version}` : "unreachable",
    color: colorFor(conn.id),
    primary: conn.id === "default",
  };
}
