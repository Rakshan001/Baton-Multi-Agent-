// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team sync chip (spec D Rev 2 §4)
   "● Synced · 3/5 online · Admin offline (last seen 12:00)"
   State is always icon + words, never colour alone.
   ============================================================ */
import { CircleCheck, RefreshCw, WifiOff, Users, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SYNC_LABEL, type SyncState, type TeamSync } from "./teamSync";

const ICON: Record<SyncState, LucideIcon> = {
  synced: CircleCheck,
  syncing: RefreshCw,
  alone: WifiOff,
  none: Users,
};

const TONE: Record<SyncState, string> = {
  synced: "text-status-online-foreground",
  syncing: "text-status-ready-foreground",
  alone: "text-status-away-foreground",
  none: "text-muted-foreground",
};

const STATES: SyncState[] = ["synced", "syncing", "alone", "none"];

export function SyncChip({ sync, demo, onDemoState, compact = false }: {
  sync: TeamSync; demo: boolean; onDemoState: (s: SyncState) => void; compact?: boolean;
}) {
  const Icon = ICON[sync.state];
  const counts = sync.online !== undefined && sync.total !== undefined ? `${sync.online}/${sync.total} online` : null;
  const summary = [SYNC_LABEL[sync.state], counts, sync.adminOffline ? `Admin offline (last seen ${sync.adminOffline.lastSeen})` : null]
    .filter(Boolean).join(" · ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Team sync: ${summary}. Show details`}
          className="inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-md border border-border-subtle bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11 max-sm:w-11 max-sm:shrink-0 max-sm:justify-center max-sm:px-0"
        >
          <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE[sync.state], sync.state === "syncing" && "motion-safe:animate-spin")} />
          <span className="max-sm:sr-only">{SYNC_LABEL[sync.state]}</span>
          {!compact && counts && <span className="hidden text-muted-foreground lg:inline">· {counts}</span>}
          {!compact && sync.adminOffline && (
            <span className="hidden text-muted-foreground 2xl:inline">· Admin offline (last seen {sync.adminOffline.lastSeen})</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border-subtle px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Icon aria-hidden className={cn("size-4", TONE[sync.state])} />
            {SYNC_LABEL[sync.state]}
            {sync.teamName && <span className="truncate font-normal text-muted-foreground">· {sync.teamName}</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {sync.state === "none"
              ? "This device isn't paired with a team. Solo work is unaffected."
              : sync.state === "alone"
                ? "No teammate devices are reachable. Changes queue here and sync when someone is back."
                : sync.state === "syncing"
                  ? "Catching up on events from teammates' devices."
                  : "Up to date with every reachable device."}
          </p>
        </div>
        {sync.devices && sync.devices.length > 0 && (
          <ul className="max-h-56 list-none overflow-y-auto p-1" aria-label="Devices">
            {sync.devices.map((d) => (
              <li key={d.name + d.label} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", d.online ? "bg-status-online" : "border border-status-offline")} />
                <span className="font-medium">{d.name}</span>
                <span className="truncate text-muted-foreground">{d.label}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{d.online ? "Online" : `Offline, last seen ${d.lastSeen ?? "—"}`}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-3 py-2 text-xs text-muted-foreground">
          <span>{sync.lastEventAt ? <>Last event <span className="font-mono">{sync.lastEventAt}</span></> : "No events yet"}</span>
          <Link to="/settings/team" className="rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            Team settings
          </Link>
        </div>
        {demo && (
          <fieldset className="border-t border-border-subtle px-3 py-2">
            <legend className="sr-only">Preview sync state (demo)</legend>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Demo · preview state</div>
            <div className="flex flex-wrap gap-1">
              {STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sync.state === s}
                  onClick={() => onDemoState(s)}
                  className="h-7 rounded-md border border-border-subtle px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-pressed:border-border-strong aria-pressed:bg-selected aria-pressed:text-foreground"
                >
                  {SYNC_LABEL[s]}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </PopoverContent>
    </Popover>
  );
}
