// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — dense left sidebar (spec D Rev 3 §1)
   Workspace (project + its screens) · Team · Board · Inbox · Workload ·
   Skills · Settings. 32px rows on desktop, 44px on touch widths.
   ============================================================ */
import { Link, useLocation } from "react-router-dom";
import {
  Activity, Bot, Brain, FileSearch, Gauge, History, Inbox, LayoutDashboard, Layers,
  Network, Settings, Sparkles, SquareKanban, TriangleAlert, Users, type LucideIcon,
} from "lucide-react";
import { BatonMark } from "@/components/BatonMark";
import { cn } from "@/lib/utils";
import { labelFor, pathFor, routeForPath } from "@/lib/routes";
import type { Connection } from "@/lib/connections";
import type { Project } from "@/types";
import { ProjectSwitcher } from "./ProjectSwitcher";

const ICONS: Record<string, LucideIcon> = {
  home: LayoutDashboard, activity: Activity, pipeline: Layers, conflicts: TriangleAlert,
  reviews: FileSearch, graph: Network, memory: Brain, history: History, agents: Bot,
  people: Users, board: SquareKanban, inbox: Inbox, workload: Gauge,
  skills: Sparkles, settings: Settings,
};

export interface SidebarProps {
  project: Project;
  onProject: (id: string) => void;
  demo: boolean;
  connections: Connection[];
  onConnectionsChange: (next: Connection[]) => void;
  conflicts: number;
  inboxUnread: number;
  /** Called after a nav item is chosen (closes the mobile drawer). */
  onNavigate?: () => void;
}

const WORKSPACE_ITEMS = ["home", "activity", "pipeline", "conflicts", "reviews", "graph", "memory", "history", "agents"];
const TEAM_ITEMS = ["people", "board", "inbox", "workload"];
const APP_ITEMS = ["skills", "settings"];

function NavItem({ id, badge, badgeLabel, tone, onNavigate, active }: {
  id: string; badge?: number; badgeLabel?: string; tone?: "danger" | "neutral"; onNavigate?: () => void; active: boolean;
}) {
  const Icon = ICONS[id];
  return (
    <li>
      <Link
        to={pathFor(id)}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        aria-label={badge ? `${labelFor(id)}, ${badgeLabel ?? badge}` : undefined}
        className={cn(
          "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors max-md:h-11",
          "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          active && "bg-selected text-foreground",
        )}
      >
        <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")} />
        <span className="flex-1 truncate">{labelFor(id)}</span>
        {!!badge && (
          <span aria-hidden className={cn(
            "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 font-mono text-[11px] font-semibold",
            tone === "danger"
              ? "border border-status-danger/30 bg-status-danger/12 text-status-danger-foreground"
              : "bg-primary text-primary-foreground",
          )}>{badge}</span>
        )}
      </Link>
    </li>
  );
}

function Section({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && <div className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>}
      <ul className="flex list-none flex-col gap-0.5">{children}</ul>
    </div>
  );
}

export function SidebarContent({ project, onProject, demo, connections, onConnectionsChange, conflicts, inboxUnread, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  const resolved = routeForPath(pathname).id;
  // Team admin and pairing live under Settings; keep Settings lit there.
  const current = resolved === "team-admin" || resolved === "pair" ? "settings" : resolved;
  const item = (id: string, extra: Partial<Parameters<typeof NavItem>[0]> = {}) => (
    <NavItem key={id} id={id} active={current === id} onNavigate={onNavigate} {...extra} />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center px-3">
        <BatonMark size={22} withWord />
      </div>
      <div className="px-2 pb-1">
        <ProjectSwitcher project={project} onProject={onProject} demo={demo} connections={connections} onConnectionsChange={onConnectionsChange} />
      </div>
      <nav aria-label="Primary" className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <Section label="Workspace">
          {WORKSPACE_ITEMS.map((id) => id === "conflicts"
            ? item(id, { badge: conflicts, tone: "danger", badgeLabel: `${conflicts} conflict${conflicts === 1 ? "" : "s"}` })
            : item(id))}
        </Section>
        <Section label="Team">
          {TEAM_ITEMS.map((id) => id === "inbox"
            ? item(id, { badge: inboxUnread, badgeLabel: `${inboxUnread} unread notification${inboxUnread === 1 ? "" : "s"}` })
            : item(id))}
        </Section>
        <div className="my-2 h-px bg-border-subtle" />
        <Section>{APP_ITEMS.map((id) => item(id))}</Section>
      </nav>
      {/* Live count for assistive tech, as a sentence rather than a bare number. */}
      <p role="status" className="sr-only">
        {inboxUnread ? `${inboxUnread} unread notification${inboxUnread === 1 ? "" : "s"}` : ""}
      </p>
    </div>
  );
}
