/**
 * MCP config snippets so each agent CLI (Claude Code, Cursor, Codex, Gemini)
 * can query the graphify knowledge graph natively. The server itself is
 * graphify's own (`python -m graphify.serve <graph.json>`), run via uv so no
 * preinstalled venv is required.
 */
import type { KbState } from './state.js';

function serveArgs(graphPath: string): string[] {
  return ['run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve', graphPath];
}

export interface McpServerDef {
  command: string;
  args: string[];
}

export function mcpServers(state: KbState): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  for (const p of state.projects) {
    servers[`graphify-${p.id}`] = { command: 'uv', args: serveArgs(p.graphPath) };
  }
  if (state.mergedGraphPath) {
    servers['graphify-merged'] = { command: 'uv', args: serveArgs(state.mergedGraphPath) };
  }
  // Coordination tools (check_files / get_report / who_touched / list_tasks).
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}

/** JSON form used by Claude Code (.mcp.json) and Cursor (.cursor/mcp.json). */
export function jsonSnippet(state: KbState): string {
  return JSON.stringify({ mcpServers: mcpServers(state) }, null, 2);
}

/** TOML form for Codex (~/.codex/config.toml). */
export function codexSnippet(state: KbState): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(mcpServers(state))) {
    lines.push(`[mcp_servers."${name}"]`);
    lines.push(`command = "${def.command}"`);
    lines.push(`args = [${def.args.map((a) => `"${a}"`).join(', ')}]`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Gemini CLI uses the same mcpServers JSON shape inside ~/.gemini/settings.json. */
export function geminiSnippet(state: KbState): string {
  return jsonSnippet(state);
}

export function snippetFor(agent: string, state: KbState): string {
  switch (agent) {
    case 'codex':
      return codexSnippet(state);
    case 'gemini':
      return geminiSnippet(state);
    case 'claude':
    case 'cursor':
    default:
      return jsonSnippet(state);
  }
}

export function allSnippets(state: KbState): Record<string, string> {
  return {
    claude: jsonSnippet(state),
    cursor: jsonSnippet(state),
    codex: codexSnippet(state),
    gemini: geminiSnippet(state),
  };
}
