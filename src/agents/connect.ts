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
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
/* Removal (the inverse of the merges above)                           */
/* ------------------------------------------------------------------ */

export interface UnmergeResult {
  text: string;
  /** server names actually removed */
  removed: string[];
  /** servers matching a Baton name that we refused to touch, and why */
  skipped: { name: string; why: string }[];
}

const NOT_OURS = 'not written by Baton — left untouched';

/** Is this a loopback URL pointing at the daemon's graphify proxy route? */
function isProxyUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  return loopback && u.pathname.includes('/mcp/g/');
}

/**
 * Does this server entry look like one Baton wrote? Removal is more dangerous
 * than addition, so ownership is proven from the entry's own contents, never
 * from its name alone: a server *called* `baton` that runs something else, or a
 * `graphify-*` pointing at the user's own backend, is somebody else's and stays.
 */
/**
 * Is this command the baton binary? An install that wired an absolute path is
 * exactly the stale entry disconnect exists to clear, so a path is accepted —
 * but only at a path boundary, so `notbaton` and `baton-other` stay other
 * people's programs.
 */
function isBatonCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && (cmd === 'baton' || /[\\/]baton$/.test(cmd));
}

export function isBatonOwned(name: string, def: unknown): boolean {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return false;
  const d = def as Record<string, unknown>;
  if (name === 'baton') return isBatonCommand(d.command);
  if (!name.startsWith('graphify-')) return false;
  if (isBatonCommand(d.command) && Array.isArray(d.args) && d.args.includes('mcp-bridge')) return true;
  return isProxyUrl(d.url) || isProxyUrl(d.httpUrl) || isProxyUrl(d.serverUrl);
}

/**
 * Remove Baton's servers from a JSON config, preserving every other server and
 * every unrelated top-level key. Mirrors mergeJsonConfig's refusal to touch a
 * file it cannot parse. `mcpServers` is left as `{}` when it empties out — the
 * file is never deleted and the key never disappears.
 */
export function unmergeJsonConfig(existing: string, path = 'the config file'): UnmergeResult {
  if (!existing.trim()) return { text: existing, removed: [], skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new McpConfigParseError(path);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new McpConfigParseError(path);

  const obj = parsed as Record<string, unknown>;
  const prior = obj.mcpServers;
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return { text: existing, removed: [], skipped: [] };

  const removed: string[] = [];
  const skipped: UnmergeResult['skipped'] = [];
  const kept: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(prior as Record<string, unknown>)) {
    const ours = name === 'baton' || name.startsWith('graphify-');
    if (ours && isBatonOwned(name, def)) removed.push(name);
    else {
      if (ours) skipped.push({ name, why: NOT_OURS });
      kept[name] = def;
    }
  }
  if (!removed.length) return { text: existing, removed, skipped };
  obj.mcpServers = kept;
  return { text: JSON.stringify(obj, null, 2) + '\n', removed, skipped };
}

/**
 * A TOML table header at column 0. Requires a key character after the bracket so
 * a bracket that opens a multi-line array is not mistaken for the next section —
 * that is what stops a removal from swallowing the block that follows it.
 */
const TOML_HEADER = /^\[\[?[A-Za-z_"']/;

/** Reconstruct enough of a server def from a TOML block to run the ownership check. */
function tomlBlockDef(block: string): Record<string, unknown> {
  const str = (key: string): string | undefined =>
    new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(block)?.[1]?.replace(/\\(.)/g, '$1');
  const argsRaw = /^args\s*=\s*\[([\s\S]*?)\]/m.exec(block)?.[1] ?? '';
  return {
    command: str('command'),
    args: [...argsRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')),
    url: str('url'),
    httpUrl: str('httpUrl'),
    serverUrl: str('serverUrl'),
  };
}

/** Remove Baton's `[mcp_servers.*]` blocks from a TOML config, leaving all others intact. */
export function unmergeTomlConfig(existing: string): UnmergeResult {
  if (!existing.trim()) return { text: existing, removed: [], skipped: [] };
  const lines = existing.split('\n');

  // Section boundaries first, so each block is sliced whole before anything is judged.
  const starts: number[] = [];
  lines.forEach((l, i) => { if (TOML_HEADER.test(l)) starts.push(i); });

  // Group every block belonging to one server, so a sub-table like
  // [mcp_servers."baton".env] is judged with its parent (which holds the
  // command) and removed with it — an orphaned sub-table configures a server
  // that no longer exists.
  const blocks = new Map<string, { from: number; to: number }[]>();
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const name = /^\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))(?=[.\]])/.exec(lines[from]);
    if (!name) continue;
    const server = (name[1] ?? name[2]).replace(/\\(.)/g, '$1');
    if (server !== 'baton' && !server.startsWith('graphify-')) continue;
    blocks.set(server, [...(blocks.get(server) ?? []), { from, to }]);
  }

  const removed: string[] = [];
  const skipped: UnmergeResult['skipped'] = [];
  const drop = new Set<number>();

  for (const [server, ranges] of blocks) {
    const text = ranges.map((r) => lines.slice(r.from, r.to).join('\n')).join('\n');
    if (!isBatonOwned(server, tomlBlockDef(text))) {
      skipped.push({ name: server, why: NOT_OURS });
      continue;
    }
    removed.push(server);
    for (const r of ranges) for (let i = r.from; i < r.to; i++) drop.add(i);
  }

  if (!removed.length) return { text: existing, removed, skipped };
  // A block already runs up to the next header, so its own trailing blank lines
  // go with it. Nothing else is reflowed — blank runs the user put elsewhere in
  // the file are not ours to normalise.
  const text = lines.filter((_, i) => !drop.has(i)).join('\n');
  return { text: text.trim() ? text.replace(/\n*$/, '\n') : '', removed, skipped };
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

export interface DisconnectResult {
  agent: string;
  scope: McpScope;
  path: string;
  /** config file present on disk at all */
  exists: boolean;
  wrote: boolean;
  needsConfirm: boolean;
  removed: string[];
  skipped: { name: string; why: string }[];
  /** full proposed file content when needsConfirm (so the UI can show it) */
  preview?: string;
}

/**
 * Remove the servers Baton wired for one agent — the inverse of
 * connectAgentMcp, and the only supported way to undo a write into $HOME.
 *
 * Same scope policy as connecting: a global file is previewed, not written,
 * until the caller confirms. The write is tmp+rename because a half-written MCP
 * config breaks the agent on its next launch.
 */
export async function disconnectAgentMcp(
  agent: string,
  root: string,
  opts: { confirmGlobal?: boolean } = {},
  home = homedir(),
): Promise<DisconnectResult> {
  const target = mcpTargetFor(agent, root, home);
  if (!target) throw new McpUnsupportedError(agent);
  const base = { agent, scope: target.scope, path: target.path };

  if (!existsSync(target.path)) {
    return { ...base, exists: false, wrote: false, needsConfirm: false, removed: [], skipped: [] };
  }
  const existing = await readFile(target.path, 'utf-8');
  const { text, removed, skipped } = target.format === 'json'
    ? unmergeJsonConfig(existing, target.path)
    : unmergeTomlConfig(existing);

  // Nothing of ours in the file: touch nothing, so a no-op can never rewrite it.
  if (!removed.length) return { ...base, exists: true, wrote: false, needsConfirm: false, removed, skipped };

  if (target.scope === 'global' && !opts.confirmGlobal) {
    return { ...base, exists: true, wrote: false, needsConfirm: true, removed, skipped, preview: text };
  }

  // Resolve first: rename() replaces a symlink rather than following it, so
  // writing to target.path directly would turn a symlinked config into a real
  // file (connect's writeFile follows it). Then tmp+rename beside the real
  // file, pid-tagged like saveKb so two runs can't share a temp path.
  const real = await realpath(target.path).catch(() => target.path);
  const tmp = `${real}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf-8');
  await rename(tmp, real);
  return { ...base, exists: true, wrote: true, needsConfirm: false, removed, skipped };
}

export type AgentDisconnectStatus =
  | 'disconnected'   // servers removed just now
  | 'nothing'        // no Baton servers in the file (or no file at all)
  | 'needs-confirm'  // a global ($HOME) file — rerun with confirmGlobal
  | 'unsupported'
  | 'parse-error'
  | 'failed';        // unreadable/unwritable file (EACCES, EISDIR, …)

export interface AgentDisconnectOutcome {
  agent: string;
  status: AgentDisconnectStatus;
  scope: McpScope | null;
  path: string | null;
  removed: string[];
  skipped: { name: string; why: string }[];
  /** why it failed, when status is 'failed' */
  error?: string;
}

/**
 * Disconnect a batch of agents. Never throws: each agent's outcome is returned
 * so one unparseable config cannot abort the rest of the batch.
 */
export async function disconnectAgents(
  root: string,
  agents: string[],
  opts: { confirmGlobal?: boolean } = {},
  home = homedir(),
): Promise<AgentDisconnectOutcome[]> {
  const out: AgentDisconnectOutcome[] = [];
  for (const agent of agents) {
    const target = mcpTargetFor(agent, root, home);
    if (!target) {
      out.push({ agent, status: 'unsupported', scope: null, path: null, removed: [], skipped: [] });
      continue;
    }
    try {
      const r = await disconnectAgentMcp(agent, root, opts, home);
      const status: AgentDisconnectStatus = r.needsConfirm ? 'needs-confirm' : r.wrote ? 'disconnected' : 'nothing';
      out.push({ agent, status, scope: target.scope, path: target.path, removed: r.removed, skipped: r.skipped });
    } catch (e) {
      // Genuinely never throws: a config that is unreadable for any reason
      // (permissions, a directory in its place) must not abort the other
      // agents — a half-done disconnect is the state this command exists to
      // prevent.
      const status = e instanceof McpConfigParseError ? 'parse-error' : 'failed';
      out.push({ agent, status, scope: target.scope, path: target.path, removed: [], skipped: [], error: (e as Error).message });
    }
  }
  return out;
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
