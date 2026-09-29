// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team workspace building blocks
   Status is always icon + words, never colour alone. Peer free text
   renders as quoted plain text (React escapes it; never innerHTML).
   ============================================================ */
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle, Check, CheckCircle2, CircleDashed, CircleDot, CirclePause, Clock, Copy, Eye, GitMerge, GitPullRequest,
  Info, OctagonAlert, RotateCcw, Scale, ShieldAlert, Upload, XCircle, Zap, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { clockTime, copyText, timeAgo } from "@/lib/format";
import { effectivePriority } from "@/lib/teamApi";
import type { Priority, TeamPerson, TeamTask, TeamTaskState } from "@/types";

/* ---------- time ---------- */

/** Re-render every `ms` so countdowns and "3m ago" stay true. */
export function useNow(ms = 1000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setT(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return t;
}

export { clockTime };
export const ago = (iso?: string) => (iso ? timeAgo(iso) : "—");

export function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function hoursSince(iso?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/* ---------- people ---------- */

/** Stable hue from a name, for people without a chosen avatar colour. */
export function nameHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function PersonAvatar({ person, size = 24 }: { person?: Pick<TeamPerson, "name" | "avatarHue">; size?: number }) {
  const hue = person ? ((Number(person.avatarHue) % 360) + 360) % 360 || 0 : 0;
  const name = person?.name ?? "?";
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), background: person ? `hsl(${hue} 45% 42%)` : "var(--st-offline)" }}>
      {initials || "?"}
    </span>
  );
}

const PRESENCE: Record<TeamPerson["presence"], { label: string; dot: string }> = {
  online: { label: "Online", dot: "bg-status-online" },
  away: { label: "Away", dot: "bg-status-away" },
  offline: { label: "Offline", dot: "border border-status-offline bg-transparent" },
};

export function Presence({ person, showLastSeen = false }: { person: TeamPerson; showLastSeen?: boolean }) {
  const p = PRESENCE[person.presence];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", p.dot)} />
      <span className={person.presence === "offline" ? "text-muted-foreground" : ""}>{p.label}</span>
      {showLastSeen && person.presence !== "online" && person.lastSeen && (
        <span className="text-muted-foreground">· last seen {clockTime(person.lastSeen)}</span>
      )}
    </span>
  );
}

/* ---------- priority, urgency, state ---------- */

const PRIORITY_TONE: Record<Priority, string> = {
  0: "border-status-danger/40 bg-status-danger/12 text-status-danger-foreground",
  1: "border-status-away/40 bg-status-away/12 text-status-away-foreground",
  2: "border-border bg-secondary text-foreground",
  3: "border-border-subtle bg-transparent text-muted-foreground",
};
export const PRIORITY_NAME: Record<Priority, string> = { 0: "Critical", 1: "High", 2: "Normal", 3: "Low" };

/** P0–P3 pill, always with text. `detail` adds "(was P2 · reminded 2×)". */
export function PriorityPill({ task, detail = false }: { task: TeamTask; detail?: boolean }) {
  const eff = effectivePriority(task);
  const raised = eff !== task.priority;
  const n = task.acknowledgedAt ? 0 : task.reminders.length;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span title={`${PRIORITY_NAME[eff]} priority`} className={cn("inline-flex h-5 items-center rounded-md border px-1.5 font-mono text-[11px] font-semibold", PRIORITY_TONE[eff])}>
        P{eff}<span className="sr-only"> ({PRIORITY_NAME[eff]} priority)</span>
      </span>
      {detail && raised && <span className="text-xs text-muted-foreground">(was P{task.priority} · reminded {n}×)</span>}
    </span>
  );
}

export function UrgentBadge() {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md border border-status-danger/40 bg-status-danger/12 px-1.5 text-[11px] font-semibold text-status-danger-foreground">
      <Zap aria-hidden className="size-3" />Urgent
    </span>
  );
}

const STATE_META: Record<TeamTaskState, { label: string; icon: LucideIcon; tone: string }> = {
  unassigned: { label: "Unassigned", icon: CircleDashed, tone: "text-muted-foreground" },
  assigned: { label: "Assigned", icon: CircleDot, tone: "text-status-away-foreground" },
  acknowledged: { label: "Acknowledged", icon: Check, tone: "text-status-ready-foreground" },
  active: { label: "In progress", icon: CircleDot, tone: "text-status-online-foreground" },
  blocked: { label: "Blocked", icon: OctagonAlert, tone: "text-status-danger-foreground" },
  paused: { label: "Paused", icon: CirclePause, tone: "text-muted-foreground" },
  review: { label: "In review", icon: Eye, tone: "text-status-review-foreground" },
  changes: { label: "Changes requested", icon: RotateCcw, tone: "text-status-away-foreground" },
  approved: { label: "Approved", icon: CheckCircle2, tone: "text-status-online-foreground" },
  pushed: { label: "Pushed", icon: Upload, tone: "text-status-ready-foreground" },
  merged: { label: "Merged", icon: GitMerge, tone: "text-status-merged-foreground" },
  done: { label: "Done", icon: CheckCircle2, tone: "text-muted-foreground" },
  "needs-owner": { label: "Needs owner", icon: Scale, tone: "text-status-danger-foreground" },
  cancelled: { label: "Cancelled", icon: XCircle, tone: "text-muted-foreground" },
};

export const stateLabel = (s: TeamTaskState) => STATE_META[s].label;

export function StateBadge({ state }: { state: TeamTaskState }) {
  const m = STATE_META[state];
  const Icon = m.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap">
      <Icon aria-hidden className={cn("size-3.5", m.tone)} />
      <span>{m.label}</span>
    </span>
  );
}

export function ProjectChip({ name }: { name: string }) {
  return <span className="inline-flex h-5 items-center rounded-md border border-border-subtle bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground">{name}</span>;
}

export function GroupChip({ title }: { title: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-[11px] text-muted-foreground">
      <GitPullRequest aria-hidden className="size-3" />{title}
    </span>
  );
}

/* ---------- surfaces ---------- */

const BANNER: Record<"info" | "warn" | "danger", { icon: LucideIcon; cls: string }> = {
  info: { icon: Info, cls: "border-status-ready/30 bg-status-ready/8 [&_svg]:text-status-ready-foreground" },
  warn: { icon: AlertTriangle, cls: "border-status-away/35 bg-status-away/8 [&_svg]:text-status-away-foreground" },
  danger: { icon: ShieldAlert, cls: "border-status-danger/35 bg-status-danger/8 [&_svg]:text-status-danger-foreground" },
};

export function Banner({ tone = "info", title, children, action, icon }: {
  tone?: "info" | "warn" | "danger"; title: string; children?: ReactNode; action?: ReactNode; icon?: LucideIcon;
}) {
  const b = BANNER[tone];
  const Icon = icon ?? b.icon;
  return (
    <div role="note" className={cn("flex flex-wrap items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", b.cls)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 text-[13px] text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 gap-1.5">{action}</div>}
    </div>
  );
}

export function Panel({ title, description, actions, children, className }: {
  title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border-subtle bg-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Peer free text: plain text in a quote, wrapped, never interpreted. */
export function QuotedText({ text, author }: { text: string; author?: string }) {
  return (
    <blockquote className="border-l-2 border-border pl-3 text-[13px] break-words whitespace-pre-wrap text-foreground">
      {author && <span className="sr-only">{author} wrote: </span>}
      {text}
    </blockquote>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); }, [copied]);
  return (
    <button type="button" onClick={async () => { if (await copyText(text)) setCopied(true); }}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11", className)}>
      {copied ? <Check aria-hidden className="size-3.5 text-status-online-foreground" /> : <Copy aria-hidden className="size-3.5" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Countdown({ ms, label }: { ms: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <Clock aria-hidden className="size-3" />
      <span role="timer" aria-label={`${label} in ${mmss(ms)}`}>{mmss(ms)}</span>
    </span>
  );
}

export function SrStatus({ children }: { children: ReactNode }) {
  return <p role="status" className="sr-only">{children}</p>;
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
