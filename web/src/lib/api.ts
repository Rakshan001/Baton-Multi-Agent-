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
import type { StatusRow, TaskDetail, TaskHistory, Task, AgentId, Meta, KbStatus, GraphData, EditSignal, CompletionReport, BlameResult, RoutingInfo, ImportResult, RepoUsage } from "../types";
import { BUILTIN_ROUTING, suggestAgent } from "./routing";
import { DEMO_KB, demoGraphFor } from "./demoKb";
import {
  SCENARIOS, statusFrom, historyFrom, detailFrom, br,
  type ScenarioName, type DemoSession,
} from "./demoData";
import { WORKSPACE, type DemoProject } from "./preview";
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
    return rows.map((r) => (this.agentOverride.has(r.slug) ? { ...r, agent: this.agentOverride.get(r.slug)! } : r));
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
      return { repo: p.path, branch: p.branch, writeEnabled: this.writeEnabled, version: "demo" };
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
  async startAgentRun(slug: string, opts: { agent?: AgentId; prompt?: string } = {}): Promise<{ slug: string; agent: string; promptSource: string }> {
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
      return { config: BUILTIN_ROUTING, path: null, errors: [], suggestion: task ? suggestAgent(task) : null };
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
