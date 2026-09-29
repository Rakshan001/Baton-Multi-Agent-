// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Member detail sheet (spec D §5.2, Rev 3 §12)
   Roles per project as a matrix, devices with fingerprint words,
   repo inventory, current task and recent activity.
   ============================================================ */
import { Link, useNavigate } from "react-router-dom";
import { Check, Minus, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { inventory, roleIn, ROLE_LABEL, teamApi } from "@/lib/teamApi";
import { links } from "@/lib/routes";
import type { ProjectRole, TeamPerson } from "@/types";
import { useTeam, currentTask, type TeamCtx } from "./context";
import { EventLine } from "./EventLine";
import { PersonAvatar, Presence, clockTime, ago, StateBadge, Panel } from "./ui";
import { SignButton } from "./confirm";

const ROLES: ProjectRole[] = ["lead", "developer", "designer", "viewer"];

function RoleMatrix({ ctx, p }: { ctx: TeamCtx; p: TeamPerson }) {
  const inv = inventory(p);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <caption className="sr-only">Roles for {p.name} in each project</caption>
        <thead>
          <tr className="border-b border-border-subtle text-left text-[11px] tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="px-3 py-2 font-medium">Project</th>
            {ROLES.map((r) => <th key={r} scope="col" className="px-2 py-2 text-center font-medium">{ROLE_LABEL[r]}</th>)}
            <th scope="col" className="px-3 py-2 font-medium">Clone</th>
          </tr>
        </thead>
        <tbody>
          {ctx.ws.projects.map((proj) => {
            const role = roleIn(p, proj.key);
            return (
              <tr key={proj.key} className="border-b border-border-subtle last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-mono text-xs font-normal">{proj.name}</th>
                {ROLES.map((r) => (
                  <td key={r} className="px-2 py-2 text-center">
                    {role === r
                      ? <span className="inline-flex items-center gap-1"><Check aria-hidden className="size-3.5 text-status-online-foreground" /><span className="sr-only">{ROLE_LABEL[r]}</span></span>
                      : <Minus aria-label="No" className="mx-auto size-3.5 text-muted-foreground/50" />}
                  </td>
                ))}
                <td className="px-3 py-2 text-xs">
                  {inv.has(proj.key) ? <span className="inline-flex items-center gap-1"><Check aria-hidden className="size-3.5 text-status-online-foreground" />Has it</span> : <span className="text-muted-foreground">No clone</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MemberSheet({ id }: { id: string }) {
  const ctx = useTeam();
  const go = useNavigate();
  const p = ctx?.person(id);
  const close = () => go("/people");
  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[520px]">
        {!ctx || !p ? (
          <SheetHeader><SheetTitle>Member not found</SheetTitle><SheetDescription>Nothing on this device matches that link.</SheetDescription></SheetHeader>
        ) : (
          <MemberBody ctx={ctx} p={p} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function MemberBody({ ctx, p }: { ctx: TeamCtx; p: TeamPerson }) {
  const task = currentTask(ctx, p);
  const canRevoke = (own: boolean) => ctx.caps.admit || own;
  const activity = ctx.ws.tasks
    .flatMap((t) => t.events.filter((e) => e.actorId === p.id).map((e) => ({ t, e })))
    .sort((a, b) => b.e.at.localeCompare(a.e.at)).slice(0, 10);
  return (
    <>
      <SheetHeader className="border-b border-border-subtle pr-12">
        <div className="flex items-center gap-3">
          <PersonAvatar person={p} size={40} />
          <div className="min-w-0">
            <SheetTitle className="truncate">{p.name}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{p.jobRole || "No job role"}</span>
              <Presence person={p} showLastSeen />
            </SheetDescription>
          </div>
        </div>
        {p.custodian && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck aria-hidden className="size-3.5" />Custodian: can admit and revoke devices for the whole team
          </p>
        )}
        {p.joinedLateAt && <p className="mt-1 text-xs text-muted-foreground">Joined at {clockTime(p.joinedLateAt)} and caught up from a teammate's device.</p>}
      </SheetHeader>

      <div className="flex flex-col gap-4 p-4">
        <Panel title="Current task">
          <div className="px-3 py-2.5 text-[13px]">
            {task ? (
              <Link to={links.task(task.id)} className="flex items-center gap-2 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <StateBadge state={task.state} />
              </Link>
            ) : <span className="text-muted-foreground">No active task</span>}
          </div>
        </Panel>

        <Panel title="Roles by project" description="Roles are granted per project. Custodian is team-wide.">
          <RoleMatrix ctx={ctx} p={p} />
        </Panel>

        <Panel title="Devices">
          <ul className="list-none divide-y divide-border-subtle">
            {p.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.label}</span>
                    <span className="text-xs text-muted-foreground">{d.model}</span>
                    {d.relay && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground uppercase">Relay</span>}
                    {d.thisDevice && <span className="text-xs text-muted-foreground">(this device)</span>}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{d.fingerprintWords}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.revokedAt ? `Revoked ${ago(d.revokedAt)}` : d.online ? "Online now" : `Last seen ${ago(d.lastSeen)}`}
                  </div>
                </div>
                {!d.revokedAt && canRevoke(p.id === ctx.viewer.id) && !d.thisDevice && (
                  <SignButton action={{ kind: "device.revoke", params: { memberId: p.id, deviceId: d.id } }} ok={`${d.label} revoked`}>Revoke…</SignButton>
                )}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Recent activity">
          {activity.length === 0 ? <p className="px-3 py-2.5 text-[13px] text-muted-foreground">Nothing yet.</p> : (
            <ol className="list-none divide-y divide-border-subtle">
              {activity.map(({ t, e }, i) => (
                <li key={i} className="flex items-baseline gap-2 px-3 py-2 text-[13px]">
                  <Link to={links.task(t.id)} className="shrink-0 font-mono text-xs text-muted-foreground hover:underline">{t.id}</Link>
                  <span className="min-w-0 flex-1"><EventLine ctx={ctx} e={e} /></span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(e.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </>
  );
}
