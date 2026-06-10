/**
 * `baton mcp` — run the coordination MCP server over stdio. Agents register
 * it via `baton kb mcp` config snippets (server entry "baton").
 */
import { startMcpServer } from '../mcp.js';

export async function mcpCmd(): Promise<void> {
  await startMcpServer();
  // stdio transport keeps the process alive until the client disconnects
}
