// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Workload (#/workload), spec D Rev 2 §5
   People × active / waiting / stuck, with a Reassign menu for leads.
   Stalls are shown ("no signal since"), never auto-re-offered.
   ============================================================ */
import { Link } from "react-router-dom";
import { ChevronDown, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { compareTasks, inventory, isClosed, roleIn, teamApi } from "@/lib/teamApi";
import { links } from "@/lib/routes";
import { cn, focusRing } from "@/lib/utils";
import type { TeamPerson, TeamTask } from "@/types";
import { useTeam, Page, PageHeader, TeamUnavailable, EmptyRows, type TeamCtx } from "./context";
import { PersonAvatar, Presence } from "./ui";
import { ActError, useAct } from "./confirm";

const STALL_MS = 2 * 3_600_000;

function bucket(t: TeamTask): "active" | "waiting" | "stuck" | null {
  if (isClosed(t) || t.state === "unassigned" || t.state === "cancelled") return null;
  if (["blocked", "paused", "needs-owner"].includes(t.state)) return "stuck";
  if (["active", "acknowledged"].includes(t.state) && t.lastSignalAt && Date.now() - new Date(t.lastSignalAt).getTime() > STALL_MS) return "stuck";
  if (["assigned", "review", "approved", "pushed"].includes(t.state)) return "waiting";
  return "active";
}

function Count({ n, label, max, tone }: { n: number; label: string; max: number; tone: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-5 text-right font-mono text-[13px] tabular-nums">{n}</span>
      <span aria-hidden className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-secondary">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${max ? (n / max) * 100 : 0}%` }} />
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function ReassignMenu({ ctx, p, tasks }: { ctx: TeamCtx; p: TeamPerson; tasks: TeamTask[] }) {
  const act = useAct();
  const movable = tasks.filter((t) => ctx.caps.manage(t.project));
  if (!movable.length) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="max-md:h-11" aria-label={`Reassign one of ${p.name}'s tasks`}>Reassign<ChevronDown aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Move a task from {p.name.split(" ")[0]}</DropdownMenuLabel>
        {movable.map((t) => {
          const others = ctx.ws.people.filter((o) => o.id !== p.id && roleIn(o, t.project) && roleIn(o, t.project) !== "viewer" && o.devices.some((d) => !d.revokedAt));
          return (
            <DropdownMenuSub key={t.id}>
              <DropdownMenuSubTrigger><span className="font-mono text-[11px] text-muted-foreground">{t.id}</span><span className="truncate">{t.title}</span></DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {others.length === 0 && <DropdownMenuItem disabled>No one else has access to {ctx.pname(t.project)}</DropdownMenuItem>}
                {others.map((o) => (
                  <DropdownMenuItem key={o.id} onSelect={() => void act.sign({ kind: "task.assign", params: { taskId: t.id, rev: t.rev, memberId: o.id } }, `Moved to ${o.name}`)}>
                    <PersonAvatar person={o} size={18} />
                    <span className="flex-1 truncate">{o.name}</span>
                    <span className="text-[11px] text-muted-foreground">{o.presence === "online" ? "online" : "offline"}{inventory(o).has(t.project) ? "" : " · no clone"}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    <ActError error={act.error} />
    </span>
  );
}

export function WorkloadScreen() {
  const ctx = useTeam();
  if (!ctx) return <TeamUnavailable title="Workload" />;
  const rows = ctx.ws.people
    .filter((p) => p.devices.some((d) => !d.revokedAt) && Object.values(p.roles).some((r) => r !== "viewer"))
    .map((p) => {
      const tasks = ctx.ws.tasks.filter((t) => t.assignee === p.id && bucket(t)).sort(compareTasks(p.id));
      return { p, tasks, active: tasks.filter((t) => bucket(t) === "active").length, waiting: tasks.filter((t) => bucket(t) === "waiting").length, stuck: tasks.filter((t) => bucket(t) === "stuck").length };
    });
  const max = Math.max(1, ...rows.flatMap((r) => [r.active, r.waiting, r.stuck]));
  const cols = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_7.5rem]";

  return (
    <Page>
      <PageHeader title="Workload" description="Active, waiting and stuck work per person. Stuck means blocked, paused, needing an owner, or no signal for 2 hours." />
      <div className="p-4 md:p-6">
        {rows.length === 0 ? <EmptyRows icon={Gauge} title="Nothing to balance yet">Once teammates have tasks, you'll see who is overloaded.</EmptyRows> : (
          <div className="overflow-hidden rounded-lg border border-border-subtle bg-card">
            <div aria-hidden className={`grid h-8 ${cols} items-center gap-3 border-b border-border-subtle px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase max-md:hidden`}>
              <span>Person</span><span>Active</span><span>Waiting</span><span>Stuck</span><span>Tasks</span><span />
            </div>
            <ul className="list-none">
              {rows.map(({ p, tasks, active, waiting, stuck }) => (
                <li key={p.id} className={`grid ${cols} items-center gap-3 border-b border-border-subtle px-4 py-2 text-[13px] last:border-b-0 max-md:flex max-md:flex-wrap max-md:py-3`}>
                  <div className="flex min-w-0 items-center gap-2 max-md:w-full">
                    <PersonAvatar person={p} />
                    <div className="min-w-0">
                      <Link to={links.member(p.id)} className="block truncate font-medium hover:underline">{p.name}</Link>
                      <Presence person={p} />
                    </div>
                  </div>
                  <div className="max-md:flex max-md:items-center max-md:gap-1"><span className="text-xs text-muted-foreground md:hidden">Active</span><Count n={active} max={max} label="active" tone="bg-status-online" /></div>
                  <div className="max-md:flex max-md:items-center max-md:gap-1"><span className="text-xs text-muted-foreground md:hidden">Waiting</span><Count n={waiting} max={max} label="waiting" tone="bg-status-away" /></div>
                  <div className="max-md:flex max-md:items-center max-md:gap-1"><span className="text-xs text-muted-foreground md:hidden">Stuck</span><Count n={stuck} max={max} label="stuck" tone="bg-status-danger" /></div>
                  <ul className="flex min-w-0 list-none flex-col gap-0.5 max-md:w-full">
                    {tasks.length === 0 ? <li className="text-xs text-muted-foreground">No open tasks</li> : tasks.map((t) => (
                      <li key={t.id} className="min-w-0">
                        <Link to={links.task(t.id)} className={cn("flex min-w-0 items-baseline gap-1.5 rounded-sm text-[13px] hover:underline", focusRing)}>
                          <span className="truncate">{t.title}</span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{t.id}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-end max-md:w-full max-md:justify-start"><ReassignMenu ctx={ctx} p={p} tasks={tasks} /></div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Page>
  );
}
