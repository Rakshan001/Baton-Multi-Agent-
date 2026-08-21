// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What it takes to run an agent, independent of who runs it.
 *
 * Baton can launch three agents headlessly (claude, codex, gemini) and a couple
 * more through tmux. It cannot launch Cursor headlessly and cannot launch
 * Antigravity at all — `agents/registry.ts` refuses to guess spawn args rather
 * than ship a wrong one. Orca knows how to launch 36, including both of those.
 *
 * So there are two ways to start an agent, and the dispatcher should not care
 * which is in play. This is the seam: four verbs, and a capability map honest
 * enough that the dispatcher can refuse *before* spawning instead of
 * discovering mid-launch that the agent it promised cannot run.
 */

/** Who actually starts the process. */
export type ExecutorId = 'local' | 'orca';

/**
 * `headless` streams output onto the bus and exits; `interactive` is a TUI a
 * human can also type into. They are not interchangeable: only headless output
 * is observable, and only interactive survives without a supervising daemon.
 */
export type RunMode = 'headless' | 'interactive';

export interface AgentCapability {
  /** Baton's id, as it appears in a plan's `@agent` and in routing config. */
  agentId: string;
  /** The backend's own id. Not always the same string — Orca's `cursor` runs a binary called `cursor-agent`. */
  nativeId: string;
  /** Empty means "known, but this backend cannot start it" — a real, representable state. */
  modes: RunMode[];
  /** Whether a model can be selected at launch. Orca honours it for claude/codex/cursor/gemini only. */
  supportsModel: boolean;
  /**
   * Whether the launcher actually delivers the prompt. False for aider and
   * opencode, whose launchers take a prompt argument and use only the model —
   * launching one of those without knowing starts an agent with no task. Where
   * this is false the prompt has to be sent after the TUI settles instead.
   */
  acceptsPromptAtLaunch: boolean;
  /** `'unknown'` where a backend cannot cheaply probe; treated as installed rather than blocking a launch on a guess. */
  installed: boolean | 'unknown';
}

export interface LaunchRequest {
  slug: string;
  agentId: string;
  model?: string;
  /** Always a Baton worktree. Baton owns the git checkout; a backend only runs a process inside it. */
  cwd: string;
  /** Short pointer to HANDOFF.md, never the plan prose — see handoff/untrusted.ts. */
  prompt: string;
  /** BATON_ROOT / BATON_SLUG / BATON_TASK / BATON_AGENT. */
  env: Record<string, string>;
  title?: string;
  mode: RunMode;
  /** The backend's id for this agent, resolved by `resolveLaunch`. */
  nativeId: string;
}

/** Enough to find a run again after the daemon restarts. Persisted verbatim. */
export interface RunHandle {
  executor: ExecutorId;
  slug: string;
  agentId: string;
  model?: string;
  /** Backend-specific: `pid:<n>` / `tmux:<name>` for local, a terminal handle for orca. */
  ref: string;
  mode: RunMode;
  startedAt: string;
  /**
   * The Baton root this run belongs to. Carried on the handle rather than
   * re-derived, because a handle is read back from disk after a daemon restart,
   * when the process cwd says nothing about where the run came from.
   */
  root: string;
}

/**
 * `unknown` is a first-class answer, not a failure: an adopted run from a
 * crashed daemon is genuinely of unknown state, and saying so beats inventing
 * `running`.
 */
export type RunState = 'starting' | 'running' | 'idle' | 'exited' | 'unknown';

export interface Observation {
  state: RunState;
  lines: string[];
  /** Opaque resume token, persisted so a restart doesn't replay the whole buffer. */
  cursor?: string;
}

export interface Executor {
  id: ExecutorId;
  /** Cheap enough to call on every dispatch; `reason` is printable when not ok. */
  available(): Promise<{ ok: boolean; reason?: string; version?: string }>;
  capabilities(root: string): Promise<Map<string, AgentCapability>>;
  launch(req: LaunchRequest): Promise<RunHandle>;
  observe(h: RunHandle, cursor?: string): Promise<Observation>;
  stop(h: RunHandle): Promise<boolean>;
  /** `null` means the run is gone. Local headless runs die with the daemon; tmux and Orca handles do not. */
  reattach(h: RunHandle): Promise<RunHandle | null>;
}
