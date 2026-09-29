// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team workspace hook + shared page chrome
   ============================================================ */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CloudOff } from "lucide-react";
import { capabilities, compareTasks, isClosed, personById, projectName, useTeamWorkspace, type Caps } from "@/lib/teamApi";
import type { TeamPerson, TeamTask, TeamWorkspace } from "@/types";

export interface TeamCtx {
  ws: TeamWorkspace;
  viewer: TeamPerson;
  caps: Caps;
  person: (id: string | null | undefined) => TeamPerson | undefined;
  pname: (key: string) => string;
}

/** The workspace plus who is looking at it and what they may do. */
export function useTeam(): TeamCtx | null {
  const ws = useTeamWorkspace();
  if (!ws) return null;
  const viewer = personById(ws, ws.viewerId) ?? ws.people[0]!;
  return {
    ws, viewer,
    caps: capabilities(viewer, ws.recovery.mode),
    person: (id) => personById(ws, id),
    pname: (key) => projectName(ws, key),
  };
}

/** The task a member is on now, by the shared sort order. */
export function currentTask(ctx: TeamCtx, p: TeamPerson): TeamTask | undefined {
  return ctx.ws.tasks.filter((t) => t.assignee === p.id && !isClosed(t) && t.state !== "needs-owner").sort(compareTasks(p.id))[0];
}

export function PageHeader({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="border-b border-border-subtle px-4 pt-4 pb-3 md:px-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl leading-tight font-semibold tracking-tight">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto">{children}</div>;
}

/** Real mode until the daemon serves the team fold (team-api task). */
export function TeamUnavailable({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
        <span aria-hidden className="mb-4 grid size-11 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><CloudOff className="size-5" /></span>
        <h2 className="text-base font-semibold">Team workspace isn't available yet</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">This daemon doesn't serve Team Sync data yet. Members, invites and sharing are managed in the classic Team screen.</p>
        <Button asChild className="mt-5"><Link to="/settings/team/classic">Open the Team screen</Link></Button>
        <p className="mt-3 text-xs text-muted-foreground">To preview the new workspace, turn on demo data in Tweaks.</p>
      </div>
    </Page>
  );
}

export function EmptyRows({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <span aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><Icon className="size-5" /></span>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}
