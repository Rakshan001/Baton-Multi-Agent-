/**
 * One-by-one MCP wiring for each agent CLI: detect whether an agent's MCP
 * config already points at Baton, and (on request) write it.
 *
 * Scope rules (decided with the user): project-level config files live inside
 * the repo and are safe to write automatically; global files in $HOME are
 * only written after an explicit confirm (the caller passes confirmGlobal).
 *
 * Supported wiring:
 *   claude      → <repo>/.mcp.json                 (project, JSON)
 *   cursor      → <repo>/.cursor/mcp.json          (project, JSON)
 *   antigravity → <repo>/.agents/mcp_config.json   (project, JSON)
 *   gemini      → ~/.gemini/settings.json          (global,  JSON)
 *   codex       → ~/.codex/config.toml             (global,  TOML)
 *   aider, opencode → no standard MCP config  (unsupported — surfaced as such)
 *
 * Writes are non-destructive: JSON files keep every existing key and merge our
 * servers into `mcpServers`; the TOML file only gets server blocks it lacks.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KbState } from '../kb/state.js';
import { mcpServers, mcpServersAntigravity, mcpServersCodex, mcpServersGemini, type McpOpts, type McpServerDef } from '../kb/mcp.js';
import { escapeRegExp } from '../util/regex.js';

export type McpScope = 'project' | 'global';

export interface AgentMcpTarget {
  agent: string;
  scope: McpScope;
  format: 'json' | 'toml';
  path: string;
}

export interface McpStatus {
  agent: string;
  /** false for agents with no MCP config Baton knows how to write (aider, opencode). */
  supported: boolean;
  scope: McpScope | null;
  path: string | null;
  /** config file present on disk */
  exists: boolean;
  /** the `baton` coordination server is already wired in that file */
  connected: boolean;
}

export interface ConnectResult {
  agent: string;
  scope: McpScope;
  path: string;
  /** true → file written; false → global write needs confirmation (see preview) */
  wrote: boolean;
  needsConfirm: boolean;
  /** server names that are now (or would be) wired */
  servers: string[];
  /** full proposed file content when needsConfirm (so the UI can show it) */
  preview?: string;
}

export class McpUnsupportedError extends Error {
  constructor(agent: string) {
    super(`'${agent}' has no MCP config Baton can wire automatically`);
    this.name = 'McpUnsupportedError';
  }
}

/** The existing config file is present but unparseable — we refuse to overwrite it. */
export class McpConfigParseError extends Error {
  constructor(path: string) {
    super(`${path} exists but isn't valid JSON — fix it by hand first, then connect (Baton won't overwrite a file it can't parse)`);
    this.name = 'McpConfigParseError';
  }
}

/** Where an agent's MCP config lives, or null if Baton can't wire it. */
export function mcpTargetFor(agent: string, root: string, home = homedir()): AgentMcpTarget | null {
  switch (agent) {
    case 'claude':
      return { agent, scope: 'project', format: 'json', path: join(root, '.mcp.json') };
    case 'cursor':
      return { agent, scope: 'project', format: 'json', path: join(root, '.cursor', 'mcp.json') };
    // Antigravity reads a project file at .agents/mcp_config.json and a global
    // one at ~/.gemini/config/mcp_config.json. Project-scoped is the safe half
    // (inside the repo, no confirm needed) and is what the IDE prefers.
    case 'antigravity':
      return { agent, scope: 'project', format: 'json', path: join(root, '.agents', 'mcp_config.json') };
    case 'gemini':
      return { agent, scope: 'global', format: 'json', path: join(home, '.gemini', 'settings.json') };
    case 'codex':
      return { agent, scope: 'global', format: 'toml', path: join(home, '.codex', 'config.toml') };
    default:
      return null; // aider, opencode — no standard MCP config file to write
  }
}

/** The servers Baton wires: graphify graphs (when the KB exists) + the coordination server. */
export function serversForState(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServers(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Gemini variant of serversForState: graphify entries use httpUrl form. */
export function serversForStateGemini(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersGemini(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Codex variant: graphify entries use `baton mcp-bridge <url>` (command+args only). */
export function serversForStateCodex(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersCodex(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Antigravity variant: bridged graphify entries — see mcpServersAntigravity for why. */
export function serversForStateAntigravity(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersAntigravity(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Agents whose graphify entries need a non-default shape; everything else
 *  gets serversForState (the `{type:'http', url}` form Claude/Cursor take). */
const SERVERS_FOR_AGENT: Record<string, (s: KbState | null, o?: McpOpts) => Record<string, McpServerDef>> = {
  gemini: serversForStateGemini,
  codex: serversForStateCodex,
  antigravity: serversForStateAntigravity,
};

/* ------------------------------------------------------------------ */
/* Pure render/merge helpers (unit-tested)                             */
/* ------------------------------------------------------------------ */

/** Matches a TOML `[mcp_servers.<name>]` table in either quoted or bare-key form. */
function tomlTableRe(name: string): RegExp {
  const q = escapeRegExp(name);
  return new RegExp(`\\[mcp_servers\\.(?:"${q}"|${q})\\]`);
}

/** TOML basic-string with `"` and `\` escaped (raw concatenation would emit invalid TOML). */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Does this config text already wire the `baton` server? */
export function isConnected(format: 'json' | 'toml', text: string): boolean {
  if (format === 'toml') return tomlTableRe('baton').test(text);
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return !!parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'baton');
  } catch {
    return false;
  }
}

/**
 * Merge our servers into an existing JSON config string, preserving all other
 * keys. Throws McpConfigParseError if the file is non-empty but unparseable —
 * the caller must NOT overwrite a config it can't understand (data loss).
 */
export function mergeJsonConfig(existing: string, servers: Record<string, McpServerDef>, path = 'the config file'): string {
  let obj: Record<string, unknown> = {};
  if (existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new McpConfigParseError(path);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    else throw new McpConfigParseError(path); // a JSON array/scalar is not a config object — refuse rather than clobber
  }
  const prior = (obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : {}) as Record<string, unknown>;
  obj.mcpServers = { ...prior, ...servers };
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Append any missing `[mcp_servers."name"]` blocks to a TOML config string.
 * Recognises both quoted and bare-key existing tables (so we never duplicate a
 * server the user wired as `[mcp_servers.baton]`), and escapes all values.
 */
export function mergeTomlConfig(existing: string, servers: Record<string, McpServerDef>): string {
  const blocks: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (tomlTableRe(name).test(existing)) continue;
    let block: string[];
    if ('httpUrl' in def) {
      block = [`[mcp_servers.${tomlStr(name)}]`, `httpUrl = ${tomlStr(def.httpUrl)}`, ''];
    } else if ('url' in def) {
      block = [`[mcp_servers.${tomlStr(name)}]`, `url = ${tomlStr(def.url)}`, ''];
    } else {
      block = [`[mcp_servers.${tomlStr(name)}]`, `command = ${tomlStr(def.command)}`,
               `args = [${def.args.map(tomlStr).join(', ')}]`, ''];
    }
    blocks.push(...block);
  }
  if (!blocks.length) return existing.endsWith('\n') || !existing ? existing : existing + '\n';
  const base = existing.trim() ? existing.replace(/\n*$/, '\n\n') : '';
  return base + blocks.join('\n').trimEnd() + '\n';
}

/* ------------------------------------------------------------------ */
/* Status + write                                                      */
/* ------------------------------------------------------------------ */

export async function readMcpStatus(agent: string, root: string, home = homedir()): Promise<McpStatus> {
  const target = mcpTargetFor(agent, root, home);
  if (!target) return { agent, supported: false, scope: null, path: null, exists: false, connected: false };
  const exists = existsSync(target.path);
  let connected = false;
  if (exists) {
    try {
      connected = isConnected(target.format, await readFile(target.path, 'utf-8'));
    } catch {
      connected = false;
    }
  }
  return { agent, supported: true, scope: target.scope, path: target.path, exists, connected };
}

export async function connectAgentMcp(
  agent: string,
  root: string,
  state: KbState | null,
  opts: { confirmGlobal?: boolean; mcpOpts?: McpOpts } = {},
  home = homedir(),
): Promise<ConnectResult> {
  const target = mcpTargetFor(agent, root, home);
  if (!target) throw new McpUnsupportedError(agent);
  const servers = SERVERS_FOR_AGENT[agent] ? SERVERS_FOR_AGENT[agent](state, opts.mcpOpts) : serversForState(state, opts.mcpOpts);
  const serverNames = Object.keys(servers);

  const existing = existsSync(target.path) ? await readFile(target.path, 'utf-8') : '';
  const next = target.format === 'json'
    ? mergeJsonConfig(existing, servers, target.path)
    : mergeTomlConfig(existing, servers);

  // Global files live outside the repo — never touch them without a confirm.
  if (target.scope === 'global' && !opts.confirmGlobal) {
    return { agent, scope: target.scope, path: target.path, wrote: false, needsConfirm: true, servers: serverNames, preview: next };
  }

  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, next, 'utf-8');
  return { agent, scope: target.scope, path: target.path, wrote: true, needsConfirm: false, servers: serverNames };
}

export type AgentConnectStatus =
  | 'connected'      // written just now
  | 'already'        // the baton server was already wired
  | 'needs-confirm'  // a global ($HOME) file — rerun with confirmGlobal
  | 'unsupported'    // aider/opencode — no standard MCP config
  | 'parse-error';   // existing file is unparseable — left untouched

export interface AgentConnectOutcome {
  agent: string;
  status: AgentConnectStatus;
  scope: McpScope | null;
  path: string | null;
}

/**
 * Wire a batch of agents to the `baton` coordination MCP server in one call —
 * the one-command "every agent can now see the others" step. Passes state=null
 * so it writes the stdio `baton mcp` server (no running daemon required); an
 * existing graphify KB config is merged, never clobbered. Never throws: each
 * agent's outcome (including unsupported / parse-error) is returned so the
 * caller can report the whole batch.
 */
export async function connectAgents(
  root: string,
  agents: string[],
  opts: { confirmGlobal?: boolean } = {},
  home = homedir(),
): Promise<AgentConnectOutcome[]> {
  const out: AgentConnectOutcome[] = [];
  for (const agent of agents) {
    const target = mcpTargetFor(agent, root, home);
    if (!target) {
      out.push({ agent, status: 'unsupported', scope: null, path: null });
      continue;
    }
    try {
      const status = await readMcpStatus(agent, root, home);
      if (status.connected) {
        out.push({ agent, status: 'already', scope: target.scope, path: target.path });
        continue;
      }
      const r = await connectAgentMcp(agent, root, null, { confirmGlobal: opts.confirmGlobal }, home);
      out.push({ agent, status: r.wrote ? 'connected' : 'needs-confirm', scope: target.scope, path: target.path });
    } catch (e) {
      if (e instanceof McpConfigParseError) {
        out.push({ agent, status: 'parse-error', scope: target.scope, path: target.path });
      } else {
        throw e;
      }
    }
  }
  return out;
}
