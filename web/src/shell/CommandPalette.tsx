// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Command palette (⌘K), on cmdk
   One search across everything Baton knows: screens, actions, sessions,
   merged commits, memory facts and skills. Data groups appear only once
   you type, so the empty palette stays a quiet command list.
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Columns3, GitBranch, GitMerge, Moon, Network, Plus, Sparkles, Sun, Wand2, type LucideIcon,
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { AgentBadge } from "@/components/primitives";
import { BatonAPI } from "@/lib/api";
import { ROUTES } from "@/lib/routes";
import type { Prefs } from "@/hooks/usePrefs";
import type { AgentId, MemoryFactStatus, SkillStatus, StatusRow, TaskHistory } from "@/types";

interface Cmd {
  id: string;
  label: string;
  sub?: string;
  icon?: LucideIcon;
  agent?: AgentId | null;
  group: string;
  run: () => void;
}

/** Capped so one noisy source can't flood the list. */
const DATA_GROUP_CAP = 6;
const DATA_GROUPS = new Set(["Commits", "Facts", "Skills"]);
/** Detail-only routes that make no sense as a destination on their own. */
const HIDDEN_ROUTES = new Set(["pair"]);

export function CommandPalette({
  open, onOpenChange, navigate, onOpen, onLaunch, sessions, history, prefs, onSeedSearch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (routeId: string) => void;
  onOpen: (slug: string) => void;
  onLaunch: (agent: AgentId | null) => void;
  sessions: StatusRow[];
  history: TaskHistory[];
  prefs: Prefs;
  onSeedSearch: (routeId: string, q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [facts, setFacts] = useState<MemoryFactStatus[]>([]);
  const [skills, setSkills] = useState<SkillStatus[]>([]);

  // Lazy-load the searchable corpora when the palette opens; both are small
  // and a failure just means fewer groups.
  useEffect(() => {
    if (!open) return;
    setQ("");
    BatonAPI.getMemories().then((r) => setFacts(r.facts)).catch(() => setFacts([]));
    BatonAPI.getSkills().then(setSkills).catch(() => setSkills([]));
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = ROUTES.filter((r) => !HIDDEN_ROUTES.has(r.id)).map((r) => ({
      id: "n-" + r.id, label: `Go to ${r.label}`, icon: ArrowRight, group: "Navigate", run: () => navigate(r.id),
    }));
    const dark = prefs.resolvedTheme === "dark";
    const actions: Cmd[] = [
      { id: "a-launch", label: "Launch session", icon: Plus, group: "Actions", run: () => onLaunch(null) },
      { id: "a-theme", label: `Switch to ${dark ? "light" : "dark"} theme`, icon: dark ? Sun : Moon, group: "Actions", run: () => prefs.setTheme(dark ? "light" : "dark") },
      { id: "a-write", label: `${prefs.writeEnabled ? "Disable" : "Enable"} write actions`, icon: GitMerge, group: "Actions", run: () => prefs.setWriteEnabled(!prefs.writeEnabled) },
      { id: "a-board", label: "View sessions as board", icon: Columns3, group: "Actions", run: () => { navigate("home"); prefs.setView("board"); } },
      { id: "a-canvas", label: "View sessions as canvas", icon: Network, group: "Actions", run: () => { navigate("home"); prefs.setView("canvas"); } },
    ];
    const sess: Cmd[] = sessions.map((s) => ({ id: "s-" + s.slug, label: s.task, sub: s.slug, agent: s.agent, group: "Sessions", run: () => onOpen(s.slug) }));
    const commits: Cmd[] = history.flatMap((h) => h.commits.map((c) => ({
      id: "c-" + c.sha, label: c.message, sub: `${c.sha.slice(0, 7)} · ${h.slug}`, icon: GitBranch,
      group: "Commits", run: () => onSeedSearch("history", c.message),
    })));
    const factCmds: Cmd[] = facts.map((f) => ({
      id: "f-" + f.id, label: f.fact.length > 90 ? f.fact.slice(0, 87) + "…" : f.fact, sub: `${f.type} · ${f.id}`,
      icon: Sparkles, group: "Facts", run: () => onSeedSearch("memory", f.id),
    }));
    const skillCmds: Cmd[] = skills.map((s) => ({
      id: "k-" + s.id, label: s.name, sub: s.id, icon: Wand2, group: "Skills", run: () => onSeedSearch("skills", s.id),
    }));
    return [...nav, ...actions, ...sess, ...commits, ...factCmds, ...skillCmds];
  }, [navigate, onOpen, onLaunch, onSeedSearch, sessions, history, facts, skills, prefs]);

  // Data groups only join once the user types — matching by content, not browsing.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? commands.filter((c) => (c.label + " " + (c.sub ?? "")).toLowerCase().includes(needle))
      : commands.filter((c) => !DATA_GROUPS.has(c.group));
    return filtered.reduce<Record<string, Cmd[]>>((m, c) => {
      if (!DATA_GROUPS.has(c.group) || (m[c.group]?.length ?? 0) < DATA_GROUP_CAP) (m[c.group] ??= []).push(c);
      return m;
    }, {});
  }, [commands, q]);

  const choose = (c: Cmd) => { onOpenChange(false); c.run(); };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search sessions, commits, facts and skills, or run a command"
      shouldFilter={false}
      contentClassName="top-[12vh] w-[min(600px,calc(100vw-24px))] max-w-none"
      commandProps={{ className: "[&_[cmdk-item]]:py-1.5 [&_[cmdk-input]]:h-11" }}
    >
      <CommandInput value={q} onValueChange={setQ} placeholder="Search or run a command…" aria-label="Search or run a command" />
      <CommandList>
        <CommandEmpty>No results for “{q}”</CommandEmpty>
        {Object.entries(groups).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((c) => {
              const Icon = c.icon;
              return (
                <CommandItem key={c.id} value={c.id} onSelect={() => choose(c)} className="gap-2.5">
                  {c.agent !== undefined
                    ? <AgentBadge id={c.agent} size="sm" showLabel={false} />
                    : Icon && <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-secondary text-muted-foreground"><Icon className="size-3.5" /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{c.label}</span>
                    {c.sub && <span className="block truncate font-mono text-[11px] text-muted-foreground">{c.sub}</span>}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-2 text-[11px] text-muted-foreground max-sm:hidden">
        <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move</span>
        <span><kbd className="kbd">↵</kbd> to run</span>
        <span><kbd className="kbd">esc</kbd> to close</span>
      </div>
    </CommandDialog>
  );
}
