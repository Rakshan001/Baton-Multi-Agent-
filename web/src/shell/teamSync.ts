// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team sync status for the top-bar chip (spec D Rev 2 §4)

   There is no sync endpoint yet (Team Sync lands with peer-sync /
   team-api), so real mode always reports "not in a team". Demo mode
   derives the chip from the team fixture (the admin-offline morning of
   system design §8) and can preview all four states from the chip.
   ============================================================ */
import { useCallback, useState } from "react";
import { ls } from "../lib/storage";
import { clockTime } from "../lib/format";
import type { TeamWorkspace } from "../types";

export type SyncState = "synced" | "syncing" | "alone" | "none";

export interface TeamSync {
  state: SyncState;
  teamName?: string;
  online?: number;
  total?: number;
  /** Set when a custodian (admin) is unreachable. */
  adminOffline?: { name: string; lastSeen: string };
  lastEventAt?: string;
  /** Devices in view, for the chip's popover. */
  devices?: { name: string; label: string; online: boolean; lastSeen?: string }[];
}


export const SYNC_LABEL: Record<SyncState, string> = {
  synced: "Synced",
  syncing: "Syncing",
  alone: "Alone on the network",
  none: "Not in a team",
};

function fromWorkspace(ws: TeamWorkspace, state: SyncState): TeamSync {
  if (state === "none") return { state };
  const people = ws.people.filter((p) => p.devices.some((d) => !d.revokedAt));
  const me = ws.viewerId;
  const devices = people.flatMap((p) => p.devices.filter((d) => !d.revokedAt).map((d) => ({
    name: p.name.split(" ")[0]!, label: d.label, online: state === "alone" ? p.id === me && !!d.thisDevice : d.online, lastSeen: clockTime(d.lastSeen),
  })));
  const online = state === "alone" ? 1 : people.filter((p) => p.presence !== "offline").length;
  const admin = people.find((p) => p.custodian && p.presence === "offline" && p.id !== me);
  const lastEvent = ws.tasks.flatMap((t) => t.events.map((e) => e.at)).sort().pop();
  return {
    state, teamName: ws.teamName, online, total: people.length, devices,
    adminOffline: state === "synced" && admin ? { name: admin.name, lastSeen: clockTime(admin.lastSeen) } : undefined,
    lastEventAt: clockTime(lastEvent),
  };
}

const KEY = "baton:demoSync";

/** The sync status to show, and (demo only) a way to preview each state. */
export function useTeamSync(demo: boolean, ws: TeamWorkspace | null): { sync: TeamSync; setDemoState: (s: SyncState) => void } {
  const [demoState, setDemoStateRaw] = useState<SyncState>(() => ls.get<SyncState>(KEY, "synced"));
  const setDemoState = useCallback((s: SyncState) => { setDemoStateRaw(s); ls.set(KEY, s); }, []);
  const sync = demo && ws ? fromWorkspace(ws, demoState) : { state: "none" as const };
  return { sync, setDemoState };
}
