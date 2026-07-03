/**
 * MCP config snippets so each agent CLI (Claude Code, Cursor, Codex, Gemini)
 * can query the graphify knowledge graph natively. Graphify entries now point
 * at the shared daemon proxy (`/mcp/g/<token>/<id>`) instead of spawning
 * per-agent `uv` processes. Codex is special-cased to keep stdio spawn because
 * its TOML MCP config does not support url-based servers (only `command` +
 * `args` keys are documented in the Codex config spec).
 */
import type { KbState } from './state.js';

function serveArgs(graphPath: string): string[] {
  return ['run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve', graphPath];
}

export type McpServerDef =
  | { command: string; args: string[] }
  | { type: 'http'; url: string };

/** TOML basic-string with `"` and `\` escaped (raw concatenation would emit invalid TOML). */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface McpOpts {
  baseUrl: string;
  token: string;
}

/**
 * Returns the MCP server definitions for the given KB state.
 * Graphify entries become `{ type: 'http', url: ... }` pointing at the daemon
 * proxy; the baton coordination server stays stdio.
 */
export function mcpServers(state: KbState, opts: McpOpts): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  const url = (id: string) => `${opts.baseUrl}/mcp/g/${opts.token}/${id}`;
  for (const p of state.projects) servers[`graphify-${p.id}`] = { type: 'http', url: url(p.id) };
  if (state.mergedGraphPath) servers['graphify-merged'] = { type: 'http', url: url('merged') };
  // Coordination tools (check_files / get_report / who_touched / list_tasks).
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/**
 * Codex stdio variant: returns server defs using `uv` spawn instead of http
 * urls, because Codex's TOML MCP format only supports `command` + `args`.
 */
function mcpServersCodex(state: KbState): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  for (const p of state.projects) {
    servers[`graphify-${p.id}`] = { command: 'uv', args: serveArgs(p.graphPath) };
  }
  if (state.mergedGraphPath) {
    servers['graphify-merged'] = { command: 'uv', args: serveArgs(state.mergedGraphPath) };
  }
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/** JSON form used by Claude Code (.mcp.json) and Cursor (.cursor/mcp.json). */
export function jsonSnippet(state: KbState, opts: McpOpts): string {
  return JSON.stringify({ mcpServers: mcpServers(state, opts) }, null, 2);
}

/** TOML form for Codex (~/.codex/config.toml). Uses stdio spawn (uv) because
 *  Codex's TOML MCP format does not support url-based servers. */
export function codexSnippet(state: KbState, opts: McpOpts): string {
  // Codex keeps stdio — special-cased because Codex only supports command+args,
  // not url-based MCP servers. Claude/Cursor/Gemini get the http defs.
  void opts; // opts accepted for uniform signature but not used here
  const lines: string[] = [];
  for (const [name, def] of Object.entries(mcpServersCodex(state))) {
    lines.push(`[mcp_servers.${tomlStr(name)}]`);
    if ('url' in def) {
      lines.push(`url = ${tomlStr(def.url)}`);
    } else {
      lines.push(`command = ${tomlStr(def.command)}`);
      lines.push(`args = [${def.args.map(tomlStr).join(', ')}]`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Gemini CLI uses the same mcpServers JSON shape inside ~/.gemini/settings.json. */
export function geminiSnippet(state: KbState, opts: McpOpts): string {
  return jsonSnippet(state, opts);
}

export function snippetFor(agent: string, state: KbState, opts: McpOpts): string {
  switch (agent) {
    case 'codex':
      return codexSnippet(state, opts);
    case 'gemini':
      return geminiSnippet(state, opts);
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
