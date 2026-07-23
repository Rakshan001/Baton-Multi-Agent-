/**
 * MCP config snippets so each agent CLI (Claude Code, Cursor, Codex, Gemini)
 * can query the graphify knowledge graph natively. Graphify entries point at
 * the shared daemon proxy (`/mcp/g/<token>/<id>`). Claude/Cursor/Gemini get
 * url-based HTTP entries; Codex's TOML MCP format only supports `command` +
 * `args`, so it gets `baton mcp-bridge <url>` — a thin stdio↔HTTP bridge into
 * the same shared pool (requires `baton serve`, same as the HTTP agents).
 */
import type { KbState } from './state.js';

export type McpServerDef =
  | { command: string; args: string[] }
  | { type: 'http'; url: string }
  | { httpUrl: string };

/** TOML basic-string with `"` and `\` escaped (raw concatenation would emit invalid TOML). */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface McpOpts {
  baseUrl: string;
  token: string;
  /** Register per-project `graphify-<id>` servers too. Off by default in a hub,
   *  where the merged graph already spans every project (P11 — avoid duplicated
   *  tool defs across 4+ backends). Ignored outside a hub. */
  perProject?: boolean;
}

/**
 * Which projects get their own `graphify-<id>` server. In a true hub (a merged
 * graph spanning 2+ projects) the merged graph already covers everything, so
 * per-project servers are redundant token/process duplication — collapse to
 * merged-only unless explicitly opted in. A lone project (even one carrying a
 * mergedGraphPath) is NOT a hub: there is nothing to collapse into, so keep it.
 */
function projectGraphs(state: KbState, perProject = false): KbState['projects'] {
  const isHub = !!state.mergedGraphPath && state.projects.length > 1;
  return isHub && !perProject ? [] : state.projects;
}

/**
 * Returns the MCP server definitions for the given KB state.
 * Graphify entries become `{ type: 'http', url: ... }` pointing at the daemon
 * proxy; the baton coordination server stays stdio.
 */
export function mcpServers(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  const url = (id: string) => `${opts.baseUrl}/mcp/g/${opts.token}/${id}`;
  for (const p of projectGraphs(state, opts.perProject)) servers[`graphify-${p.id}`] = { type: 'http', url: url(p.id) };
  if (state.mergedGraphPath) servers['graphify-merged'] = { type: 'http', url: url('merged') };
  // Coordination tools (check_files / get_report / who_touched / list_tasks).
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/**
 * Same daemon proxy URLs as Claude/Cursor, but every graphify entry wrapped in
 * `baton mcp-bridge <url>` so the whole config is `command` + `args`. Used by
 * any client whose config can't express a url-based server, or whose url key we
 * aren't confident enough about to bet a silent dead server on.
 */
function mcpServersBridged(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  const url = (id: string) => `${opts.baseUrl}/mcp/g/${opts.token}/${id}`;
  for (const p of projectGraphs(state, opts.perProject)) {
    servers[`graphify-${p.id}`] = { command: 'baton', args: ['mcp-bridge', url(p.id)] };
  }
  if (state.mergedGraphPath) {
    servers['graphify-merged'] = { command: 'baton', args: ['mcp-bridge', url('merged')] };
  }
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/** Codex: its TOML MCP format supports only `command` + `args` — no url servers at all. */
export function mcpServersCodex(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  return mcpServersBridged(state, opts);
}

/**
 * Antigravity: its JSON config DOES take remote servers, but under `serverUrl`
 * — not `url` (Claude/Cursor) or `httpUrl` (Gemini). That key is documented in
 * exactly one place, and getting it wrong yields a server that loads and
 * answers nothing. The bridge form is command+args, which every MCP client
 * agrees on, so we take the same shared pool with none of the risk. Revisit
 * only once `serverUrl` is verified against a live Antigravity install.
 */
export function mcpServersAntigravity(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  return mcpServersBridged(state, opts);
}

/** JSON form used by Claude Code (.mcp.json) and Cursor (.cursor/mcp.json). */
export function jsonSnippet(state: KbState, opts: McpOpts): string {
  return JSON.stringify({ mcpServers: mcpServers(state, opts) }, null, 2);
}

/** TOML form for Codex (~/.codex/config.toml). Uses `baton mcp-bridge <url>`
 *  so Codex's command+args-only format still hits the shared daemon pool. */
export function codexSnippet(state: KbState, opts: McpOpts): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(mcpServersCodex(state, opts))) {
    lines.push(`[mcp_servers.${tomlStr(name)}]`);
    if ('command' in def) {
      lines.push(`command = ${tomlStr(def.command)}`);
      lines.push(`args = [${def.args.map(tomlStr).join(', ')}]`);
    } else if ('httpUrl' in def) {
      lines.push(`httpUrl = ${tomlStr(def.httpUrl)}`);
    } else {
      lines.push(`url = ${tomlStr(def.url)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Gemini CLI variant: graphify entries use `{ httpUrl }` (streamable-HTTP form
 * required by Gemini CLI's settings.json schema) instead of `{ type:'http', url }`.
 * The baton coordination server stays stdio.
 */
export function mcpServersGemini(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  const url = (id: string) => `${opts.baseUrl}/mcp/g/${opts.token}/${id}`;
  for (const p of projectGraphs(state, opts.perProject)) servers[`graphify-${p.id}`] = { httpUrl: url(p.id) };
  if (state.mergedGraphPath) servers['graphify-merged'] = { httpUrl: url('merged') };
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/** Gemini CLI uses httpUrl (not url) for streamable-HTTP MCP entries in ~/.gemini/settings.json. */
export function geminiSnippet(state: KbState, opts: McpOpts): string {
  return JSON.stringify({ mcpServers: mcpServersGemini(state, opts) }, null, 2);
}

/** Antigravity: same `mcpServers` key as Claude/Cursor, bridged graphify entries. */
export function antigravitySnippet(state: KbState, opts: McpOpts): string {
  return JSON.stringify({ mcpServers: mcpServersAntigravity(state, opts) }, null, 2);
}

export function snippetFor(agent: string, state: KbState, opts: McpOpts): string {
  switch (agent) {
    case 'codex':
      return codexSnippet(state, opts);
    case 'gemini':
      return geminiSnippet(state, opts);
    case 'antigravity':
      return antigravitySnippet(state, opts);
    case 'claude':
    case 'cursor':
    default:
      return jsonSnippet(state, opts);
  }
}

export function allSnippets(state: KbState, opts: McpOpts): Record<string, string> {
  return {
    claude: jsonSnippet(state, opts),
    cursor: jsonSnippet(state, opts),
    codex: codexSnippet(state, opts),
    gemini: geminiSnippet(state, opts),
  };
}
