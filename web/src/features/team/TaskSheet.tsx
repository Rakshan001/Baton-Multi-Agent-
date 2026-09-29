// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Task detail sheet (#/board/task/:id)
   spec D §5.4 + §5.6, Rev 3 §3–§6, §8–§10; Team Sync §7;
   guardrails §1.3 (large deletion) and §1.4 (protected branches).
   Irreversible actions go through confirmAndSign with params only.
   ============================================================ */
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, BellRing, ExternalLink, GitBranch, Lock, Scale, Zap } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { cn, focusRing } from "@/lib/utils";
import {
  agentView, copyPromptText, githubCompareUrl, inventory, isUnacknowledged, remindCooldown, roleIn, teamApi,
} from "@/lib/teamApi";
import { isTaskId, links } from "@/lib/routes";
import type { ConflictSide, Priority, TeamTask } from "@/types";
import { useTeam, type TeamCtx } from "./context";
import { eventText } from "./EventLine";
import { AttachmentDrop, AttachmentList } from "./Attachments";
import { ActError, useAct } from "./confirm";
import {
  Banner, CopyButton, Countdown, GroupChip, Panel, PersonAvatar, Presence, PriorityPill, ProjectChip, QuotedText,
  StateBadge, UrgentBadge, ago, clockTime, hoursSince, useNow, PRIORITY_NAME,
} from "./ui";

const select = cn("h-8 max-w-full rounded-md border border-input bg-background px-2 text-[13px] max-md:h-11", focusRing);

export function TaskSheet({ id, back = "/board" }: { id: string; back?: string }) {
  const ctx = useTeam();
  const go = useNavigate();
  const task = isTaskId(id) ? ctx?.ws.tasks.find((t) => t.id === id) : undefined;
  return (
    <Sheet open onOpenChange={(o) => { if (!o) go(back); }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[640px]">
        {!ctx || !task ? (
          <SheetHeader><SheetTitle>Task not found</SheetTitle><SheetDescription>Nothing on this device matches that link.</SheetDescription></SheetHeader>
        ) : <TaskBody ctx={ctx} t={task} />}
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- header + actions ---------------- */

function TaskBody({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const assignee = ctx.person(t.assignee);
  const group = t.group ? ctx.ws.groups.find((g) => g.id === t.group) : undefined;
  const siblings = group ? group.taskIds.filter((x) => x !== t.id) : [];
  const lead = ctx.caps.manage(t.project);
  const branchAct = useAct();
  const quiet = t.lastSignalAt && ["active", "acknowledged"].includes(t.state) && Date.now() - new Date(t.lastSignalAt).getTime() > 2 * 3_600_000;

  return (
    <>
      <SheetHeader className="gap-2 border-b border-border-subtle pr-12">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>{t.id}</span><span>rev {t.rev}</span>
        </div>
        <SheetTitle className="text-lg leading-snug">{t.title}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityPill task={t} detail />
            {t.urgent && <UrgentBadge />}
            <StateBadge state={t.state} />
            <ProjectChip name={ctx.pname(t.project)} />
            {group && <GroupChip title={group.title} />}
          </div>
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {assignee ? (
            <Link to={links.member(assignee.id)} className={cn("inline-flex items-center gap-2 rounded-sm hover:underline", focusRing)}>
              <PersonAvatar person={assignee} size={22} /><span className="font-medium">{assignee.name}</span>
            </Link>
          ) : <span className="text-muted-foreground">Unassigned</span>}
          {assignee && <Presence person={assignee} showLastSeen />}
          {quiet && <span className="text-xs text-status-away-foreground">No signal since {clockTime(t.lastSignalAt)}</span>}
        </div>
        {siblings.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Part of <span className="text-foreground">{group!.title}</span> with{" "}
            {siblings.map((s, i) => {
              const st = ctx.ws.tasks.find((x) => x.id === s);
              return <span key={s}>{i > 0 && ", "}<Link to={links.task(s)} className={cn("rounded-sm font-mono underline underline-offset-2", focusRing)}>{s}</Link>{st && ` (${ctx.pname(st.project)})`}</span>;
            })}
          </p>
        )}
      </SheetHeader>

      <div className="flex flex-col gap-3 p-4">
        <Notices ctx={ctx} t={t} />
        {t.onProtectedBranch && (ctx.caps.isAssignee(t) || lead) && (
          <Banner tone="danger" title={`${ctx.caps.isAssignee(t) ? "You are" : `${assignee?.name ?? "The assignee"} is`} on a protected branch (${t.onProtectedBranch}): create a task branch`}
            action={ctx.caps.isAssignee(t) ? <Button size="sm" variant="outline" onClick={() => branchAct.run(() => teamApi.createTaskBranch(t.id), "Task branch created")}>Create task branch</Button> : undefined}>
            Agents are blocked from editing here. Work on {t.onProtectedBranch} only lands through a pull request.
            <ActError error={branchAct.error} className="mt-1" />
          </Banner>
        )}
        <Actions ctx={ctx} t={t} lead={lead} />
      </div>

      <Tabs key={t.id} defaultValue={t.review ? "review" : "brief"} className="gap-0 px-4 pb-6">
        <TabsList variant="line" className="w-full justify-start border-b border-border-subtle">
          <TabsTrigger value="brief" className="flex-none">Brief</TabsTrigger>
          <TabsTrigger value="files" className="flex-none">Attachments {t.attachments.length ? `(${t.attachments.length})` : ""}</TabsTrigger>
          <TabsTrigger value="review" className="flex-none">Review</TabsTrigger>
          <TabsTrigger value="timeline" className="flex-none">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="brief" className="pt-4"><BriefTab ctx={ctx} t={t} /></TabsContent>
        <TabsContent value="files" className="pt-4"><FilesTab ctx={ctx} t={t} /></TabsContent>
        <TabsContent value="review" className="pt-4"><ReviewPanel ctx={ctx} t={t} /></TabsContent>
        <TabsContent value="timeline" className="pt-4">
          <ol className="list-none border-l border-border-subtle">
            {[...t.events].reverse().map((e, i) => (
              <li key={i} className="relative py-1.5 pl-4 text-[13px]">
                <span aria-hidden className="absolute top-3 -left-[3px] size-1.5 rounded-full bg-border-strong" />
                {eventText(ctx, e)} <span className="text-xs text-muted-foreground">· {ago(e.at)}</span>
              </li>
            ))}
          </ol>
        </TabsContent>
      </Tabs>
    </>
  );
}

function FilesTab({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const act = useAct();
  return (
    <div className="flex flex-col gap-3">
      <AttachmentList items={t.attachments} />
      {ctx.caps.attach(t) && (
        <>
          <AttachmentDrop designer={roleIn(ctx.viewer, t.project) === "designer"} onAdd={(a) => act.run(() => teamApi.addAttachments(t.id, a), `${a.length} file${a.length === 1 ? "" : "s"} attached`)} />
          <ActError error={act.error} />
        </>
      )}
    </div>
  );
}

function sideText(ctx: TeamCtx, s: ConflictSide): string {
  const a = ctx.person(s.actorId)?.name ?? "Someone";
  switch (s.action) {
    case "reassign": return `${a} reassigned it to ${ctx.person(s.targetId)?.name ?? "someone"}`;
    case "complete": return `${a} marked it complete and asked for review`;
    case "priority": return `${a} changed the priority`;
    case "cancel": return `${a} cancelled it`;
  }
}

function Notices({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const act = useAct();
  const out: ReactNode[] = [];
  if (t.state === "needs-owner" && t.conflict) {
    const canResolve = ctx.caps.resolveConflict(t.project);
    out.push(
      <section key="conflict" aria-labelledby="conflict-h" className="rounded-lg border border-status-danger/35 p-3">
        <h3 id="conflict-h" className="flex items-center gap-1.5 text-sm font-medium"><Scale aria-hidden className="size-4 text-status-danger-foreground" />Needs an owner: two changes happened at once</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">These were made on devices that couldn't see each other. Baton won't pick one silently.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
          {(["a", "b"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-2 rounded-md border border-border-subtle bg-background p-3">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Change {k.toUpperCase()}</span>
              <span className="text-[13px]">{sideText(ctx, t.conflict![k])}</span>
              <span className="text-xs text-muted-foreground">{clockTime(t.conflict![k].at)}</span>
              {canResolve && (
                <Button size="sm" variant="outline" className="mt-auto max-md:h-11"
                  onClick={() => void act.sign({ kind: "conflict.resolve", params: { taskId: t.id, keep: k } }, "Conflict resolved")}>Keep {k.toUpperCase()}</Button>
              )}
            </div>
          ))}
        </div>
        <ActError error={act.error} className="mt-2" />
        {!canResolve && <p className="mt-2 text-xs text-muted-foreground">A lead of {ctx.pname(t.project)} will choose.</p>}
      </section>,
    );
  }
  if (t.lostClaim) {
    const mine = t.lostClaim.loserId === ctx.viewer.id;
    const loser = ctx.person(t.lostClaim.loserId)?.name ?? "Someone";
    const winner = ctx.person(t.lostClaim.winnerId)?.name ?? "someone";
    out.push(
      <Banner key="lost" tone="warn" title={mine ? `You lost the claim: ${winner}'s device took this task first` : `Lost claim: ${loser} and ${winner} took it at the same time`}>
        {mine ? "Your" : `${loser}'s`} worktree <span className="font-mono">{t.lostClaim.worktree}</span> is kept, so no work is lost.
      </Banner>,
    );
  }
  return <>{out}</>;
}

function Actions({ ctx, t, lead }: { ctx: TeamCtx; t: TeamTask; lead: boolean }) {
  const now = useNow(1000);
  const mineAct = useAct();
  const remindAct = useAct();
  const editAct = useAct();
  const mine = ctx.caps.isAssignee(t);
  const assignee = ctx.person(t.assignee);
  const cooldown = remindCooldown(t, now);
  const unacked = isUnacknowledged(t);
  const prompt = copyPromptText(t);
  const block: ReactNode[] = [];

  if (mine && (unacked || ["acknowledged", "active", "changes", "approved"].includes(t.state))) {
    block.push(
      <div key="mine" className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          {unacked && <Button size="sm" className="max-md:h-11" onClick={() => mineAct.run(() => teamApi.acknowledge(t.id), "Acknowledged")}>Acknowledge</Button>}
          {["acknowledged", "active", "changes"].includes(t.state) && (
            <Button size="sm" variant={unacked ? "outline" : "default"} className="max-md:h-11" onClick={() => mineAct.run(() => teamApi.readyForReview(t.id), "Sent for review")}>Ready for review</Button>
          )}
          {t.state === "approved" && (
            <Button size="sm" className="max-md:h-11" onClick={() => void mineAct.sign({ kind: "git.push", params: { taskId: t.id, branch: t.review?.branch ?? null } }, "Pushed")}>Push now</Button>
          )}
          <CopyButton text={prompt} label="Copy prompt" />
        </div>
        <p className="text-xs text-muted-foreground">Copies: <span className="font-mono text-foreground">{prompt}</span></p>
        <ActError error={mineAct.error} />
      </div>,
    );
  }

  if (lead) {
    const candidates = ctx.ws.people.filter((p) => roleIn(p, t.project) && roleIn(p, t.project) !== "viewer" && p.devices.some((d) => !d.revokedAt));
    block.push(
      <div key="lead" className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-card p-3">
        {unacked && assignee && (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <BellRing aria-hidden className="size-4 text-status-away-foreground" />
              <span>Unacknowledged · {hoursSince(t.assignedAt)}</span>
              {t.reminders.length > 0 && <span className="text-muted-foreground">· Reminded {t.reminders.length}× by {ctx.person(t.reminders[t.reminders.length - 1]!.by)?.name}</span>}
              <span className="ml-auto flex items-center gap-2">
                {cooldown > 0 && <Countdown ms={cooldown} label="Next reminder" />}
                <Button size="sm" variant="outline" disabled={cooldown > 0} className="max-md:h-11"
                  onClick={() => remindAct.run(() => teamApi.remind(t.id), `Reminder sent to ${assignee.name}`)}>Remind</Button>
              </span>
            </div>
            <ActError error={remindAct.error} />
          </div>
        )}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[13px] max-sm:grid-cols-1">
          <Label htmlFor={`prio-${t.id}`} className="text-muted-foreground">Priority</Label>
          <div className="flex flex-wrap items-center gap-2">
            <select id={`prio-${t.id}`} value={t.priority} onChange={(e) => editAct.run(() => teamApi.setPriority(t.id, Number(e.target.value) as Priority))} className={select}>
              {([0, 1, 2, 3] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {PRIORITY_NAME[p]}</option>)}
            </select>
            <button type="button" aria-pressed={t.urgent} onClick={() => editAct.run(() => teamApi.setUrgent(t.id, !t.urgent))}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium max-md:h-11", focusRing,
                t.urgent ? "border-status-danger/40 bg-status-danger/12 text-status-danger-foreground" : "border-border hover:bg-accent")}>
              <Zap aria-hidden className="size-3.5" />Urgent{t.urgent ? " on" : ""}
            </button>
          </div>
          <Label htmlFor={`assign-${t.id}`} className="text-muted-foreground">{t.assignee ? "Reassign" : "Assign"}</Label>
          <select id={`assign-${t.id}`} value="" className={select}
            onChange={(e) => { const id = e.target.value; if (id) void editAct.sign({ kind: "task.assign", params: { taskId: t.id, rev: t.rev, memberId: id } }, `Assigned to ${ctx.person(id)?.name ?? "them"}`); }}>
            <option value="" disabled>{t.assignee ? `Currently ${assignee?.name ?? "someone"}…` : "Choose a person…"}</option>
            {candidates.filter((p) => p.id !== t.assignee).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.presence === "online" ? "online" : `offline${p.lastSeen ? `, last seen ${clockTime(p.lastSeen)}` : ""}`} · {inventory(p).has(t.project) ? `has ${ctx.pname(t.project)}` : `no ${ctx.pname(t.project)} clone`}
              </option>
            ))}
          </select>
        </div>
        {t.state === "approved" && (
          <div><Button size="sm" variant="outline" className="max-md:h-11" onClick={() => editAct.run(() => teamApi.requestPush(t.id), `Asked ${assignee?.name ?? "the assignee"} to push`)}>Ask to push</Button></div>
        )}
        {t.state === "pushed" && t.review && (
          <div><Button size="sm" className="max-md:h-11" onClick={() => void editAct.sign({ kind: "git.merge", params: { taskId: t.id, sha: t.review!.sha, branch: t.review!.branch } }, "Merged")}>Merge…</Button></div>
        )}
        <ActError error={editAct.error} />
      </div>,
    );
  }

  return <>{block}</>;
}

/* ---------------- brief ---------------- */

function BriefList({ label, items, check = false }: { label: string; items: string[]; check?: boolean }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <ul className={cn("mt-1 flex flex-col gap-0.5 pl-4 text-[13px]", check ? "list-none pl-0" : "list-disc")}>
        {items.map((x, i) => <li key={i}>{check ? <><span aria-hidden className="mr-1.5 text-muted-foreground">☐</span>{x}</> : x}</li>)}
      </ul>
    </div>
  );
}

function BriefTab({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const [showAgent, setShowAgent] = useState(false);
  const assignee = ctx.person(t.assignee);
  const author = ctx.person(t.noteAuthor);
  const view = agentView({ id: t.id, rev: t.rev, priority: t.priority, urgent: t.urgent, projectName: ctx.pname(t.project), brief: t.brief });
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Agent brief" description="Structured. This is what the agent works from."
        actions={<Button size="xs" variant="ghost" aria-expanded={showAgent} onClick={() => setShowAgent((v) => !v)}>{showAgent ? "Hide" : "What the agent sees"}</Button>}>
        <div className="flex flex-col gap-3 p-3">
          <div><h4 className="text-xs font-medium text-muted-foreground">Goal</h4><p className="mt-1 text-[13px]">{t.brief.goal}</p></div>
          <BriefList label="In scope" items={t.brief.inScope} />
          <BriefList label="Out of scope" items={t.brief.outOfScope} />
          <BriefList label="Acceptance" items={t.brief.acceptance} check />
          {t.brief.skills.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="text-muted-foreground">Skills</span>{t.brief.skills.map((s) => <span key={s} className="rounded border border-border-subtle px-1.5 py-0.5 font-mono">{s}</span>)}</div>
          )}
          {showAgent && <pre aria-label="What the agent sees" className="overflow-x-auto rounded-md border border-border-subtle bg-background p-3 font-mono text-[12px] whitespace-pre-wrap">{view}</pre>}
        </div>
      </Panel>
      {t.note && (
        <Panel title={`Note to ${assignee?.name.split(" ")[0] ?? "the assignee"}`}
          actions={<span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"><Lock aria-hidden className="size-3" />Agents never see this</span>}>
          <div className="p-3">
            <QuotedText text={t.note} author={author?.name} />
            <p className="mt-2 text-xs text-muted-foreground">From {author?.name ?? "a lead"}</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ---------------- review panel ---------------- */

function ReviewPanel({ ctx, t }: { ctx: TeamCtx; t: TeamTask }) {
  const [mode, setMode] = useState<null | "changes" | "question" | "reply">(null);
  const [text, setText] = useState("");
  const act = useAct();
  const r = t.review;
  const lead = ctx.caps.review(t.project);
  if (!r) {
    return <p className="text-[13px] text-muted-foreground">No review yet. It starts when {ctx.person(t.assignee)?.name ?? "the assignee"} marks the task ready.</p>;
  }
  const project = ctx.ws.projects.find((p) => p.key === t.project);
  // Built here from the project's own remote, never from a peer-supplied URL.
  const compare = project ? githubCompareUrl(project.remote, project.protectedBranches[0] ?? "main", r.branch) : null;
  const stale = !!r.approvedSha && r.approvedSha !== r.sha;
  const heavy = r.files.filter((f) => f.deleted || (f.removedPct ?? 0) > 30);
  const canDecide = lead && ["review", "approved", "changes"].includes(t.state);
  const isLead = (id: string) => { const p = ctx.person(id); return !!p && (p.custodian || roleIn(p, t.project) === "lead"); };

  const decide = async (decision: "approved" | "changes" | "question", comment: string, askPush = false) => {
    const res = await act.sign({ kind: "review.decide", params: { taskId: t.id, sha: r.sha, decision, comment, askPush } }, decision === "approved" ? "Approved" : "Sent");
    if (res.ok) { setMode(null); setText(""); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-1 font-mono text-xs"><GitBranch aria-hidden className="size-3.5" />{r.branch}</span>
        <span className="font-mono text-xs text-muted-foreground">{r.sha}</span>
        <span className="rounded border border-border px-1.5 text-[11px]">{r.intent === "ready" ? "Ready" : "Tracking"}</span>
        {stale && (
          <span className="inline-flex items-center gap-1 rounded-md border border-status-away/40 bg-status-away/12 px-1.5 text-[11px] font-medium text-status-away-foreground">
            <AlertTriangle aria-hidden className="size-3" />Approval is stale · {r.commitsSinceApproval} commit{r.commitsSinceApproval === 1 ? "" : "s"} since approval
          </span>
        )}
        {compare && (
          <a href={compare} target="_blank" rel="noopener noreferrer" className={cn("ml-auto inline-flex items-center gap-1 rounded-sm text-xs underline-offset-2 hover:underline", focusRing)}>
            Compare on GitHub<ExternalLink aria-hidden className="size-3" /><span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>

      {heavy.length > 0 && (
        <Banner tone="warn" title="Large deletion: confirm intentional">
          {heavy.map((f) => `${f.path} (${f.deleted ? "deleted" : `${f.removedPct}% removed`})`).join(", ")}
        </Banner>
      )}

      <Panel title={`${r.files.length} files changed`}>
        <ul className="list-none divide-y divide-border-subtle">
          {r.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 px-3 py-1.5 font-mono text-[12px]">
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              {f.deleted && <span className="rounded border border-status-danger/40 px-1 font-sans text-[10px] text-status-danger-foreground uppercase">Deleted</span>}
              <span className="text-status-online-foreground">+{f.added}</span>
              <span className="text-status-danger-foreground">−{f.removed}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {canDecide && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="max-md:h-11" onClick={() => void decide("approved", "Approved.")}>Approve</Button>
          <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => void decide("approved", "Approved. Please push.", true)}>Approve &amp; ask to push</Button>
          <Button size="sm" variant="outline" className="max-md:h-11" aria-expanded={mode === "changes"} onClick={() => setMode(mode === "changes" ? null : "changes")}>Request changes</Button>
          <Button size="sm" variant="ghost" className="max-md:h-11" aria-expanded={mode === "question"} onClick={() => setMode(mode === "question" ? null : "question")}>Ask question</Button>
        </div>
      )}
      <ActError error={act.error} />

      {mode && (
        <form className="flex flex-col gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          if (mode === "reply") { if (act.run(() => teamApi.comment(t.id, text.trim()))) { setText(""); setMode(null); } return; }
          void decide(mode, text.trim());
        }}>
          <Label htmlFor="review-text">{mode === "changes" ? "What needs to change" : mode === "question" ? "Your question" : "Reply"}</Label>
          <textarea id="review-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} required
            className={cn("rounded-md border border-input bg-background px-3 py-2 text-[13px]", focusRing)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setMode(null); setText(""); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!text.trim()}>Send</Button>
          </div>
        </form>
      )}

      <section aria-label="Review thread" className="flex flex-col gap-3">
        {r.comments.map((c) => {
          const who = ctx.person(c.authorId);
          return (
            <article key={c.id} className="flex gap-2.5">
              <PersonAvatar person={who} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-medium">{who?.name ?? "Unknown"}</span>
                  {isLead(c.authorId) && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground uppercase">Lead</span>}
                  {c.decision && <span className="text-muted-foreground">· {c.decision === "approved" ? "Approved" : c.decision === "changes" ? "Requested changes" : "Asked a question"}</span>}
                  <span className="text-muted-foreground">· {ago(c.at)}</span>
                </div>
                <div className="mt-1"><QuotedText text={c.text} author={who?.name} /></div>
              </div>
            </article>
          );
        })}
        {!mode && (lead || ctx.caps.isAssignee(t)) && (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setMode("reply")}>Reply</Button>
        )}
      </section>
    </div>
  );
}
