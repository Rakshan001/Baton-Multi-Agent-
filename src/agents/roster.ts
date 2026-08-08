// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The agent roster behind GET /api/agents: for every agent Baton knows, is it
 * installed on this machine, can Baton drive it (headless/interactive), is its
 * MCP config wired, and what is it doing right now (process scan + headless
 * runs + interactive terminals unified into one live-session list).
 *
 * This is the single source the dashboard's Agents screen renders — no static
 * "all six always look available" guessing.
 */
import { probeBinary } from '../util/exec.js';
import { collectStatus } from '../board.js';
import { runningHeadless } from '../spawn.js';
import { listTerminals } from '../terminals.js';
import { agentsFor } from './registry.js';
import { readMcpStatus, type McpStatus } from './connect.js';

export type LiveKind = 'process' | 'headless' | 'terminal';

export interface LiveSession {
  slug: string;
  kind: LiveKind;
}

export interface AgentRosterEntry {
  id: string;
  label: string;
  binary: string;
  installed: boolean;
  headless: boolean;
  interactive: boolean;
  mcp: McpStatus;
  live: LiveSession[];
  /** installed, nothing running */
  idle: boolean;
  /** Defined by this repo's `.baton/agents.json` rather than by the person
   *  running Baton — surfaced so a repo-supplied entry can never pass for a
   *  built-in in a list you launch from. */
  fromProject?: true;
}

// probeBinary spawns a process per agent; cache so /api/agents stays poll-cheap.
const INSTALL_TTL_MS = 30_000;
const installCache = new Map<string, { at: number; val: boolean }>();

async function isInstalled(binary: string, now: number): Promise<boolean> {
  const hit = installCache.get(binary);
  if (hit && now - hit.at < INSTALL_TTL_MS) return hit.val;
  const val = await probeBinary(binary);
  installCache.set(binary, { at: now, val });
  return val;
}

/**
 * Is an agent's CLI installed? Cached (30s TTL) and shared with the roster, so
 * the hot routing/handoff path doesn't fork a `<cli> --version` per resolve.
 * `root` brings the project's `.baton/agents.json` layer in — a routing chain
 * may legitimately name a project agent whose binary differs from its id.
 * Unknown ids fall back to probing the id as a binary name.
 */
export function agentInstalled(agentId: string, root?: string, now = Date.now()): Promise<boolean> {
  return isInstalled(agentsFor(root)[agentId]?.binary ?? agentId, now);
}

/** Test seam — clear the install probe cache. */
export function clearInstallCache(): void {
  installCache.clear();
}

export async function collectAgents(root: string, now = Date.now()): Promise<AgentRosterEntry[]> {
  const rows = await collectStatus(root);
  const headless = runningHeadless();
  const terminals = listTerminals();

  return Promise.all(
    // agentsFor, not the module registry: a project's `.baton/agents.json`
    // agent must get a roster row — it is launchable and connectable, and its
    // live sessions would otherwise be silently dropped from everyone's list.
    Object.values(agentsFor(root)).map(async (def): Promise<AgentRosterEntry> => {
      const [installed, mcp] = await Promise.all([
        isInstalled(def.binary, now),
        readMcpStatus(def.id, root),
      ]);
      const live: LiveSession[] = [];
      for (const r of rows) if (r.agent === def.id) live.push({ slug: r.slug, kind: 'process' });
      for (const h of headless) if (h.agent === def.id && !live.some((l) => l.slug === h.slug)) live.push({ slug: h.slug, kind: 'headless' });
      for (const t of terminals) if (t.agent === def.id && !live.some((l) => l.slug === t.slug)) live.push({ slug: t.slug, kind: 'terminal' });
      return {
        id: def.id,
        label: def.label,
        binary: def.binary,
        installed,
        headless: !!def.headless,
        interactive: !!def.interactive,
        mcp,
        live,
        idle: installed && live.length === 0,
        ...(def.fromProject ? { fromProject: true as const } : {}),
      };
    }),
  );
}
