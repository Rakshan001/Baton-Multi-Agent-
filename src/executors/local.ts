// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The backend Baton has always been: execa for headless runs, tmux for TUIs.
 *
 * This adds no launching ability — `spawn.ts` and `terminals.ts` still do the
 * work. What it adds is an honest account of what those two can and cannot do,
 * so a caller can find out before spawning rather than during.
 */
import { startAgent, stopAgent, hasHeadlessRun, runningHeadless } from '../spawn.js';
import { createTerminal, listTerminals } from '../terminals.js';
import { agentsFor, type AgentDef } from '../agents/registry.js';
import { agentInstalled } from '../agents/roster.js';
import { tmuxSessionExists, killSessionFor } from '../util/tmux.js';
import type { AgentCapability, Executor, LaunchRequest, Observation, RunHandle, RunMode } from './types.js';
import { endpointViaFor } from '../endpoints/reach.js';

/**
 * Sentinels pushed through a launcher's own `args()` to see what it does with
 * them. Probing beats a hardcoded list: `~/.baton/agents.json` can define
 * agents this file has never heard of, and they deserve the same honest answer
 * as the built-ins.
 */
const PROMPT_PROBE = '__baton_prompt_probe__';
const MODEL_PROBE = '__baton_model_probe__';

function launcherUses(def: AgentDef, mode: RunMode, probe: string, prompt: string, model: string): boolean {
  const launcher = mode === 'headless' ? def.headless : def.interactive;
  if (!launcher) return false;
  try {
    return launcher.args(prompt, model).some((a) => a.includes(probe));
  } catch {
    // A launcher that throws on a probe is one we cannot characterize; claiming
    // support we haven't observed is exactly the guess this file avoids.
    return false;
  }
}

function modesOf(def: AgentDef): RunMode[] {
  const modes: RunMode[] = [];
  if (def.headless) modes.push('headless');
  if (def.interactive) modes.push('interactive');
  return modes;
}

export interface LocalExecutorDeps {
  /** Injected so capability probing doesn't fork a `--version` per agent in tests. */
  isInstalled?: (agentId: string, root: string) => Promise<boolean>;
}

export class LocalExecutor implements Executor {
  readonly id = 'local' as const;

  constructor(private readonly deps: LocalExecutorDeps = {}) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true }; // in-process; nothing to reach
  }

  async capabilities(root: string): Promise<Map<string, AgentCapability>> {
    const isInstalled = this.deps.isInstalled ?? ((id: string, r: string) => agentInstalled(id, r));
    const defs = agentsFor(root);
    const out = new Map<string, AgentCapability>();

    await Promise.all(Object.values(defs).map(async (def) => {
      const modes = modesOf(def);
      // Characterize against the mode we would actually use.
      const probeMode: RunMode = modes.includes('headless') ? 'headless' : 'interactive';
      out.set(def.id, {
        agentId: def.id,
        nativeId: def.id, // local runs Baton's own registry — no translation
        modes,
        supportsModel: launcherUses(def, probeMode, MODEL_PROBE, PROMPT_PROBE, MODEL_PROBE),
        acceptsPromptAtLaunch: launcherUses(def, probeMode, PROMPT_PROBE, PROMPT_PROBE, MODEL_PROBE),
        installed: await isInstalled(def.id, root),
        endpointVia: endpointViaFor(def.id),
      });
    }));

    return out;
  }

  async launch(req: LaunchRequest): Promise<RunHandle> {
    const root = req.env.BATON_ROOT;
    const base = {
      executor: this.id, slug: req.slug, agentId: req.agentId, model: req.model,
      startedAt: new Date().toISOString(), root,
    };
    if (req.mode === 'headless') {
      const res = await startAgent(req.slug, { agent: req.agentId, model: req.model, prompt: req.prompt }, root);
      // The resolved agent and model, not the requested ones: `baton start` with
      // no --agent picks a default in here, and printing the request instead of
      // the result would make that line a guess (P2-E5).
      return {
        ...base,
        agentId: res.agent,
        model: res.model,
        mode: 'headless',
        ref: `pid:${res.pid ?? 0}`,
        pid: res.pid ?? null,
        promptSource: res.promptSource,
      };
    }
    const term = await createTerminal(req.slug, { agent: req.agentId, model: req.model, prompt: req.prompt }, root);
    return { ...base, mode: 'interactive', ref: `tmux:${term.sessionName}` };
  }

  /**
   * Liveness only. Headless output already streams onto the bus as it happens,
   * and a tmux TUI's scrollback belongs to whoever is attached — neither is
   * something to re-deliver here.
   */
  async observe(h: RunHandle): Promise<Observation> {
    return { state: (await this.isLive(h)) ? 'running' : 'exited', lines: [] };
  }

  async stop(h: RunHandle): Promise<boolean> {
    if (h.mode === 'headless') return stopAgent(h.slug);
    await killSessionFor(h.root, h.slug).catch(() => undefined);
    return true;
  }

  /**
   * Headless runs live in an in-process Map, so a daemon restart loses them and
   * `null` is the honest answer. tmux sessions outlive the daemon by design —
   * that asymmetry is real, and hiding it would make a restart look lossless.
   */
  async reattach(h: RunHandle): Promise<RunHandle | null> {
    return (await this.isLive(h)) ? h : null;
  }

  private async isLive(h: RunHandle): Promise<boolean> {
    if (h.mode === 'headless') return hasHeadlessRun(h.slug);
    return tmuxSessionExists(h.root, h.slug).catch(() => false);
  }
}

/**
 * Runs this backend currently owns, for concurrency accounting.
 *
 * Both modes, and that is the whole point: the dispatcher gates on this number,
 * and counting only terminals would let every headless agent past
 * `maxConcurrent` — a limit that held for TUIs and silently did not exist for
 * the mode the dispatcher actually uses.
 */
export function localRunCount(): number {
  return listTerminals().length + runningHeadless().length;
}
