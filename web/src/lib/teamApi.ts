// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team workspace data layer (spec D §7, Team Sync §5, §7)

   Demo first: the daemon's team endpoints (team-api task) don't exist
   yet, so demo mode runs an in-memory copy of lib/demoTeam.ts and every
   action mutates it, the way a refold would. Real mode reports the
   workspace as unavailable and the screens say so instead of erroring.

   Pure helpers (effective priority, sort order, permissions, the agent's
   view of a brief, the copy-prompt text) live here too so screens and
   tests share one definition.
   ============================================================ */
import { useSyncExternalStore } from "react";
import { BatonAPI } from "./api";
import { buildDemoWorkspace } from "./demoTeam";
import { registerDemoMain, type SignedAction } from "./signedActions";
import type {
  AgentBrief, InboxItem, Priority, ProjectRole, TeamAttachment, TeamPerson, TeamTask, TeamTaskState, TeamWorkspace,
} from "../types";

/* ---------------- store ---------------- */

let state: TeamWorkspace | null = null;
const listeners = new Set<() => void>();

function current(): TeamWorkspace {
  if (!state) state = buildDemoWorkspace();
  return state;
}

function commit(next: TeamWorkspace) {
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const getSnapshot = () => (BatonAPI.demo ? current() : null);

/** The folded team state, or null when this daemon has no team workspace yet. */
export function useTeamWorkspace(): TeamWorkspace | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Immutable update of one task, bumping its rev like an upsert would. */
function patchTask(id: string, fn: (t: TeamTask) => TeamTask) {
  const ws = current();
  commit({ ...ws, tasks: ws.tasks.map((t) => (t.id === id ? { ...fn(t), rev: t.rev + 1 } : t)) });
}

const now = () => new Date().toISOString();

/* ---------------- priority and order (Team Sync §7.3) ---------------- */

export const REMIND_COOLDOWN_MS = 30 * 60_000;

/** Unacknowledged reminders raise priority by at most two steps. */
export function effectivePriority(t: TeamTask): Priority {
  const bump = t.acknowledgedAt ? 0 : Math.min(t.reminders.length, 2);
  return Math.max(0, t.priority - bump) as Priority;
}

const CLOSED: TeamTaskState[] = ["merged", "done", "cancelled"];

/** Deterministic order: held task, urgent, effective priority, assign time, id. */
export function compareTasks(viewerId: string) {
  return (a: TeamTask, b: TeamTask) => {
    const held = (t: TeamTask) => (t.assignee === viewerId && t.state === "active" ? 0 : 1);
    return held(a) - held(b)
      || Number(b.urgent) - Number(a.urgent)
      || effectivePriority(a) - effectivePriority(b)
      || (a.assignedAt ?? "").localeCompare(b.assignedAt ?? "")
      || a.id.localeCompare(b.id);
  };
}

export const isClosed = (t: TeamTask) => CLOSED.includes(t.state);
export const isUnacknowledged = (t: TeamTask) => t.state === "assigned" && !t.acknowledgedAt;

/** ms until this lead may remind again (0 = now). */
export function remindCooldown(t: TeamTask, at = Date.now()): number {
  const last = t.reminders[t.reminders.length - 1];
  if (!last) return 0;
  return Math.max(0, new Date(last.at).getTime() + REMIND_COOLDOWN_MS - at);
}

/* ---------------- permissions (Team Sync §5.2) ---------------- */

export function roleIn(p: TeamPerson, project: string): ProjectRole | null {
  return p.roles[project] ?? p.roles["*"] ?? null;
}

export function capabilities(p: TeamPerson | undefined, recovery = false) {
  const lead = (project: string) => !!p && (p.custodian || roleIn(p, project) === "lead");
  return {
    /** Assign, reassign, remind, priority, briefs. */
    manage: lead,
    review: lead,
    resolveConflict: (project: string) => !!p && roleIn(p, project) === "lead",
    /** Devices and pairing: custodians, and not while in recovery mode. */
    admit: !!p && p.custodian && !recovery,
    createTasks: !!p && (p.custodian || Object.values(p.roles).includes("lead")),
    isAssignee: (t: TeamTask) => !!p && t.assignee === p.id,
    attach: (t: TeamTask) => lead(t.project) || (!!p && t.assignee === p.id),
    anyLead: !!p && (p.custodian || Object.values(p.roles).includes("lead")),
  };
}
export type Caps = ReturnType<typeof capabilities>;

/** "Custodian · Lead (all projects)" style summary for headers. */
export function roleSummary(p: TeamPerson, projectName: (key: string) => string): string {
  const parts: string[] = [];
  if (p.custodian) parts.push("Custodian");
  const byRole = new Map<ProjectRole, string[]>();
  for (const [k, r] of Object.entries(p.roles)) byRole.set(r, [...(byRole.get(r) ?? []), k === "*" ? "all projects" : projectName(k)]);
  for (const [r, ks] of byRole) parts.push(`${ROLE_LABEL[r]} (${ks.join(", ")})`);
  return parts.join(" · ") || "No project access";
}

export const ROLE_LABEL: Record<ProjectRole, string> = {
  lead: "Lead", developer: "Developer", designer: "Designer", viewer: "Viewer",
};

/** Designers default to simple mode (spec D Rev 3 §7). */
export const prefersSimpleMode = (p: TeamPerson | undefined) =>
  !!p && !p.custodian && Object.values(p.roles).every((r) => r === "designer");

/* ---------------- what the agent sees ---------------- */

/** The brief exactly as MCP `my_tasks` will serve it. The human note is never included. */
export function agentView(t: { id: string; rev: number; priority: Priority; urgent: boolean; projectName: string; brief: AgentBrief }): string {
  const list = (xs: string[]) => xs.filter(Boolean).map((x) => `- ${x}`).join("\n");
  const lines = [
    `Task ${t.id} (rev ${t.rev}) · P${t.priority}${t.urgent ? " · URGENT" : ""} · project ${t.projectName}`,
    `Goal: ${t.brief.goal || "(none)"}`,
  ];
  if (t.brief.inScope.some(Boolean)) lines.push("In scope:", list(t.brief.inScope));
  if (t.brief.outOfScope.some(Boolean)) lines.push("Out of scope:", list(t.brief.outOfScope));
  if (t.brief.acceptance.some(Boolean)) lines.push("Acceptance:", t.brief.acceptance.filter(Boolean).map((x) => `- [ ] ${x}`).join("\n"));
  if (t.brief.skills.length) lines.push(`Skills: ${t.brief.skills.join(", ")}`);
  return lines.join("\n");
}

/** Brief budget: ~chars/4 tokens against the 1,500-token cap (spec A §6.4). */
export const BRIEF_TOKEN_CAP = 1500;
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Copy prompt: ids only, never task text (spec D Rev 3 §6). */
export const copyPromptText = (t: Pick<TeamTask, "id" | "rev">) =>
  `Work on Baton task ${t.id} (rev ${t.rev}). Call my_tasks to load the brief and follow it.`;

/* ---------------- attachments ---------------- */

/** SVG and HTML are never rendered inline, only downloaded (Team Sync §12.4). */
export const inlinePreviewable = (a: TeamAttachment) => a.kind === "image" || a.kind === "pdf" || a.kind === "markdown";

/** Demo stand-in for the blob server's content sniffing: from the MIME type
 *  the browser reports, never from the file name. Real kinds come from the server. */
export function kindFromMime(mime: string): TeamAttachment["kind"] {
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime === "image/svg+xml") return "svg";
  if (mime === "text/html") return "html";
  return "other";
}

/** Attachment names are sanitised before they touch disk (§12.4). */
export const sanitizeName = (name: string) => name.replace(/[^\w .-]/g, "_").slice(0, 80) || "file";

/** Only loopback blob-origin URLs may be embedded (Team Sync §12.4). */
export function safeBlobUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* ---------------- links built locally ---------------- */

/**
 * "Compare on GitHub", built from the project's normalized remote and the
 * branch. Never taken from a peer. Only for github.com remotes.
 */
export function githubCompareUrl(remote: string, base: string, branch: string): string | null {
  const m = /^github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(remote);
  const ref = /^[A-Za-z0-9._/-]{1,200}$/;
  if (!m || !ref.test(base) || !ref.test(branch) || branch.includes("..")) return null;
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${m[1]}/${m[2]}/compare/${enc(base)}...${enc(branch)}`;
}

/* ---------------- reversible actions (no signature) ---------------- */

export class TeamUnavailable extends Error {
  constructor() { super("The team workspace isn't available on this daemon yet."); }
}

function guard() {
  if (!BatonAPI.demo) throw new TeamUnavailable();
}

/** Uploaded-but-unattached files, keyed by id (demo blob store). */
const staged = new Map<string, TeamAttachment>();

export const teamApi = {
  setViewer(id: string) { guard(); commit({ ...current(), viewerId: id }); },
  setRecovery(mode: boolean) { guard(); const ws = current(); commit({ ...ws, recovery: { ...ws.recovery, mode } }); },

  acknowledge(taskId: string) {
    guard();
    const who = current().viewerId;
    patchTask(taskId, (t) => ({
      ...t, state: t.state === "assigned" ? "acknowledged" : t.state, acknowledgedAt: now(), reminders: [],
      events: [...t.events, { at: now(), kind: "acknowledged", actorId: who }],
    }));
  },

  remind(taskId: string) {
    guard();
    const ws = current();
    const t = ws.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (remindCooldown(t) > 0) throw new Error("A reminder went out less than 30 minutes ago.");
    patchTask(taskId, (x) => ({
      ...x, reminders: [...x.reminders, { at: now(), by: ws.viewerId }],
      events: [...x.events, { at: now(), kind: "reminded", actorId: ws.viewerId }],
    }));
  },

  setPriority(taskId: string, priority: Priority) { guard(); patchTask(taskId, (t) => ({ ...t, priority })); },
  setUrgent(taskId: string, urgent: boolean) { guard(); patchTask(taskId, (t) => ({ ...t, urgent })); },

  readyForReview(taskId: string) {
    guard();
    const who = current().viewerId;
    patchTask(taskId, (t) => ({ ...t, state: "review", events: [...t.events, { at: now(), kind: "review.requested", actorId: who }] }));
  },

  comment(taskId: string, text: string) {
    guard();
    const who = current().viewerId;
    patchTask(taskId, (t) => t.review ? { ...t, review: { ...t.review, comments: [...t.review.comments, { id: `c-${Date.now()}`, authorId: who, text, at: now() }] } } : t);
  },

  requestPush(taskId: string) {
    guard();
    const ws = current();
    const t = ws.tasks.find((x) => x.id === taskId);
    if (!t?.assignee) return;
    const item: InboxItem = { id: `n-${Date.now()}`, to: t.assignee, kind: "push.requested", at: now(), read: false, taskId, actorId: ws.viewerId };
    commit({ ...ws, inbox: [item, ...ws.inbox] });
  },

  /** Upload to the (demo) blob store; returns ids to reference in a signed create. */
  stageAttachments(files: TeamAttachment[]): string[] { guard(); for (const f of files) staged.set(f.id, f); return files.map((f) => f.id); },
  addAttachments(taskId: string, files: TeamAttachment[]) { guard(); patchTask(taskId, (t) => ({ ...t, attachments: [...t.attachments, ...files] })); },

  /** Demo of `baton new`: move the work onto its own task branch. */
  createTaskBranch(taskId: string) { guard(); patchTask(taskId, (t) => ({ ...t, onProtectedBranch: undefined })); },

  markRead(itemId: string) { guard(); const ws = current(); commit({ ...ws, inbox: ws.inbox.map((i) => (i.id === itemId ? { ...i, read: true } : i)) }); },
  markAllRead() { guard(); const ws = current(); commit({ ...ws, inbox: ws.inbox.map((i) => (i.to === ws.viewerId ? { ...i, read: true } : i)) }); },
  dismissDigest() { guard(); commit({ ...current(), digest: null }); },

  updateProfile(personId: string, patch: Partial<Pick<TeamPerson, "name" | "jobRole" | "avatarHue" | "timezone">>) {
    guard();
    const ws = current();
    const clean = { ...patch, ...(patch.avatarHue !== undefined ? { avatarHue: ((Number(patch.avatarHue) % 360) + 360) % 360 || 0 } : {}) };
    commit({ ...ws, people: ws.people.map((p) => (p.id === personId ? { ...p, ...clean } : p)) });
  },

  renameDevice(personId: string, deviceId: string, label: string) {
    guard();
    const ws = current();
    commit({ ...ws, people: ws.people.map((p) => p.id !== personId ? p : { ...p, devices: p.devices.map((d) => (d.id === deviceId ? { ...d, label } : d)) }) });
  },

  /** Resolve an unmatched repo, or confirm a root-commit match. */
  locateRepo(personId: string, path: string, projectKey: string) {
    guard();
    const ws = current();
    commit({ ...ws, people: ws.people.map((p) => p.id !== personId ? p : { ...p, root: { ...p.root, repos: p.root.repos.map((r) => (r.path === path ? { ...r, projectKey, match: "located" as const } : r)) } }) });
  },

  choosePrimaryClone(personId: string, path: string) {
    guard();
    const ws = current();
    commit({ ...ws, people: ws.people.map((p) => {
      if (p.id !== personId) return p;
      const chosen = p.root.repos.find((r) => r.path === path);
      if (!chosen) return p;
      return { ...p, root: { ...p.root, repos: p.root.repos.map((r) => {
        if (r.projectKey !== chosen.projectKey) return r;
        return r.path === path ? { ...r, duplicateOf: undefined } : { ...r, duplicateOf: path };
      }) } };
    }) });
  },
};

/* ---------------- demo "main": signed actions ----------------
   Stands in for Electron main (lib/signedActions.ts). It builds the dialog
   text from the params and the current fold, asks, then applies. These
   mutations are module-private: nothing in the renderer can call them. */

export interface DemoPrompt { title: string; body: string; confirmLabel: string; tone: "default" | "danger" }
let prompter: ((p: DemoPrompt) => Promise<boolean>) | null = null;

/** The in-page dialog registers itself here (features/team/confirm.tsx). */
export function setDemoPrompter(fn: ((p: DemoPrompt) => Promise<boolean>) | null) { prompter = fn; }

const nameOf = (ws: TeamWorkspace, id: string | null | undefined) => ws.people.find((p) => p.id === id)?.name ?? "someone";
const taskOf = (ws: TeamWorkspace, id: string) => ws.tasks.find((t) => t.id === id);
const pname = (ws: TeamWorkspace, key: string) => (key === "*" ? "all projects" : projectName(ws, key));

function describe(ws: TeamWorkspace, a: SignedAction): DemoPrompt | string {
  switch (a.kind) {
    case "task.assign": {
      const t = taskOf(ws, a.params.taskId);
      if (!t) return "That task no longer exists.";
      if (t.rev !== a.params.rev) return `${t.id} changed since you opened it. Review it again.`;
      const who = ws.people.find((p) => p.id === a.params.memberId);
      if (!who) return "That person isn't in the team.";
      const noClone = !inventory(who).has(t.project);
      return {
        title: `${t.assignee ? "Reassign" : "Assign"} ${t.id} to ${who.name}?`,
        body: `${who.name} is notified and must acknowledge it.${noClone ? ` ${who.name} has no clone of ${pname(ws, t.project)} yet and will be asked to clone it.` : ""}`,
        confirmLabel: t.assignee ? "Reassign" : "Assign", tone: "default",
      };
    }
    case "task.create": {
      const p = a.params;
      const many = p.projects.length > 1;
      return {
        title: p.memberId ? `Create and assign to ${nameOf(ws, p.memberId)}?` : "Create this task?",
        body: `${many ? `Creates a feature group with ${p.projects.length} tasks (${p.projects.map((k) => pname(ws, k)).join(", ")}).` : `Creates one task in ${pname(ws, p.projects[0] ?? "")}.`}${p.memberId ? ` ${nameOf(ws, p.memberId)} is notified and must acknowledge it.` : " It stays unassigned."}`,
        confirmLabel: p.memberId ? "Create and assign" : "Create", tone: "default",
      };
    }
    case "review.decide": {
      const t = taskOf(ws, a.params.taskId);
      if (!t?.review) return "There is nothing to review on that task.";
      if (t.review.sha !== a.params.sha) return `New commits arrived on ${t.id}. Review the latest commit.`;
      const d = a.params.decision;
      return {
        title: d === "approved" ? `Approve ${t.id} at ${t.review.sha}${a.params.askPush ? " and ask to push" : ""}?` : d === "changes" ? `Request changes on ${t.id}?` : `Send a question on ${t.id}?`,
        body: d === "approved" ? `Approves commit ${t.review.sha} on ${t.review.branch}. New commits make this approval stale.` : `${nameOf(ws, t.assignee)} is notified with your comment.`,
        confirmLabel: d === "approved" ? "Approve" : "Send", tone: "default",
      };
    }
    case "git.push": {
      const t = taskOf(ws, a.params.taskId);
      if (!t) return "That task no longer exists.";
      return { title: `Push ${t.review?.branch ?? "your work"} to origin?`, body: `Uploads your latest work on ${t.id} so the team can see it.`, confirmLabel: "Push now", tone: "default" };
    }
    case "git.merge": {
      const t = taskOf(ws, a.params.taskId);
      if (!t?.review || t.review.sha !== a.params.sha) return "The branch changed. Review the latest commit first.";
      const base = ws.projects.find((p) => p.key === t.project)?.protectedBranches[0] ?? "main";
      return { title: `Merge ${t.review.branch}?`, body: `Squash-merges ${t.review.sha} into ${base} after a restore point is tagged. Everyone is told to pull.`, confirmLabel: "Merge", tone: "default" };
    }
    case "conflict.resolve": {
      const t = taskOf(ws, a.params.taskId);
      if (!t?.conflict) return "That conflict was already resolved.";
      const side = t.conflict[a.params.keep];
      const what = side.action === "reassign" ? `${nameOf(ws, side.actorId)} reassigned it to ${nameOf(ws, side.targetId)}`
        : side.action === "complete" ? `${nameOf(ws, side.actorId)} marked it complete` : `${nameOf(ws, side.actorId)}'s change`;
      return { title: `Keep: ${what}?`, body: "The other change is discarded for everyone. Both stay in the timeline.", confirmLabel: "Keep this change", tone: "default" };
    }
    case "device.revoke": {
      const p = ws.people.find((x) => x.id === a.params.memberId);
      const d = p?.devices.find((x) => x.id === a.params.deviceId);
      if (!p || !d) return "That device isn't in the team.";
      return { title: `Revoke ${d.label}?`, body: `${d.label} (${p.name}) stops syncing now. Events it signs after this point are voided.`, confirmLabel: "Revoke device", tone: "danger" };
    }
    case "member.remove": {
      const p = ws.people.find((x) => x.id === a.params.memberId);
      if (!p) return "That person isn't in the team.";
      const n = p.devices.filter((d) => !d.revokedAt).length;
      return { title: `Remove ${p.name} from the team?`, body: `Revokes ${n} device${n === 1 ? "" : "s"}. Unsynced work after this point is voided until a custodian accepts it.`, confirmLabel: "Remove", tone: "danger" };
    }
    case "device.admit": {
      const p = a.params;
      const scopes = Object.entries(p.roles).map(([k, r]) => `${r} on ${pname(ws, k)}`).join(", ");
      return { title: `Admit ${p.deviceLabel}?`, body: `${p.name} joins ${ws.teamName} (${scopes}). Only allow if all six words matched: ${p.sasWords.join(" ")}.`, confirmLabel: "Allow", tone: "default" };
    }
    case "project.protect": {
      const pr = ws.projects.find((x) => x.key === a.params.projectKey);
      if (!pr) return "Unknown project.";
      return { title: `Apply recommended protection to ${pr.name}?`, body: `Turns on GitHub rules for ${pr.protectedBranches.join(", ")}: pull request required, one approval, no force-push, no deletion.`, confirmLabel: "Apply protection", tone: "default" };
    }
    case "skill.accept":
      return "Accepting skills isn't available in this preview yet.";
  }
}

function apply(ws: TeamWorkspace, a: SignedAction): string[] | undefined {
  const who = ws.viewerId;
  switch (a.kind) {
    case "task.assign": {
      const { taskId, memberId } = a.params;
      patchTask(taskId, (t) => ({
        ...t, assignee: memberId, state: "assigned", assignedAt: now(), acknowledgedAt: undefined, reminders: [],
        events: [...t.events, { at: now(), kind: t.assignee ? "reassigned" : "assigned", actorId: who, targetId: memberId }],
      }));
      return;
    }
    case "task.create": {
      const p = a.params;
      const nextNum = Math.max(0, ...ws.tasks.map((t) => Number(t.id.slice(2)) || 0)) + 1;
      const groupId = p.projects.length > 1 ? `G-${nextNum}` : undefined;
      const attachments = p.attachmentIds.map((id) => staged.get(id)).filter((x): x is TeamAttachment => !!x);
      const created: TeamTask[] = p.projects.map((project, i) => ({
        id: `T-${String(nextNum + i).padStart(4, "0")}`, rev: 1, title: p.title, project, group: groupId,
        state: p.memberId ? "assigned" : "unassigned", priority: p.priority, urgent: p.urgent, assignee: p.memberId,
        brief: p.brief, note: p.note || undefined, noteAuthor: p.note ? who : undefined, attachments,
        assignedAt: p.memberId ? now() : undefined, reminders: [],
        events: [{ at: now(), kind: p.memberId ? "assigned" : "created", actorId: who, targetId: p.memberId ?? undefined }],
        prechecks: { repoLocated: true, gitAuth: true, branchPushed: false },
      }));
      const groups = groupId ? [...ws.groups, { id: groupId, title: p.title, taskIds: created.map((t) => t.id) }] : ws.groups;
      const inbox = p.memberId
        ? [...created.map((t, i): InboxItem => ({ id: `n-${Date.now()}-${i}`, to: p.memberId!, kind: "task.assigned", at: now(), read: false, taskId: t.id, actorId: who })), ...ws.inbox]
        : ws.inbox;
      commit({ ...ws, tasks: [...ws.tasks, ...created], groups, inbox });
      return created.map((t) => t.id);
    }
    case "review.decide": {
      const { taskId, decision, comment, askPush } = a.params;
      patchTask(taskId, (t) => {
        if (!t.review) return t;
        const c = { id: `c-${Date.now()}`, authorId: who, text: comment, at: now(), decision };
        const review = { ...t.review, comments: [...t.review.comments, c], ...(decision === "approved" ? { approvedSha: t.review.sha, commitsSinceApproval: 0 } : {}) };
        const state: TeamTaskState = decision === "approved" ? "approved" : decision === "changes" ? "changes" : t.state;
        return { ...t, review, state, events: [...t.events, { at: now(), kind: "review.decided", actorId: who }] };
      });
      if (askPush) teamApi.requestPush(taskId);
      return;
    }
    case "git.push":
      patchTask(a.params.taskId, (t) => ({ ...t, state: t.state === "approved" ? "pushed" : t.state, prechecks: t.prechecks ? { ...t.prechecks, branchPushed: true } : t.prechecks, events: [...t.events, { at: now(), kind: "pushed", actorId: who }] }));
      return;
    case "git.merge":
      patchTask(a.params.taskId, (t) => ({ ...t, state: "merged", events: [...t.events, { at: now(), kind: "merged", actorId: who }] }));
      return;
    case "conflict.resolve":
      patchTask(a.params.taskId, (t) => {
        if (!t.conflict) return t;
        const side = t.conflict[a.params.keep];
        const base = { ...t, conflict: undefined, events: [...t.events, { at: now(), kind: "resolved" as const, actorId: who }] };
        if (side.action === "reassign") return { ...base, assignee: side.targetId ?? t.assignee, state: "assigned", assignedAt: now(), acknowledgedAt: undefined, reminders: [] };
        if (side.action === "complete") return { ...base, state: "review" };
        if (side.action === "cancel") return { ...base, state: "cancelled" };
        return { ...base, state: "active" };
      });
      return;
    case "device.revoke":
    case "member.remove": {
      const { memberId } = a.params;
      const only = a.kind === "device.revoke" ? a.params.deviceId : null;
      commit({ ...ws, people: ws.people.map((p) => p.id !== memberId ? p : { ...p, devices: p.devices.map((d) => (!only || d.id === only) && !d.revokedAt ? { ...d, online: false, revokedAt: now() } : d) }) });
      return;
    }
    case "device.admit": {
      const p = a.params;
      const id = p.name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12) || `m${Date.now()}`;
      const idBytes = crypto.getRandomValues(new Uint8Array(10));
      const device = { id: Array.from(idBytes, (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("").slice(0, 16).padEnd(16, "a"), label: p.deviceLabel, model: p.model, online: true, fingerprintWords: p.sasWords.join(" · ") };
      const existing = ws.people.find((x) => x.id === id);
      const people = existing
        ? ws.people.map((x) => (x.id === id ? { ...x, devices: [...x.devices, device], presence: "online" as const } : x))
        : [...ws.people, { id, name: p.name, jobRole: "", avatarHue: (id.length * 47) % 360, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, custodian: false, roles: p.roles, devices: [device], root: { path: "", repos: [] }, presence: "online" as const }];
      commit({ ...ws, people });
      return;
    }
    case "project.protect":
      commit({ ...ws, projects: ws.projects.map((p) => (p.key === a.params.projectKey ? { ...p, serverProtection: true } : p)) });
      return;
    case "skill.accept":
      return;
  }
}

registerDemoMain(async (a) => {
  const ws = current();
  const d = describe(ws, a);
  if (typeof d === "string") return { ok: false, reason: "rejected", message: d };
  if (!prompter) return { ok: false, reason: "unavailable", message: "The confirmation dialog isn't mounted." };
  if (!(await prompter(d))) return { ok: false, reason: "cancelled" };
  return { ok: true, created: apply(current(), a) };
});

/* ---------------- selectors ---------------- */

export function personById(ws: TeamWorkspace, id: string | null | undefined): TeamPerson | undefined {
  return id ? ws.people.find((p) => p.id === id) : undefined;
}

export function projectName(ws: TeamWorkspace, key: string): string {
  return ws.projects.find((p) => p.key === key)?.name ?? key;
}

/** Which projects a member actually has a clone of (device inventory, §4.3). */
export function inventory(p: TeamPerson): Set<string> {
  return new Set(p.root.repos.filter((r) => r.projectKey && r.match !== "unmatched").map((r) => r.projectKey!));
}

export function inboxFor(ws: TeamWorkspace, viewerId = ws.viewerId): InboxItem[] {
  return ws.inbox.filter((i) => i.to === viewerId).sort((a, b) => b.at.localeCompare(a.at));
}

export function unreadCount(ws: TeamWorkspace | null): number {
  return ws ? inboxFor(ws).filter((i) => !i.read).length : 0;
}
