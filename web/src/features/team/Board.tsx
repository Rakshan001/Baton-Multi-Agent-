// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team Board (#/board?member=&project=&state=)
   spec D §5.4, Rev 2 §3, Rev 3 §3; Team Sync §7.3 sort order.
   Separate from the Pipeline phases screen: this is team tasks by
   person. Filters live in the URL so notifications can deep-link.
   ============================================================ */
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, BellRing, Plus, Scale, SquareKanban, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn, focusRing } from "@/lib/utils";
import { compareTasks, isUnacknowledged } from "@/lib/teamApi";
import { links } from "@/lib/routes";
import type { TeamTask, TeamTaskState } from "@/types";
import { useTeam, Page, PageHeader, TeamUnavailable, EmptyRows, type TeamCtx } from "./context";
import { AttachmentCount } from "./Attachments";
import { SignButton } from "./confirm";
import { Banner, GroupChip, PersonAvatar, PriorityPill, ProjectChip, StateBadge, UrgentBadge, hoursSince, stateLabel } from "./ui";
import { TaskSheet } from "./TaskSheet";
import { ComposeTask } from "./Compose";

const COLUMNS: { id: string; label: string; states: TeamTaskState[] }[] = [
  { id: "open", label: "Unassigned", states: ["unassigned"] },
  { id: "ack", label: "To acknowledge", states: ["assigned"] },
  { id: "doing", label: "In progress", states: ["acknowledged", "active", "blocked", "paused", "changes", "needs-owner"] },
  { id: "review", label: "Review", states: ["review", "approved", "pushed"] },
  { id: "done", label: "Done", states: ["merged", "done"] },
];

function Signals({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const out: { icon: typeof AlertTriangle; text: string; tone: string }[] = [];
  if (t.state === "needs-owner") out.push({ icon: Scale, text: "Needs owner", tone: "text-status-danger-foreground" });
  if (isUnacknowledged(t)) out.push({ icon: BellRing, text: `Unacknowledged · ${hoursSince(t.assignedAt)}${t.reminders.length ? ` · reminded ${t.reminders.length}×` : ""}`, tone: "text-status-away-foreground" });
  if (t.review?.approvedSha && t.review.approvedSha !== t.review.sha && t.state === "review") out.push({ icon: AlertTriangle, text: "Approval is stale", tone: "text-status-away-foreground" });
  if (t.review?.files.some((f) => f.deleted || (f.removedPct ?? 0) > 30)) out.push({ icon: AlertTriangle, text: "Large deletion", tone: "text-status-away-foreground" });
  if (t.lostClaim) out.push({ icon: AlertTriangle, text: `Lost claim · ${ctx.person(t.lostClaim.loserId)?.name.split(" ")[0]}`, tone: "text-muted-foreground" });
  if (!out.length) return null;
  return (
    <ul className="flex list-none flex-col gap-0.5">
      {out.map((s, i) => { const I = s.icon; return <li key={i} className={cn("flex items-center gap-1 text-[11px]", s.tone)}><I aria-hidden className="size-3" />{s.text}</li>; })}
    </ul>
  );
}

function Card({ ctx, t, search }: { ctx: TeamCtx; t: TeamTask; search: string }) {
  const who = ctx.person(t.assignee);
  const group = t.group ? ctx.ws.groups.find((g) => g.id === t.group) : undefined;
  return (
    <li>
      <Link to={links.task(t.id) + search}
        className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          t.state === "needs-owner" ? "border-status-danger/40" : t.urgent ? "border-status-danger/25" : "border-border-subtle")}>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityPill task={t} />
          {t.urgent && <UrgentBadge />}
          <span className="ml-auto flex items-center gap-2"><AttachmentCount n={t.attachments.length} /><span className="font-mono text-[11px] text-muted-foreground">{t.id}</span></span>
        </div>
        <span className="line-clamp-2 text-[13px] leading-snug font-medium">{t.title}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {who ? <span className="inline-flex items-center gap-1.5 text-[13px]"><PersonAvatar person={who} size={20} />{who.name.split(" ")[0]}</span> : <span className="text-xs text-muted-foreground">Unassigned</span>}
          <ProjectChip name={ctx.pname(t.project)} />
          {group && <GroupChip title={group.title} />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <StateBadge state={t.state} />
        </div>
        <Signals ctx={ctx} t={t} />
      </Link>
    </li>
  );
}

function FilterSelect({ id, label, value, onChange, options }: {
  id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-input bg-background px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11">
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function TeamBoardScreen() {
  const ctx = useTeam();
  const { taskId } = useParams();
  const [params, setParams] = useSearchParams();
  const [composing, setComposing] = useState(false);
  if (!ctx) return <TeamUnavailable title="Board" />;
  const member = params.get("member") ?? "";
  const project = params.get("project") ?? "";
  const state = params.get("state") ?? "";
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const search = params.toString() ? `?${params.toString()}` : "";

  const tasks = ctx.ws.tasks
    .filter((t) => t.state !== "cancelled")
    .filter((t) => !member || t.assignee === member)
    .filter((t) => !project || t.project === project)
    .filter((t) => !state || t.state === state)
    .sort(compareTasks(ctx.viewer.id));
  const needsOwner = tasks.filter((t) => t.state === "needs-owner");
  // Shown once per project here (and in Team admin), not on every task.
  const unprotected = ctx.ws.projects.filter((p) => !p.serverProtection);
  const filtered = !!(member || project || state);

  return (
    <Page>
      <PageHeader title="Board" description="Team tasks by person. Sorted by urgency, then effective priority."
        actions={ctx.caps.createTasks ? <Button size="sm" onClick={() => setComposing(true)}><Plus aria-hidden />New task</Button> : undefined}>
        <div className="mt-3 flex flex-wrap items-center gap-3" role="group" aria-label="Filters">
          <FilterSelect id="f-member" label="Person" value={member} onChange={(v) => set("member", v)} options={ctx.ws.people.map((p) => ({ value: p.id, label: p.name }))} />
          <FilterSelect id="f-project" label="Project" value={project} onChange={(v) => set("project", v)} options={ctx.ws.projects.map((p) => ({ value: p.key, label: p.name }))} />
          <FilterSelect id="f-state" label="State" value={state} onChange={(v) => set("state", v)}
            options={(["unassigned", "assigned", "acknowledged", "active", "changes", "review", "approved", "pushed", "needs-owner", "merged"] as TeamTaskState[]).map((s) => ({ value: s, label: stateLabel(s) }))} />
          {filtered && <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}><X aria-hidden />Clear</Button>}
          <span role="status" className="ml-auto text-xs text-muted-foreground">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
        </div>
      </PageHeader>

      <div className="p-4 md:p-6">
        {unprotected.length > 0 && (
          <div className="mb-4">
            <Banner tone="danger" title={`Protected branches aren't protected on GitHub in ${unprotected.map((p) => p.name).join(", ")}`}
              action={<>{unprotected.filter((p) => ctx.caps.manage(p.key)).map((p) => (
                <SignButton key={p.key} action={{ kind: "project.protect", params: { projectKey: p.key } }} ok={`Protection applied to ${p.name}`}>
                  Protect {p.name}…
                </SignButton>
              ))}</>}>
              {unprotected.map((p) => `${p.name}: ${p.protectedBranches.join(", ")}`).join(" · ")}. Agents are still blocked locally, but a push from anywhere else could change them directly.
            </Banner>
          </div>
        )}
        {needsOwner.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-status-danger/35 px-3 py-2 text-[13px]">
            <Scale aria-hidden className="size-4 text-status-danger-foreground" />
            <span className="font-medium">{needsOwner.length === 1 ? "1 task needs" : `${needsOwner.length} tasks need`} an owner</span>
            {needsOwner.map((t) => <Link key={t.id} to={links.task(t.id) + search} className={cn("rounded-sm font-mono text-xs underline underline-offset-2", focusRing)}>{t.id}</Link>)}
          </div>
        )}
        {tasks.length === 0 ? (
          <EmptyRows icon={SquareKanban} title={filtered ? "No tasks match these filters" : "No team tasks yet"}>
            {filtered ? "Clear a filter to see more." : ctx.caps.createTasks ? "Create a task and assign it to a teammate." : "Tasks assigned to you will appear here."}
          </EmptyRows>
        ) : (
          <div className="grid grid-cols-5 gap-3 max-xl:grid-cols-3 max-md:grid-cols-1">
            {COLUMNS.map((c) => {
              const items = tasks.filter((t) => c.states.includes(t.state));
              if (c.id === "open" && !items.length) return null;
              return (
                <section key={c.id} aria-labelledby={`col-${c.id}`} className="flex min-w-0 flex-col gap-2">
                  <h2 id={`col-${c.id}`} className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
                    {c.label}<span className="font-mono">{items.length}</span>
                  </h2>
                  {items.length === 0
                    ? <p className="rounded-lg border border-dashed border-border-subtle px-3 py-4 text-center text-xs text-muted-foreground">Nothing here</p>
                    : <ul className="flex list-none flex-col gap-2">{items.map((t) => <Card key={t.id} ctx={ctx} t={t} search={search} />)}</ul>}
                </section>
              );
            })}
          </div>
        )}
      </div>
      {taskId && <TaskSheet id={taskId} back={`/board${search}`} />}
      {composing && <ComposeTask open onClose={() => setComposing(false)} />}
    </Page>
  );
}
