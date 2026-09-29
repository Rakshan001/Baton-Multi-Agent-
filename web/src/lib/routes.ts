// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — hash routes (spec D §4)

   One source of truth for every screen's URL. The old `baton:route` values
   ("home", "pipeline", "team", …) are kept as route ids so saved state, the
   command palette and anything else that still speaks in ids resolves to
   the same hash.
   ============================================================ */

export type RouteGroup = "workspace" | "team" | "app";

export interface RouteDef {
  /** Legacy `baton:route` id — also the key screens are rendered by. */
  id: string;
  /** Hash path, without the leading `#`. */
  path: string;
  label: string;
  group: RouteGroup;
}

export const ROUTES: RouteDef[] = [
  // Workspace — the current project's screens
  { id: "home", path: "/", label: "Command Center", group: "workspace" },
  { id: "activity", path: "/activity", label: "Activity", group: "workspace" },
  { id: "pipeline", path: "/pipeline", label: "Pipeline", group: "workspace" },
  { id: "conflicts", path: "/conflicts", label: "Conflicts", group: "workspace" },
  { id: "reviews", path: "/reviews", label: "Code review", group: "workspace" },
  { id: "graph", path: "/graph", label: "Knowledge graph", group: "workspace" },
  { id: "memory", path: "/memory", label: "Memory", group: "workspace" },
  { id: "history", path: "/history", label: "History", group: "workspace" },
  { id: "agents", path: "/agents", label: "Agents", group: "workspace" },
  // Team workspace (spec D Rev 2 §3) — a separate top-level area
  { id: "people", path: "/people", label: "Team", group: "team" },
  { id: "board", path: "/board", label: "Board", group: "team" },
  { id: "inbox", path: "/inbox", label: "Inbox", group: "team" },
  { id: "workload", path: "/workload", label: "Workload", group: "team" },
  // App
  { id: "skills", path: "/skills", label: "Skills", group: "app" },
  { id: "settings", path: "/settings", label: "Settings", group: "app" },
  { id: "team-admin", path: "/settings/team", label: "Team admin", group: "app" },
  { id: "pair", path: "/settings/team/pair", label: "Pair a device", group: "app" },
  { id: "profile", path: "/profile", label: "Profile", group: "app" },
];

/** Old ids that were renamed — `team` used to be the single Team screen. */
const ALIASES: Record<string, string> = { team: "people" };

const BY_ID = new Map(ROUTES.map((r) => [r.id, r]));

/** Display label for a route id (the sidebar, palette and breadcrumb share it). */
export const labelFor = (id: string): string => BY_ID.get(ALIASES[id] ?? id)?.label ?? id;

/** Hash path for a route id (legacy ids included). Unknown ids go home. */
export function pathFor(id: string): string {
  return BY_ID.get(ALIASES[id] ?? id)?.path ?? "/";
}

/**
 * The route a pathname belongs to. Detail paths resolve to their parent list
 * (`/people/mem_1` → people, `/board/task/T-1` → board), so the sidebar keeps
 * the right item highlighted while a detail sheet is open.
 */
export function routeForPath(pathname: string): RouteDef {
  const exact = ROUTES.find((r) => r.path === pathname);
  if (exact) return exact;
  const parent = ROUTES
    .filter((r) => r.path !== "/" && pathname.startsWith(r.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return parent ?? ROUTES[0];
}

/** Ids are regex-checked before they go into a link or a lookup. */
export const isTaskId = (id: string | undefined): id is string => !!id && /^T-\d{1,8}$/.test(id);
export const isMemberId = (id: string | undefined): id is string => !!id && /^[a-z0-9_-]{1,40}$/.test(id);
export const isInboxId = (id: string | undefined): id is string => !!id && /^n-[A-Za-z0-9-]{1,48}$/.test(id);

/** Deep-link builders for the detail routes in spec D §4. Invalid ids link to the list. */
export const links = {
  member: (memberId: string) => (isMemberId(memberId) ? `/people/${encodeURIComponent(memberId)}` : "/people"),
  task: (taskId: string) => (isTaskId(taskId) ? `/board/task/${encodeURIComponent(taskId)}` : "/board"),
  inboxItem: (itemId: string) => (isInboxId(itemId) ? `/inbox/${encodeURIComponent(itemId)}` : "/inbox"),
  board: (q: { member?: string; project?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.member && isMemberId(q.member)) p.set("member", q.member);
    if (q.project) p.set("project", q.project);
    const s = p.toString();
    return s ? `/board?${s}` : "/board";
  },
};
