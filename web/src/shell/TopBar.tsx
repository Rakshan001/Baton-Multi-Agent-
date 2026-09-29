// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — top bar (spec D Rev 3 §1)
   Page title · search (⌘K) · Team sync chip · New session · mode ·
   daemon status · profile menu. On narrow screens the menu button opens
   the sidebar as a left sheet.
   ============================================================ */
import { useLocation } from "react-router-dom";
import { FlaskConical, Lock, Menu, PenLine, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiDot } from "@/components/primitives";
import { routeForPath } from "@/lib/routes";
import type { Prefs } from "@/hooks/usePrefs";
import { SyncChip } from "./SyncChip";
import { ProfileMenu, type ViewAs } from "./ProfileMenu";
import type { SyncState, TeamSync } from "./teamSync";

export interface TopBarProps {
  onMenu: () => void;
  projectName: string;
  onSearch: () => void;
  onLaunch: () => void;
  prefs: Prefs;
  demo: boolean;
  apiState: "online" | "fetching" | "offline";
  lastUpdated: number | null;
  onRefresh: () => void;
  live: boolean;
  reconnecting: boolean;
  sync: TeamSync;
  onDemoSync: (s: SyncState) => void;
  userName: string;
  userHue: number;
  userRole: string | null;
  viewAs?: ViewAs;
  simpleMode: boolean;
  onSimpleMode: (v: boolean) => void;
}

function ModeChip({ icon: Icon, label, tip, tone }: { icon: typeof Lock; label: string; tip: string; tone: "muted" | "write" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can reach the explanation too. */}
        <span tabIndex={0} className={
          "hidden h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:inline-flex " +
          (tone === "write"
            ? "border-status-online/30 bg-status-online/12 text-status-online-foreground"
            : "border-dashed border-border text-muted-foreground")
        }>
          <Icon aria-hidden className="size-3.5" />{label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function TopBar(p: TopBarProps) {
  const { pathname } = useLocation();
  const route = routeForPath(pathname);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-background px-2 md:px-3 max-md:h-14">
      {!p.simpleMode && (
        <Button variant="ghost" size="icon" className="md:hidden max-md:size-11" onClick={p.onMenu} aria-label="Open navigation">
          <Menu aria-hidden />
        </Button>
      )}
      {/* Breadcrumb, not a second page title: each screen owns its own <h1>. */}
      <nav aria-label="Breadcrumb" className="min-w-0 truncate text-[13px]">
        {p.simpleMode ? <span aria-current="page" className="font-medium">My tasks</span> : <>
        {route.group === "workspace" && <span className="text-muted-foreground max-sm:hidden">{p.projectName}<span aria-hidden className="px-1.5">/</span></span>}
        <span aria-current="page" className="font-medium">{route.label}</span>
        </>}
      </nav>
      <div className="flex-1" />

      <button type="button" onClick={p.onSearch} aria-label="Search and commands"
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-2 text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:size-11 max-md:justify-center max-md:px-0 md:w-44 lg:w-56">
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="flex-1 text-left text-[13px] max-md:hidden">Search…</span>
        <kbd className="kbd max-md:hidden">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      <SyncChip sync={p.sync} demo={p.demo} onDemoState={p.onDemoSync} />

      <Button size="sm" onClick={p.onLaunch} aria-label="New session" className="shrink-0 max-md:size-11 max-md:px-0">
        <Plus aria-hidden /><span className="max-md:hidden">New session</span>
      </Button>

      {p.demo && <ModeChip icon={FlaskConical} label="Demo" tone="muted" tip="Showing illustrative data. The daemon isn't being queried. Turn off in Tweaks." />}
      {p.prefs.writeEnabled
        ? <ModeChip icon={PenLine} label="Write" tone="write" tip="Write actions are on: Merge and Remove are live." />
        : <ModeChip icon={Lock} label="Read-only" tone="muted" tip={p.demo ? "Write actions are off. Toggle them in the ⌘K palette." : "Merge, GC and Repair are disabled. Restart with `baton serve --write` to enable."} />}

      <div className="max-sm:hidden">
        <ApiDot state={p.apiState} lastUpdated={p.lastUpdated} onRefresh={p.onRefresh} live={p.live} reconnecting={p.reconnecting} compact />
      </div>
      <ProfileMenu name={p.userName} hue={p.userHue} role={p.userRole} prefs={p.prefs} simpleMode={p.simpleMode} onSimpleMode={p.onSimpleMode} viewAs={p.viewAs} />
    </header>
  );
}
