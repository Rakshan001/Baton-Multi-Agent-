// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Workspace / project switcher (sidebar header)
   Demo: the preview workspace's projects. Real: one row per daemon
   connection, each probed via /api/meta when the menu opens.
   ============================================================ */
import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, FolderOpen, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { WORKSPACE } from "@/lib/preview";
import {
  addConnection, fetchMeta, loadConnections, projectFromMeta, removeConnection, type Connection,
} from "@/lib/connections";
import type { Meta, Project } from "@/types";

type ProbeState = Record<string, Meta | "loading" | "offline">;

interface Row { id: string; name: string; sub: string; color: string; live?: boolean; offline?: boolean; removable?: boolean }

export function ProjectMark({ name, color, size = "md" }: { name: string; color: string; size?: "sm" | "md" }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-[5px] font-bold text-white", size === "sm" ? "size-4 text-[9px]" : "size-6 text-[11px]")}
      style={{ background: color }}>
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function ProjectSwitcher({ project, onProject, demo, connections, onConnectionsChange }: {
  project: Project; onProject: (id: string) => void; demo: boolean;
  connections: Connection[]; onConnectionsChange: (next: Connection[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [probes, setProbes] = useState<ProbeState>({});
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || demo) return;
    setAdding(false); setAddError(null);
    setProbes(Object.fromEntries(connections.map((c) => [c.id, "loading" as const])));
    for (const c of connections) {
      fetchMeta(c)
        .then((meta) => setProbes((p) => ({ ...p, [c.id]: meta })))
        .catch(() => setProbes((p) => ({ ...p, [c.id]: "offline" })));
    }
  }, [open, demo, connections]);

  const submitAdd = async (force = false) => {
    setAddError(null);
    const conn = { name: draftName, baseUrl: draftUrl };
    if (!force) {
      try {
        await fetchMeta({ id: "probe", name: draftName, baseUrl: draftUrl.trim().replace(/\/+$/, "") });
      } catch {
        setAddError(`Could not reach ${draftUrl}/api/meta. Is \`baton serve\` running there?`);
        return;
      }
    }
    try {
      const added = addConnection(conn);
      onConnectionsChange(loadConnections());
      setAdding(false); setDraftName(""); setDraftUrl("");
      showToast({ kind: "ok", title: `Added ${added.name}`, desc: added.baseUrl, mono: true });
    } catch (e) {
      setAddError((e as Error).message);
    }
  };

  const remove = (id: string) => {
    removeConnection(id);
    if (project.id === id) onProject("default");
    onConnectionsChange(loadConnections());
  };

  const rows: Row[] = demo
    ? WORKSPACE.projects.map((p) => ({ id: p.id, name: p.name, sub: p.framework, color: p.color, live: !!p.primary }))
    : connections.map((c) => {
        const probe = probes[c.id];
        const meta = typeof probe === "object" ? probe : null;
        const proj = projectFromMeta(c, meta);
        return {
          id: c.id, name: proj.name, color: proj.color,
          sub: probe === "loading" ? "checking…" : meta ? `${meta.branch} · ${meta.repo}` : "unreachable",
          offline: probe === "offline", removable: c.id !== "default",
        };
      });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Project: ${project.name} on ${project.branch}. Switch project`}
          className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[state=open]:bg-accent">
          <ProjectMark name={project.name} color={project.color} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-4 font-semibold">{project.name}</span>
            <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">{project.branch}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(320px,calc(100vw-24px))] p-1">
        <div className="flex items-center gap-2 px-2 pt-1.5 pb-2 text-[11px] text-muted-foreground">
          <FolderOpen aria-hidden className="size-3.5" />
          <span className="font-mono">{demo ? WORKSPACE.folder : "daemons"}</span>
          <span className="ml-auto">{rows.length} {demo ? "projects" : `connection${rows.length === 1 ? "" : "s"}`}</span>
        </div>
        <ul className="list-none" aria-label="Projects">
          {rows.map((p) => {
            const on = p.id === project.id;
            return (
              <li key={p.id} className="group relative">
                <button type="button" aria-current={on ? "true" : undefined}
                  onClick={() => { onProject(p.id); setOpen(false); }}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 pr-9 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11", on && "bg-selected", p.offline && "opacity-70")}>
                  <ProjectMark name={p.name} color={p.color} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium">
                      {p.name}
                      {p.live && <span className="rounded-full border border-status-online/30 bg-status-online/12 px-1.5 text-[10px] font-semibold text-status-online-foreground uppercase">live</span>}
                      {p.offline && <span className="rounded-full border border-status-danger/30 bg-status-danger/12 px-1.5 text-[10px] font-semibold text-status-danger-foreground uppercase">unreachable</span>}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{p.sub}</span>
                  </span>
                  {on && <Check aria-label="Current project" className="size-4 shrink-0" />}
                </button>
                {p.removable && (
                  <button type="button" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}
                    className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="my-1 h-px bg-border-subtle" />
        {demo ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Demo workspace. Run <span className="font-mono">baton serve</span> in another repo and turn off demo data to add it here.
          </p>
        ) : adding ? (
          <form className="flex flex-col gap-2 p-2" onSubmit={(e) => { e.preventDefault(); void submitAdd(); }}>
            <div className="grid gap-1">
              <Label htmlFor="conn-name" className="text-xs">Name</Label>
              <Input id="conn-name" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="skfin" autoFocus className="h-8" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="conn-url" className="text-xs">Daemon URL</Label>
              <Input id="conn-url" value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="http://localhost:7078" className="h-8 font-mono"
                aria-invalid={addError ? true : undefined} aria-describedby={addError ? "conn-error" : undefined} />
            </div>
            {addError && (
              <p id="conn-error" className="text-xs text-status-danger-foreground">
                {addError}{" "}
                <button type="button" onClick={() => void submitAdd(true)} className="underline underline-offset-2">Add anyway</button>
              </p>
            )}
            <div className="flex justify-end gap-1.5">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setAddError(null); }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!draftUrl.trim()}>Add</Button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:min-h-11">
            <span aria-hidden className="grid size-6 place-items-center rounded-[5px] border border-dashed border-border"><Plus className="size-3.5" /></span>
            Add connection…
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
