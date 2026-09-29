// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Compose task (Lead), spec D Rev 3 §5
   Two clearly separate panels: the structured "Agent brief" with a live
   "What the agent sees" preview and budget meter, and a human-only
   "Note to <name>" that agents never see. Several projects make a
   feature group with one child task per repo (Team Sync §7.5).
   ============================================================ */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Zap } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, focusRing } from "@/lib/utils";
import {
  BRIEF_TOKEN_CAP, agentView, estimateTokens, inventory, roleIn, teamApi,
} from "@/lib/teamApi";
import { links } from "@/lib/routes";
import type { Priority, TeamAttachment } from "@/types";
import { useTeam } from "./context";
import { AttachmentDrop, AttachmentList } from "./Attachments";
import { ActError, useAct } from "./confirm";
import { Banner, PRIORITY_NAME, clockTime } from "./ui";

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const field = cn("rounded-md border border-input bg-background px-3 py-2 text-[13px]", focusRing);

export function ComposeTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useTeam();
  const go = useNavigate();
  const [title, setTitle] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<Priority>(2);
  const [urgent, setUrgent] = useState(false);
  const [goal, setGoal] = useState("");
  const [inScope, setInScope] = useState("");
  const [outScope, setOutScope] = useState("");
  const [accept, setAccept] = useState("");
  const [skills, setSkills] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<TeamAttachment[]>([]);
  const [tried, setTried] = useState(false);
  const act = useAct();

  const brief = useMemo(() => ({
    goal: goal.trim(), inScope: lines(inScope), outOfScope: lines(outScope), acceptance: lines(accept),
    skills: skills.split(",").map((s) => s.trim()).filter(Boolean),
  }), [goal, inScope, outScope, accept, skills]);

  if (!ctx) return null;
  const leadProjects = ctx.ws.projects.filter((p) => ctx.caps.manage(p.key));
  const person = ctx.person(assignee || null);
  const firstName = person?.name.split(" ")[0];
  const preview = agentView({ id: "T-new", rev: 1, priority, urgent, projectName: projects.map(ctx.pname).join(" + ") || "—", brief });
  const tokens = estimateTokens(preview);
  const over = tokens > BRIEF_TOKEN_CAP;
  const missing = person ? projects.filter((k) => !inventory(person).has(k)) : [];
  const errors = { title: !title.trim(), projects: projects.length === 0, goal: !goal.trim() };
  const valid = !errors.title && !errors.projects && !errors.goal && !over;

  const candidates = ctx.ws.people.filter((p) => p.devices.some((d) => !d.revokedAt) && Object.values(p.roles).some((r) => r !== "viewer"));

  const submit = async () => {
    setTried(true);
    if (!valid) return;
    let attachmentIds: string[] = [];
    if (!act.run(() => { attachmentIds = teamApi.stageAttachments(files); })) return;
    const res = await act.sign(
      { kind: "task.create", params: { title: title.trim(), projects, memberId: assignee || null, priority, urgent, brief, note: note.trim(), attachmentIds } },
      projects.length > 1 ? "Feature group created" : "Task created",
    );
    if (res.ok) { onClose(); if (res.created?.[0]) go(links.task(res.created[0])); }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[720px]">
        <SheetHeader className="border-b border-border-subtle">
          <SheetTitle>New task</SheetTitle>
          <SheetDescription>The agent brief goes to the agent. The note goes only to the person.</SheetDescription>
        </SheetHeader>
        <form className="flex flex-col gap-4 p-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="c-title">Title</Label>
            <Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-invalid={tried && errors.title} aria-describedby={tried && errors.title ? "c-title-err" : undefined} />
            {tried && errors.title && <p id="c-title-err" className="text-xs text-status-danger-foreground">Give the task a title.</p>}
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">Projects</legend>
            <div className="flex flex-wrap gap-1.5">
              {leadProjects.map((p) => {
                const on = projects.includes(p.key);
                return (
                  <label key={p.key} className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background max-md:h-11", on ? "border-border-strong bg-selected" : "border-border hover:bg-accent")}>
                    <input type="checkbox" className="size-3.5 accent-current" checked={on} onChange={() => setProjects(on ? projects.filter((k) => k !== p.key) : [...projects, p.key])} />
                    {p.name}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{projects.length > 1 ? `Makes a feature group: one task per repo (${projects.map(ctx.pname).join(", ")}).` : "Pick two or more to make a feature group with one task per repo."}</p>
            {tried && errors.projects && <p className="text-xs text-status-danger-foreground">Pick at least one project.</p>}
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 max-sm:grid-cols-1">
            <div className="grid gap-1.5">
              <Label htmlFor="c-assignee">Assignee</Label>
              <select id="c-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className={cn(field, "h-9 py-0 max-md:h-11")}>
                <option value="">Leave unassigned</option>
                {candidates.map((p) => {
                  const inv = inventory(p);
                  const has = projects.length ? projects.map((k) => `${inv.has(k) ? "has" : "no"} ${ctx.pname(k)}`).join(", ") : "";
                  const avail = p.presence === "online" ? "online" : `offline${p.lastSeen ? `, last seen ${clockTime(p.lastSeen)}` : ""}`;
                  return <option key={p.id} value={p.id}>{p.name} · {avail}{has ? ` · ${has}` : ""}</option>;
                })}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="c-prio">Priority</Label>
                <select id="c-prio" value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)} className={cn(field, "h-9 py-0 max-md:h-11")}>
                  {([0, 1, 2, 3] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {PRIORITY_NAME[p]}</option>)}
                </select>
              </div>
              <button type="button" aria-pressed={urgent} onClick={() => setUrgent(!urgent)}
                className={cn("inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11", urgent ? "border-status-danger/40 bg-status-danger/12 text-status-danger-foreground" : "border-border hover:bg-accent")}>
                <Zap aria-hidden className="size-3.5" />Urgent
              </button>
            </div>
          </div>
          {person && missing.length > 0 && (
            <Banner tone="warn" title={`${person.name} has no clone of ${missing.map(ctx.pname).join(" or ")}`}>
              Assign anyway and they'll be asked to clone it, or pick someone else.
            </Banner>
          )}
          {person && projects.some((k) => roleIn(person, k) === null) && (
            <Banner tone="warn" title={`${person.name} has no role in ${projects.filter((k) => roleIn(person, k) === null).map(ctx.pname).join(", ")}`}>Grant access in Team admin first, or pick someone else.</Banner>
          )}

          <section aria-labelledby="c-brief-h" className="rounded-lg border border-border-subtle">
            <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
              <h3 id="c-brief-h" className="text-sm font-semibold">Agent brief</h3>
              <span className="text-xs text-muted-foreground">Structured. The agent reads this through my_tasks.</span>
            </header>
            <div className="grid grid-cols-2 gap-4 p-3 max-md:grid-cols-1">
              <div className="flex flex-col gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="c-goal">Goal</Label>
                  <textarea id="c-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} className={field} aria-invalid={tried && errors.goal} />
                  {tried && errors.goal && <p className="text-xs text-status-danger-foreground">Say what done looks like in a sentence.</p>}
                </div>
                <div className="grid gap-1.5"><Label htmlFor="c-in">In scope <span className="font-normal text-muted-foreground">(one per line)</span></Label><textarea id="c-in" rows={3} value={inScope} onChange={(e) => setInScope(e.target.value)} className={field} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-out">Out of scope</Label><textarea id="c-out" rows={2} value={outScope} onChange={(e) => setOutScope(e.target.value)} className={field} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-acc">Acceptance <span className="font-normal text-muted-foreground">(one per line)</span></Label><textarea id="c-acc" rows={3} value={accept} onChange={(e) => setAccept(e.target.value)} className={field} /></div>
                <div className="grid gap-1.5"><Label htmlFor="c-skills">Skills <span className="font-normal text-muted-foreground">(comma separated)</span></Label><Input id="c-skills" value={skills} onChange={(e) => setSkills(e.target.value)} className="font-mono" /></div>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground" id="c-preview-h">What the agent sees</span>
                <pre aria-labelledby="c-preview-h" className="min-h-40 flex-1 overflow-auto rounded-md border border-border-subtle bg-background p-3 font-mono text-[12px] break-words whitespace-pre-wrap">{preview}</pre>
                <div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Brief budget</span><span className={cn("font-mono", over && "text-status-danger-foreground")}>{tokens} / {BRIEF_TOKEN_CAP} tokens</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary" role="meter" aria-valuemin={0} aria-valuemax={BRIEF_TOKEN_CAP} aria-valuenow={tokens} aria-label="Brief token budget">
                    <div className={cn("h-full rounded-full", over ? "bg-status-danger" : "bg-foreground/60")} style={{ width: `${Math.min(100, (tokens / BRIEF_TOKEN_CAP) * 100)}%` }} />
                  </div>
                  {over && <p className="mt-1 text-xs text-status-danger-foreground">Over budget. Move detail into an attachment or a skill.</p>}
                </div>
              </div>
            </div>
          </section>

          <section aria-labelledby="c-note-h" className="rounded-lg border border-border-subtle">
            <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
              <h3 id="c-note-h" className="text-sm font-semibold">Note to {firstName ?? "the assignee"}</h3>
              <span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"><Lock aria-hidden className="size-3" />Agents never see this</span>
            </header>
            <div className="grid gap-1.5 p-3">
              <Label htmlFor="c-note" className="sr-only">Note to {firstName ?? "the assignee"}</Label>
              <textarea id="c-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="Context for the person: who to ask, what to watch out for." />
            </div>
          </section>

          <div className="grid gap-2">
            <span className="text-sm font-medium">Attachments</span>
            {files.length > 0 && <AttachmentList items={files} previews={false} />}
            <AttachmentDrop onAdd={(a) => setFiles((f) => [...f, ...a])} />
          </div>

          <ActError error={act.error} />
          <SheetFooter className="flex-row justify-end border-t border-border-subtle px-0 pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit">{person ? "Create and assign…" : "Create…"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
