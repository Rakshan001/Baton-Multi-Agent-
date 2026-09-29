// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Profile (#/profile), spec D Rev 3 §2
   Name, job role, avatar colour, timezone; my devices; my projects as
   resolved from this device's repos (with "Locate repo…" for unmatched
   ones); notification preferences; simple mode.
   ============================================================ */
import { useEffect, useState } from "react";
import { Check, FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { ls } from "@/lib/storage";
import { inventory, roleIn, roleSummary, teamApi } from "@/lib/teamApi";
import { showToast } from "@/lib/toast";
import type { MemberRepo, TeamPerson } from "@/types";
import { useTeam, Page, PageHeader, TeamUnavailable, type TeamCtx } from "./context";
import { ActError, SignButton, useAct } from "./confirm";
import { Panel, PersonAvatar, ago } from "./ui";

const JOB_ROLES = ["All-rounder", "Backend", "Web", "Mobile", "UI/Design", "Web + backend", "Security admin", "Product manager"];
const HUES: [number, string][] = [[152, "Green"], [205, "Blue"], [20, "Orange"], [280, "Purple"], [330, "Pink"], [45, "Olive"], [0, "Red"], [250, "Indigo"]];
const ZONES = ["Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Singapore", "Australia/Sydney", "UTC"];
const field = "h-9 rounded-md border border-input bg-background px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11";

function Details({ ctx, me }: { ctx: TeamCtx; me: TeamPerson }) {
  const [name, setName] = useState(me.name);
  const [job, setJob] = useState(me.jobRole);
  const [hue, setHue] = useState(me.avatarHue);
  const [tz, setTz] = useState(me.timezone);
  useEffect(() => { setName(me.name); setJob(me.jobRole); setHue(me.avatarHue); setTz(me.timezone); }, [me.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useAct();
  const dirty = name !== me.name || job !== me.jobRole || hue !== me.avatarHue || tz !== me.timezone;
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];
  return (
    <Panel title="Profile" description={roleSummary(me, ctx.pname)}>
      <form className="grid gap-4 p-3" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; act.run(() => teamApi.updateProfile(me.id, { name: name.trim(), jobRole: job, avatarHue: Number(hue), timezone: tz }), "Profile saved"); }}>
        <div className="flex items-center gap-3">
          <PersonAvatar person={{ name: name || "?", avatarHue: hue }} size={44} />
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="pf-name">Name</Label>
            <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required aria-invalid={!name.trim()} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <div className="grid gap-1.5">
            <Label htmlFor="pf-job">Job role</Label>
            <select id="pf-job" value={job} onChange={(e) => setJob(e.target.value)} className={field}>
              {(JOB_ROLES.includes(job) || !job ? JOB_ROLES : [job, ...JOB_ROLES]).map((r) => <option key={r}>{r}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Shown to teammates. Permissions come from project roles, not this.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pf-tz">Timezone</Label>
            <select id="pf-tz" value={tz} onChange={(e) => setTz(e.target.value)} className={field}>{zones.map((z) => <option key={z}>{z}</option>)}</select>
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Avatar colour</legend>
          <div className="flex flex-wrap gap-2">
            {HUES.map(([h, hueName]) => (
              <label key={h} className="relative cursor-pointer">
                <input type="radio" name="pf-hue" value={h} checked={hue === h} onChange={() => setHue(h)} className="peer sr-only" />
                <span className="grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-background peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background" style={{ background: `hsl(${h} 45% 42%)` }}>
                  {hue === h && <Check aria-hidden className="size-4 text-white" />}
                </span>
                <span className="sr-only">{hueName}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center justify-end gap-2"><ActError error={act.error} /><Button type="submit" size="sm" disabled={!dirty || !name.trim()}>Save profile</Button></div>
      </form>
    </Panel>
  );
}

function Devices({ me }: { me: TeamPerson }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const act = useAct();
  return (
    <Panel title="My devices" description="Each device has its own key. Revoking one stops it syncing.">
      <ActError error={act.error} className="px-3 pt-2" />
      <ul className="list-none divide-y divide-border-subtle">
        {me.devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              {editing === d.id ? (
                <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (label.trim() && act.run(() => teamApi.renameDevice(me.id, d.id, label.trim()), "Device renamed")) setEditing(null); }}>
                  <Label htmlFor={`dl-${d.id}`} className="sr-only">Device label</Label>
                  <Input id={`dl-${d.id}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} className="h-8" autoFocus />
                  <Button size="sm" type="submit">Save</Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.label}</span>
                  <span className="text-xs text-muted-foreground">{d.model}</span>
                  {d.thisDevice && <span className="text-xs text-muted-foreground">(this device)</span>}
                  {d.relay && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground uppercase">Relay</span>}
                </div>
              )}
              <div className="font-mono text-[11px] text-muted-foreground">{d.fingerprintWords}</div>
              <div className="text-xs text-muted-foreground">{d.revokedAt ? `Revoked ${ago(d.revokedAt)}` : d.online ? "Online now" : `Last seen ${ago(d.lastSeen)}`}</div>
            </div>
            {!d.revokedAt && editing !== d.id && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => { setEditing(d.id); setLabel(d.label); }}>Rename</Button>
                {!d.thisDevice && <SignButton action={{ kind: "device.revoke", params: { memberId: me.id, deviceId: d.id } }} ok={`${d.label} revoked`}>Revoke…</SignButton>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function RepoRow({ ctx, me, r }: { ctx: TeamCtx; me: TeamPerson; r: MemberRepo }) {
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");
  const act = useAct();
  const status = r.duplicateOf ? `Second clone of ${ctx.pname(r.projectKey ?? "")}`
    : r.match === "remote" ? "Matched by remote" : r.match === "located" ? "Confirmed by you"
      : r.match === "root-commit" ? "Matched by first commit. Confirm it's the right repo"
        : "Unmatched";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs break-all">{r.path}</span>
          {r.projectKey && <span className="text-xs">→ <span className="font-mono">{ctx.pname(r.projectKey)}</span></span>}
        </div>
        <div className={cn("text-xs", r.match === "unmatched" ? "text-status-away-foreground" : "text-muted-foreground")}>{status}</div>
        <ActError error={act.error} />
      </div>
      {r.match === "root-commit" && !r.duplicateOf && (
        <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => act.run(() => teamApi.locateRepo(me.id, r.path, r.projectKey!), "Repo confirmed")}>Confirm</Button>
      )}
      {r.duplicateOf && (
        <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => act.run(() => teamApi.choosePrimaryClone(me.id, r.path), "Primary clone changed")}>Use this clone</Button>
      )}
      {r.match === "unmatched" && !picking && (
        <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => setPicking(true)}><FolderSearch aria-hidden />Locate repo…</Button>
      )}
      {picking && (
        <form className="flex w-full flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (choice && act.run(() => teamApi.locateRepo(me.id, r.path, choice), "Repo located")) setPicking(false); }}>
          <Label htmlFor={`loc-${r.path}`} className="text-xs text-muted-foreground">This folder is the team project</Label>
          <select id={`loc-${r.path}`} value={choice} onChange={(e) => setChoice(e.target.value)} className={field}>
            <option value="" disabled>Choose…</option>
            {ctx.ws.projects.filter((p) => roleIn(me, p.key)).map((p) => <option key={p.key} value={p.key}>{p.name} ({p.remote})</option>)}
          </select>
          <Button size="sm" type="submit" disabled={!choice}>Save</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
        </form>
      )}
    </li>
  );
}

function Projects({ ctx, me }: { ctx: TeamCtx; me: TeamPerson }) {
  const inv = inventory(me);
  const missing = ctx.ws.projects.filter((p) => roleIn(me, p.key) && !inv.has(p.key));
  return (
    <Panel title="My projects" description={me.root.path ? `Repos found under ${me.root.path}` : "No Baton folder opened on this device yet."}>
      <ul className="list-none divide-y divide-border-subtle">
        {me.root.repos.map((r) => <RepoRow key={r.path} ctx={ctx} me={me} r={r} />)}
        {missing.map((p) => (
          <li key={p.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <span className="font-mono text-xs">{p.name}</span>
              <div className="text-xs text-muted-foreground">You have access but no clone on this device</div>
            </div>
            <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => showToast({ kind: "info", title: `Clone ${p.remote}`, desc: "Pick a folder in the desktop app to clone into." })}>Clone…</Button>
          </li>
        ))}
        {me.root.repos.length === 0 && missing.length === 0 && <li className="px-3 py-2.5 text-[13px] text-muted-foreground">No repos yet.</li>}
      </ul>
    </Panel>
  );
}

interface NotifyPrefs { quietFrom: string; quietTo: string; osDevice: string; assigned: boolean; reviews: boolean; reminders: boolean; merges: boolean }

function Notifications({ me }: { me: TeamPerson }) {
  const key = `baton:team:notify:${me.id}`;
  const live = me.devices.filter((d) => !d.revokedAt && !d.relay);
  const [p, setP] = useState<NotifyPrefs>(() => ls.get<NotifyPrefs>(key, { quietFrom: "20:00", quietTo: "08:00", osDevice: "recent", assigned: true, reviews: true, reminders: true, merges: false }));
  const set = (patch: Partial<NotifyPrefs>) => { const n = { ...p, ...patch }; setP(n); ls.set(key, n); };
  return (
    <Panel title="Notifications" description="OS notifications go to one device. Every device still gets Inbox items.">
      <div className="grid gap-4 p-3">
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">Quiet hours</legend>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Label htmlFor="q-from" className="text-muted-foreground">From</Label>
            <input id="q-from" type="time" value={p.quietFrom} onChange={(e) => set({ quietFrom: e.target.value })} className={field} />
            <Label htmlFor="q-to" className="text-muted-foreground">to</Label>
            <input id="q-to" type="time" value={p.quietTo} onChange={(e) => set({ quietTo: e.target.value })} className={field} />
          </div>
          <p className="text-xs text-muted-foreground">Urgent tasks still notify during quiet hours.</p>
        </fieldset>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">Send OS notifications to</legend>
          {[{ id: "recent", label: "Whichever device I used last", sub: "Recommended" }, ...live.map((d) => ({ id: d.id, label: d.label, sub: d.model }))].map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 text-[13px] max-md:min-h-11">
              <input type="radio" name="os-device" value={o.id} checked={p.osDevice === o.id} onChange={() => set({ osDevice: o.id })} className="size-4 accent-current" />
              <span>{o.label}</span><span className="text-xs text-muted-foreground">{o.sub}</span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-2">
          {([["assigned", "Tasks assigned to me"], ["reviews", "Review requests and decisions"], ["reminders", "Reminders"], ["merges", "Merges (pull to stay current)"]] as const).map(([k, label]) => (
            <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
              <span id={`nt-${k}`}>{label}</span>
              <Switch checked={p[k]} onChange={(v) => set({ [k]: v } as Partial<NotifyPrefs>)} label={label} />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function ProfileScreen({ simpleMode, onSimpleMode }: { simpleMode: boolean; onSimpleMode: (v: boolean) => void }) {
  const ctx = useTeam();
  if (!ctx) return <TeamUnavailable title="Profile" />;
  const me = ctx.viewer;
  return (
    <Page>
      <PageHeader title="Profile" description="How teammates see you, your devices and the repos on this Mac." />
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
        <Details ctx={ctx} me={me} />
        <Devices me={me} />
        <Projects ctx={ctx} me={me} />
        <Notifications me={me} />
        <Panel title="Simple mode" description="One screen with your tasks and four big actions. No diffs, no git words beyond Push.">
          <div className="flex items-center justify-between gap-3 p-3 text-[13px]">
            <span>Use simple mode on this device</span>
            <Switch checked={simpleMode} onChange={onSimpleMode} label="Simple mode" />
          </div>
        </Panel>
      </div>
    </Page>
  );
}
