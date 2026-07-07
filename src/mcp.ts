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
 *   save_memory   — persist a learned fact (evidence-anchored, shared)
 *   recall_memory — fresh, evidence-checked facts; stale ones withheld
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { collectStatus } from './board.js';
import { gitRoot } from './git.js';
import { resolveMcpRoot } from './store.js';
import { queryFile } from './history.js';
import { checkFiles, getSignals } from './signals.js';
import { getReport, listReports } from './reports.js';
import { MemoryValidationError, MEMORY_TYPES, recallMemories, saveMemory } from './memory.js';

const asText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export async function startMcpServer(): Promise<void> {
  // Coordination store: an agent runs `baton mcp` from inside its worktree, so
  // gitRoot() would point at an empty per-worktree shadow store. resolveMcpRoot
  // finds the real hub/repo .baton (and honors BATON_ROOT for spawned agents).
  const root = await resolveMcpRoot();
  // Memory tools resolve the shared main repo themselves (worktree-safe) from a
  // git path, so give them the git root — unchanged in hub mode.
  const memRoot = await gitRoot();
  // The caller's own task, so check_files/who_touched don't report its edits as
  // "busy" to itself (set by baton when it spawns the agent).
  const selfSlug = process.env.BATON_SLUG?.trim() || undefined;
  const server = new McpServer({ name: 'baton', version: '0.1.0' });

  server.registerTool(
    'check_files',
    {
      description:
        'Check whether files are currently being edited by another Baton session (live edit signals + unmerged branch changes). Call BEFORE editing shared files; if busy, prefer waiting or picking other work, then re-check.',
      inputSchema: { paths: z.array(z.string()).describe('Repo-relative file paths to check') },
    },
    async ({ paths }) => asText(await checkFiles(root, paths, selfSlug)),
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
      const [merged, live] = [queryFile(root, file), await checkFiles(root, [file], selfSlug)];
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

  server.registerTool(
    'save_memory',
    {
      description:
        'Persist a fact you LEARNED while working (a decision made, a gotcha hit, a convention discovered) so future agent sessions skip re-discovering it. 1–3 sentences: the fact + why + how to apply. Pass the repo-relative files the fact is about — they become evidence anchors; if those files later change, the fact is automatically flagged stale instead of being served as truth. Do NOT store anything derivable from the code itself, task-only context, or secrets (rejected).',
      inputSchema: {
        fact: z.string().describe('The fact: 1–3 sentences, why + how to apply'),
        type: z.enum(MEMORY_TYPES as [string, ...string[]]).optional().describe('decision | gotcha | convention | reference | preference'),
        files: z.array(z.string()).optional().describe('Repo-relative files this fact is about (evidence anchors, max 8)'),
        agent: z.string().optional().describe('Your agent name, e.g. "claude"'),
        task: z.string().optional().describe('Task slug you are working on'),
      },
    },
    async ({ fact, type, files, agent, task }) => {
      try {
        // memory.ts resolves the MAIN repo root internally (worktree-safe).
        const saved = await saveMemory(memRoot, { fact, type, files, agent, task });
        return asText({ saved: saved.id, supersedes: saved.supersedes, anchoredFiles: saved.anchors.files.map((f) => f.path) });
      } catch (e) {
        if (e instanceof MemoryValidationError) return asText({ rejected: e.message });
        throw e;
      }
    },
  );

  server.registerTool(
    'recall_memory',
    {
      description:
        'Recall project memory BEFORE exploring the repo — facts earlier agent sessions learned (decisions, gotchas, conventions), evidence-checked against the current code. Stale facts (whose anchored files changed since) are withheld and only counted, so everything returned is safe to trust. Pass a topic to rank by relevance; omit it for the most recent facts.',
      inputSchema: {
        topic: z.string().optional().describe('What you are working on — ranks facts by relevance'),
        limit: z.number().optional().describe('Max facts to return (default 10, max 50)'),
      },
    },
    async ({ topic, limit }) => {
      const r = await recallMemories(memRoot, { topic, limit });
      return asText({
        facts: r.facts.map((f) => ({ id: f.id, type: f.type, fact: f.fact, task: f.task, freshness: f.freshness, commitsBehind: f.commitsBehind })),
        totalStored: r.total,
        staleWithheld: r.staleDropped,
      });
    },
  );

  await server.connect(new StdioServerTransport());
}
