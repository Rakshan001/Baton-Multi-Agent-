// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { activeBatonRoot, loadTasks, projectOf } from './store.js';
import { diffStampFor, groundMovedNotice, registerPipelineTools, type RegisterTool } from './mcp-pipeline.js';
import { queryFile, searchHistory } from './history.js';
import { checkFiles, getSignals, isWatcherActive, recordHookEdit, registerHookSession, sessionSlug, setProgress, touchHookSession } from './signals.js';
import { getReport, listReports, reportSummary } from './reports.js';
import { remoteClaims, remoteHoldersFor, remoteNote } from './remote-claims.js';
import { MemoryValidationError, MEMORY_TYPES, recallMemories, recallRows, saveMemory } from './memory.js';
import { createSessionHandoff } from './handoff/session-brief.js';
import { nextHandoff } from './handoff/next.js';
import { resolveBriefBySlug } from './handoff/resolve.js';
import { listBriefs } from './handoff/resume.js';
import { saveProgress } from './handoff/progress-ledger.js';
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
/** How often a task-bound session re-reads its own row to notice a cancellation
 *  or a takeover. Cheap (one small JSON read) but not free, so debounced. */
const STATE_CHECK_MS = 15_000;

export async function startMcpServer(): Promise<void> {
  // Coordination store: an agent runs `baton mcp` from inside its worktree, so
  // gitRoot() would point at an empty per-worktree shadow store. activeBatonRoot
  // finds the real hub/repo .baton (and honors BATON_ROOT for spawned agents).
  const root = await activeBatonRoot();
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
      const agent = process.env.BATON_AGENT?.trim() || (await detectParentAgent(6, root));
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
  // Cancellation notice. An agent working in a worktree has no reason to look
  // at the board again, so a task cancelled (or taken over) under it would be
  // discovered at `complete_task` — after the work. Every tool answer carries
  // the notice instead, because whatever the agent called next is the soonest
  // moment it can hear. Debounced, and only for a session that holds a task.
  const noticeState = { at: 0, sent: '' };
  const cancellationNotice = async (): Promise<string | null> => {
    if (!taskSlug) return null;                           // no task, no ground to move
    const now = Date.now();
    if (now - noticeState.at < STATE_CHECK_MS) return null;
    noticeState.at = now;
    try {
      const notice = groundMovedNotice(
        (await loadTasks(root)).find((x) => x.slug === taskSlug), taskSlug, selfSlug,
      );
      if (!notice || notice === noticeState.sent) return null;   // say it once, not every call
      noticeState.sent = notice;
      return notice;
    } catch { return null; }                              // never break a tool call over this
  };

  const reg = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    (server.registerTool as (...x: unknown[]) => unknown)(name, config, async (...a: unknown[]) => {
      presenceTouch();
      const res = await cb(...a) as { content?: { type: string; text: string }[] };
      const notice = await cancellationNotice();
      if (notice && Array.isArray(res?.content)) {
        return { ...res, content: [{ type: 'text' as const, text: JSON.stringify({ batonNotice: notice }) }, ...res.content] };
      }
      return res;
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
    async ({ paths }) => {
      /*
       * Local signals AND the host's federated claims. Without the second half
       * a teammate's claim is visible to a human on the dashboard and invisible
       * to the agent about to overwrite their work.
       *
       * `remote` is always present when a host is linked, including when it
       * could not be reached — an agent must be able to tell "nobody else is on
       * this file" from "I could not find out", and only the first is a reason
       * to proceed confidently.
       */
      const [files, view, project] = await Promise.all([
        checkFiles(root, paths, selfSlug),
        remoteClaims(root),
        projectOf(root, selfSlug),
      ]);
      const elsewhere = remoteHoldersFor(view, paths, undefined, project);
      for (const [p, holders] of Object.entries(elsewhere)) {
        if (files[p]) files[p] = { ...files[p], busy: true, elsewhere: holders };
      }
      const note = remoteNote(view);
      /*
       * The remote semantics are taught HERE, in the answer, and only when they
       * apply — never in TOOL_HELP. Same reasoning as recall_memory's `ids`
       * (see the comment in mcp-help.ts): a description is a tax every session
       * pays before doing any work, whereas a tip costs nothing until the day
       * there is actually a teammate on the other end of the file.
       */
      const tip = Object.keys(elsewhere).length
        ? 'A path with `elsewhere` is held by a teammate on another machine. Claims are advisory, not locks — prefer other work, or agree with them first.'
        : note
          ? 'Remote claims could not be fetched, so "not busy" covers THIS machine only.'
          : null;
      return asText({
        watcherActive: isWatcherActive(root),
        files,
        ...(view.linked
          ? { remote: { reachable: view.reachable, ...(note ? { note } : {}) } }
          : {}),
        ...(tip ? { tip } : {}),
      });
    },
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
      // Scope blame to the asker's sub-project: paths are worktree-relative, so
      // an unscoped `src/index.ts` in a hub returned every project's history and
      // named agents that never opened this file. projectOf yields null outside
      // a hub, which queryFile reads as "don't scope".
      const [hits, live] = [queryFile(root, file, await projectOf(root, selfSlug)), await checkFiles(root, [file], selfSlug)];
      const capped = capList(hits, WHO_TOUCHED_CAP);
      // Landed vs still on a branch. `history reindex` walks task branches, so
      // the index now carries real commits that are NOT on main — and reporting
      // those under `merged` would tell an agent to build against code that is
      // nowhere it can see.
      const landed = capped.items.filter((h) => h.merged);
      const inFlight = capped.items.filter((h) => !h.merged);
      return asText({
        merged: landed,
        moreMerged: capped.more,
        ...(inFlight.length ? { onBranchNotYetMerged: inFlight } : {}),
        live: live[file],
      });
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
    'save_progress',
    {
      description: TOOL_HELP.save_progress,
      inputSchema: {
        plan: z.array(z.object({
          content: z.string().describe('The checklist item'),
          status: z.string().optional().describe('pending | in_progress | completed'),
        })).optional().describe('Your full current plan/checklist (replaces the stored one)'),
        notes: z.array(z.string()).optional().describe('Decisions/findings the next agent should see'),
        next: z.string().optional().describe('The single most useful next action for whoever resumes'),
        files: z.array(z.string()).optional().describe('Repo-relative files you have edited (accumulated)'),
      },
    },
    async ({ plan, notes, next, files }) => {
      try {
        // Stamp the checkpoint with the diff at this moment. A ledger is what
        // everyone downstream reads INSTEAD of the diff, so a ticked-off item
        // with nothing behind it is invisible unless the two are compared here.
        const stamp = taskSlug ? await diffStampFor(root, taskSlug) : undefined;
        const led = await saveProgress(root, selfSlug, { plan, notes, next, filesEdited: files, stamp });
        return asText({
          saved: selfSlug, plan: led.plan.length, notes: led.notes.length, files: led.filesEdited.length,
          ...(led.stamp ? { stamp: led.stamp } : {}),
          // Returned to the agent that wrote it, not just recorded: the moment
          // it can still correct the claim is right now.
          ...(led.flagged ? { flagged: led.flagged } : {}),
        });
      } catch (e) {
        return asText({ rejected: e instanceof Error ? e.message : String(e) });
      }
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
        const agent = process.env.BATON_AGENT?.trim() || (await detectParentAgent(6, root).catch(() => undefined)) || undefined;
        const brief = await createSessionHandoff(root, {
          slug: selfSlug, agent, title, done, pending, next, decisions, suggestedSkills: suggested_skills, to, cwd: process.cwd(),
        });
        return asText({
          brief: brief.path,
          pickup: brief.resume,
          ...(brief.capturedFacts.length ? { memorized: brief.capturedFacts } : {}),
          // A decision the memory gate refused is worth one line back: you are
          // the only one who can restate it durably, and the brief still has it.
          ...(brief.skippedFacts.length ? { notMemorized: brief.skippedFacts } : {}),
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
        local_only: z.boolean().optional().describe('Keep this fact out of git — for something private to this machine, not for secrets (those are refused outright)'),
      },
    },
    async ({ fact, type, files, agent, task, local_only }) => {
      try {
        // memory.ts resolves the MAIN repo root internally (worktree-safe).
        const saved = await saveMemory(memRoot, { fact, type, files, agent, task, localOnly: local_only });
        return asText({
          saved: saved.id,
          // Where it went, always — an agent that cannot see this cannot tell
          // whether it just wrote something the whole team will read.
          shared: saved.area !== 'local',
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
        // `author` rides the HYDRATION path only, never `recallRows` below.
        // Rows are served on every recall in every session, so a field there is
        // a permanent context tax; asking for a fact by id is the moment you are
        // actually scrutinizing it, and "whose claim is this" is what you need
        // to challenge it.
        return asText({
          facts: r.facts.map((f) => ({ id: f.id, type: f.type, fact: f.fact, task: f.task, author: f.author, freshness: f.freshness, commitsBehind: f.commitsBehind })),
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

  reg(
    'next_handoff',
    { description: TOOL_HELP.next_handoff, inputSchema: {} },
    async () => asText(nextHandoff(await listBriefs(root))),
  );

  reg(
    'resolve_handoff',
    {
      description: TOOL_HELP.resolve_handoff,
      inputSchema: {
        slug: z.string().describe('The brief you finished, e.g. "sess-p1234" — next_handoff names it'),
        note: z.string().optional().describe('What you actually did, for whoever reviews it: outcome, what you verified, anything left'),
      },
    },
    async ({ slug, note }) => {
      const by = process.env.BATON_AGENT?.trim() || selfSlug;
      const r = await resolveBriefBySlug(root, slug, { by, note });
      if (!r.closed) {
        // Not an error to throw at an agent reporting finished work — the brief
        // may simply have been closed already. Say so, and give it the next move.
        return asText({ closed: false, reason: r.error, tip: 'Call next_handoff to see what is actually open.' });
      }
      const remaining = nextHandoff(await listBriefs(root));
      return asText({
        closed: slug,
        title: r.title,
        report: r.path,
        // Closing one brief usually unblocks another. Saying which, here, is
        // the difference between a relay and a queue somebody has to poll.
        ...(remaining.next ? { nowReady: remaining.next.slug, pickup: remaining.next.pickup } : {}),
        open: remaining.open,
      });
    },
  );

  registerPipelineTools(reg as unknown as RegisterTool, root);

  await server.connect(new StdioServerTransport());
}
