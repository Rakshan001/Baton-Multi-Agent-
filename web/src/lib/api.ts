// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { DEMO_BRIEF_BODY, demoResumePrompt } from "./demoHandoff";
import type { StatusRow, TaskDetail, TaskHistory, Task, AgentId, Meta, KbStatus, GraphData, EditSignal, PresenceSession, HandoffLoadSuggestion, HandoffBriefEntry, CompletionReport, BlameResult, RoutingInfo, ImportResult, RepoUsage, TerminalInfo, RunningAgentInfo, MemoryFactStatus, MemoryProject, RetentionPolicy, StorageBreakdown, PurgePreview, PurgeResult, PurgeCategory, DiffFile, AgentRosterEntry, ConnectResult, SkillStatus, SkillAgent, SkillInstallResult, QuarantineView, ContextPackResponse, ReviewRecord, ReviewAxis, FindingStatus, TeamState, Team, InviteResult, MemberRole, Reachability, FleetDaemon, PipelineView, LaneTask, CancelResult, CancelScopeInput, PlanInventory, MemoryConsolidation, MemoryDelegateSpend, MemoryProducedFact, WorktreeRow, WorktreeKind } from "../types";
import { DEMO_MEMORY, DEMO_MEMORY_PROJECTS } from "./demoMemory";
import { DEMO_REVIEWS, DEMO_REVIEW_HEAD } from "./demoReviews";
import { DEMO_TEAM, DEMO_TEAM_SOLO, DEMO_REACHABILITY } from "./demoTeam";
import { DEMO_FLEET } from "./fleet";
import { DEMO_SKILLS, type DemoSkill } from "./demoSkills";
import { DEMO_QUARANTINE } from "./quarantine";
import { DEMO_PIPELINE, DEMO_PLAN_MD } from "./demoPipeline";
import {
  applyDemoOverlay, demoMergePatch, demoMergeRefusal, demoPausePatch, demoPauseRefusal,
  demoTakeoverPatch, demoTakeoverRefusal, demoWorktreeProgress, demoWorktrees,
} from "./demoWorktrees";
import type { WorktreeProgress } from "../components/flow/panel";
import { demoDiscardRefusal, demoDoctorReport } from "./demoRecover";
import { BUILTIN_ROUTING, suggestRoute } from "./routing";
import { DEMO_KB, demoGraphFor, DEMO_CONTEXT_PACK } from "./demoKb";
import {
  SCENARIOS, statusFrom, historyFrom, detailFrom, br,
  type ScenarioName, type DemoSession,
} from "./demoData";
import { WORKSPACE, getDiff as demoDiff, type DemoProject } from "./preview";
import { loadConnections, type Connection } from "./connections";
import { ls } from "./storage";
import { auth } from "./auth";

export type ApiErrorCode =
  | "OFFLINE"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "READ_ONLY"
  | "MERGE_FAILED"
  | "BAD_REQUEST"
  | "CONFLICT"
  /** A repo held several skills and none was named — details.choices lists them. */
  | "AMBIGUOUS"
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

/**
 * One clause naming what actually stopped a read — for a screen that would
 * otherwise have to guess, and guess benignly.
 *
 * D-009 applied to failures rather than to numbers: a cause may be reported
 * only where it is known, and the only place that knowledge exists is the
 * `code` the transport put on the ApiError. A refused credential, a read-only
 * refusal, a daemon that went away mid-poll and a daemon that never had the
 * route are four different facts; collapsing them into one reassuring sentence
 * is the failure this exists to prevent.
 *
 * Reads as the tail of "Couldn't read X — …", so it starts lowercase and
 * carries no full stop.
 */
export function failureReason(e: unknown): string {
  if (!(e instanceof ApiError)) {
    return e instanceof Error && e.message ? e.message : "an unknown error";
  }
  switch (e.code) {
    case "OFFLINE":
      return "Baton couldn't be reached";
    case "UNAUTHORIZED":
      return "this daemon refused the credential";
    case "READ_ONLY":
      return "this daemon is read-only and refused the request";
    case "NOT_FOUND":
      return "this daemon serves no such endpoint";
    default:
      return e.message || `the daemon answered ${e.status ?? "an error"}`;
  }
}

/* ============================================================
   THE JUNK AUDIT (GET /api/doctor)

   A verbatim mirror of `AuditReport` / `JunkItem` in src/cleanup.ts.
   Declared here rather than in types.ts because this change does not own
   that file — the same reason components/flow/panel.ts declares
   `WorktreeProgress` beside the panel that reads it.

   Note the vocabulary: the daemon calls these things JUNK, and every item
   carries a `reason` and an `action` written for `baton clean`. The Recover
   screen re-states them as work to rescue (features/recoverModel.ts explains
   why); nothing is widened or renamed on the way in, so this stays a
   faithful mirror of what the route sends.
   ============================================================ */
export type JunkKind =
  | "orphan-worktree-task"
  | "orphan-worktree-disk"
  | "orphan-branch"
  | "orphan-tmux"
  | "tmp-file"
  | "tmp-upload";

export interface JunkItem {
  kind: JunkKind;
  /** slug / branch / session name / filename — the thing to act on. */
  id: string;
  path: string | null;
  reason: string;
  action: string;
  /** Set when a fix would REFUSE this item (and why). */
  blocked?: "dirty" | "main-worktree" | null;
  bytes?: number | null;
  branch?: string;
}

export interface DoctorReport {
  items: JunkItem[];
  scannedAt: string;
  counts: Record<JunkKind, number>;
}

/* ============================================================
   DEMO FIXTURES — plan inventory

   It lives here rather than beside the daemon shape it mirrors, because
   demo mode is the showcase: these are the values a person sees before they
   ever run `baton serve`, and they have to teach the real states.

   Everything below is invented. Nothing here is fetched, and no daemon is
   contacted when demo mode is on.
   ============================================================ */

/**
 * Every plan state on one screen, because the states are the point:
 * approved-and-running, waiting for a human, VOID because the file changed
 * after approval, broken, and unreadable. A fixture that only showed the happy
 * plan would teach nothing about the checkpoint this screen exists to expose.
 */
const DEMO_PLAN_INVENTORY: PlanInventory = {
  dir: "baton/plans",
  plans: [
    {
      id: "auth", planId: "auth", path: "baton/plans/auth.md",
      goal: "Ship API-key auth end to end",
      tasks: 6, phases: 3, parses: true, issues: [], readable: true,
      applied: true, appliedTasks: 6,
      sha256: "9f2b41c7e8a05d3b6c1f4a92e7d08b53c6a1f9e42d7b0c85a3e6f1d94b7c20a8e",
      approval: {
        state: "approved", reason: null, approvedBy: "you@example.com",
        at: "2026-09-02T09:14:00.000Z",
        sha256: "9f2b41c7e8a05d3b6c1f4a92e7d08b53c6a1f9e42d7b0c85a3e6f1d94b7c20a8e",
      },
    },
    {
      // The blind spot: on disk, never applied, and until now invisible.
      id: "billing", planId: "billing", path: "baton/plans/billing.md",
      goal: "Metered billing with Stripe usage records",
      tasks: 4, phases: 2, parses: true, issues: [], readable: true,
      applied: false, appliedTasks: 0,
      sha256: "1a7c05e93b8d4f26a0c71e8b52d4396f7a0b1c8e35d92f47b6a0c3e8d15f92b74",
      approval: {
        state: "unapproved",
        reason: "this plan has not been approved. Read it, then run `baton plan approve <plan>`.",
        approvedBy: null, at: null, sha256: null,
      },
    },
    {
      // Approved, then edited. The one case the byte-exact gate exists for.
      id: "search-rework", planId: "search-rework", path: "baton/plans/search-rework.md",
      goal: "Replace the search index and re-rank results",
      tasks: 5, phases: 2, parses: true, issues: [], readable: true,
      applied: true, appliedTasks: 5,
      sha256: "c4e08b7a13f95d6208e7b4c1a9f30d582b7e6c04a1d93f8b5e2c7a06d41b98f3c",
      approval: {
        state: "void",
        reason: "the plan changed since you@example.com approved it on 2026-08-29T16:02:00.000Z"
          + " (approved 55d1f0a9b3c2…, on disk c4e08b7a13f9…)."
          + " Read the change, then run `baton plan approve <plan>` again.",
        approvedBy: "you@example.com", at: "2026-08-29T16:02:00.000Z",
        sha256: "55d1f0a9b3c264e7180a9c3b5d2e7f406a8b1c9d3e5f70a2b4c68d1e93f0a7b5",
      },
    },
    {
      id: "flaky-tests", planId: "flaky-tests", path: "baton/plans/flaky-tests.md",
      goal: "Stop the checkout e2e suite flaking",
      tasks: 3, phases: 1, parses: false,
      issues: [
        { where: "phase 1", message: "'retry-harness' and 'quarantine-list' both claim test/e2e/checkout.spec.ts — two agents, one file, same phase" },
        { where: "smoke-run", message: "no scope: a task must say which files it may touch" },
      ],
      readable: true, applied: false, appliedTasks: 0,
      sha256: "7b2d9c04a15e386f0b7c2a9d4e81f35062a7c1b8d90e4f37a5c2b6d08e91f4a20",
      approval: {
        state: "unapproved",
        reason: "this plan has not been approved. Read it, then run `baton plan approve <plan>`.",
        approvedBy: null, at: null, sha256: null,
      },
    },
    {
      // Listed, not swallowed: the row somebody has to go and look at.
      id: "perf-budget", planId: "perf-budget", path: "baton/plans/perf-budget.md",
      goal: "", tasks: 0, phases: 0, parses: false,
      issues: [{ where: "plan", message: "baton/plans/perf-budget.md could not be read (EACCES)" }],
      readable: false, applied: false, appliedTasks: 0, sha256: null,
      approval: {
        state: "unknown",
        reason: "this plan could not be read, so nothing can be vouched for.",
        approvedBy: null, at: null, sha256: null,
      },
    },
  ],
};

/** Branch convention from the CLI (src/commands/new.ts). */
export function branchFor(slug: string): string {
  return `baton/${slug}`;
}

/** Demo-only id slug, mirroring `slugify` in src/util/slug.ts. Real ids are
 *  always minted by the daemon; this exists so demo mode can invent one. */
function slugId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
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
  /** Hub sub-project Launch should preselect. Not a board filter. */
  hubTarget: string | null = ls.get<string | null>("baton:hub-target", null);
  private demoSessions: DemoSession[] = [];
  private demoHistory: TaskHistory[] = [];
  /** Runs "started" in demo, so the showcase can demonstrate the stop control
   *  rather than a Start button that never changes. */
  private demoRunning = new Map<string, { agent: string; startedAt: string }>();
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
  setHubTarget(id: string | null) {
    this.hubTarget = id;
    ls.set("baton:hub-target", id);
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

  /** The event stream was refused (revoked or rotated token). Raises the same
   *  gate a refused API call raises — a live feed that silently stops is worse
   *  than one that says why. */
  notifyAuthRequired() {
    this.challenge();
  }

  /* ---- credential (real mode over `--host`; see lib/auth.ts) ---- */

  /** True once the daemon has refused our credential — the shell shows the
   *  sign-in gate instead of a dashboard full of identical error toasts. */
  needsAuth = false;

  /** What the daemon last reported about THIS viewer (GET /api/meta). Cached
   *  because capability answers depend on it — most importantly terminals,
   *  which no credential makes reachable from another machine. */
  viewer: Meta["viewer"] | null = null;

  /** True when the daemon has told us this browser is NOT on its machine. Stays
   *  false until meta has been read once: guessing "remote" from the mere
   *  presence of a stored token would misjudge a local viewer who once signed
   *  in to the same URL from elsewhere. */
  get isRemoteViewer(): boolean {
    return !!this.viewer && !this.viewer.local;
  }

  /** The member token for the active daemon, or "" when none is held. */
  get token(): string {
    return auth.get(this.baseUrl);
  }

  /** Store a credential and clear the gate. Callers validate it first. */
  signIn(token: string, remember: boolean) {
    auth.set(this.baseUrl, token, remember);
    this.needsAuth = false;
    this.emit();
  }

  /** Drop this daemon's credential and show the gate again. */
  signOut() {
    auth.clear(this.baseUrl);
    this.needsAuth = true;
    this.emit();
  }

  /**
   * Try a candidate token against the daemon WITHOUT storing it, returning what
   * that token can see. The sign-in gate uses this so a bad paste is answered
   * with "that token was refused" on the spot, rather than being saved and
   * turning every screen behind it into an error.
   *
   * `/api/meta` is the probe because it is cheap, read-only, and already
   * reports the two things the gate wants to show next: who you are and whether
   * this daemon accepts writes.
   */
  async probeToken(token: string): Promise<Meta> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/meta`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      throw new ApiError("OFFLINE", `Could not reach Baton at ${this.baseUrl || "this origin"}`);
    }
    if (res.status === 401) {
      const body = await res.json().catch(() => null);
      throw new ApiError("UNAUTHORIZED", (body as { error?: string })?.error || "that token was refused", 401, body);
    }
    if (!res.ok) throw new ApiError("SERVER", res.statusText, res.status);
    return (await res.json()) as Meta;
  }

  /** The daemon refused us. Kept separate from signOut: the stored token is
   *  NOT discarded, because a 401 during a blip is not proof it is bad, and
   *  silently erasing a good credential would be its own bug. */
  private challenge() {
    if (this.needsAuth) return;
    this.needsAuth = true;
    this.emit();
  }

  /* ---- transport ---- */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.forcedOffline) {
      throw new ApiError("OFFLINE", `Could not reach Baton at ${this.baseUrl || "this origin"}`);
    }
    let res: Response;
    try {
      const token = this.token;
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          // Only when we hold one. A loopback daemon needs no credential, and
          // sending an empty Authorization header would be a malformed request
          // rather than an anonymous one.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers as Record<string, string> | undefined),
        },
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
      if (res.status === 401) {
        this.challenge();
        throw new ApiError("UNAUTHORIZED", msg, 401, body);
      }
      if (res.status === 404) throw new ApiError("NOT_FOUND", msg, 404, body);
      if (res.status === 403) throw new ApiError("READ_ONLY", msg, 403, body);
      if (res.status === 400) throw new ApiError("BAD_REQUEST", msg, 400, body);
      if (res.status === 409) throw new ApiError("CONFLICT", msg, 409, body);
      // 300: not a failure — the daemon needs to know WHICH skill in that repo.
      if (res.status === 300) throw new ApiError("AMBIGUOUS", msg, 300, body);
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
  /**
   * The worktree read-model — one row per worktree (src/worktrees.ts).
   *
   * Read-only and needs no `--write`: it is a join over what four subsystems
   * already know, and the whole point of it is that it states `holderRunning`
   * — whether a process is ACTUALLY alive in the worktree, as opposed to a
   * claim in tasks.json saying somebody owns it.
   *
   * A daemon older than the route 404s. That is NOT an empty repo, so it is not
   * laundered into `[]`: the Worktrees screen says the daemon does not serve
   * this yet, which is a fact a person can act on.
   */
  async getWorktrees(): Promise<WorktreeRow[]> {
    if (this.demo) {
      await this.demoGate();
      return applyDemoOverlay(demoWorktrees(), this.demoWorktreePatches);
    }
    return this.request<WorktreeRow[]>("/api/worktrees");
  }

  /**
   * GET /api/worktrees/:slug/progress — what the agent SAID it was doing.
   *
   * The read above can say a worktree has been quiet for 34 minutes; only the
   * progress ledger can say what it was doing when it went quiet. Read-only
   * and not write-gated, for the same reason as the read above.
   *
   * An unknown slug is NOT a 404 here: the daemon answers with
   * `hasLedger: false` on purpose (src/handoff/progress-ledger.ts:170),
   * because "said nothing" and "does not exist" are different facts. So
   * nothing in this method laundered a missing ledger into an error either.
   */
  async getWorktreeProgress(slug: string): Promise<WorktreeProgress> {
    if (this.demo) {
      await this.demoGate();
      return demoWorktreeProgress(slug);
    }
    return this.request<WorktreeProgress>(
      `/api/worktrees/${encodeURIComponent(slug)}/progress`,
    );
  }

  /* ---- the recovery audit (GET /api/doctor + its one per-item delete) ---- */

  /**
   * The junk audit, read as the source for the Recover screen.
   *
   * NOT write-gated, deliberately: `auditJunk` never mutates (src/cleanup.ts
   * says so at the top and the route comment repeats it), and someone hunting
   * for work an agent left behind has to be able to LOOK at a read-only
   * daemon. Only the two verbs below need `--write`.
   */
  async getDoctor(): Promise<DoctorReport> {
    if (this.demo) {
      await this.demoGate();
      return demoDoctorReport(Date.now(), this.demoDiscarded);
    }
    return this.request<DoctorReport>("/api/doctor");
  }

  /** Slugs a demo delete has removed, so the demo audit stops reporting them. */
  private demoDiscarded = new Set<string>();

  /**
   * Delete ONE stranding — the secondary action on the Recover screen.
   *
   * Only a stale task record has a per-item route (`DELETE /api/tasks/:slug`).
   * `POST /api/doctor/clean` is deliberately NOT called from here: `cleanJunk`
   * acts on the whole report at once, so a per-row button wired to it would
   * delete rows the reader never looked at. `canDiscard` in features/recoverModel.ts
   * is the same rule stated for the UI, and this refuses anything else rather
   * than trusting the caller to have asked.
   *
   * `force: false`, unlike `removeTask` above, which forces by default: a
   * stranding that still holds uncommitted work must hit the daemon's own
   * DirtyWorktreeError and come back as a 409 carrying its sentence, not be
   * quietly bulldozed by the one screen that exists to stop that happening.
   */
  async discardStranding(item: JunkItem): Promise<void> {
    this.assertWrite();
    if (item.kind !== "orphan-worktree-task") {
      throw new ApiError(
        "BAD_REQUEST",
        `No endpoint deletes one ${item.kind}. Run \`baton clean --apply\`, which acts on the whole audit.`,
      );
    }
    if (this.demo) {
      await this.demoGate(140);
      const refusal = demoDiscardRefusal(item);
      if (refusal) throw new ApiError("CONFLICT", refusal, 409);
      this.demoDiscarded.add(item.id);
      this.emit();
      return;
    }
    await this.request(`/api/tasks/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    this.emit();
  }

  /* ---- WRITE: the two worktree verbs (src/endpoints/worktrees.ts) ----
     Both are `--write` gated by the daemon and refuse with a 409 whose `error`
     is the pipeline's own sentence, passed through untouched. `request` already
     turns that into ApiError("CONFLICT", <that sentence>), so the panel has the
     CLI's wording to render and this layer adds no vocabulary of its own.

     The demo has no daemon, so it patches the fixture instead — and reproduces
     the refusals from the RECORDED lifecycle sentences in lib/demoWorktrees.ts,
     because a showcase whose stall guard does not exist teaches the opposite of
     the feature. */

  /** Slug → the patch a demo write left on `demoWorktrees()`. */
  private demoWorktreePatches = new Map<string, Partial<WorktreeRow>>();

  private demoRow(slug: string): WorktreeRow | null {
    const rows = applyDemoOverlay(demoWorktrees(), this.demoWorktreePatches);
    return rows.find((r) => r.slug === slug) ?? null;
  }

  private demoPatch(slug: string, patch: Partial<WorktreeRow>) {
    this.demoWorktreePatches.set(slug, { ...this.demoWorktreePatches.get(slug), ...patch });
    this.emit(); // every poll-driven screen refetches, so the canvas moves too
  }

  /** Adopt work that went quiet. `agent` is the agent taking it over. */
  async takeoverWorktree(slug: string, agent: string): Promise<void> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const row = this.demoRow(slug);
      if (!row) throw new ApiError("NOT_FOUND", `No task '${slug}'.`, 404);
      const refusal = demoTakeoverRefusal(row);
      if (refusal) throw new ApiError("CONFLICT", refusal, 409);
      this.demoPatch(slug, demoTakeoverPatch(agent));
      return;
    }
    await this.request(`/api/worktrees/${encodeURIComponent(slug)}/takeover`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
  }

  /** Hand the task back deliberately. `reason` is recorded as `stoppedReason`. */
  async pauseWorktree(slug: string, opts: { reason?: string; agent?: string } = {}): Promise<void> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const row = this.demoRow(slug);
      if (!row) throw new ApiError("NOT_FOUND", `No task '${slug}'.`, 404);
      const refusal = demoPauseRefusal(row);
      if (refusal) throw new ApiError("CONFLICT", refusal, 409);
      this.demoPatch(slug, demoPausePatch());
      return;
    }
    await this.request(`/api/worktrees/${encodeURIComponent(slug)}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason: opts.reason, agent: opts.agent }),
    });
  }

  /** Overlay to put back if a merge fails — see `mergeWorktree`. */
  private mergeUndo = new Map<string, Partial<WorktreeRow> | null>();

  /**
   * Merge a worktree's branch into the branch the daemon is on.
   *
   * POSTs the committed route `POST /api/tasks/:slug/merge`
   * (src/server.ts:2989), which takes `{ squash, archive }` and answers 200
   * with `{ merged, into, branch, squashed, archivedRef }`, 404 for an unknown
   * slug, or 409 carrying the conflicting files.
   *
   * SEPARATE FROM `mergeTask`, deliberately, and it is one line of difference
   * that matters: `mergeTask` follows a successful merge with
   * `DELETE /api/tasks/:slug?force=true` so the session board stops showing a
   * shipped card. `baton merge` itself does not — it prints "remove the
   * worktree with: baton rm <slug>" and leaves it (src/commands/merge.ts).
   * A Merge button on the worktree canvas that silently deleted the worktree
   * would be doing something its own confirmation never named, on the one
   * screen built for not losing work. Both call the same route.
   *
   * `into` comes back from the daemon, so the caller can report where the work
   * actually landed rather than where it expected it to.
   */
  async mergeWorktree(
    slug: string,
    opts: { squash?: boolean; archive?: boolean } = {},
  ): Promise<{ into: string; branch: string; squashed: boolean; archivedRef: string | null }> {
    this.assertWrite();
    // Snapshot the overlay this slug had BEFORE the write, so a failure can put
    // it back exactly — the optimistic-write-plus-rollback flow
    // features/Board.tsx:111-125 uses for its own merge.
    this.mergeUndo.set(slug, this.demoWorktreePatches.get(slug) ?? null);
    if (this.demo) {
      await this.demoGate(240);
      const row = this.demoRow(slug);
      if (!row) throw new ApiError("NOT_FOUND", `No task '${slug}'.`, 404);
      const refusal = demoMergeRefusal(row);
      if (refusal) throw new ApiError("MERGE_FAILED", refusal, 409);
      this.demoPatch(slug, demoMergePatch());
      return {
        // The demo's target is the demo project's branch, which is what its
        // `/api/meta` reports — so switching project switches the branch the
        // panel names, exactly as it would against a real daemon.
        into: this.activeProject().branch,
        branch: row.branch ?? `baton/${slug}`,
        squashed: opts.squash !== false,
        archivedRef: opts.archive !== false ? `refs/baton/archive/${slug}` : null,
      };
    }
    try {
      const r = await this.request<{ into: string; branch: string; squashed: boolean; archivedRef: string | null }>(
        `/api/tasks/${encodeURIComponent(slug)}/merge`,
        { method: "POST", body: JSON.stringify({ squash: opts.squash !== false, archive: opts.archive !== false }) },
      );
      this.emit();
      return r;
    } catch (e) {
      // The 409's file list, in the one sentence this client already uses for a
      // halted merge (`mergeTask` above) rather than a second wording for it.
      if (e instanceof ApiError && e.status === 409) {
        const conflicts = (e.details as { conflicts?: { path: string }[] })?.conflicts;
        const files = conflicts?.map((c) => c.path).join(", ");
        throw new ApiError("MERGE_FAILED", files ? `Merge halted on conflicts: ${files}` : e.message, 409, e.details);
      }
      throw e;
    }
  }

  /** Undo an optimistic merge overlay after the write failed, and make every
   *  screen re-read the daemon rather than trust what the click implied. */
  rollbackWorktree(slug: string) {
    const before = this.mergeUndo.get(slug);
    if (before !== undefined) {
      if (before === null) this.demoWorktreePatches.delete(slug);
      else this.demoWorktreePatches.set(slug, before);
      this.mergeUndo.delete(slug);
    }
    this.emit();
  }
  /** Agents at the hub/repo root or a kb sub-project — not attached to any task worktree. */
  async getRootAgents(): Promise<Array<{ agent: string; count: number }>> {
    if (this.demo) {
      await this.demoGate();
      return []; // the demo showcase has no root-terminal scenario to fabricate honestly
    }
    return this.request<Array<{ agent: string; count: number }>>("/api/agents/root");
  }
  /** Connected agents with no task worktree — the presence layer (ISS-12/ISS-14). */
  async getSessions(): Promise<PresenceSession[]> {
    if (this.demo) {
      await this.demoGate();
      return []; // presence is a real-daemon view; the demo showcase fabricates no connected agents
    }
    try {
      return await this.request<PresenceSession[]>("/api/sessions");
    } catch (e) {
      // 404 only: an older daemon doesn't serve this, so the panel stays
      // hidden. A failed refresh is NOT the same event — an empty array here
      // makes the panel vanish, which the screen reads as "nothing connected
      // outside worktrees", and it silently disabled the panel's own
      // "may be stale" badge (usePoll never saw an error, so the badge could
      // never fire). Rethrowing lets the last known list stay up, labelled.
      if (e instanceof ApiError && e.code === "NOT_FOUND") return [];
      throw e;
    }
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
        // The showcase views as a local owner — the sign-in gate is a real-mode
        // path and must never appear in front of the demo.
        viewer: (this.viewer = { local: true, memberId: null, name: null, role: "owner" }),
        agents: {
          headless: ["claude", "codex", "gemini"],
          interactive: ["claude", "cursor", "codex", "gemini", "aider", "opencode"],
          // Wider than the two lists above, exactly as in real mode: antigravity
          // and openclaw are detection-only, so they can be handed off to but
          // never launched.
          known: ["claude", "cursor", "codex", "gemini", "antigravity", "aider", "opencode", "openclaw"],
          // Empty on purpose, and not fabricated: the showcase ships no
          // `.baton/agents.json`, so nothing here arrived with a repo. Present
          // rather than omitted so demo and real mode have the same shape.
          fromProject: [],
        },
      };
    }
    const meta = await this.request<Meta>("/api/meta");
    this.viewer = meta.viewer ?? null;
    return meta;
  }

  /* ---- knowledge base (graphify) ---- */
  async getKb(): Promise<KbStatus> {
    if (this.demo) {
      await this.demoGate();
      return DEMO_KB;
    }
    return this.request<KbStatus>("/api/kb");
  }
  /** The shareable context pack (markdown + metadata) for a project or the whole hub. */
  async getKbContext(project?: string): Promise<ContextPackResponse> {
    if (this.demo) {
      await this.demoGate(150);
      return DEMO_CONTEXT_PACK;
    }
    const q = project ? `?format=json&project=${encodeURIComponent(project)}` : '?format=json';
    return this.request<ContextPackResponse>(`/api/kb/context${q}`);
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
  /**
   * Which runs this daemon is driving right now.
   *
   * The dashboard could start an agent but had no way to ask whether one was
   * already running, so it could not offer to stop one either — `stopAgentRun`
   * existed with nothing calling it. Demo returns nothing running: the showcase
   * has no daemon to drive a process.
   */
  async getRunningAgents(): Promise<RunningAgentInfo[]> {
    if (this.demo) {
      await this.demoGate(80);
      return [...this.demoRunning.entries()].map(([slug, r]) => ({
        slug, agent: r.agent, startedAt: r.startedAt, recentLines: [],
      }));
    }
    const r = await this.request<{ running: RunningAgentInfo[] }>("/api/agents/running");
    return r.running ?? [];
  }
  async startAgentRun(slug: string, opts: { agent?: AgentId; model?: string; prompt?: string } = {}): Promise<{ slug: string; agent: string; promptSource: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      const agent = opts.agent ?? "claude";
      this.demoRunning.set(slug, { agent, startedAt: new Date().toISOString() });
      return { slug, agent, promptSource: "task" };
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
      return { stopped: this.demoRunning.delete(slug) };
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
      case "antigravity": return { scope: "project", path: ".agents/mcp_config.json" };
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
      return { skill: id, agent, rel: inst?.rel ?? "", path: inst?.rel ?? "", wrote: true, references: skill?.references.length ?? 0 };
    }
    const r = await this.request<SkillInstallResult>(`/api/skills/${encodeURIComponent(id)}/install`, {
      method: "POST", body: JSON.stringify({ agent }),
    });
    this.emit();
    return r;
  }
  async installSkillEverywhere(id: string): Promise<SkillInstallResult[]> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      this.demoSkills ??= JSON.parse(JSON.stringify(DEMO_SKILLS)) as SkillStatus[];
      const skill = this.demoSkills.find((s) => s.id === id);
      const results = (skill?.installs ?? []).map((inst) => {
        inst.installed = true;
        return { skill: id, agent: inst.agent, rel: inst.rel, path: inst.rel, wrote: true, references: skill?.references.length ?? 0 };
      });
      this.emit();
      return results;
    }
    const r = await this.request<{ results: SkillInstallResult[] }>(`/api/skills/${encodeURIComponent(id)}/install`, {
      method: "POST", body: JSON.stringify({ agent: "all" }),
    });
    this.emit();
    return r.results;
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
  async importSkill(source: string, opts: { id?: string; replace?: boolean } = {}): Promise<SkillStatus> {
    const fallback = source.split(/[/\\]/).pop()?.replace(/\.(md|mdc|markdown|txt)$/i, "") || "imported-skill";
    return this.saveSkill("/api/skills/import", { source, ...opts }, opts.id ?? fallback, `Imported from ${source}.`);
  }

  /**
   * Add a skill from a file the user picked in the browser.
   *
   * The text is read client-side and posted as JSON rather than multipart: a
   * 256KB markdown file fits the daemon's existing body cap, and a multipart
   * parser would be a dependency in a daemon that deliberately has none.
   */
  async uploadSkill(input: { filename: string; content: string; id?: string; replace?: boolean }): Promise<SkillStatus> {
    const fallback = input.id ?? input.filename.replace(/\.(md|mdc|markdown|txt)$/i, "");
    return this.saveSkill("/api/skills/upload", input, fallback, `Uploaded from ${input.filename}.`);
  }

  /** One write path for import and upload, so demo and real behave alike for both. */
  private async saveSkill(path: string, body: unknown, fallbackId: string, demoBody: string): Promise<SkillStatus> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(220);
      const id = this.slugify(fallbackId || "imported-skill");
      const existing = (this.demoSkills ?? [...DEMO_SKILLS]).find((s) => s.id === id);
      // The demo must reproduce the refusals too, or the showcase teaches a
      // flow that the real daemon then rejects.
      if (existing?.source === "bundled") throw new ApiError("BAD_REQUEST", `'${id}' is a Baton built-in — pick another shortcut`);
      if (existing && !(body as { replace?: boolean }).replace) throw new ApiError("CONFLICT", `you already have a skill called '${id}'`);
      // A DemoSkill, not a SkillStatus: demo mode has no daemon to fetch a body
      // from, so the fixture carries one.
      const text = `# ${id}\n\n${demoBody}\n`;
      const skill: DemoSkill = {
        id, name: id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: "Your skill (demo preview).", tags: [], produces: [], body: text,
        source: "global", references: [], bookmarked: false,
        byteSize: new TextEncoder().encode(text).length,
        contentSha256: "0".repeat(64),
        installs: [
          { agent: "claude", rel: `.claude/skills/${id}/SKILL.md`, installed: false },
          { agent: "cursor", rel: `.cursor/rules/${id}.mdc`, installed: false },
          { agent: "antigravity", rel: `.agents/skills/${id}/SKILL.md`, installed: false },
        ],
      };
      this.demoSkills = [...(this.demoSkills ?? [...DEMO_SKILLS]).filter((s) => s.id !== id), skill];
      this.emit();
      return skill;
    }
    // The daemon returns the parsed skill without per-agent install state; the
    // screen refetches the catalog right after, which fills installs in.
    const r = await this.request<{ skill: Omit<SkillStatus, "installs"> }>(path, { method: "POST", body: JSON.stringify(body) });
    this.emit();
    return { ...r.skill, installs: [] };
  }

  /** Pin or unpin a skill. Bookmarks live with the library (machine-wide), not
   *  in this browser, so they survive a cleared cache and show in the CLI too. */
  async bookmarkSkill(id: string, on: boolean): Promise<{ id: string; bookmarked: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(90);
      // A NEW array with a NEW row, not a mutation: getSkills returns
      // this.demoSkills by reference, so re-assigning the same array leaves
      // React's setState comparing a value to itself — it bails, and the star
      // never flips even though the data changed.
      const all = this.demoSkills ?? (JSON.parse(JSON.stringify(DEMO_SKILLS)) as SkillStatus[]);
      this.demoSkills = all.map((s) => (s.id === id ? { ...s, bookmarked: on } : s));
      this.emit();
      return { id, bookmarked: on };
    }
    const r = await this.request<{ id: string; bookmarked: boolean }>(
      `/api/skills/${encodeURIComponent(id)}/bookmark`, { method: "POST", body: JSON.stringify({ on }) });
    this.emit();
    return r;
  }

  /* ---- the imported-skill review gate ----
     A downloaded skill becomes the agent's OWN instructions, so it is held
     until a person has read it. These two calls are that review: what is
     waiting, and "I read this exact content and accept it". */

  /** Skills held pending review, each with its findings AND its full content.
   *  Read-only, and available in read-only mode: seeing what is waiting on you
   *  must not require write access. */
  async getQuarantine(): Promise<QuarantineView> {
    if (this.demo) {
      const view = JSON.parse(JSON.stringify(DEMO_QUARANTINE)) as QuarantineView;
      return { ...view, held: view.held.filter((h) => !this.demoReleasedSkills.has(`${h.id}@${h.hash}`)) };
    }
    return this.request<QuarantineView>("/api/skills/quarantine");
  }

  /** Keyed by `id@hash`, not by id: releasing approves CONTENT, so a skill that
   *  changes after release is held again rather than inheriting the approval. */
  private demoReleasedSkills = new Set<string>();

  /**
   * Take responsibility for this exact content.
   *
   * The hash is required and the daemon re-checks it against what is on disk —
   * a 409 means the skill changed between being shown and being approved, and
   * the caller must re-read it rather than retrying.
   */
  async releaseHeldSkill(id: string, hash: string): Promise<{ id: string; released: boolean; hash: string }> {
    this.assertWrite();
    if (!hash) throw new ApiError("BAD_REQUEST", "releasing needs the hash of the content you read");
    if (this.demo) {
      await this.demoGate(260);
      this.demoReleasedSkills.add(`${id}@${hash}`);
      this.emit();
      return { id, released: true, hash };
    }
    const r = await this.request<{ id: string; released: boolean; hash: string }>(
      `/api/skills/${encodeURIComponent(id)}/release`, { method: "POST", body: JSON.stringify({ hash }) });
    this.emit();
    return r;
  }

  /** Delete a skill of the user's own — from the catalog and every agent. */
  /** Re-fetch a skill from its recorded origin. Throws CONFLICT when the local
   *  copy has been edited, so the caller can offer to overwrite. */
  async updateSkill(id: string, force = false): Promise<{ id: string; status: "updated" | "already-current" | "no-origin"; changed?: string[]; origin?: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(300);
      return { id, status: "already-current", changed: [] };
    }
    return this.request(`/api/skills/${encodeURIComponent(id)}/update`, {
      method: "POST", body: JSON.stringify({ force }),
    });
  }

  async removeSkill(id: string): Promise<{ removed: boolean; unwired: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      const all = this.demoSkills ?? [...DEMO_SKILLS];
      const found = all.find((s) => s.id === id);
      if (found && found.source === "bundled") {
        throw new ApiError("BAD_REQUEST", ` is a Baton built-in — it ships with the package and can't be deleted`);
      }
      this.demoSkills = all.filter((s) => s.id !== id);
      this.emit();
      return { removed: !!found, unwired: [] };
    }
    const r = await this.request<{ removed: boolean; unwired: string[] }>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    this.emit();
    return r;
  }

  /**
   * Download URLs. Returned rather than fetched, because the browser's own
   * navigation handles Content-Disposition — reading the body into JS just to
   * re-offer it as a blob would be more code doing the same thing worse.
   */
  skillFileUrl(id: string): string {
    return `${this.baseUrl}/api/skills/${encodeURIComponent(id)}/file`;
  }

  /**
   * One skill's playbook, fetched on demand.
   *
   * The catalogue listing deliberately carries no bodies — the bundled set is
   * ~330 KB, so shipping them all to render a list of names cost ~58k tokens.
   * Only the detail view reads a body, and it reads exactly one.
   */
  async skillBody(id: string): Promise<string> {
    if (this.demo) {
      const skill = DEMO_SKILLS.find((s) => s.id === id);
      if (!skill) throw new ApiError("NOT_FOUND", `no skill ${id}`, 404, null);
      return skill.body;
    }
    const token = this.token;
    const res = await fetch(this.skillFileUrl(id), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new ApiError("NOT_FOUND", `could not load ${id}`, res.status, null);
    }
    return res.text();
  }
  skillsExportUrl(): string {
    return `${this.baseUrl}/api/skills/export`;
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
    // Null for a remote viewer, and deliberately BEFORE opening anything: the
    // daemon refuses terminal endpoints over the network (src/access.ts rule 2),
    // and EventSource answers a 403 by retrying forever. An honest "not here"
    // beats a panel that reconnects into a wall for as long as it stays open.
    if (this.demo || this.isRemoteViewer) return null;
    return `${this.baseUrl}/api/tasks/${encodeURIComponent(slug)}/terminal/stream`;
  }

  /* ---- code review (three axes, src/reviews.ts) ---- */
  private demoReviewStore: ReviewRecord[] | null = null;
  /** Mutable demo copy so warn / disconnect / revoke actually change something. */
  private demoTeam: TeamState | null = null;
  private demoFleet: FleetDaemon[] | null = null;
  private demoReviewRecords(): ReviewRecord[] {
    return (this.demoReviewStore ??= JSON.parse(JSON.stringify(DEMO_REVIEWS)) as ReviewRecord[]);
  }
  /** Per-axis open counts. Never summed — see the note on ReviewRecord. */
  private static openByAxis(r: ReviewRecord): Record<ReviewAxis, number> {
    const out: Record<ReviewAxis, number> = { standards: 0, spec: 0, security: 0 };
    for (const f of r.findings) if (f.status === "open") out[f.axis]++;
    return out;
  }
  async getReviews(): Promise<{ reviews: ReviewRecord[]; head: string }> {
    if (this.demo) {
      await this.demoGate(60);
      return { reviews: this.demoReviewRecords(), head: DEMO_REVIEW_HEAD };
    }
    const r = await this.request<{ reviews: ReviewRecord[]; head: string }>("/api/reviews");
    return { reviews: r.reviews ?? [], head: r.head ?? "" };
  }
  /**
   * Resolve one finding by its STABLE id, never by array position: a re-review
   * reorders findings, so an index that was right when this screen rendered can
   * address a different finding by the time the click lands.
   */
  async resolveReviewFinding(slug: string, id: string, dismiss = false): Promise<ReviewRecord> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const next = this.demoReviewRecords().map((r) => {
        if (r.slug !== slug) return r;
        const findings = r.findings.map((f) => (f.id === id ? { ...f, status: (dismiss ? "dismissed" : "fixed") as FindingStatus } : f));
        const updated = { ...r, findings, updatedAt: new Date().toISOString() };
        return { ...updated, open: BatonClient.openByAxis(updated) };
      });
      this.demoReviewStore = next;
      this.emit();
      const rec = next.find((r) => r.slug === slug);
      if (!rec) throw new Error(`no review '${slug}'`);
      return rec;
    }
    const r = await this.request<ReviewRecord>(`/api/reviews/${encodeURIComponent(slug)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ id, dismiss }),
    });
    this.emit();
    return r;
  }

  /* ---- project memory (evidence-anchored facts, src/memory.ts) ---- */
  private demoMemory: MemoryFactStatus[] | null = null;
  private demoRetention: RetentionPolicy = {};
  private demoFacts(): MemoryFactStatus[] {
    return (this.demoMemory ??= JSON.parse(JSON.stringify(DEMO_MEMORY)) as MemoryFactStatus[]);
  }
  async getMemories(): Promise<{ facts: MemoryFactStatus[]; projects: MemoryProject[] }> {
    if (this.demo) {
      await this.demoGate(60);
      return { facts: this.demoFacts(), projects: DEMO_MEMORY_PROJECTS };
    }
    const r = await this.request<{ facts: MemoryFactStatus[]; projects: MemoryProject[] }>("/api/memory");
    return { facts: r.facts, projects: r.projects ?? [] };
  }
  async addMemory(input: { fact: string; type?: string; files?: string[]; task?: string }): Promise<MemoryFactStatus> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(150);
      const fact: MemoryFactStatus = {
        id: `mem-${this.slugify(input.fact)}`, type: (input.type as MemoryFactStatus["type"]) ?? "reference",
        fact: input.fact, agent: "dashboard", author: "you@example.com", task: input.task ?? null, createdAt: new Date().toISOString(),
        anchors: { commit: "demo", files: (input.files ?? []).map((p) => ({ path: p, hash: "demo" })) },
        supersedes: null, freshness: "fresh", staleReason: null, commitsBehind: 0, project: null,
      };
      this.demoMemory = [fact, ...this.demoFacts()];
      this.emit();
      return fact;
    }
    const r = await this.request<MemoryFactStatus>("/api/memory", { method: "POST", body: JSON.stringify(input) });
    this.emit();
    return r;
  }
  async bulkDeleteMemories(ids: string[]): Promise<{ removed: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(160);
      const set = new Set(ids);
      this.demoMemory = this.demoFacts().filter((f) => !set.has(f.id));
      this.emit();
      return { removed: ids };
    }
    const r = await this.request<{ removed: string[] }>("/api/memory/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) });
    this.emit();
    return r;
  }
  async pruneMemories(policy: RetentionPolicy): Promise<{ removed: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      const removed = this.applyDemoRetention(policy);
      this.emit();
      return { removed };
    }
    const r = await this.request<{ removed: string[] }>("/api/memory/prune", { method: "POST", body: JSON.stringify(policy) });
    this.emit();
    return r;
  }
  async getRetention(): Promise<RetentionPolicy> {
    if (this.demo) { await delay(40); return this.demoRetention; }
    return this.request<RetentionPolicy>("/api/memory/retention");
  }
  async setRetention(policy: RetentionPolicy): Promise<{ policy: RetentionPolicy; removed: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(150);
      this.demoRetention = policy;
      const removed = this.applyDemoRetention(policy);
      this.emit();
      return { policy, removed };
    }
    const r = await this.request<{ policy: RetentionPolicy; removed: string[] }>("/api/memory/retention", { method: "POST", body: JSON.stringify(policy) });
    this.emit();
    return r;
  }
  /** Demo-only: apply a retention policy to the in-memory facts (mirrors factsToPrune). */
  private applyDemoRetention(policy: RetentionPolicy): string[] {
    const now = Date.now();
    const cutoff = policy.maxAgeDays && policy.maxAgeDays > 0 ? now - policy.maxAgeDays * 86_400_000 : null;
    const keep: MemoryFactStatus[] = [], removed: string[] = [];
    for (const f of this.demoFacts()) {
      const tooOld = cutoff !== null && Date.parse(f.createdAt) < cutoff;
      const drop = tooOld || (policy.dropStale && f.freshness === "stale") || (policy.dropAging && f.freshness === "aging");
      if (drop) removed.push(f.id); else keep.push(f);
    }
    this.demoMemory = keep;
    return removed;
  }
  async getStorage(): Promise<StorageBreakdown> {
    if (this.demo) {
      await this.demoGate(80);
      return {
        root: "/demo/orbit",
        memory: { bytes: this.demoFacts().length * 480, facts: this.demoFacts().length },
        history: { bytes: 86_016 }, reports: { bytes: 12_400, count: 4 },
        graphs: [{ id: "api", label: "api", bytes: 1_180_000, count: 3 }, { id: "web", label: "web", bytes: 940_000, count: 3 }],
        graphsTotal: 2_120_000, total: 2_120_000 + 86_016 + 12_400 + this.demoFacts().length * 480,
      };
    }
    return this.request<StorageBreakdown>("/api/storage");
  }
  async getPurgePreview(): Promise<PurgePreview> {
    if (this.demo) {
      await this.demoGate(90);
      const facts = this.demoFacts().length;
      return {
        root: "/demo/orbit", repo: "orbit", confirmPhrase: "purge orbit", gitObjectBytes: 18_400_000,
        items: [
          { category: "archives", label: "Completed-task git history", bytes: 18_400_000, count: 7, destructive: true, detail: "5 archived merge ref(s) + 2 orphan branch(es), then git gc to reclaim packed objects" },
          { category: "history", label: "History index (history.db)", bytes: 86_016, count: 1, destructive: true, detail: "queryable merge/commit index — rebuildable from git history" },
          { category: "reports", label: "Completion reports", bytes: 12_400, count: 4, destructive: true, detail: "4 merged-task report file(s)" },
          { category: "graphs", label: "Knowledge graphs", bytes: 2_120_000, count: 2, destructive: false, detail: "graphify graphs — rebuildable with `baton kb rebuild`" },
          { category: "tmp", label: "Temp / upload staging", bytes: 4_096, count: 1, destructive: false, detail: "leftover upload + atomic-write temp files" },
          { category: "memory", label: "Shared memory (knowledge base)", bytes: facts * 480, count: facts, destructive: true, detail: `${facts} evidence-anchored fact(s)`, warning: "This is your shared knowledge base — agents lose every saved fact. There is no undo." },
        ],
      };
    }
    return this.request<PurgePreview>("/api/storage/purge");
  }
  async purgeStorage(categories: PurgeCategory[], confirm: string): Promise<PurgeResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(260);
      const prev = await this.getPurgePreview();
      const freed = prev.items.filter((i) => categories.includes(i.category)).reduce((n, i) => n + i.bytes, 0);
      if (categories.includes("memory")) this.demoMemory = [];
      this.emit();
      return { deleted: categories.map((c) => ({ category: c, count: 1 })), freedBytes: freed, gcRan: categories.includes("archives") };
    }
    const r = await this.request<PurgeResult>("/api/storage/purge", { method: "POST", body: JSON.stringify({ categories, confirm }) });
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
  /** Re-anchor stale facts whose verifiable terms survived; the rest are queued for review. */
  async repairMemories(): Promise<{ reanchored: string[]; needsReview: string[] }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(300);
      // Mirror of the daemon's rule, simplified: a fact naming a `code term`
      // or file path can be re-verified mechanically; plain prose can't.
      const verifiable = (t: string) => /`[^`]+`|\b[\w-]+(?:[./][\w-]+)+\b/.test(t);
      const reanchored: string[] = [], needsReview: string[] = [];
      this.demoMemory = this.demoFacts().map((f) => {
        if (f.freshness !== "stale") return f;
        if (verifiable(f.fact)) {
          reanchored.push(f.id);
          return { ...f, freshness: "fresh" as const, staleReason: null, commitsBehind: 0 };
        }
        needsReview.push(f.id);
        return f;
      });
      this.emit();
      return { reanchored, needsReview };
    }
    const r = await this.request<{ reanchored: string[]; needsReview: string[] }>("/api/memory/repair", { method: "POST", body: "{}" });
    this.emit();
    return r;
  }


  /* ---- memory consolidation: mechanical (always on) + agent-assisted (opt-in) ----
     The only setting in this client that can spend the user's money, so it is
     the one place a silent default would be worst: `enabled` is never inferred
     here — it is whatever the daemon says, and the daemon's own default
     (DELEGATE_DEFAULTS, src/memory/delegate.ts) is false. */

  /** Demo only. The switch position the fixtures are rendered against. */
  private demoDelegateEnabled = false;

  /**
   * Fixtures for BOTH switch positions — no daemon is contacted either way.
   *
   * The ledger deliberately carries a run in the OFF state too: turning the
   * setting off does not un-spend the tokens or erase what the pass produced,
   * and a showcase that hid the receipt when the switch went off would teach
   * the opposite.
   */
  private demoConsolidation(enabled: boolean): MemoryConsolidation {
    const min = 60_000;
    const lastRun: MemoryDelegateSpend = {
      at: Date.now() - 96 * min,
      ok: true,
      agent: "aider",
      model: "local/qwen2.5-coder",
      inputFacts: 41,
      promptChars: 8_642,
      inputTokens: 11_204,
      outputTokens: 1_386,
      costUsd: 0.031,
      durationMs: 42_500,
      produced: 2,
      rejected: 3,
    };
    const produced: MemoryProducedFact[] = [
      {
        id: "mc-worktree-branch-naming",
        // Plain text on purpose, including the angle brackets: this string is
        // written by a model and the screen must render it as characters.
        fact: "[machine-consolidated] Worktrees are created at ../<repo>-<slug> and never inside the repo, so a stray build never walks into another agent's tree.",
        cites: ["mem-worktree-path", "mem-worktree-nested"],
        generator: "aider:local/qwen2.5-coder",
      },
      {
        id: "mc-sse-not-socketio",
        fact: "[machine-consolidated] Realtime is SSE through the bus in src/events.ts — <script>-free, one event type per publisher, and socket.io was ruled out by decision rather than by accident.",
        cites: ["mem-sse-decision", "mem-events-bus", "mem-no-socketio"],
        generator: "aider:local/qwen2.5-coder",
      },
    ];
    return {
      mechanical: {
        status: "ran",
        at: Date.now() - 12 * min,
        superseded: ["mem-dup-graphify-cmd", "mem-dup-serve-port"],
        contradictions: [
          { ids: ["mem-preflight-node18", "mem-preflight-node20"], reason: "same claim, different version number" },
        ],
      },
      delegate: {
        config: {
          enabled,
          maxRunsPerDay: 4,
          minIntervalMs: 60 * 60 * 1000,
          maxFactsPerJob: 60,
          maxUsdPerDay: 0.5,
          windowMs: 24 * 60 * 60 * 1000,
        },
        runsInWindow: 1,
        usdInWindow: lastRun.costUsd ?? 0,
        lastRun,
        produced,
        // null = "a pass ran", which is the fiction this fixture already tells:
        // the facts above carry generators and cites that only a completed
        // agent pass could produce. Real mode reports DELEGATE_NO_LAUNCHER here
        // instead, because no launcher is wired — so the demo is showing the
        // screen a working pass WOULD fill, not what a real daemon returns.
        noPassReason: null,
      },
    };
  }

  /** Both passes' state. null = this daemon does not report it (an older build,
   *  which answers 404); the card then explains that the mechanical pass still
   *  runs, rather than drawing a switch that could only fail.
   *
   *  ONLY a 404 means that, and the distinction is the whole point. A bare
   *  `catch { return null }` here turned a refused credential (401), a
   *  read-only refusal (403) and a dropped connection into the same confident
   *  sentence — "this daemon doesn't report consolidation yet" — which the
   *  code cannot tell apart from any of them, and which is false for all
   *  three. D-009: what cannot be measured is reported as absent, never
   *  guessed. Everything but 404 is rethrown so the card can name what
   *  actually happened. */
  async getMemoryConsolidation(): Promise<MemoryConsolidation | null> {
    if (this.demo) {
      await delay(60);
      return this.demoConsolidation(this.demoDelegateEnabled);
    }
    try {
      return await this.request<MemoryConsolidation>("/api/memory/consolidation");
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  /** Turn agent-assisted consolidation on or off. Write-gated like every other
   *  mutation — a read-only daemon refuses it, and the screen says so BEFORE
   *  the click rather than after. */
  async setMemoryDelegateEnabled(enabled: boolean): Promise<MemoryConsolidation> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(120);
      this.demoDelegateEnabled = enabled;
      return this.demoConsolidation(enabled);
    }
    return this.request<MemoryConsolidation>("/api/memory/consolidation", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
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

  /** Load-aware handoff recommendation: least-loaded available agent for a task. */
  async suggestHandoff(slug: string): Promise<HandoffLoadSuggestion> {
    if (this.demo) {
      await delay(80);
      // Load = each agent's actively-churning (dirty/conflict) tasks, from the board.
      const loads: Record<string, number> = {};
      for (const s of this.demoSessions) {
        if (s.agent && (s.status === "dirty" || s.status === "conflict")) loads[s.agent] = (loads[s.agent] ?? 0) + 1;
      }
      const me = this.demoSessions.find((s) => s.slug === slug);
      const pool = [...new Set(this.demoSessions.map((s) => s.agent).filter((a): a is AgentId => !!a && a !== me?.agent))];
      pool.sort((a, b) => (loads[a] ?? 0) - (loads[b] ?? 0));
      const recommended = pool[0] ?? null;
      const n = recommended ? loads[recommended] ?? 0 : 0;
      return { recommended, reason: recommended ? `${recommended} has the lightest load (${n === 0 ? "idle" : `${n} active`})` : "no other agent available", loads };
    }
    return this.request<HandoffLoadSuggestion>(`/api/tasks/${encodeURIComponent(slug)}/suggest-handoff`);
  }

  /** Briefs closed in this demo session, so the panel behaves like the real one. */
  private demoResolved = new Set<string>();

  /** Open handoff briefs awaiting pickup (task worktrees + session briefs). */
  async getHandoffs(): Promise<HandoffBriefEntry[]> {
    if (this.demo) {
      await this.demoGate();
      // One illustrative open brief so the inbox + copy buttons are explorable.
      const body = DEMO_BRIEF_BODY;
      // The fence has ONE implementation (src/handoff/untrusted.ts), and the
      // daemon builds the resume prompt with it so no client ever assembles
      // one. Demo calls no daemon, so it replays a RECORDING of that output —
      // see web/src/lib/demoHandoff.ts. Rebuilding the fence here, as this once
      // did, is the second implementation that rule exists to forbid; showing
      // no fence at all would teach the wrong shape.
      const demoResume = demoResumePrompt;
      // Two briefs, one waiting on the other: the demo has to show the
      // pipeline, because the pipeline is the point of the panel. Closing one
      // unblocks the next, exactly as it does against a real daemon.
      const all: HandoffBriefEntry[] = [
        {
          slug: "sess-cursor-demo", kind: "session", title: "Fix flaky checkout e2e",
          status: "ready", from: "cursor", to: "any",
          created: new Date(Date.now() - 22 * 60_000).toISOString(),
          path: "/repo/.baton/handoffs/sess-cursor-demo.md", cwd: "/repo",
          markdown: body, body, resumePrompt: demoResume("sess-cursor-demo", "/repo"),
          dependsOn: [], phase: null, step: 1, parallel: true,
          ready: true, blockedBy: [], cyclic: false,
        },
        {
          slug: "sess-docs-demo", kind: "session", title: "Document the webhook retry contract",
          status: "ready", from: "cursor", to: "gemini",
          created: new Date(Date.now() - 18 * 60_000).toISOString(),
          path: "/repo/.baton/handoffs/sess-docs-demo.md", cwd: "/repo",
          markdown: body, body, resumePrompt: demoResume("sess-docs-demo", "/repo"),
          dependsOn: [], phase: null, step: 1, parallel: true,
          ready: true, blockedBy: [], cyclic: false,
        },
        {
          slug: "sess-release-demo", kind: "session", title: "Cut the patch release",
          status: "ready", from: "cursor", to: "claude",
          created: new Date(Date.now() - 9 * 60_000).toISOString(),
          path: "/repo/.baton/handoffs/sess-release-demo.md", cwd: "/repo",
          markdown: body, body, resumePrompt: demoResume("sess-release-demo", "/repo"),
          dependsOn: ["sess-cursor-demo"], phase: null, step: 2, parallel: false,
          ready: false, blockedBy: ["sess-cursor-demo"], cyclic: false,
        },
      ];
      const open = all.filter((b) => !this.demoResolved.has(b.slug));
      // Re-derive the pipeline over what is left, the way the daemon does:
      // a dependency that is no longer open no longer blocks.
      return open.map((b) => {
        const blockedBy = b.blockedBy.filter((d) => open.some((o) => o.slug === d));
        const step = blockedBy.length ? b.step : 1;
        return { ...b, blockedBy, ready: blockedBy.length === 0, step,
          parallel: open.filter((o) => (o.blockedBy.filter((d) => open.some((x) => x.slug === d)).length ? o.step : 1) === step).length > 1 };
      });
    }
    try {
      const r = await this.request<{ briefs: HandoffBriefEntry[] }>("/api/handoffs");
      return r.briefs;
    } catch {
      return []; // older daemons don't serve this — the inbox just stays hidden
    }
  }

  /**
   * Close a finished brief so it leaves the pickup list.
   *
   * The same call the `resolve_handoff` MCP tool makes — an agent closes its
   * own brief; this is the button for work finished outside one.
   */
  async resolveHandoff(slug: string, opts: { by?: string; note?: string } = {}): Promise<void> {
    if (this.demo) {
      await this.demoGate(120);
      this.demoResolved.add(slug);
      return;
    }
    this.assertWrite();
    await this.request(`/api/handoffs/${encodeURIComponent(slug)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ by: opts.by ?? "dashboard", note: opts.note }),
    });
  }

  /* ---- pipeline: phase swimlanes, plan view, cancellation ----
     Every judgement on this screen (which lane is open, why a task cannot
     start, what a cancellation would touch) is made by the daemon and read
     here. Deciding any of it in the browser would be a second implementation
     of the phase barrier, and the two would disagree exactly when it mattered:
     the board saying "startable" while every agent is refused the task. */
  private demoPipeline: PipelineView | null = null;

  async getPipeline(): Promise<PipelineView> {
    if (this.demo) {
      await this.demoGate(60);
      this.demoPipeline ??= JSON.parse(JSON.stringify(DEMO_PIPELINE)) as PipelineView;
      return this.demoPipeline;
    }
    return this.request<PipelineView>("/api/pipeline");
  }

  async getPlan(id: string): Promise<{ id: string; markdown: string; path: string }> {
    if (this.demo) {
      await this.demoGate(90);
      return { id, markdown: DEMO_PLAN_MD, path: `baton/plans/${id}.md` };
    }
    return this.request<{ id: string; markdown: string; path: string }>(
      `/api/pipeline/plans/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Every plan ON DISK and whether a human approved the bytes that are there
   * now — GET /api/plans (src/plans/inventory.ts).
   *
   * Read-only, and it stays that way. There is no approve method here on
   * purpose: approval is recorded against bytes somebody is supposed to have
   * read, and a one-click approval in a browser is a checkpoint that has
   * stopped checking anything.
   */
  async getPlanInventory(): Promise<PlanInventory> {
    if (this.demo) {
      await this.demoGate(80);
      return DEMO_PLAN_INVENTORY;
    }
    return this.request<PlanInventory>("/api/plans");
  }

  /**
   * Preview or perform a cancellation.
   *
   * `dryRun` still asserts write, because the daemon gates the whole endpoint
   * on it — a read-only dashboard offering a preview it could never act on
   * would be a button that lies. The screen hides the control instead.
   */
  async cancelPipeline(
    scope: CancelScopeInput,
    opts: { reason?: string; dryRun?: boolean } = {},
  ): Promise<CancelResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(opts.dryRun ? 120 : 260);
      return this.demoCancel(scope, opts);
    }
    return this.request<CancelResult>("/api/pipeline/cancel", {
      method: "POST",
      body: JSON.stringify({ ...scope, ...opts }),
    });
  }

  /**
   * The demo shim — a fixture, not a second copy of the rule.
   *
   * In real mode the radius comes from the daemon and the browser computes
   * nothing. Here there is no daemon and no write, so the showcase fabricates
   * both from the demo board; the preview and the "write" go through this one
   * function so the demo at least stays consistent with itself.
   */
  private demoCancel(
    scope: CancelScopeInput,
    opts: { reason?: string; dryRun?: boolean },
  ): CancelResult {
    this.demoPipeline ??= JSON.parse(JSON.stringify(DEMO_PIPELINE)) as PipelineView;
    const view = this.demoPipeline;
    const rows = view.lanes.flatMap((l) => l.tasks);
    const inScope = (t: LaneTask) =>
      "slug" in scope ? t.slug === scope.slug
        : "phase" in scope ? t.phase === scope.phase
          : t.planId === scope.plan;
    const finished = (s: string) => s === "done" || s === "cancelled";

    const matched = rows.filter(inScope);
    const stopping = matched.filter((t) => !finished(t.state))
      .map((t) => ({ slug: t.slug, state: t.state, holder: t.holder?.agent ?? null }));
    const doomed = new Set(stopping.map((s) => s.slug));
    // Transitive, mirroring src/pipeline.ts. A one-hop count here would have
    // the showcase quietly contradicting the product on the one number the
    // dialog puts under the word STRANDED.
    const alive = rows.filter((t) => !doomed.has(t.slug) && !finished(t.state));
    const strandedBy = new Map<string, string[]>();
    for (let changed = true; changed;) {
      changed = false;
      for (const t of alive) {
        if (strandedBy.has(t.slug)) continue;
        const cause = t.dependsOn.filter((d) => doomed.has(d) || strandedBy.has(d));
        if (cause.length) { strandedBy.set(t.slug, cause); changed = true; }
      }
    }
    const stranding = alive
      .filter((t) => strandedBy.has(t.slug))
      .map((t) => ({ slug: t.slug, dependsOn: strandedBy.get(t.slug)! }));
    const radius = {
      stopping,
      alreadyFinished: matched.filter((t) => finished(t.state)).map((t) => t.slug),
      stranding,
    };
    const label = "slug" in scope ? `'${scope.slug}'` : "phase" in scope ? `phase ${scope.phase}` : `plan '${scope.plan}'`;
    const agentsStopped = stopping.filter((s) => s.holder && (s.state === "active" || s.state === "claimed")).length;
    if (opts.dryRun || !stopping.length) {
      return { ok: true, dryRun: !!opts.dryRun, scope: label, radius, agentsStopped, cancelled: [] };
    }
    // Mutate the fixture so the board visibly changes — nothing is destroyed,
    // exactly as the real thing behaves: the branch stays on the row.
    for (const lane of view.lanes) {
      for (const t of lane.tasks) {
        if (!doomed.has(t.slug)) continue;
        t.state = "cancelled";
        t.holder = null;
        t.blocker = null;
        t.cancelledBy = { actor: "you", at: new Date().toISOString(), ...(opts.reason ? { reason: opts.reason } : {}) };
      }
      lane.done = lane.tasks.filter((x) => finished(x.state)).length;
    }
    view.totals.cancelled += stopping.length;
    view.totals.active = view.lanes.flatMap((l) => l.tasks).filter((x) => x.state === "active").length;
    return { ok: true, dryRun: false, scope: label, radius, agentsStopped, cancelled: [...doomed] };
  }

  /* ---- coordination: signals / reports / blame ---- */
  async getSignals(): Promise<EditSignal[]> {
    if (this.demo) {
      await this.demoGate();
      // mirror the busy scenario's overlap so the section is explorable
      const overlap = this.demoSessions.filter((s) => (s.conflictFiles || []).length);
      const byPath = new Map<string, typeof overlap>();
      overlap.forEach((s) => s.conflictFiles.forEach((f) => { if (!byPath.has(f)) byPath.set(f, []); byPath.get(f)!.push(s); }));
      // A little variety so the "editing right now" panel shows live intent + freshness.
      const DEMO_NOTES: Record<string, string> = {
        "fix-checkout-e2e": "reproducing the flaky Stripe redirect in a test",
        "react-19-upgrade": "migrating class components off legacy context",
        "add-dark-mode": "wiring the theme toggle into the settings store",
      };
      return [...byPath.entries()].map(([path, ss], pi) => ({
        path,
        level: ss.length > 1 ? "warning" as const : "info" as const,
        holders: ss.map((s, hi) => {
          const secsAgo = 20 + pi * 35 + hi * 50; // staggered freshness
          const note = DEMO_NOTES[s.slug];
          return {
            slug: s.slug, agent: s.agent,
            lastEditAt: new Date(Date.now() - secsAgo * 1000).toISOString(),
            ...(note ? { note, noteAt: new Date(Date.now() - secsAgo * 1000).toISOString() } : {}),
          };
        }),
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
  async getDiff(slug: string): Promise<import("../types").DiffResult> {
    if (this.demo) {
      await this.demoGate(120);
      return { files: demoDiff(slug), truncated: false };
    }
    const r = await this.request<{ files: DiffFile[]; truncated?: boolean }>(`/api/tasks/${encodeURIComponent(slug)}/diff`);
    return { files: r.files, truncated: r.truncated === true };
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
  async launchSession({ task, agent, project }: { task: string; agent: AgentId; attach?: boolean; project?: string }): Promise<{ slug: string; agent: AgentId | null }> {
    const created = await this.createTask(task, project);
    return { slug: created.slug, agent };
  }

  /* ---- WRITE: create (real Phase-1 endpoint, or demo store) ---- */
  /** @param project in a multi-repo hub, which sub-project the task targets. */
  async createTask(task: string, project?: string): Promise<Task> {
    // Creating a task makes a git branch and a worktree, so it is a write like
    // any other — this was the only mutator on the client that never said so,
    // which left the button live against a read-only daemon and turned the
    // server's gate into a bare 403 toast.
    this.assertWrite();
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
      body: JSON.stringify(project ? { task: t, project } : { task: t }),
    });
    this.emit(); // trigger an immediate refetch so the new session appears
    return created;
  }

  /* ---- Team: membership + federated claims ---- */

  /**
   * The whole Team screen in one call. `viewer.isOwner` decides what the UI
   * bothers rendering; the SERVER decides what actually happens, independently,
   * on every control below. A hidden button is not a permission check.
   */
  async getTeam(): Promise<TeamState> {
    if (this.demo) {
      await this.demoGate(60);
      // The `empty` scenario doubles as the solo-hub state: nobody has joined,
      // so the screen should point at the invite flow rather than show a table.
      if (this.scenario === "empty") return DEMO_TEAM_SOLO;
      this.demoTeam ??= structuredClone(DEMO_TEAM);
      return this.demoTeam;
    }
    const r = await this.request<TeamState>("/api/members");
    return {
      members: r.members ?? [], teams: r.teams ?? [], claims: r.claims ?? [], overlaps: r.overlaps ?? [],
      ttlMs: r.ttlMs ?? 90_000,
      viewer: r.viewer ?? { local: false, memberId: null, isOwner: false },
    };
  }

  /* ---- Teams (src/teams.ts) --------------------------------------------
     A team groups members and filters this screen. None of these calls
     changes anyone's access, and the server re-checks ownership on every one
     of them regardless of what the UI chose to render. ------------------- */

  async createTeam(name: string, projects: string[] = []): Promise<{ team: Team }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      const state = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const id = slugId(name);
      if (!id) throw new ApiError("BAD_REQUEST", `'${name}' has no usable letters or digits for an id`);
      if (state.teams.some((t) => t.id === id)) throw new ApiError("CONFLICT", `team '${id}' already exists`);
      const team: Team = { id, name: name.trim(), projects, createdAt: new Date().toISOString() };
      state.teams = [...state.teams, team];
      this.emit();
      return { team };
    }
    return this.request<{ team: Team }>("/api/teams", {
      method: "POST", body: JSON.stringify({ name, projects }),
    });
  }

  async updateTeam(id: string, patch: { name?: string; projects?: string[] }): Promise<{ team: Team }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(160);
      const state = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const team = state.teams.find((t) => t.id === id);
      if (!team) throw new ApiError("NOT_FOUND", `no team '${id}'`);
      if (patch.name !== undefined) team.name = patch.name.trim();
      if (patch.projects !== undefined) team.projects = patch.projects;
      this.emit();
      return { team };
    }
    return this.request<{ team: Team }>(`/api/teams/${encodeURIComponent(id)}`, {
      method: "POST", body: JSON.stringify(patch),
    });
  }

  async deleteTeam(id: string): Promise<{ ok: boolean; unassigned: number; note: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(180);
      const state = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      if (!state.teams.some((t) => t.id === id)) throw new ApiError("NOT_FOUND", `no team '${id}'`);
      state.teams = state.teams.filter((t) => t.id !== id);
      let unassigned = 0;
      for (const m of state.members) if (m.team === id) { m.team = null; unassigned++; }
      this.emit();
      return {
        ok: true, unassigned,
        note: unassigned
          ? `${unassigned} member${unassigned === 1 ? "" : "s"} moved to no team. Nobody lost access — a team was only ever a grouping.`
          : "Nobody was in it.",
      };
    }
    return this.request(`/api/teams/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /* ---- daemon fleet (loopback-only; src/daemons.ts) ---- */

  /** Every Baton daemon on this machine, or null when this daemon cannot say
   *  (older daemon, or a remote viewer the endpoint refuses) — null hides the
   *  card, which beats drawing a panel that can only error. */
  async getDaemons(): Promise<FleetDaemon[] | null> {
    if (this.demo) {
      await this.demoGate();
      return structuredClone(this.demoFleet ??= structuredClone(DEMO_FLEET));
    }
    try {
      return (await this.request<{ daemons: FleetDaemon[] }>("/api/daemons")).daemons;
    } catch {
      return null;
    }
  }

  /** Stop ANOTHER daemon (never this one — that is shutdownSelf). The server
   *  re-verifies before acting; a stale record is cleaned, never signalled.
   *  The pid rides along because a port is not a daemon: a crash leftover and
   *  a live daemon can both claim it, and the row the user clicked is a
   *  (pid, port) pair. */
  /** `expect` echoes what the caller's screen showed ("stale" = the Clean-up
   *  dialog promised a file deletion) — the server re-verifies, and refuses
   *  with a 409 rather than stop a daemon that turned out to be alive. */
  async stopFleetDaemon(port: number, pid: number, expect?: "stale" | "live"): Promise<{ ok: boolean; outcome: "graceful" | "signal" | "refused-stale" | "cleaned"; root: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      const fleet = (this.demoFleet ??= structuredClone(DEMO_FLEET));
      const row = fleet.find((d) => d.port === port && d.pid === pid);
      if (!row) throw new ApiError("NOT_FOUND", `no daemon record for port ${port} with pid ${pid}`);
      if (expect === "stale" && row.status === "live") {
        throw new ApiError("CONFLICT", `the record for port ${port} is not a leftover — pid ${pid} is alive and answering`);
      }
      this.demoFleet = fleet.filter((d) => !(d.port === port && d.pid === pid));
      this.emit();
      return { ok: true, outcome: row.status === "stale" ? "cleaned" : "graceful", root: row.root };
    }
    return this.request(`/api/daemons/${port}/stop`, { method: "POST", body: JSON.stringify({ pid, ...(expect ? { expect } : {}) }) });
  }

  /** The bulk twin of clicking Clean up on each stale row: the server buries
   *  every record whose process is provably gone. Deletion only — no probe is
   *  consulted and nothing running is signalled, so `removed` can be smaller
   *  than the stale rows on screen (a stale record whose pid still lives is
   *  kept for the per-row, re-verified stop). */
  async cleanFleet(): Promise<{ ok: boolean; removed: number }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      const fleet = (this.demoFleet ??= structuredClone(DEMO_FLEET));
      const removed = fleet.filter((d) => d.status === "stale").length;
      this.demoFleet = fleet.filter((d) => d.status !== "stale");
      this.emit();
      return { ok: true, removed };
    }
    return this.request("/api/daemons/clean", { method: "POST" });
  }

  /** Stop the daemon serving THIS dashboard. The daemon answers, then exits;
   *  the staleness banner takes the screen over from there. */
  async shutdownSelf(): Promise<{ ok: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(200);
      // The demo has no daemon to stop; the card says so instead of pretending.
      throw new ApiError("BAD_REQUEST", "Demo mode — this dashboard is a preview, there is no daemon behind it to stop.");
    }
    return this.request("/api/shutdown", { method: "POST" });
  }

  /** Move one member. `null` takes them out of every team. */
  async assignMemberTeam(memberId: string, team: string | null): Promise<{ ok: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const state = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      if (team && !state.teams.some((t) => t.id === team)) throw new ApiError("NOT_FOUND", `no team '${team}'`);
      const m = state.members.find((x) => x.id === memberId);
      if (m) m.team = team;
      this.emit();
      return { ok: true };
    }
    return this.request(`/api/members/${encodeURIComponent(memberId)}/team`, {
      method: "POST", body: JSON.stringify({ team }),
    });
  }

  /**
   * Mint an invite. The token comes back exactly once — nothing stores it, so a
   * closed tab means rotating rather than looking it up.
   */
  async inviteMember(name: string, role: MemberRole = "member"): Promise<InviteResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(240);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const id = slugId(name);
      if (!id) throw new ApiError("BAD_REQUEST", `'${name}' has no usable letters or digits for an id`);
      if (team.members.some((m) => m.id === id && !m.revokedAt)) {
        throw new ApiError("CONFLICT", `member '${id}' already exists — revoke them first, or pick another name`);
      }
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      team.members = [...team.members, {
        id, name, role, registered: true, team: null, createdAt: new Date().toISOString(),
        online: false, device: null, sessions: 0, since: null, lastSeen: null,
        claims: 0, warnings: [], expiresAt,
      }];
      this.emit();
      return {
        member: { id, name, role, expiresAt },
        // Recognisably fake: a demo must never hand out something that looks
        // like a live credential someone might actually paste somewhere.
        token: "baton_demo000000000000000000000000000000000000000000000000000000000",
        command: "npx baton join http://mac-mini.local:7077 --token baton_demo…",
        expiresAt,
        note: "This command carries a live credential. Send it over a private channel, and it is shown only once.",
      };
    }
    return this.request<InviteResult>("/api/members", {
      method: "POST", body: JSON.stringify({ name, role }),
    });
  }

  /** Reissue a token, invalidating the previous one. */
  async rotateMember(id: string): Promise<InviteResult> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(220);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const m = team.members.find((x) => x.id === id);
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      if (m) { m.expiresAt = expiresAt; delete m.firstUsedAt; }
      this.emit();
      return {
        member: { id, name: m?.name ?? id, role: m?.role ?? "member", expiresAt },
        token: "baton_demo000000000000000000000000000000000000000000000000000000000",
        command: "npx baton join http://mac-mini.local:7077 --token baton_demo…",
        expiresAt,
        note: "Their previous token stopped working the moment this one was created.",
      };
    }
    return this.request<InviteResult>(`/api/members/${encodeURIComponent(id)}/rotate`, { method: "POST" });
  }

  /**
   * Send a member a notice. Fails when they are not connected — a warning is a
   * live-plane action, and reporting "sent" to an empty room would leave the
   * owner believing the person had been told.
   */
  async warnMember(id: string, message: string): Promise<{ ok: boolean }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const m = team.members.find((x) => x.id === id);
      if (!m?.online) throw new ApiError("CONFLICT", `'${m?.name ?? id}' is not connected — a warning has nowhere to be delivered`);
      m.warnings = [...m.warnings, { id: `w${Date.now()}`, message, from: "you", at: new Date().toISOString() }];
      this.emit();
      return { ok: true };
    }
    return this.request(`/api/members/${encodeURIComponent(id)}/warn`, {
      method: "POST", body: JSON.stringify({ message }),
    });
  }

  /** Drop a member from the live view. Soft: their token still works and they
   *  reconnect on their next heartbeat. */
  async disconnectMember(id: string): Promise<{ ok: boolean; dropped: boolean; note: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(160);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const m = team.members.find((x) => x.id === id);
      const dropped = !!m?.online;
      if (m) { m.online = false; m.sessions = 0; m.claims = 0; m.since = null; }
      team.claims = team.claims.filter((c) => c.memberId !== id);
      team.overlaps = team.overlaps.filter((o) => o.holders.every((h) => h.memberId !== id));
      this.emit();
      return {
        ok: true, dropped,
        note: dropped
          ? "Dropped from the live view. Their token still works — they reconnect on their next heartbeat."
          : "They were not connected.",
      };
    }
    return this.request(`/api/members/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
  }

  /** Revoke a member's token. Refused server-side for the last active owner. */
  async revokeMember(id: string): Promise<{ ok: boolean; note: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(220);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      const m = team.members.find((x) => x.id === id);
      const owners = team.members.filter((x) => x.role === "owner" && !x.revokedAt);
      if (m?.role === "owner" && owners.length === 1) {
        throw new ApiError("CONFLICT", `'${m.id}' is the only owner — promote someone else before revoking them`);
      }
      if (m) { m.revokedAt = new Date().toISOString(); m.online = false; m.claims = 0; m.sessions = 0; }
      team.claims = team.claims.filter((c) => c.memberId !== id);
      team.overlaps = team.overlaps.filter((o) => o.holders.every((h) => h.memberId !== id));
      this.emit();
      return { ok: true, note: "Their token no longer works. Anything they already cloned or synced stays on their machine." };
    }
    return this.request(`/api/members/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  /** Clear one stale claim. Corrects the shared VIEW — if their agent is still
   *  on the file, their next heartbeat re-states it. */
  async releaseClaim(memberId: string, relPath: string, projectId: string | null = null): Promise<{ ok: boolean; note: string }> {
    this.assertWrite();
    if (this.demo) {
      await this.demoGate(140);
      const team = (this.demoTeam ??= structuredClone(DEMO_TEAM));
      team.claims = team.claims.filter((c) => !(c.memberId === memberId && c.relPath === relPath && c.projectId === projectId));
      team.overlaps = team.overlaps.filter((o) => !(o.relPath === relPath && o.projectId === projectId));
      const m = team.members.find((x) => x.id === memberId);
      if (m) m.claims = team.claims.filter((c) => c.memberId === memberId).length;
      this.emit();
      return { ok: true, note: "Cleared from the shared view. If their agent is still editing it, their next heartbeat re-states it." };
    }
    return this.request("/api/claims/release", {
      method: "POST", body: JSON.stringify({ memberId, relPath, projectId }),
    });
  }

  /**
   * Can anyone else reach this hub? Owner-only server-side — it enumerates LAN
   * addresses and installed tooling, which a member has no use for.
   */
  async getReachability(): Promise<Reachability> {
    if (this.demo) {
      await this.demoGate(80);
      return DEMO_REACHABILITY;
    }
    return this.request<Reachability>("/api/reachability");
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
