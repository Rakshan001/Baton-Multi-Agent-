// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2-E2 — which backend starts an agent.
 *
 * `auto` may choose Orca only when all three are true: the binary resolves, the
 * daemon answers, and the daemon actually serves THIS repo. Two of three is not
 * close enough. An Orca that is running but has never opened this repo cannot
 * launch anything in its worktree, and discovering that at spawn time produces
 * the worst outcome available: a task that reports started and did nothing.
 *
 * Every answer carries `why`, because a dispatcher that quietly used a different
 * backend than the config asked for is a debugging session nobody can begin.
 *
 * The probe is injected. The commands it runs (`orca status --json`,
 * `orca repo list --json`) are Orca's published CLI contract — see
 * ORCA-CLI-CONTRACT.md in the orcabaton repo — and keeping them behind an
 * interface is what lets this be tested without an Orca on the machine.
 */
import { resolve } from 'node:path';

export interface OrcaProbe {
  /** Absolute path, or null when the binary is not on PATH. */
  resolveBin(bin: string): Promise<string | null>;
  /** Whether a daemon answers. `reason` is surfaced verbatim. */
  status(bin: string): Promise<{ ok: boolean; reason?: string }>;
  /** Repo roots Orca serves, or null when the list could not be read. */
  repos(bin: string): Promise<string[] | null>;
}

export interface ExecutorChoice {
  /** Never `auto`: auto is a question, and this is the answer. */
  backend: 'local' | 'orca';
  why: string;
  /** Set when the config named a backend that could not be used. */
  degradedFrom?: 'orca';
}

/** Long enough that a dispatch loop does not shell out per task; short enough
 *  that starting Orca is noticed within one coffee-length pause. */
export const EXECUTOR_CHOICE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; choice: ExecutorChoice }>();

export function resetExecutorChoiceCache(): void {
  cache.clear();
}

/** Trailing slashes and `..` segments are not a different repo. win32 case is. */
function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function probeOrca(root: string, bin: string, probe: OrcaProbe): Promise<ExecutorChoice> {
  const resolved = await probe.resolveBin(bin);
  if (resolved === null) {
    return { backend: 'local', why: `orca is not on PATH (looked for ${bin})` };
  }
  const status = await probe.status(resolved);
  if (!status.ok) {
    // P2-E2. An installed CLI is not a running daemon.
    return { backend: 'local', why: `orca is installed but not answering: ${status.reason ?? 'no reason given'}` };
  }
  const repos = await probe.repos(resolved);
  if (repos === null) {
    // "Could not ask" is not "does not serve it". An empty list would be a claim
    // the failed call cannot support.
    return { backend: 'local', why: 'could not read the repo list from orca' };
  }
  if (!repos.some((candidate) => samePath(candidate, root))) {
    return { backend: 'local', why: `orca is running but does not have this repo open (${root})` };
  }
  return { backend: 'orca', why: 'orca is running and has this repo open' };
}

export async function resolveExecutor(
  root: string,
  config: { backend: 'auto' | 'local' | 'orca'; orca: { bin: string } },
  probe: OrcaProbe,
  now: () => number = Date.now,
): Promise<ExecutorChoice> {
  if (config.backend === 'local') {
    // Nothing to probe: shelling out to check a backend nobody asked for is
    // latency on the dispatch path for an answer that cannot change anything.
    return { backend: 'local', why: 'configured backend is local' };
  }

  const key = `${resolve(root)}\n${config.orca.bin}\n${config.backend}`;
  const hit = cache.get(key);
  const at = now();
  if (hit && at - hit.at < EXECUTOR_CHOICE_TTL_MS) {
    return hit.choice;
  }

  let choice: ExecutorChoice;
  try {
    choice = await probeOrca(root, config.orca.bin, probe);
  } catch (error) {
    // This runs on the dispatch path; a rejection here stops dispatch entirely.
    choice = { backend: 'local', why: `probing orca failed: ${(error as Error).message}` };
  }

  if (config.backend === 'orca' && choice.backend === 'local') {
    // Recorded, not silent. It is safe to degrade because the capability layer
    // still refuses any agent only Orca could have launched, so the consequence
    // surfaces where a person can act on it.
    choice = { ...choice, degradedFrom: 'orca' };
  }

  cache.set(key, { at, choice });
  return choice;
}
