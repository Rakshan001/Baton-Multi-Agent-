// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — People (spec D §5.1, Rev 2 §5, Rev 3 §12)
   Dense roster with presence, job role, device model + label and the
   current task. Online first, offline below a divider. Row → member
   detail sheet (#/people/:id).
   ============================================================ */
import { Link, useNavigate, useParams } from "react-router-dom";
import { MoreHorizontal, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { teamApi } from "@/lib/teamApi";
import { links } from "@/lib/routes";
import type { TeamPerson } from "@/types";
import { useTeam, currentTask, Page, PageHeader, TeamUnavailable, EmptyRows, type TeamCtx } from "./context";
import { PersonAvatar, Presence, ProjectChip, ago, SrStatus } from "./ui";
import { ActError, useAct } from "./confirm";
import { MemberSheet } from "./MemberSheet";

function projectsOf(ctx: TeamCtx, p: TeamPerson): string[] {
  return Object.keys(p.roles).map((k) => (k === "*" ? "all" : ctx.pname(k)));
}

function RowMenu({ ctx, p }: { ctx: TeamCtx; p: TeamPerson }) {
  const go = useNavigate();
  const act = useAct();
  const live = p.devices.filter((d) => !d.revokedAt);
  return (
    <span className="inline-flex items-center gap-2">
    <ActError error={act.error} />
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${p.name}`} className="max-md:size-11" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => go(links.member(p.id))}>Open details</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go(links.board({ member: p.id }))}>View tasks on the board</DropdownMenuItem>
        {ctx.caps.admit && p.id !== ctx.viewer.id && live.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void act.sign({ kind: "member.remove", params: { memberId: p.id } }, `${p.name} removed`)}>Remove from team…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </span>
  );
}

function PersonRow({ ctx, p }: { ctx: TeamCtx; p: TeamPerson }) {
  const go = useNavigate();
  const task = currentTask(ctx, p);
  const device = p.devices.find((d) => d.online && !d.revokedAt) ?? p.devices.find((d) => !d.revokedAt);
  const projects = projectsOf(ctx, p);
  return (
    <li onClick={() => go(links.member(p.id))}
      className="group grid cursor-pointer grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_5rem_2.5rem] items-center gap-3 border-b border-border-subtle px-4 text-[13px] last:border-b-0 hover:bg-accent/60 max-lg:grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1.6fr)_2.5rem] max-md:flex max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1 max-md:py-3 md:h-10">
      <div className="flex min-w-0 items-center gap-2.5 max-md:w-full">
        <PersonAvatar person={p} />
        <Link to={links.member(p.id)} onClick={(e) => e.stopPropagation()}
          className="min-w-0 truncate rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          {p.name}
        </Link>
        <span className="truncate text-xs text-muted-foreground">{p.jobRole}</span>
        {p.id === ctx.viewer.id && <span className="text-xs text-muted-foreground">(you)</span>}
        <div className="ml-auto md:hidden"><RowMenu ctx={ctx} p={p} /></div>
      </div>
      <Presence person={p} />
      <div className="min-w-0 truncate">
        {task ? (
          <Link to={links.task(task.id)} onClick={(e) => e.stopPropagation()} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <span className="font-mono text-xs text-muted-foreground">{task.id}</span> {task.title}
          </Link>
        ) : <span className="text-muted-foreground">No active task</span>}
      </div>
      <div className="flex min-w-0 flex-wrap gap-1 max-lg:hidden">{projects.map((n) => <ProjectChip key={n} name={n} />)}</div>
      <div className="min-w-0 truncate text-xs max-lg:hidden max-md:block max-md:w-full">
        {device ? <>{device.model} <span className="text-muted-foreground">· {device.label}</span></> : <span className="text-muted-foreground">No devices</span>}
      </div>
      <div className="text-xs text-muted-foreground max-lg:hidden">{p.presence === "online" ? "now" : ago(p.lastSeen)}</div>
      <div className="max-md:hidden"><RowMenu ctx={ctx} p={p} /></div>
    </li>
  );
}

export function PeopleScreen() {
  const ctx = useTeam();
  const { memberId } = useParams();
  if (!ctx) return <TeamUnavailable title="Team" />;
  const { ws, caps } = ctx;
  const visible = ws.people.filter((p) => p.devices.some((d) => !d.revokedAt));
  const online = visible.filter((p) => p.presence !== "offline");
  const offline = visible.filter((p) => p.presence === "offline");
  const away = visible.filter((p) => p.presence === "away").length;
  const conflicts = ws.tasks.filter((t) => t.state === "needs-owner").length;
  const summary = [`${online.length - away} online`, away ? `${away} away` : "", `${offline.length} offline`].filter(Boolean).join(" · ");

  return (
    <Page>
      <PageHeader
        title="Team"
        description={<span>{ws.teamName} · <span aria-hidden>{summary}</span>{conflicts > 0 && <> · <Link to={links.board({})} className="underline underline-offset-2">{conflicts === 1 ? "1 task needs" : `${conflicts} tasks need`} an owner</Link></>}</span>}
        actions={caps.admit ? <Button asChild size="sm"><Link to="/settings/team/pair"><UserPlus aria-hidden />Add teammate</Link></Button> : undefined}
      />
      <SrStatus>{summary}</SrStatus>
      <div className="p-4 md:p-6">
        {visible.length === 0 ? (
          <EmptyRows icon={Users} title="No teammates yet">Pair another device to work together.</EmptyRows>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-subtle bg-card">
            <div aria-hidden className="grid h-8 grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_5rem_2.5rem] items-center gap-3 border-b border-border-subtle px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase max-lg:grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1.6fr)_2.5rem] max-md:hidden">
              <span>Name</span><span>Status</span><span>Working on</span><span className="max-lg:hidden">Projects</span><span className="max-lg:hidden">Device</span><span className="max-lg:hidden">Last seen</span><span />
            </div>
            <ul className="list-none" aria-label="Online teammates">
              {online.map((p) => <PersonRow key={p.id} ctx={ctx} p={p} />)}
            </ul>
            {offline.length > 0 && (
              <>
                <div className="border-y border-border-subtle bg-background/40 px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Offline</div>
                <ul className="list-none" aria-label="Offline teammates">
                  {offline.map((p) => <PersonRow key={p.id} ctx={ctx} p={p} />)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
      {memberId && <MemberSheet id={memberId} />}
    </Page>
  );
}
