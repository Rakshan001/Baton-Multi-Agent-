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
import { detectParentAgent } from './agents.js';
import { gitRoot } from './git.js';
import { resolveMcpRoot } from './store.js';
import { queryFile, searchHistory } from './history.js';
import { checkFiles, getSignals, isWatcherActive, recordHookEdit, registerHookSession, sessionSlug, setProgress, touchHookSession } from './signals.js';
import { getReport, listReports, reportSummary } from './reports.js';
import { MemoryValidationError, MEMORY_TYPES, recallMemories, recallRows, saveMemory } from './memory.js';
import { createSessionHandoff } from './handoff/session-brief.js';
import { snapshotTask } from './commands/snapshot.js';
import { buildOrientation } from './kb/orient.js';
import { asText, capList } from './mcp-format.js';
import { TOOL_HELP } from './mcp-help.js';

/** who_touched can span a file's whole history — cap what an agent is served. */
const WHO_TOUCHED_CAP = 20;
/** A busy hub can hold hundreds of live signals — cap what one answer serves. */
const SIGNALS_CAP = 30;
/**
 * Debounce for refreshing a session's presence on tool calls — well under the
 * 2-min heartbeat window (WATCHER_HEARTBEAT_STALE_MS) so an active agent always
 * reads as live, without a DB write on every single tool invocation.
 */
const PRESENCE_TOUCH_MS = 30_000;

export async function startMcpServer(): Promise<void> {
  // Coordination store: an agent runs `baton mcp` from inside its worktree, so
  // gitRoot() would point at an empty per-worktree shadow store. resolveMcpRoot
  // finds the real hub/repo .baton (and honors BATON_ROOT for spawned agents).
  const root = await resolveMcpRoot();
  // Memory tools resolve the shared main repo themselves (worktree-safe) from a
  // git path, so give them the git root — unchanged in hub mode.
  const memRoot = await gitRoot();
  // The caller's own task, so check_files/who_touched don't report its edits as
  // "busy" to itself (set by baton when it spawns the agent). Sessions with no
  // task (any agent, repo root, no worktree) get a per-session identity instead:
  // `baton mcp` runs one process per agent session, so the pid is the session
  // and the parent process chain says which agent spawned us (M1, zero config).
  const taskSlug = process.env.BATON_SLUG?.trim() || undefined;
  const selfSlug = taskSlug ?? sessionSlug(`p${process.pid}`);
  if (!taskSlug) {
    try {
      const agent = process.env.BATON_AGENT?.trim() || (await detectParentAgent());
      registerHookSession(root, selfSlug, agent, memRoot);
    } catch { /* identity is best-effort — tools still work anonymously */ }
  }
  const server = new McpServer(
    { name: 'baton', version: '0.1.0' },
    { instructions: 'New to this repo? Call orient() first for a budgeted project brief (memory, recent work, structure), then recall_memory before exploring, and check_files before editing shared files.' },
  );

  // Keep presence fresh on ANY tool call, not just edits (finding #5): an agent
  // that only reads (orient/check_files/recall) is still connected, but
  // hook_sessions.at would otherwise advance only on connect/edit — so the
  // dashboard would show it idle after the heartbeat and drop it after the
  // window. `reg` wraps every tool registration below to refresh the session's
  // last-seen, debounced to well under the heartbeat window so a chatty agent
  // doesn't write on every call. Wrapping via a local helper (not by reassigning
  // server.registerTool) keeps the SDK's full type at each call site.
  let lastPresenceTouch = 0;
  const presenceTouch = (): void => {
    if (taskSlug) return; // only non-task sessions have a hook_sessions row to touch
    const now = Date.now();
    if (now - lastPresenceTouch < PRESENCE_TOUCH_MS) return;
    lastPresenceTouch = now;
    try { touchHookSession(root, selfSlug); } catch { /* presence is best-effort */ }
  };
  const reg = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    (server.registerTool as (...x: unknown[]) => unknown)(name, config, (...a: unknown[]) => {
      presenceTouch();
      return cb(...a);
    })) as unknown as typeof server.registerTool;

  reg(
    'orient',
    {
      description: TOOL_HELP.orient,
      inputSchema: { topic: z.string().optional().describe('What you are about to work on — biases the memory facts') },
    },
    async ({ topic }) => asText({ orientation: await buildOrientation(root, { topic }) }),
  );

  reg(
    'check_files',
    {
      description: TOOL_HELP.check_files,
      inputSchema: { paths: z.array(z.string()).describe('Repo-relative file paths to check') },
    },
    async ({ paths }) => asText({ watcherActive: isWatcherActive(root), files: await checkFiles(root, paths, selfSlug) }),
  );

  reg(
    'list_signals',
    {
      description: TOOL_HELP.list_signals,
      inputSchema: {},
    },
    async () => {
      const capped = capList(await getSignals(root), SIGNALS_CAP);
      return asText({ signals: capped.items, more: capped.more });
    },
  );

  reg(
    'get_report',
    {
      description: TOOL_HELP.get_report,
      inputSchema: { slug: z.string().optional().describe('Task slug; omit for recent reports') },
    },
    async ({ slug }) =>
      asText(slug ? (getReport(root, slug) ?? { error: `no report for '${slug}'` }) : listReports(root, 10).map(reportSummary)),
  );

  reg(
    'who_touched',
    {
      description: TOOL_HELP.who_touched,
      inputSchema: { file: z.string().describe('Repo-relative file path') },
    },
    async ({ file }) => {
      const [hits, live] = [queryFile(root, file), await checkFiles(root, [file], selfSlug)];
      const capped = capList(hits, WHO_TOUCHED_CAP);
      return asText({ merged: capped.items, moreMerged: capped.more, live: live[file] });
    },
  );

  reg(
    'list_tasks',
    {
      description: TOOL_HELP.list_tasks,
      inputSchema: {},
    },
    async () => asText(await collectStatus(root)),
  );

  reg(
    'report_progress',
    {
      description: TOOL_HELP.report_progress,
      inputSchema: { note: z.string().describe('One line: what you are doing + rough progress') },
    },
    async ({ note }) => {
      const trimmed = note.trim().slice(0, 200);
      setProgress(root, selfSlug, trimmed);
      return asText({ reported: trimmed, slug: selfSlug });
    },
  );

  reg(
    'touch_files',
    {
      description: TOOL_HELP.touch_files,
      inputSchema: { paths: z.array(z.string()).describe('Repo-relative file paths you are editing') },
    },
    async ({ paths }) => {
      const touched = paths.map((p) => p.trim()).filter((p) => p && !p.startsWith('/') && !p.includes('..'));
      for (const p of touched) recordHookEdit(root, { slug: selfSlug, path: p });
      // ISS-03: keep a resumable HANDOFF.md fresh for agents that reach us via
      // MCP rather than an edit hook (Codex/Gemini). Only for a real task
      // (taskSlug); debounced + best-effort so it never blocks or fails the tool.
      if (taskSlug && touched.length) {
        void snapshotTask(taskSlug, { root, from: process.env.BATON_AGENT?.trim() }).catch(() => {});
      }
      return asText({ touched, as: selfSlug });
    },
  );

  reg(
    'search_history',
    {
      description: TOOL_HELP.search_history,
      inputSchema: {
        query: z.string().describe('Keywords: symbols, file names, or message words'),
        limit: z.number().optional().describe('Max hits (default 10, max 25)'),
      },
    },
    async ({ query, limit }) => asText({ hits: searchHistory(root, query, limit ?? 10) }),
  );

  reg(
    'create_handoff',
    {
      description: TOOL_HELP.create_handoff,
      inputSchema: {
        title: z.string().describe('One line: what this work is'),
        done: z.array(z.string()).optional().describe('Completed items'),
        pending: z.array(z.string()).optional().describe('Remaining items, most important first'),
        next: z.string().optional().describe('The single most useful next action for whoever resumes'),
        decisions: z.array(z.string()).optional().describe('Decisions made / gotchas found — things git cannot show'),
        suggested_skills: z.array(z.string()).optional().describe('Skills the next agent should invoke to continue, e.g. "bug-fix", "stack-migration"'),
        to: z.string().optional().describe('Receiving agent, if known (e.g. "codex")'),
      },
    },
    async ({ title, done, pending, next, decisions, suggested_skills, to }) => {
      try {
        const agent = process.env.BATON_AGENT?.trim() || (await detectParentAgent().catch(() => undefined)) || undefined;
        const brief = await createSessionHandoff(root, {
          slug: selfSlug, agent, title, done, pending, next, decisions, suggestedSkills: suggested_skills, to, cwd: process.cwd(),
        });
        return asText({
          brief: brief.path,
          pickup: brief.resume,
          ...(brief.capturedFacts.length ? { memorized: brief.capturedFacts } : {}),
          tip: 'Tell the user the pickup command — the next agent runs it to continue.',
        });
      } catch (e) {
        return asText({ rejected: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  reg(
    'save_memory',
    {
      description: TOOL_HELP.save_memory,
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
        return asText({
          saved: saved.id,
          supersedes: saved.supersedes,
          anchoredFiles: saved.anchors.files.map((f) => f.path),
          // Write-time reconciliation (M8): you are the judge — merge or ignore.
          ...(saved.similarExisting?.length
            ? { possibleDuplicates: saved.similarExisting, tip: 'If one of these is the same knowledge, keep the better wording and remove the other (baton memory rm <id>).' }
            : {}),
        });
      } catch (e) {
        if (e instanceof MemoryValidationError) return asText({ rejected: e.message });
        throw e;
      }
    },
  );

  reg(
    'recall_memory',
    {
      description: TOOL_HELP.recall_memory,
      inputSchema: {
        topic: z.string().optional().describe('What you are working on — ranks facts by relevance'),
        limit: z.number().optional().describe('Max facts to return (default 10, max 50)'),
        ids: z.array(z.string()).optional().describe('Fetch these facts in full (hydrates preview rows)'),
      },
    },
    async ({ topic, limit, ids }) => {
      const r = await recallMemories(memRoot, { topic, limit, ids });
      // Hydration mode: full bodies for the requested ids, failures named.
      if (ids?.length) {
        return asText({
          facts: r.facts.map((f) => ({ id: f.id, type: f.type, fact: f.fact, task: f.task, freshness: f.freshness, commitsBehind: f.commitsBehind })),
          ...(r.withheld?.length ? { withheld: r.withheld } : {}),
        });
      }
      const rows = recallRows(r.facts);
      return asText({
        facts: rows,
        // Anchor-graph neighbors: facts on the same files the hits are about,
        // which the topic words alone would have missed.
        ...(r.related?.length ? { relatedByFiles: r.related.map((f) => ({ id: f.id, type: f.type, fact: f.fact })) } : {}),
        totalStored: r.total,
        staleWithheld: r.staleDropped,
        // ISS-04: withheld stale facts as re-grounding pointers, not just a
        // count — what each claimed, the commit it was true at, and the file to
        // re-check. Verify before relying; do not re-derive from the gap.
        ...(r.staleGrounding.length
          ? { staleGrounding: r.staleGrounding, staleTip: 'These WERE true as of the noted commit. Re-check the `verify` file before trusting; if still true, save_memory to re-anchor; if wrong, ignore. Do not re-derive blind.' }
          : {}),
        ...(rows.some((row) => row.preview) ? { tip: 'preview rows are truncated — recall_memory({ ids: [...] }) returns full bodies' } : {}),
        // Repair queue (M3): you are on these files anyway — verifying costs ~nothing.
        ...(r.review ? { reviewRequest: { ...r.review, note: 'This stale fact shares files with your hits. If still true, re-save it with save_memory (fresh anchors); if wrong, ignore it.' } } : {}),
      });
    },
  );

  await server.connect(new StdioServerTransport());
}
