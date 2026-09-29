// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Inbox (#/inbox, #/inbox/:itemId), spec D §5.5, Rev 3 §11
   Titles come from local templates (never peer text). After catch-up
   one "While you were away" digest replaces a burst of toasts.
   ============================================================ */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BellRing, CheckCheck, Eye, GitMerge, Inbox as InboxIcon, MonitorSmartphone, RotateCcw, Scale, Sparkles, Upload, UserPlus, X, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn, focusRing } from "@/lib/utils";
import { copyText } from "@/lib/format";
import { copyPromptText, inboxFor, isUnacknowledged, teamApi } from "@/lib/teamApi";
import { isInboxId, links } from "@/lib/routes";
import { showToast } from "@/lib/toast";
import type { InboxItem, InboxKind } from "@/types";
import { useTeam, Page, PageHeader, TeamUnavailable, EmptyRows, type TeamCtx } from "./context";
import { ActError, useAct } from "./confirm";
import { ago, clockTime } from "./ui";

const ICON: Record<InboxKind, LucideIcon> = {
  "task.assigned": InboxIcon, "task.reminded": BellRing, "review.requested": Eye, "review.decided": RotateCcw,
  "push.requested": Upload, "skill.offer": Sparkles, "pair.request": UserPlus, "lost-claim": X, "needs-owner": Scale, "pr.merged": GitMerge,
};

const GIT: InboxKind[] = ["review.requested", "review.decided", "push.requested", "pr.merged"];

function title(ctx: TeamCtx, i: InboxItem): string {
  const a = ctx.person(i.actorId)?.name ?? "Someone";
  switch (i.kind) {
    case "task.assigned": return `${a} assigned you ${i.taskId}`;
    case "task.reminded": return `Reminded ${i.count ?? 1}× by ${a} about ${i.taskId}`;
    case "review.requested": return `${a} asked you to review ${i.taskId}`;
    case "review.decided": return i.decision === "approved" ? `${a} approved ${i.taskId}` : i.decision === "changes" ? `${a} requested changes on ${i.taskId}` : `${a} asked a question on ${i.taskId}`;
    case "push.requested": return `${a} asked you to push ${i.taskId}`;
    case "skill.offer": return `${a} offered you the ${i.skill ?? "a"} skill`;
    case "pair.request": return `${i.deviceLabel ?? "A device"} wants to join the team`;
    case "lost-claim": return `You lost the claim on ${i.taskId} to ${a}`;
    case "needs-owner": return `${i.taskId} needs an owner: two changes conflict`;
    case "pr.merged": return `${i.taskId} was merged. Pull to stay current`;
  }
}

function needsAction(ctx: TeamCtx, i: InboxItem): boolean {
  const t = ctx.ws.tasks.find((x) => x.id === i.taskId);
  switch (i.kind) {
    case "review.requested": return t?.state === "review";
    case "push.requested": return t?.state === "approved";
    case "needs-owner": return t?.state === "needs-owner";
    case "task.assigned": case "task.reminded": return !!t && isUnacknowledged(t);
    case "review.decided": return i.decision !== "approved" && t?.state === "changes";
    case "pair.request": case "skill.offer": return !i.read;
    default: return false;
  }
}

function Actions({ ctx, i }: { ctx: TeamCtx; i: InboxItem }) {
  const go = useNavigate();
  const [pushed, setPushed] = useState<null | "busy" | "done">(null);
  const run = useAct();
  const t = ctx.ws.tasks.find((x) => x.id === i.taskId);
  const open = (label = "Open task") => t && <Button key={`open-${label}`} size="sm" variant="ghost" asChild className="max-md:h-11"><Link to={links.task(t.id)}>{label}</Link></Button>;
  const act = needsAction(ctx, i);
  const out: ReactNode[] = [];

  switch (i.kind) {
    case "review.requested":
      out.push(act ? <Button key="r" size="sm" asChild className="max-md:h-11"><Link to={links.task(i.taskId!)}>Open review</Link></Button> : open());
      break;
    case "review.decided": {
      const leadSigned = !!t && !!ctx.person(i.actorId) && ctx.caps && (ctx.person(i.actorId)!.custodian || Object.entries(ctx.person(i.actorId)!.roles).some(([k, r]) => r === "lead" && (k === "*" || k === t.project)));
      if (act && t && leadSigned) {
        out.push(<Button key="s" size="sm" className="max-md:h-11" onClick={async () => {
          if (await copyText(`${copyPromptText(t)} Address the review comments first.`)) showToast({ kind: "ok", title: "Copied, paste it into your agent" });
        }}>Send to my agent</Button>);
      }
      out.push(<span key="o">{open()}</span>);
      break;
    }
    case "push.requested":
      if (act && t) {
        out.push(<Button key="p" size="sm" disabled={pushed === "busy"} className="max-md:h-11" onClick={async () => {
          setPushed("busy");
          const r = await run.sign({ kind: "git.push", params: { taskId: t.id, branch: t.review?.branch ?? null } }, "Pushed");
          if (r.ok) run.run(() => teamApi.markRead(i.id));
          setPushed(r.ok ? "done" : null);
        }}>{pushed === "busy" ? "Pushing…" : "Push now"}</Button>);
      }
      if (pushed === "done") out.push(<span key="d" role="status" className="text-xs text-status-online-foreground">Pushed to origin</span>);
      out.push(<span key="v">{open("View diff")}</span>);
      break;
    case "skill.offer":
      out.push(<Button key="k" size="sm" variant="outline" className="max-md:h-11" onClick={() => { teamApi.markRead(i.id); go("/skills"); }}>Review offer</Button>);
      break;
    case "pair.request":
      if (act && ctx.caps.admit) {
        out.push(<Button key="a" size="sm" className="max-md:h-11" onClick={() => go("/settings/team/pair?request=1")}>Allow…</Button>);
        out.push(<Button key="n" size="sm" variant="ghost" className="max-md:h-11" onClick={() => run.run(() => teamApi.markRead(i.id), "Request denied")}>Deny</Button>);
      }
      break;
    case "task.assigned": case "task.reminded":
      if (act && t) out.push(<Button key="k" size="sm" className="max-md:h-11" onClick={() => run.run(() => { teamApi.acknowledge(t.id); teamApi.markRead(i.id); }, "Acknowledged")}>Acknowledge</Button>);
      out.push(<span key="o">{open()}</span>);
      break;
    case "needs-owner":
      out.push(act ? <Button key="r" size="sm" variant="outline" asChild className="max-md:h-11"><Link to={links.task(i.taskId!)}>Resolve</Link></Button> : open());
      break;
    default:
      out.push(<span key="o">{open()}</span>);
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">{out}</div>
      <ActError error={run.error} />
    </div>
  );
}

function Row({ ctx, i }: { ctx: TeamCtx; i: InboxItem }) {
  const Icon = ICON[i.kind];
  const t = ctx.ws.tasks.find((x) => x.id === i.taskId);
  return (
    <li className={cn("flex gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0", !i.read && "bg-accent/30")}>
      <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border-subtle bg-background text-muted-foreground"><Icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <Link to={links.inboxItem(i.id)} className={cn("min-w-0 flex-1 rounded-sm text-[13px] font-medium hover:underline", focusRing)}>
            {title(ctx, i)}
          </Link>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {ago(i.at)}
            {!i.read && <><span aria-hidden className="size-2 rounded-full bg-status-ready" /><span className="sr-only">Unread</span></>}
          </span>
        </div>
        {t && <p className="truncate text-xs text-muted-foreground">{t.title}</p>}
        <div className="mt-2"><Actions ctx={ctx} i={i} /></div>
      </div>
    </li>
  );
}

function Digest({ ctx }: { ctx: TeamCtx }) {
  const d = ctx.ws.digest;
  if (!d) return null;
  const parts = [
    d.assigned && `${d.assigned} task${d.assigned === 1 ? "" : "s"} assigned`,
    d.reviews && `${d.reviews} review${d.reviews === 1 ? "" : "s"}`,
    d.merged && `${d.merged} merged`,
    d.reminders && `${d.reminders} reminder${d.reminders === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <section aria-labelledby="digest-h" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-card px-4 py-3">
      <MonitorSmartphone aria-hidden className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 id="digest-h" className="text-sm font-semibold">While you were away</h2>
        <p className="text-[13px] text-muted-foreground">Since {clockTime(d.since)}: {parts.join(" · ")}. Everything is below.</p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => teamApi.dismissDigest()}>Dismiss</Button>
    </section>
  );
}

const TABS = [
  { id: "all", label: "All" },
  { id: "action", label: "Needs action" },
  { id: "git", label: "Git" },
] as const;

export function InboxScreen() {
  const ctx = useTeam();
  const { itemId } = useParams();
  const [params, setParams] = useSearchParams();
  if (!ctx) return <TeamUnavailable title="Inbox" />;
  const tab = (params.get("tab") ?? "all") as (typeof TABS)[number]["id"];
  const all = inboxFor(ctx.ws);
  const unread = all.filter((i) => !i.read).length;
  const list = all.filter((i) => tab === "all" ? true : tab === "action" ? needsAction(ctx, i) : GIT.includes(i.kind));
  const count = (id: string) => all.filter((i) => id === "all" ? !i.read : id === "action" ? needsAction(ctx, i) : id === "git" ? GIT.includes(i.kind) && !i.read : false).length;

  return (
    <Page>
      <PageHeader title="Inbox" description={unread ? `${unread} unread` : "All read"}
        actions={unread > 0 ? <Button size="sm" variant="outline" onClick={() => teamApi.markAllRead()}><CheckCheck aria-hidden />Mark all read</Button> : undefined}>
        <div role="tablist" aria-label="Inbox filter" className="-mb-3 mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const on = tab === t.id;
            const n = count(t.id);
            return (
              <button key={t.id} role="tab" aria-selected={on} type="button"
                onClick={() => { const q = new URLSearchParams(params); if (t.id === "all") q.delete("tab"); else q.set("tab", t.id); setParams(q, { replace: true }); }}
                className={cn("relative h-9 shrink-0 rounded-t-md px-3 text-[13px] font-medium max-md:h-11", focusRing, on ? "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t.label}{n > 0 && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{n}</span>}
              </button>
            );
          })}
        </div>
      </PageHeader>
      <div className="p-4 md:p-6">
        {tab === "all" && <Digest ctx={ctx} />}
        {list.length === 0 ? (
          <EmptyRows icon={InboxIcon} title="You're all caught up">
            New notifications that need you will appear here.
          </EmptyRows>
        ) : (
          <ul role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="list-none overflow-hidden rounded-lg border border-border-subtle bg-card">
            {list.map((i) => <Row key={i.id} ctx={ctx} i={i} />)}
          </ul>
        )}
      </div>
      {itemId && <InboxItemSheet id={itemId} />}
    </Page>
  );
}

function InboxItemSheet({ id }: { id: string }) {
  const ctx = useTeam();
  const go = useNavigate();
  const item = isInboxId(id) ? ctx?.ws.inbox.find((i) => i.id === id && i.to === ctx.ws.viewerId) : undefined;
  useEffect(() => { if (item && !item.read) teamApi.markRead(item.id); }, [item]);
  const t = item && ctx?.ws.tasks.find((x) => x.id === item.taskId);
  return (
    <Sheet open onOpenChange={(o) => { if (!o) go("/inbox"); }}>
      <SheetContent side="right" className="w-full sm:max-w-[480px]">
        {!ctx || !item ? (
          <SheetHeader><SheetTitle>Notification not found</SheetTitle><SheetDescription>It may have been cleared on another of your devices.</SheetDescription></SheetHeader>
        ) : (
          <>
            <SheetHeader className="border-b border-border-subtle pr-12">
              <SheetTitle>{title(ctx, item)}</SheetTitle>
              <SheetDescription>{ago(item.at)}{t ? ` · ${t.title}` : ""}</SheetDescription>
            </SheetHeader>
            <div className="p-4"><Actions ctx={ctx} i={item} /></div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
