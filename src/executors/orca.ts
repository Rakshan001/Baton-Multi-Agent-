// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Launching agents through the `orca` CLI.
 *
 * Baton can start three agents headlessly and a couple more through tmux; Orca
 * knows how to start thirty. This is the seam that lets a plan say
 * `@antigravity` and have it mean something — and it is the whole reason P4
 * exists, because `agents/registry.ts` refuses to guess spawn args rather than
 * ship a wrong one.
 *
 * Baton still owns the git checkout. Orca only runs a process inside a worktree
 * Baton built, addressed by absolute path.
 *
 * Every argv and every envelope is decided in `orca-cli.ts`, which is pure. The
 * only thing here is process execution and the order of it.
 */
import { execa } from 'execa';
import { detectSecret } from '../memory.js';
import { orcaCapabilities, ORCA_MODEL_AGENTS } from './orca-agents.js';
import {
  orcaBinary, orcaEnv, parseOrcaEnvelope, repoListArgs, statusArgs,
  terminalCloseArgs, terminalCreateArgs, terminalReadArgs, terminalSendArgs,
  terminalShowArgs, terminalWaitArgs, type OrcaEnvelope,
} from './orca-cli.js';
import type {
  AgentCapability, Executor, LaunchRequest, Observation, RunHandle,
} from './types.js';

/** Long enough for a cold TUI on a slow machine; short enough that a wedged
 *  launch is a refusal rather than a hang the operator has to notice. */
const TUI_IDLE_TIMEOUT_MS = 60_000;
/** A CLI call that has not answered by now is not going to. */
const EXEC_TIMEOUT_MS = 90_000;

export class OrcaRefused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrcaRefused';
    this.code = code;
  }
}

export interface OrcaExecutorDeps {
  /** Overridden in tests to point at the scripted fixture. */
  bin?: string;
  /** Argv placed before the subcommand — how the fixture is invoked via node. */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

const MODEL_AGENTS = new Set(ORCA_MODEL_AGENTS);

export class OrcaExecutor implements Executor {
  readonly id = 'orca' as const;

  constructor(private readonly deps: OrcaExecutorDeps = {}) {}

  private async run(args: string[]): Promise<OrcaEnvelope> {
    const bin = this.deps.bin ?? orcaBinary(this.deps.env);
    try {
      const { stdout } = await execa(bin, [...(this.deps.prefixArgs ?? []), ...args], {
        // The fence, on every call without exception. A daemon started from an
        // Orca terminal inherits its attestation variables, and Orca would then
        // treat the dispatcher's calls as coming from that terminal.
        env: orcaEnv(this.deps.env),
        extendEnv: false,
        timeout: EXEC_TIMEOUT_MS,
        reject: false,
      });
      return parseOrcaEnvelope(stdout);
    } catch (e) {
      // ENOENT and friends: `available()` reports this as a reason; a launch
      // turns it into a refusal. Either way it is never a silent success.
      return { ok: false, code: 'orca_unreachable', message: (e as Error).message };
    }
  }

  private async expect(args: string[]): Promise<unknown> {
    const out = await this.run(args);
    if (!out.ok) throw new OrcaRefused(out.code, out.message);
    return out.result;
  }

  async available(): Promise<{ ok: boolean; reason?: string; version?: string }> {
    const out = await this.run(statusArgs());
    if (!out.ok) return { ok: false, reason: out.message };
    const version = (out.result as { version?: unknown } | null)?.version;
    return { ok: true, ...(typeof version === 'string' ? { version } : {}) };
  }

  /**
   * The snapshot, not a live query.
   *
   * Asking Orca per agent costs a round trip on the dispatch path for an answer
   * that changes only when Orca is upgraded — and `baton doctor` is where drift
   * belongs (P4-E5).
   */
  async capabilities(): Promise<Map<string, AgentCapability>> {
    return orcaCapabilities();
  }

  /**
   * Is this repo registered with Orca?
   *
   * `path:` resolves against the worktrees Orca has scanned, and it only scans
   * repos it knows. Asking `repo list` first turns P4-E1 from a confusing
   * `selector_not_found` after a terminal already exists into a refusal that
   * names the one command that fixes it — and leaves nothing behind.
   */
  private async repoRegistered(cwd: string): Promise<boolean> {
    const out = await this.run(repoListArgs());
    if (!out.ok) return false;
    const repos = Array.isArray(out.result) ? out.result : [];
    return repos.some((repo) => {
      const path = (repo as { path?: unknown } | null)?.path;
      return typeof path === 'string' && path.length > 0 && isInside(cwd, path);
    });
  }

  async launch(req: LaunchRequest): Promise<RunHandle> {
    if (req.model && !MODEL_AGENTS.has(req.agentId)) {
      // Loud, never a silent drop: running a different model than the plan asked
      // for spends the user's money on a choice they did not make.
      throw new OrcaRefused(
        'no-model',
        `Orca cannot start '${req.agentId}' with a specific model, and dropping '${req.model}' would run something the plan did not ask for. Remove the model, or assign an agent that supports one (${ORCA_MODEL_AGENTS.join(', ')}).`,
      );
    }

    if (!(await this.repoRegistered(req.cwd))) {
      throw new OrcaRefused(
        'selector_not_found',
        `Orca does not have this repo registered, so it cannot resolve ${req.cwd}. Register it once with \`orca repo add <repo>\` and dispatch again.`,
      );
    }

    const created = await this.createTerminal(req);
    const handle = handleOf(created);
    if (!handle) {
      throw new OrcaRefused('orca_error', 'orca created a terminal but returned no handle to address it by.');
    }

    // P4-E4. A pointer typed into a TUI that is still starting lands in the
    // wrong buffer, or nowhere — and the agent then sits at a prompt having
    // read nothing while the board says it is working.
    const waited = await this.run(terminalWaitArgs(handle, TUI_IDLE_TIMEOUT_MS));
    if (!waited.ok) {
      // Close it. A TUI left open in the user's window, attached to a task whose
      // claim is about to be released, is the visible half of "looks busy and
      // isn't".
      await this.run(terminalCloseArgs(handle));
      throw new OrcaRefused(
        'not-idle',
        `'${req.agentId}' did not become ready within ${TUI_IDLE_TIMEOUT_MS / 1000}s (${waited.message}). Nothing was sent to it and the terminal was closed.`,
      );
    }

    await this.expect(terminalSendArgs(handle, req.prompt));

    return {
      executor: 'orca',
      slug: req.slug,
      agentId: req.agentId,
      ...(req.model ? { model: req.model } : {}),
      ref: `orca:${handle}`,
      mode: req.mode,
      startedAt: new Date().toISOString(),
      // Orca owns the process; Baton never sees a pid. `null` rather than 0,
      // which is a pid that never exists.
      pid: null,
      promptSource: 'handoff',
      root: req.env.BATON_ROOT ?? '',
    };
  }

  private async createTerminal(req: LaunchRequest): Promise<unknown> {
    const command = req.model ? `${req.nativeId} --model ${req.model}` : req.nativeId;
    const out = await this.run(terminalCreateArgs({ cwd: req.cwd, command, slug: req.slug }));
    if (out.ok) return out.result;
    if (out.code === 'selector_not_found') {
      // The registration check above should have caught this; reaching here
      // means the repo is registered but this worktree is not scanned yet.
      throw new OrcaRefused(
        'selector_not_found',
        `Orca could not resolve ${req.cwd}. The repo is registered but this worktree is not in its list yet — open the repo in Orca once, or re-add it with \`orca repo add\`.`,
      );
    }
    throw new OrcaRefused(out.code, out.message);
  }

  async observe(h: RunHandle, cursor?: string): Promise<Observation> {
    const out = await this.run(terminalReadArgs(refOf(h), cursor));
    if (!out.ok) {
      // `unknown` is a real answer. Reporting `idle` for a read that failed
      // would be an invented observation of a process nobody looked at.
      return { state: 'unknown', lines: [] };
    }
    const result = out.result as { lines?: unknown; nextCursor?: unknown } | null;
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    return {
      state: 'running',
      // P4-E7. An Orca-side agent echoing a `.env` is the same problem as a
      // local one, and this output reaches the same bus and the same
      // `/api/agents/running` any member of a --host daemon can read.
      lines: lines.filter((l): l is string => typeof l === 'string').map(redact),
      ...(typeof result?.nextCursor === 'string' ? { cursor: result.nextCursor } : {}),
    };
  }

  async stop(h: RunHandle): Promise<boolean> {
    return (await this.run(terminalCloseArgs(refOf(h)))).ok;
  }

  /**
   * P4-E2 — after an Orca restart the handle is meaningless.
   *
   * `null` means the run is lost. Anything else would leave a task looking
   * worked-on with nothing behind it, which is the one state the whole dispatch
   * design is built to avoid. "Could not ask" lands here too: the difference
   * between gone and unreachable belongs in a message, not in a fabricated
   * claim that it is still running.
   */
  async reattach(h: RunHandle): Promise<RunHandle | null> {
    return (await this.run(terminalShowArgs(refOf(h)))).ok ? h : null;
  }
}

/** Same rule as `spawn.ts:redactLine`, over the same detector. */
function redact(line: string): string {
  const what = detectSecret(line);
  return what ? `[redacted: ${what}]` : line;
}

function handleOf(result: unknown): string | null {
  const handle = (result as { handle?: unknown } | null)?.handle;
  return typeof handle === 'string' && handle.length > 0 ? handle : null;
}

function refOf(h: RunHandle): string {
  return h.ref.startsWith('orca:') ? h.ref.slice(5) : h.ref;
}

/** Is `cwd` the repo itself, or a path beneath it? A Baton worktree lives at
 *  `<repo>/.baton/wt/<slug>`, so the repo's own path is a prefix. */
function isInside(cwd: string, repoPath: string): boolean {
  const normal = (p: string): string => p.replace(/[\\/]+$/, '');
  const left = normal(process.platform === 'win32' ? cwd.toLowerCase() : cwd);
  const right = normal(process.platform === 'win32' ? repoPath.toLowerCase() : repoPath);
  return left === right || left.startsWith(`${right}/`) || left.startsWith(`${right}\\`);
}
