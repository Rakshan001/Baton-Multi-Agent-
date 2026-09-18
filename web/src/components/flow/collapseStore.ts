// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — which plan/phase groups are collapsed, and remembering it

   "Collapse state survives a reload" is half of what makes collapse
   worth having: a canvas you have to re-tidy on every refresh is one
   you stop tidying. So the set of collapsed group ids is persisted.

   WHERE, AND WHY NOT SOMEWHERE NEW. `web/` already has exactly one
   local-preference mechanism — the `ls` helper in lib/storage.ts, which
   hooks/usePrefs.ts and lib/api.ts both sit on. This uses that same
   helper and nothing else. It deliberately does NOT go into
   `usePrefs`: collapse is one screen's view state, not an app-wide
   preference like theme or accent, and every field on `Prefs` is
   re-rendered into the whole shell. A self-contained store keeps a
   toggle on the Worktrees canvas from re-rendering the sidebar.

   THE KEY IS NAMESPACED PER PROJECT. lib/api.ts lets somebody point the
   dashboard at a different repo, and group ids are `grp:<planId>:<phase>`
   — two repos can easily both have a plan called `auth`. Sharing one key
   would mean collapsing a phase in one project silently collapsed a
   same-named phase in another.

   Reads are defensive on purpose: this value is in localStorage, which
   is user-writable, survives upgrades, and is the first thing to hold a
   shape an older Baton wrote. Anything that is not an array of strings
   is treated as "nothing collapsed" rather than thrown.
   ============================================================ */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { ls } from "../../lib/storage";

/** Bumped only if the stored SHAPE ever changes; a stale key then reads as
 *  "nothing collapsed", which is the harmless default. */
const KEY_PREFIX = "baton:flow:collapsed:v1";

export function collapseStorageKey(project: string | null): string {
  return project ? `${KEY_PREFIX}:${project}` : KEY_PREFIX;
}

/**
 * The persisted set. Anything malformed reads as empty — an unreadable
 * preference must never leave the canvas in a state the person cannot see
 * out of, and "everything expanded" is the state where nothing is hidden.
 */
export function readCollapsed(project: string | null): Set<string> {
  const raw = ls.get<unknown>(collapseStorageKey(project), null);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

/** Sorted on the way out so the stored value is stable for the same set —
 *  a round-trip cannot depend on Set insertion order. */
export function writeCollapsed(project: string | null, collapsed: ReadonlySet<string>): void {
  ls.set(collapseStorageKey(project), [...collapsed].sort());
}

export interface CollapseStore {
  collapsed: ReadonlySet<string>;
  isCollapsed: (groupId: string) => boolean;
  toggle: (groupId: string) => void;
  /** Collapse or expand every group at once, for the header's one-click tidy. */
  setMany: (groupIds: readonly string[], value: boolean) => void;
}

/**
 * State + persistence in one place.
 *
 * Every mutation writes through immediately rather than in an effect: an
 * effect keyed on the set would fire on mount too and rewrite what it just
 * read, and a person who collapses a group and closes the tab in the same
 * second should still find it collapsed.
 */
export function useCollapseStore(project: string | null): CollapseStore {
  const key = collapseStorageKey(project);
  // localStorage is read ONCE per key, in the lazy initialiser — not on every
  // render. Every later read comes out of state, so a collapse toggle costs no
  // storage access at all.
  const [state, setState] = useState<{ key: string; set: Set<string> }>(
    () => ({ key, set: readCollapsed(project) }),
  );
  // React's documented "adjust state when a prop changes" pattern: someone
  // switched the active repo, so re-read rather than carry the previous
  // project's collapse set across. Rare, and cheaper than an effect that would
  // render one frame of the wrong repo's layout first.
  if (state.key !== key) setState({ key, set: readCollapsed(project) });
  const collapsed = state.key === key ? state.set : readCollapsed(project);

  const commit = useCallback((next: Set<string>) => {
    writeCollapsed(project, next);
    setState({ key: collapseStorageKey(project), set: next });
  }, [project]);

  const toggle = useCallback((groupId: string) => {
    const next = new Set(collapsed);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    commit(next);
  }, [collapsed, commit]);

  const setMany = useCallback((groupIds: readonly string[], value: boolean) => {
    const next = new Set(collapsed);
    for (const id of groupIds) {
      if (value) next.add(id);
      else next.delete(id);
    }
    commit(next);
  }, [collapsed, commit]);

  const isCollapsed = useCallback((groupId: string) => collapsed.has(groupId), [collapsed]);

  return useMemo(
    () => ({ collapsed, isCollapsed, toggle, setMany }),
    [collapsed, isCollapsed, toggle, setMany],
  );
}

/**
 * How a group NODE reaches the toggle.
 *
 * Context rather than a callback on `node.data`, because `data` is rebuilt
 * from the descriptor on every poll: a function living there would be a new
 * identity several times a minute, which defeats the `memo` on the node and
 * repaints every card. React Flow renders custom nodes inside our own JSX
 * tree, so a provider wrapped around <ReactFlow> reaches them.
 */
export const GroupToggleContext = createContext<(groupId: string) => void>(() => {});

export function useGroupToggle(): (groupId: string) => void {
  return useContext(GroupToggleContext);
}
