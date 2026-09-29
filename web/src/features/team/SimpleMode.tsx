// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Simple mode, "My tasks" (spec D Rev 3 §7)
   The default for designers. One card per task, four big actions, each
   gated by plain-language pre-checks with a one-line fix. No diffs and
   no git words beyond "Push".
   ============================================================ */
import { Link } from "react-router-dom";
import { Check, CircleAlert, LayoutList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, focusRing } from "@/lib/utils";
import { links } from "@/lib/routes";
import { copyText } from "@/lib/format";
import { compareTasks, copyPromptText, isClosed, isUnacknowledged, teamApi } from "@/lib/teamApi";
import { showToast } from "@/lib/toast";
import type { TeamTask } from "@/types";
import { useTeam, Page, PageHeader, EmptyRows, type TeamCtx } from "./context";
import { ActError, useAct } from "./confirm";
import { PriorityPill, ProjectChip, StateBadge, UrgentBadge } from "./ui";

interface Check { ok: boolean; label: string; fix: string; to?: string }

function checks(t: TeamTask): { repo: Check; auth: Check; uploaded: Check } {
  const p = t.prechecks ?? { repoLocated: true, gitAuth: true, branchPushed: false };
  return {
    repo: { ok: p.repoLocated, label: "Project folder found", fix: "Find the project folder in your Profile.", to: "/profile" },
    auth: { ok: p.gitAuth, label: "Signed in to GitHub", fix: "Sign in to GitHub from Settings, then come back.", to: "/settings" },
    uploaded: { ok: p.branchPushed || ["pushed", "merged"].includes(t.state), label: "Work uploaded", fix: "Press Push now to upload your latest work." },
  };
}

function CheckRow({ c }: { c: Check }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      {c.ok
        ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-status-online-foreground" />
        : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-away-foreground" />}
      <span>
        <span className={c.ok ? "" : "font-medium"}>{c.label}</span>
        <span className="sr-only">{c.ok ? ": done" : ": needs attention"}</span>
        {!c.ok && <span className="block text-xs text-muted-foreground">{c.to ? <Link to={c.to} className="underline underline-offset-2">{c.fix}</Link> : c.fix}</span>}
      </span>
    </li>
  );
}

function BigAction({ id, label, disabled, reason, onClick, primary }: { id: string; label: string; disabled?: boolean; reason?: string; onClick: () => void; primary?: boolean }) {
  const why = disabled && reason ? `${id}-why` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <Button size="lg" variant={primary ? "default" : "outline"} disabled={disabled} onClick={onClick} className="h-12 w-full" aria-describedby={why}>
        {label}
      </Button>
      {why && <span id={why} className="text-center text-[11px] text-muted-foreground">{reason}</span>}
    </div>
  );
}

function TaskCard({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const c = checks(t);
  const unacked = isUnacknowledged(t);
  const canReview = ["acknowledged", "active", "changes"].includes(t.state);
  const act = useAct();
  return (
    <li className="rounded-xl border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PriorityPill task={t} />
        {t.urgent && <UrgentBadge />}
        <ProjectChip name={ctx.pname(t.project)} />
        <span className="ml-auto"><StateBadge state={t.state} /></span>
      </div>
      <h2 className="mt-2 text-base font-semibold">
        <Link to={links.task(t.id)} className={cn("rounded-sm hover:underline", focusRing)}>{t.title}</Link>
      </h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{t.brief.goal}</p>

      <ul className="mt-3 flex list-none flex-col gap-1.5" aria-label="Before you start">
        <CheckRow c={c.repo} /><CheckRow c={c.auth} /><CheckRow c={c.uploaded} />
      </ul>

      <div className="mt-4 grid grid-cols-4 gap-2 max-md:grid-cols-2">
        <BigAction id={`${t.id}-ack`} label="Acknowledge" primary={unacked} disabled={!unacked} reason={unacked ? undefined : "Done"}
          onClick={() => act.run(() => teamApi.acknowledge(t.id), "Acknowledged")} />
        <BigAction id={`${t.id}-copy`} label="Copy prompt" disabled={!c.repo.ok} reason="Find the folder first"
          onClick={async () => { if (await copyText(copyPromptText(t))) showToast({ kind: "ok", title: "Copied, paste it into your agent" }); }} />
        <BigAction id={`${t.id}-review`} label="Ready for review" disabled={!canReview || !c.uploaded.ok} reason={!canReview ? (unacked ? "Acknowledge first" : "Already sent") : "Push your work first"}
          onClick={() => act.run(() => teamApi.readyForReview(t.id), "Sent for review")} />
        <BigAction id={`${t.id}-push`} label="Push now" primary={t.state === "approved"} disabled={!c.auth.ok || unacked || isClosed(t)} reason={!c.auth.ok ? "Sign in to GitHub first" : unacked ? "Acknowledge first" : "Nothing to push"}
          onClick={() => void act.sign({ kind: "git.push", params: { taskId: t.id, branch: t.review?.branch ?? null } }, "Pushed")} />
      </div>
      <ActError error={act.error} className="mt-2" />
      <p className="mt-2 text-xs text-muted-foreground">Copy prompt pastes: <span className="font-mono text-foreground">{copyPromptText(t)}</span></p>
    </li>
  );
}

export function SimpleModeScreen({ onExit }: { onExit: () => void }) {
  const ctx = useTeam();
  const exit = <Button size="sm" variant="outline" onClick={onExit}>Exit simple mode</Button>;
  if (!ctx) {
    return (
      <Page>
        <PageHeader title="My tasks" actions={exit} />
        <EmptyRows icon={LayoutList} title="Team tasks aren't available yet">This daemon doesn't serve team data yet.</EmptyRows>
      </Page>
    );
  }
  const mine = ctx.ws.tasks.filter((t) => t.assignee === ctx.viewer.id && !isClosed(t) && t.state !== "cancelled").sort(compareTasks(ctx.viewer.id));
  return (
    <Page>
      <PageHeader title="My tasks" description={`${ctx.viewer.name.split(" ")[0]}, here's what's assigned to you, most important first.`} actions={exit} />
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        {mine.length === 0 ? (
          <EmptyRows icon={LayoutList} title="No tasks assigned to you">When a lead assigns you a task it appears here as a card.</EmptyRows>
        ) : (
          <ul className={cn("flex list-none flex-col gap-3")}>{mine.map((t) => <TaskCard key={t.id} ctx={ctx} t={t} />)}</ul>
        )}
      </div>
    </Page>
  );
}
