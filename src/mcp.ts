/**
 * `baton mcp` — stdio MCP server exposing Baton's coordination state to
 * agents (Claude Code, Cursor, Codex, Gemini CLI). The graph itself is served
 * by graphify's own MCP server; this one answers the coordination questions:
 *
 *   check_files   — "are these files being edited by another session? wait?"
 *   list_signals  — everything being edited right now, overlaps flagged
 *   get_report    — what a finished task shipped (is my bug already fixed?)
 *   who_touched   — agent-blame for a file (merged history + live signals)
 *   list_tasks    — all sessions with status/agent
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { collectStatus } from './board.js';
import { gitRoot } from './git.js';
import { queryFile } from './history.js';
import { checkFiles, getSignals } from './signals.js';
import { getReport, listReports } from './reports.js';

const asText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export async function startMcpServer(): Promise<void> {
  const root = await gitRoot();
  const server = new McpServer({ name: 'baton', version: '0.1.0' });

  server.registerTool(
    'check_files',
    {
      description:
        'Check whether files are currently being edited by another Baton session (live edit signals + unmerged branch changes). Call BEFORE editing shared files; if busy, prefer waiting or picking other work, then re-check.',
      inputSchema: { paths: z.array(z.string()).describe('Repo-relative file paths to check') },
    },
    async ({ paths }) => asText(await checkFiles(root, paths)),
  );

  server.registerTool(
    'list_signals',
    {
      description:
        'List every file under live edit across all Baton sessions right now. level="warning" means 2+ sessions are editing the same path.',
      inputSchema: {},
    },
    async () => asText(await getSignals(root)),
  );

  server.registerTool(
    'get_report',
    {
      description:
        'Get the completion report of a merged task (summary, files changed, commits). Use after waiting on busy files to decide whether your issue is already fixed. Omit slug to list recent reports.',
      inputSchema: { slug: z.string().optional().describe('Task slug; omit for recent reports') },
    },
    async ({ slug }) => asText(slug ? (getReport(root, slug) ?? { error: `no report for '${slug}'` }) : listReports(root, 10)),
  );

  server.registerTool(
    'who_touched',
    {
      description:
        'Agent-blame for a file: which task/agent/commits touched it (merged history) and who is editing it live right now.',
      inputSchema: { file: z.string().describe('Repo-relative file path') },
    },
    async ({ file }) => {
      const [merged, live] = [queryFile(root, file), await checkFiles(root, [file])];
      return asText({ merged, live: live[file] });
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'List all Baton sessions (worktrees) with status, attached agent, and ahead/behind counts.',
      inputSchema: {},
    },
    async () => asText(await collectStatus(root)),
  );

  await server.connect(new StdioServerTransport());
}
