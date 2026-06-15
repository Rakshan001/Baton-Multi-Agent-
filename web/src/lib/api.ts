/* ============================================================
   BATON — API client
   Mirrors the contract at VITE_BATON_API (default same-origin → the
   `baton serve` daemon on :7077, reached via the Vite dev proxy).

   Reads (status / history / task) hit the REAL endpoints.
   createTask hits the REAL POST /api/tasks (Phase 1 backend endpoint).
   merge / remove / handoff are WRITE-GATED and, until their server
   endpoints land (Phase 2), run an honest optimistic overlay locally so
   the optimistic-UI + rollback flow is exercised truthfully. Every such
   call is gated on writeEnabled and surfaces a READ_ONLY error otherwise.

   DEMO MODE (default ON until the daemon is wired up): when `demo` is
   true, reads + writes run against an in-memory store seeded from
   lib/demoData scenarios + lib/preview WORKSPACE, with simulated latency
   and offline so every loading / empty / error / read-only path is real.
   Flip it OFF (Tweaks panel) to use the real fetch path below unchanged.
   ============================================================ */
import type { StatusRow, TaskDetail, TaskHistory, Task, AgentId, Meta, KbStatus, GraphData, EditSignal, CompletionReport, BlameResult, RoutingInfo, ImportResult, RepoUsage, TerminalInfo, MemoryFactStatus, DiffFile, AgentRosterEntry, ConnectResult, SkillStatus, SkillAgent, SkillInstallResult } from "../types";
import { DEMO_MEMORY } from "./demoMemory";
import { DEMO_SKILLS } from "./demoSkills";
import { BUILTIN_ROUTING, suggestRoute } from "./routing";
import { DEMO_KB, demoGraphFor } from "./demoKb";
import {
  SCENARIOS, statusFrom, historyFrom, detailFrom, br,
  type ScenarioName, type DemoSession,
} from "./demoData";
import { WORKSPACE, getDiff as demoDiff, type DemoProject } from "./preview";
import { loadConnections, type Connection } from "./connections";
import { ls } from "./storage";

export type ApiErrorCode =
  | "OFFLINE"
  | "NOT_FOUND"
  | "READ_ONLY"
  | "MERGE_FAILED"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "SERVER";

export class ApiError extends Error {
  code: ApiErrorCode;
  status?: number;
  details?: unknown;
  constructor(code: ApiErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Branch convention from the CLI (src/commands/new.ts). */
export function branchFor(slug: string): string {
  return `baton/${slug}`;
}

type Listener = () => void;

class BatonClient {
  baseUrl: string;
  writeEnabled = false;
  forcedOffline = false;

  /* ---- demo mode (UI-preview shim; see header) ----
     Default ON in dev (so the UI is previewable without a daemon) and
     OFF in prod (the built dashboard is served by `baton serve` itself,
     so it must show real data). An explicit user choice persists and
     overrides the env default. */
  demo = ls.get<boolean>("baton:demo", import.meta.env.DEV);
  scenario: ScenarioName = ls.get<ScenarioName>("baton:scenario", "busy");
  project = ls.get<string>("baton:project", "orbit");
  private demoSessions: DemoSession[] = [];
  private demoHistory: TaskHistory[] = [];
  private scenarioOffline = false;

  // handoff is still a PREVIEW (no server endpoint) — applied as a local overlay.
  private agentOverride = new Map<string, AgentId>();
  private listeners = new Set<Listener>();

  /** Active daemon connection (real mode). "" baseUrl = same-origin / VITE_BATON_API. */
  connectionId = ls.get<string>("baton:connection", "default");

  constructor() {
    const conn = loadConnections().find((c) => c.id === this.connectionId);
    this.baseUrl = conn?.baseUrl || import.meta.env.VITE_BATON_API || "";
    if (!conn) this.connectionId = "default";
    this.applyDataset();
  }

  /** Switch the active daemon (real-mode project switcher). */
  setConnection(conn: Connection) {
    this.connectionId = conn.id;
    this.baseUrl = conn.baseUrl || import.meta.env.VITE_BATON_API || "";
    this.agentOverride.clear(); // overlays belong to the previous daemon
    ls.set("baton:connection", conn.id);
    this.emit(); // every poll hook refetches against the new daemon
  }

  get isOffline(): boolean {
    return this.forcedOffline || (this.demo && this.scenarioOffline);
  }
  setForcedOffline(v: boolean) {
    this.forcedOffline = v;
    this.emit();
  }
  setWriteEnabled(v: boolean) {
    this.writeEnabled = v;
    this.emit();
  }

  /* ---- demo-mode controls (persisted) ---- */
  setDemo(v: boolean) {
    this.demo = v;
    ls.set("baton:demo", v);
    this.applyDataset();
  }
  setScenario(name: ScenarioName) {
    this.scenario = name;
    ls.set("baton:scenario", name);
    this.applyDataset();
  }
  setProject(id: string) {
    this.project = id;
    ls.set("baton:project", id);
    this.applyDataset();
  }
  activeProject(): DemoProject {
    return WORKSPACE.projects.find((p) => p.id === this.project) || WORKSPACE.projects[0];
  }
  /** Seed the in-memory store from the active scenario / project. */
  private applyDataset() {
    let sessions: DemoSession[] = [], history: TaskHistory[] = [], offline = false;
    if (this.project === "orbit") {
      const sc = SCENARIOS[this.scenario] || SCENARIOS.busy;
      sessions = sc.sessions; history = sc.history; offline = !!sc.offline;
    } else {
      const proj = this.activeProject();
      sessions = proj.data?.sessions || []; history = proj.data?.history || [];
    }
    this.demoSessions = JSON.parse(JSON.stringify(sessions));
    this.demoHistory = JSON.parse(JSON.stringify(history));
    this.scenarioOffline = offline;
    this.emit();
  }
  /** Simulated network gate for demo reads/writes. */
  private async demoGate(extra = 0) {
    await delay(220 + Math.random() * 260 + extra);
    if (this.isOffline) {
      throw new ApiError("OFFLINE", `Could not reach Baton at ${this.baseUrl || "this origin"}`);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }
  /** External wake-up (SSE push): make every poll-driven screen refetch now. */
  notify() {
    this.emit();
  }

  /* ---- transport ---- */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.forcedOffline) {
      throw new ApiError("OFFLINE", `Could not reach Baton at ${this.baseUrl || "this origin"}`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
    } catch (e) {
      throw new ApiError("OFFLINE", `Could not reach Baton at ${this.baseUrl || "this origin"}`);
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error */
      }
      const msg = (body as { error?: string })?.error || res.statusText;
      if (res.status === 404) throw new ApiError("NOT_FOUND", msg, 404, body);
      if (res.status === 403) throw new ApiError("READ_ONLY", msg, 403, body);
      if (res.status === 400) throw new ApiError("BAD_REQUEST", msg, 400, body);
      if (res.status === 409) throw new ApiError("CONFLICT", msg, 409, body);
      throw new ApiError("SERVER", msg, res.status, body);
    }
    return (await res.json()) as T;
  }

  /* ---- GET endpoints (real, or demo-store when demo mode is on) ---- */
  async getStatus(): Promise<StatusRow[]> {
    if (this.demo) {
      await this.demoGate();
      return statusFrom(this.demoSessions);
    }
    const rows = await this.request<StatusRow[]>("/api/status");
    return rows.map((r) => {
      if (!this.agentOverride.has(r.slug)) return r;
      if (r.agent) { this.agentOverride.delete(r.slug); return r; } // agent attached — overlay no longer needed
      return { ...r, agent: this.agentOverride.get(r.slug)! };
    });
  }
  async getHistory(): Promise<TaskHistory[]> {
    if (this.demo) {
      await this.demoGate();
      return historyFrom(this.demoHistory);
    }
    return this.request<TaskHistory[]>("/api/history");
  }
  async getTask(slug: string): Promise<TaskDetail> {
    if (this.demo) {
      await this.demoGate();
      const s = this.demoSessions.find((x) => x.slug === slug);
      if (!s) throw new ApiError("NOT_FOUND", `No task ${slug}`, 404);
      return detailFrom(s, this.activeProject().path);
    }
    const t = await this.request<TaskDetail>(`/api/tasks/${encodeURIComponent(slug)}`);
    return this.agentOverride.has(slug) ? { ...t, agent: this.agentOverride.get(slug)! } : t;
  }
  async getMeta(): Promise<Meta> {
    if (this.demo) {
      await this.demoGate();
      const p = this.activeProject();
      return {
        repo: p.path, branch: p.branch, writeEnabled: this.writeEnabled, version: "demo",
        terminals: { available: true },
        agents: { headless: ["claude", "codex", "gemini"], interactive: ["claude", "cursor", "codex", "gemini", "aider", "opencode"] },
      };
    }
    return this.request<Meta>("/api/meta");
  }

  /* ---- knowledge base (graphify) ---- */
  async getKb(): Promise<KbStatus> {
    if (this.demo) {
      await this.demoGate();
      return DEMO_KB;
    }
    return this.request<KbStatus>("/api/kb");
  }
  async getKbGraph(project: string): Promise<GraphData> {
    if (this.demo) {
      await this.demoGate(120);
      return demoGraphFor(project);
    }
    return this.request<GraphData>(`/api/kb/graph?project=${encodeURIComponent(project)}`);
  }
  async rebuildKb(project?: string, full = false): Promise<{ building: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      return { building: project ? [project] : DEMO_KB.projects.map((p) => p.id) };
    }
    return this.request<{ building: string[] }>("/api/kb/rebuild", {
      method: "POST",
      body: JSON.stringify({ project, full }),
    });
  }

  /** Download URL for the KB pack (null in demo mode — nothing real to export). */
  kbExportUrl(): string | null {
    return this.demo ? null : `${this.baseUrl}/api/kb/export`;
  }
  async importKbPack(file: File): Promise<ImportResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(300);
      return { projects: [{ id: "api", status: "ok" }, { id: "web", status: "ok" }], gitHead: "demo", commitsBehind: 0, warnings: [] };
    }
    if (this.forcedOffline) throw new ApiError("OFFLINE", "Could not reach Baton");
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/kb/import`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: file,
      });
    } catch {
      throw new ApiError("OFFLINE", "Could not reach Baton");
    }
    const body = (await res.json().catch(() => null)) as ImportResult | { error?: string } | null;
    if (!res.ok) {
      if (res.status === 403) throw new ApiError("READ_ONLY", (body as { error?: string })?.error || "read-only", 403);
      throw new ApiError("BAD_REQUEST", (body as { error?: string })?.error || res.statusText, res.status);
    }
    this.emit();
    return body as ImportResult;
  }

  /* ---- headless agent control ---- */
  async startAgentRun(slug: string, opts: { agent?: AgentId; model?: string; prompt?: string } = {}): Promise<{ slug: string; agent: string; promptSource: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      return { slug, agent: opts.agent ?? "claude", promptSource: "task" };
    }
    const r = await this.request<{ slug: string; agent: string; promptSource: string }>(
      `/api/tasks/${encodeURIComponent(slug)}/agent/start`,
      { method: "POST", body: JSON.stringify(opts) },
    );
    this.emit();
    return r;
  }
  async stopAgentRun(slug: string): Promise<{ stopped: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(120);
      return { stopped: true };
    }
    const r = await this.request<{ stopped: boolean }>(`/api/tasks/${encodeURIComponent(slug)}/agent/stop`, { method: "POST", body: "{}" });
    this.emit();
    return r;
  }

  /* ---- agent roster (installed? drivable? MCP wired? live?) ---- */
  async getAgents(): Promise<AgentRosterEntry[]> {
    if (this.demo) {
      await this.demoGate(80);
      return this.demoRoster();
    }
    const r = await this.request<{ agents: AgentRosterEntry[] }>("/api/agents");
    return r.agents;
  }
  // Demo MCP targets — mirror src/agents/connect.ts mcpTargetFor exactly so the
  // showcase shows the real config paths the daemon would write.
  private demoMcpTarget(id: AgentId): { scope: ConnectResult["scope"]; path: string } | null {
    switch (id) {
      case "claude": return { scope: "project", path: ".mcp.json" };
      case "cursor": return { scope: "project", path: ".cursor/mcp.json" };
      case "gemini": return { scope: "global", path: "~/.gemini/settings.json" };
      case "codex": return { scope: "global", path: "~/.codex/config.toml" };
      default: return null; // aider, opencode — no MCP wiring
    }
  }

  /** Wire an agent's MCP config. Global files need confirmGlobal (server returns a preview otherwise). */
  async connectAgent(id: AgentId, confirmGlobal = false): Promise<ConnectResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(160);
      const target = this.demoMcpTarget(id) ?? { scope: "project" as const, path: ".mcp.json" };
      if (target.scope === "global" && !confirmGlobal) {
        return { agent: id, scope: target.scope, path: target.path, wrote: false, needsConfirm: true, servers: ["baton"], preview: `{\n  "mcpServers": {\n    "baton": { "command": "baton", "args": ["mcp"] }\n  }\n}` };
      }
      this.demoConnected.add(id);
      this.emit();
      return { agent: id, scope: target.scope, path: target.path, wrote: true, needsConfirm: false, servers: ["baton"] };
    }
    const r = await this.request<ConnectResult>(`/api/agents/${encodeURIComponent(id)}/connect`, {
      method: "POST", body: JSON.stringify({ confirmGlobal }),
    });
    if (r.wrote) this.emit();
    return r;
  }

  // Demo roster: every CLI "installed", MCP pre-wired for claude/cursor, live
  // sessions read from the active demo scenario. Mirrors the real shape.
  private demoConnected = new Set<AgentId>(["claude", "cursor"]);
  private demoRoster(): AgentRosterEntry[] {
    const defs: { id: AgentId; label: string; binary: string; headless: boolean; interactive: boolean; mcp: boolean }[] = [
      { id: "claude", label: "Claude Code", binary: "claude", headless: true, interactive: true, mcp: true },
      { id: "cursor", label: "Cursor", binary: "cursor-agent", headless: false, interactive: true, mcp: true },
      { id: "codex", label: "Codex", binary: "codex", headless: true, interactive: true, mcp: true },
      { id: "gemini", label: "Gemini", binary: "gemini", headless: true, interactive: true, mcp: true },
      { id: "aider", label: "Aider", binary: "aider", headless: false, interactive: true, mcp: false },
      { id: "opencode", label: "OpenCode", binary: "opencode", headless: false, interactive: true, mcp: false },
    ];
    return defs.map((d) => {
      const live = this.demoSessions.filter((s) => s.agent === d.id).map((s) => ({ slug: s.slug, kind: "process" as const }));
      const connected = d.mcp && this.demoConnected.has(d.id);
      const target = this.demoMcpTarget(d.id);
      return {
        id: d.id, label: d.label, binary: d.binary, installed: true,
        headless: d.headless, interactive: d.interactive,
        mcp: { agent: d.id, supported: d.mcp, scope: target?.scope ?? null, path: target?.path ?? null, exists: connected, connected },
        live, idle: live.length === 0,
      };
    });
  }

  /* ---- skills (searchable catalog, install into .claude/.cursor) ---- */
  private demoSkills: SkillStatus[] | null = null;
  async getSkills(): Promise<SkillStatus[]> {
    if (this.demo) {
      await this.demoGate(70);
      this.demoSkills ??= JSON.parse(JSON.stringify(DEMO_SKILLS)) as SkillStatus[];
      return this.demoSkills;
    }
    const r = await this.request<{ skills: SkillStatus[] }>("/api/skills");
    return r.skills;
  }
  async installSkill(id: string, agent: SkillAgent): Promise<SkillInstallResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      this.demoSkills ??= JSON.parse(JSON.stringify(DEMO_SKILLS)) as SkillStatus[];
      const skill = this.demoSkills.find((s) => s.id === id);
      const inst = skill?.installs.find((i) => i.agent === agent);
      if (inst) inst.installed = true;
      this.emit();
      return { skill: id, agent, rel: inst?.rel ?? "", path: inst?.rel ?? "", wrote: true };
    }
    const r = await this.request<SkillInstallResult>(`/api/skills/${encodeURIComponent(id)}/install`, {
      method: "POST", body: JSON.stringify({ agent }),
    });
    this.emit();
    return r;
  }
  async uninstallSkill(id: string, agent: SkillAgent): Promise<{ removed: boolean; rel: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(120);
      this.demoSkills ??= JSON.parse(JSON.stringify(DEMO_SKILLS)) as SkillStatus[];
      const skill = this.demoSkills.find((s) => s.id === id);
      const inst = skill?.installs.find((i) => i.agent === agent);
      if (inst) inst.installed = false;
      this.emit();
      return { removed: true, rel: inst?.rel ?? "" };
    }
    const r = await this.request<{ removed: boolean; rel: string }>(`/api/skills/${encodeURIComponent(id)}/install?agent=${encodeURIComponent(agent)}`, { method: "DELETE" });
    this.emit();
    return r;
  }
  async importSkill(source: string): Promise<SkillStatus> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(220);
      const id = this.slugify(source.split(/[/\\]/).pop()?.replace(/\.(md|mdc|txt)$/i, "") || "imported-skill");
      const skill: SkillStatus = {
        id, name: id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: "Imported skill (demo preview).", tags: [], produces: [], body: `# ${id}\n\nImported from ${source}.\n`,
        source: "imported",
        installs: [
          { agent: "claude", rel: `.claude/skills/${id}/SKILL.md`, installed: false },
          { agent: "cursor", rel: `.cursor/rules/${id}.mdc`, installed: false },
        ],
      };
      this.demoSkills = [...(this.demoSkills ?? [...DEMO_SKILLS]).filter((s) => s.id !== id), skill];
      this.emit();
      return skill;
    }
    // The daemon returns the parsed skill without per-agent install state; the
    // screen refetches the catalog right after, which fills installs in.
    const r = await this.request<{ skill: Omit<SkillStatus, "installs"> }>("/api/skills/import", { method: "POST", body: JSON.stringify({ source }) });
    this.emit();
    return { ...r.skill, installs: [] };
  }

  /* ---- interactive terminals (tmux-backed, src/terminals.ts) ---- */
  async getTerminals(): Promise<{ available: boolean; hint?: string; terminals: TerminalInfo[] }> {
    if (this.demo) {
      await this.demoGate(80);
      return { available: true, terminals: [] };
    }
    return this.request("/api/terminals");
  }
  async createTerminal(slug: string, opts: { agent?: AgentId; model?: string; prompt?: string; cols?: number; rows?: number } = {}): Promise<TerminalInfo> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      return { slug, agent: opts.agent ?? "claude", sessionName: `baton-demo-${slug}`, startedAt: new Date().toISOString() };
    }
    const r = await this.request<TerminalInfo>(`/api/tasks/${encodeURIComponent(slug)}/terminal`, {
      method: "POST", body: JSON.stringify(opts),
    });
    this.emit();
    return r;
  }
  async killTerminal(slug: string): Promise<{ killed: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(120);
      return { killed: true };
    }
    const r = await this.request<{ killed: boolean }>(`/api/tasks/${encodeURIComponent(slug)}/terminal`, { method: "DELETE" });
    this.emit();
    return r;
  }
  /** Raw keystrokes (base64) → the agent's PTY. Fire-and-forget latency path. */
  async sendTerminalInput(slug: string, data: string): Promise<void> {
    if (this.demo) return; // demo terminal is playback-only
    await this.request(`/api/tasks/${encodeURIComponent(slug)}/terminal/input`, {
      method: "POST", body: JSON.stringify({ data }),
    });
  }
  async resizeTerminal(slug: string, cols: number, rows: number): Promise<void> {
    if (this.demo) return;
    await this.request(`/api/tasks/${encodeURIComponent(slug)}/terminal/resize`, {
      method: "POST", body: JSON.stringify({ cols, rows }),
    }).catch(() => undefined); // resize is best-effort
  }
  /** Per-session SSE byte stream URL (EventSource). Null in demo mode. */
  terminalStreamUrl(slug: string): string | null {
    return this.demo ? null : `${this.baseUrl}/api/tasks/${encodeURIComponent(slug)}/terminal/stream`;
  }

  /* ---- project memory (evidence-anchored facts, src/memory.ts) ---- */
  private demoMemory: MemoryFactStatus[] | null = null;
  async getMemories(): Promise<MemoryFactStatus[]> {
    if (this.demo) {
      await this.demoGate(60);
      this.demoMemory ??= JSON.parse(JSON.stringify(DEMO_MEMORY)) as MemoryFactStatus[];
      return this.demoMemory;
    }
    const r = await this.request<{ facts: MemoryFactStatus[] }>("/api/memory");
    return r.facts;
  }
  async addMemory(input: { fact: string; type?: string; files?: string[]; task?: string }): Promise<MemoryFactStatus> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(150);
      const fact: MemoryFactStatus = {
        id: `mem-${this.slugify(input.fact)}`, type: (input.type as MemoryFactStatus["type"]) ?? "reference",
        fact: input.fact, agent: "dashboard", task: input.task ?? null, createdAt: new Date().toISOString(),
        anchors: { commit: "demo", files: (input.files ?? []).map((p) => ({ path: p, hash: "demo" })) },
        supersedes: null, freshness: "fresh", staleReason: null, commitsBehind: 0,
      };
      this.demoMemory = [fact, ...(this.demoMemory ?? [...DEMO_MEMORY])];
      this.emit();
      return fact;
    }
    const r = await this.request<MemoryFactStatus>("/api/memory", { method: "POST", body: JSON.stringify(input) });
    this.emit();
    return r;
  }
  async deleteMemory(id: string): Promise<void> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(100);
      this.demoMemory = (this.demoMemory ?? [...DEMO_MEMORY]).filter((f) => f.id !== id);
      this.emit();
      return;
    }
    await this.request(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
    this.emit();
  }
  async gcMemories(): Promise<{ removed: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(150);
      const stale = (this.demoMemory ?? [...DEMO_MEMORY]).filter((f) => f.freshness === "stale").map((f) => f.id);
      this.demoMemory = (this.demoMemory ?? [...DEMO_MEMORY]).filter((f) => f.freshness !== "stale");
      this.emit();
      return { removed: stale };
    }
    const r = await this.request<{ removed: string[] }>("/api/memory/gc", { method: "POST", body: "{}" });
    this.emit();
    return r;
  }

  /* ---- real token usage (Claude session files) ---- */
  async getRealUsage(): Promise<RepoUsage | null> {
    if (this.demo) return null; // demo keeps its labelled illustrative numbers
    try {
      return await this.request<RepoUsage>("/api/usage");
    } catch {
      return null; // usage is an enhancement — never break the page over it
    }
  }

  /* ---- routing (task-type → agent) ---- */
  async getRouting(task?: string): Promise<RoutingInfo> {
    if (this.demo) {
      await delay(60); // suggestion must feel instant; no offline gate needed
      return { config: BUILTIN_ROUTING, path: null, errors: [], suggestion: task ? suggestRoute(task) : null };
    }
    const q = task ? `?task=${encodeURIComponent(task)}` : "";
    return this.request<RoutingInfo>(`/api/routing${q}`);
  }

  /* ---- coordination: signals / reports / blame ---- */
  async getSignals(): Promise<EditSignal[]> {
    if (this.demo) {
      await this.demoGate();
      // mirror the busy scenario's overlap so the section is explorable
      const overlap = this.demoSessions.filter((s) => (s.conflictFiles || []).length);
      const byPath = new Map<string, typeof overlap>();
      overlap.forEach((s) => s.conflictFiles.forEach((f) => { if (!byPath.has(f)) byPath.set(f, []); byPath.get(f)!.push(s); }));
      return [...byPath.entries()].map(([path, ss]) => ({
        path,
        level: ss.length > 1 ? "warning" as const : "info" as const,
        holders: ss.map((s) => ({ slug: s.slug, agent: s.agent, lastEditAt: new Date(Date.now() - 120_000).toISOString() })),
      }));
    }
    const r = await this.request<{ signals: EditSignal[] }>("/api/signals");
    return r.signals;
  }
  async getReports(): Promise<CompletionReport[]> {
    if (this.demo) {
      await this.demoGate();
      return this.demoHistory.filter((h) => h.mergedAt).slice(0, 10).map((h) => ({
        slug: h.slug, task: h.task, agent: h.agent, mergedAt: h.mergedAt!,
        summary: h.task, files: ["src/app.ts", "src/lib/api.ts"],
        commits: h.commits, overlappedWith: [],
      }));
    }
    return this.request<CompletionReport[]>("/api/reports");
  }
  async getReport(slug: string): Promise<CompletionReport | null> {
    if (this.demo) {
      const all = await this.getReports();
      return all.find((r) => r.slug === slug) ?? null;
    }
    try {
      return await this.request<CompletionReport>(`/api/reports/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }
  /** Full diff vs the task's base — GET /api/tasks/:slug/diff (demo: scripted fixtures). */
  async getDiff(slug: string): Promise<DiffFile[]> {
    if (this.demo) {
      await this.demoGate(120);
      return demoDiff(slug);
    }
    const r = await this.request<{ files: DiffFile[] }>(`/api/tasks/${encodeURIComponent(slug)}/diff`);
    return r.files;
  }
  async getBlame(file: string): Promise<BlameResult> {
    if (this.demo) {
      await this.demoGate();
      return { file, merged: [], live: [] };
    }
    return this.request<BlameResult>(`/api/blame?file=${encodeURIComponent(file)}`);
  }

  /** Client-side slug preview (mirrors the CLI's slugify for the launch form). */
  slugify(t: string): string {
    return (
      (t || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-") || "task"
    );
  }

  /** Launch a new session. Creating the worktree + branch is REAL (POST /api/tasks);
   *  "attaching" the agent process is a labelled preview — you start the agent in the
   *  worktree yourself. `agent` is recorded as the intended owner only. */
  async launchSession({ task, agent }: { task: string; agent: AgentId; attach?: boolean }): Promise<{ slug: string; agent: AgentId | null }> {
    const created = await this.createTask(task);
    return { slug: created.slug, agent };
  }

  /* ---- WRITE: create (real Phase-1 endpoint, or demo store) ---- */
  async createTask(task: string): Promise<Task> {
    const t = task.trim();
    if (!t) throw new ApiError("BAD_REQUEST", "Task description is required");
    if (this.demo) {
      await this.demoGate(220);
      let slug = this.slugify(t), n = 1;
      while (this.demoSessions.some((s) => s.slug === slug)) slug = `${this.slugify(t)}-${++n}`;
      const createdAt = new Date().toISOString();
      const p = this.activeProject();
      this.demoSessions.unshift({
        slug, task: t, agent: null, status: "clean", ahead: 0, behind: 0,
        conflictFiles: [], filesChanged: 0, createdAt, commits: [],
      });
      this.emit();
      return { slug, task: t, branch: br(slug), worktreePath: `${p.path}/.baton/wt/${slug}`, baseBranch: p.branch, baseCommit: null, createdAt };
    }
    const created = await this.request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ task: t }),
    });
    this.emit(); // trigger an immediate refetch so the new session appears
    return created;
  }

  /* ---- WRITE: merge / remove / handoff (gated; optimistic overlay) ---- */
  private assertWrite() {
    if (!this.writeEnabled) {
      throw new ApiError("READ_ONLY", "Write API disabled. Start `baton serve --write` to enable.");
    }
  }
  /** Merge the branch into the current branch (squash + archive). After a
   *  successful merge the now-shipped worktree is removed so the board reflects
   *  reality. Throws ApiError("MERGE_FAILED") with conflict details on 409. */
  async mergeTask(slug: string, opts: { squash?: boolean; archive?: boolean } = {}): Promise<{ merged: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(240);
      const idx = this.demoSessions.findIndex((x) => x.slug === slug);
      if (idx === -1) throw new ApiError("NOT_FOUND", `No task ${slug}`, 404);
      const s = this.demoSessions[idx];
      this.demoHistory.unshift({ slug: s.slug, task: s.task, agent: s.agent, mergedAt: new Date().toISOString(), commits: (s.commits || []).map((c) => ({ ...c })) });
      this.demoSessions.splice(idx, 1);
      this.emit();
      return { merged: slug };
    }
    try {
      await this.request(`/api/tasks/${encodeURIComponent(slug)}/merge`, {
        method: "POST",
        body: JSON.stringify({ squash: opts.squash !== false, archive: opts.archive !== false }),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const conflicts = (e.details as { conflicts?: { path: string }[] })?.conflicts;
        const files = conflicts?.map((c) => c.path).join(", ");
        throw new ApiError("MERGE_FAILED", files ? `Merge halted on conflicts: ${files}` : e.message, 409, e.details);
      }
      throw e;
    }
    // merge keeps the worktree; remove the shipped session so the board updates.
    try {
      await this.request(`/api/tasks/${encodeURIComponent(slug)}?force=true`, { method: "DELETE" });
    } catch {
      /* merge already succeeded — leave the worktree if removal fails */
    }
    this.emit();
    return { merged: slug };
  }
  async removeTask(slug: string, opts: { force?: boolean } = {}): Promise<{ removed: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate();
      const idx = this.demoSessions.findIndex((x) => x.slug === slug);
      if (idx === -1) throw new ApiError("NOT_FOUND", `No task ${slug}`, 404);
      this.demoSessions.splice(idx, 1);
      this.emit();
      return { removed: slug };
    }
    const q = opts.force === false ? "" : "?force=true";
    const res = await this.request<{ removed: string }>(`/api/tasks/${encodeURIComponent(slug)}${q}`, { method: "DELETE" });
    this.emit();
    return res;
  }
  /** Hand work off: POST /api/tasks/:slug/handoff generates a HANDOFF.md brief. */
  async handoffTask(slug: string, opts: { toAgent: AgentId; commitPending?: boolean; note?: string }): Promise<{ slug: string; toAgent: AgentId; estTokens?: number; estCostUsd?: number; briefPath?: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      const s = this.demoSessions.find((x) => x.slug === slug);
      if (!s) throw new ApiError("NOT_FOUND", `No task ${slug}`, 404);
      if (opts.commitPending && s.filesChanged > 0) {
        s.commits = s.commits || [];
        s.commits.push({ sha: Math.random().toString(16).slice(2, 9), message: "chore: checkpoint before handoff", at: new Date().toISOString() });
        s.ahead += 1; s.filesChanged = 0; if (s.status === "dirty") s.status = "clean";
      }
      s.agent = opts.toAgent;
      this.emit();
      return { slug, toAgent: opts.toAgent, estTokens: 48_200, estCostUsd: 0.14, briefPath: `${this.activeProject().path}/.baton/wt/${slug}/HANDOFF.md` };
    }
    const r = await this.request<{ slug: string; toAgent: string; estTokens: number; estCostUsd: number; briefPath: string }>(
      `/api/tasks/${encodeURIComponent(slug)}/handoff`,
      { method: "POST", body: JSON.stringify({ toAgent: opts.toAgent, note: opts.note, commitPending: opts.commitPending }) },
    );
    this.agentOverride.set(slug, opts.toAgent); // board shows the intended owner until the agent attaches
    this.emit();
    return { ...r, toAgent: opts.toAgent };
  }

  /** Roll back an optimistic mutation (used on API failure). */
  rollback(slug: string) {
    this.agentOverride.delete(slug);
    this.emit();
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const BatonAPI = new BatonClient();
