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
 *   list_worktrees— what worktrees exist, who holds them, which went quiet
 *   save_memory   — persist a learned fact (evidence-anchored, shared)
 *   recall_memory — fresh, evidence-checked facts; stale ones withheld
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { collectStatus } from './board.js';
import { detectParentAgent } from './agents.js';
import { gitRoot } from './git.js';
import { activeBatonRoot, loadTasks, projectOf } from './store.js';
import { diffStampFor, groundMovedNotice, quoted, registerPipelineTools, type RegisterTool } from './mcp-pipeline.js';
import { queryFile, searchHistory } from './history.js';
import { canonicalSignalPath, checkFiles, getSignals, isWatcherActive, recordHookEdit, registerHookSession, sessionSlug, setProgress, touchHookSession } from './signals.js';
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
import { suggestSkills } from './mcp-suggest.js';
import { nudgeChannel, type NudgeChannel } from './mcp-nudge.js';
import { TOOL_HELP, WORKTREES_FILTER_HELP } from './mcp-help.js';
import { collectWorktrees, type WorktreeHealth, type WorktreeRow } from './worktrees.js';

/**
 * Strip the one field the SDK stamps on every tool in `tools/list` whose absence
 * the MCP schema defines to mean exactly what its presence means.
 *
 * `execution: {"taskSupport":"forbidden"}`, 40 B per tool, 800 B per handshake.
 * The schema says of taskSupport: "If not present, defaults to 'forbidden'."
 * Sending it states what omitting it states, so no client can distinguish the
 * two — that is what makes this an envelope trim and not a protocol change.
 * Dropped on the way out rather than at registration because the SDK adds it
 * itself, after the config it is handed.
 *
 * `inputSchema.$schema` was stripped here too, and is not any more (2026-09-06).
 * It reads like the same kind of byte — 52 B per tool, 1,040 per handshake — but
 * it is not: a dialect declaration is a claim a strict client is entitled to
 * validate against, and nothing in the spec says its absence means the default.
 * `baton/plans/context-cost.md` said "trim wording, never fields", and for that
 * one it was right. The 1,040 bytes are paid; see docs/mcp-tools.md.
 *
 * Budgeted by test/mcp-wire-budget.test.ts, which measures the real wire.
 */
function stripWireFat(message: unknown): void {
  const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (!Array.isArray(tools)) return;                      // not a tools/list answer
  for (const tool of tools as Record<string, unknown>[]) delete tool.execution;
}

/**
 * Every registered tool answers through here.
 *
 * Two things ride out on an ordinary tool answer, neither of them asked for and
 * neither of them a tool: the ground moved under your task
 * (`groundMovedNotice`), and you have recorded nothing in a while
 * (`memoryNudge`). Baton is not inside an agent's loop, so the answer to the
 * tool it just called is the soonest moment it can possibly hear either one.
 *
 * One rider block, not one per message: an answer whose first element is a
 * three-line preamble is an answer the agent starts skipping.
 *
 * A result with no `content` array goes out untouched AND spends nothing — the
 * nudge decision is consumed only when there is somewhere to put it, because a
 * reminder dropped on the floor still restarts its fifteen-minute clock.
 *
 * Exported for test/mcp-answer-notices.test.ts, which is the guard against the
 * shape of defect this replaced: a complete, tested notice wired to nothing.
 */
export function withNotices(
  cb: (...args: never[]) => unknown,
  hooks: {
    /** Refresh session presence. Runs before the tool, on every call. */
    presence?: () => void;
    cancellation: () => Promise<string | null>;
    nudge: NudgeChannel;
  },
): (...args: never[]) => Promise<unknown> {
  return async (...args: never[]): Promise<unknown> => {
    hooks.presence?.();
    const res = await cb(...args) as { content?: { type: string; text: string }[] };
    if (!Array.isArray(res?.content)) return res;
    const notice = await hooks.cancellation();
    const reminder = hooks.nudge.notice();
    if (!notice && !reminder) return res;
    const riders = {
      ...(notice ? { batonNotice: notice } : {}),
      ...(reminder ? { batonReminder: reminder } : {}),
    };
    return { ...res, content: [{ type: 'text' as const, text: JSON.stringify(riders) }, ...res.content] };
  };
}

/** who_touched can span a file's whole history — cap what an agent is served. */
const WHO_TOUCHED_CAP = 20;
/** A busy hub can hold hundreds of live signals — cap what one answer serves. */
const SIGNALS_CAP = 30;
/**
 * The most paths one `check_files` / `touch_files` call carries.
 *
 * `z.array(z.string())` bounds neither the count nor the content, and the
 * caller is a language model: a measured 2,000-path `check_files` answered
 * 79,002 bytes — eight times the entire 9,750-byte `tools/list` handshake this
 * repo budgets to the byte — and the same list through `touch_files` writes one
 * live-signal row per path into state every other agent then reads back. Every
 * other list this server serves is capped (`SIGNALS_CAP`, `WHO_TOUCHED_CAP`);
 * these two were the exception, on the input side where it is cheapest to hold.
 */
export const PATHS_CAP = 200;

/**
 * A caller-supplied path as the signal store's own key, or null saying it has
 * none.
 *
 * `touch_files` writes what it is given into shared state, so what it accepts
 * is what every other agent and the dashboard will read. The guard it replaces
 * was `p && !p.startsWith('/') && !p.includes('..')`, which let through a NUL
 * byte (`a\0b` was measured going in and coming back out of `list_signals`), a
 * Windows drive path (`C:\win\x`, absolute everywhere it matters), and a UNC
 * share — while rejecting `test/fixtures/v1..v2.diff`, a real filename, because
 * it tested `..` as a SUBSTRING rather than as a path segment.
 *
 * It is `canonicalSignalPath` itself and not a second implementation, because
 * the rule this validator enforces and the key `checkFiles` looks up have to be
 * the same rule: when they were merely similar, `touch_files('./src/a.ts')`
 * wrote a row that `check_files(['src/a.ts'])` could not find. What it returns
 * is now the FOLDED path — the spelling actually recorded — which is also what
 * `touch_files` echoes back in `touched`, so the caller is shown the key it got.
 *
 * Exported for test/mcp-args.test.ts.
 */
export function repoRelative(raw: string): string | null {
  return canonicalSignalPath(raw).key;
}

/**
 * Split a caller's path list at `PATHS_CAP`.
 *
 * Returned as two halves rather than truncated, because what was NOT looked at
 * is the half that matters: `check_files` exists to answer "is anyone else on
 * this file", and a path quietly dropped from the question reads in the answer
 * exactly like a path nobody is editing. The caller names them instead.
 */
export function capPaths(paths: string[], cap = PATHS_CAP): { within: string[]; skipped: string[] } {
  return paths.length <= cap
    ? { within: paths, skipped: [] }
    : { within: paths.slice(0, cap), skipped: paths.slice(cap) };
}

/**
 * `search_history`'s `limit`, as SQLite will accept it.
 *
 * `z.number()` admits 2.7 and Infinity, and `history.ts` clamps with
 * `Math.max(1, Math.min(limit, 25))` — which keeps 2.7 as 2.7, binds it to
 * `LIMIT ?`, and gets back the driver's own words: the measured answer to
 * `search_history({ query: 'a', limit: 2.7 })` was `isError: true,
 * "datatype mismatch"`. An agent reading that learns nothing and simply loses
 * search. Rounded here, at the boundary that owns the tool's documented
 * contract ("Max hits (default 10, max 25)").
 */
export function historyLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 25));
}

/* ------------------------------------------------------------------ */
/* list_worktrees — the projection of the worktree read-model            */
/* ------------------------------------------------------------------ */

/** `unmanaged` is left out: this tool serves Baton's own rows only, so a filter
 *  of it could only ever answer empty — and is refused instead. */
type BatonHealth = Exclude<WorktreeHealth, 'unmanaged'>;

/**
 * The health vocabulary as a runtime value, because a refusal has to be able to
 * name it.
 *
 * `WorktreeHealth` (worktrees.ts) is a type and erases at build time, and the
 * one thing this list must never do is drift from it: a filter validated
 * against a stale copy would refuse a health the read-model genuinely derives.
 * The two lines below make that a COMPILE error in both directions —
 * `satisfies` rejects a name that is not a health, and `_healthsAreComplete`
 * rejects a health that is missing here. Nothing about the health LADDER is
 * duplicated; deriving health remains `deriveHealth`'s job and only its job.
 */
export const WORKTREE_HEALTHS = [
  'working', 'quiet', 'stalled', 'abandoned',
  'ok', 'dirty', 'conflict', 'rebasing', 'missing', 'orphan-disk', 'unknown',
] as const satisfies readonly BatonHealth[];

type MissingHealth = Exclude<BatonHealth, (typeof WORKTREE_HEALTHS)[number]>;
// Wrapped in a tuple on purpose: a bare `MissingHealth extends never` is a
// distributive conditional and evaluates to `never` when the list IS complete,
// which would fail exactly when nothing is wrong.
const _healthsAreComplete: [MissingHealth] extends [never] ? true : MissingHealth = true;
void _healthsAreComplete;

/** One worktree as an agent is served it. A strict subset of `WorktreeRow` —
 *  what a sibling agent needs to decide "leave it alone" or "take it over". */
export interface WorktreeBrief {
  slug: string;
  branch: string | null;
  state: string | null;
  /** Straight from `deriveHealth`. Never rewritten here — see `worktreeBrief`. */
  health: WorktreeHealth;
  /** Who holds it: the task record's claim, else the process actually detected. */
  holder: string | null;
  /** The fact nothing else in the product states: claimed, but is anyone there? */
  holderRunning: boolean;
  quietForMs: number | null;
  /** Present only on the caller's own worktree. */
  mine?: true;
}

/**
 * Path identity as the filesystem sees it, not as the string looks — the same
 * hazard `worktrees.ts:samePath` documents. `git worktree list` reports
 * `/private/var/...` on macOS while a shell's `cwd` reports `/var/...`, so a
 * string compare decides an agent standing inside its own worktree is standing
 * nowhere. Falls back to `resolve` for a path that is gone (health `missing`).
 */
function realPath(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** Containment by path SEGMENT, not by prefix: `/wt/a-two` starts with `/wt/a`
 *  and is a different worktree. */
function contains(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Which row is the caller's own.
 *
 * `cwd` first, and it wins: where the process actually stands is a physical
 * fact, and an agent that `cd`-ed into a worktree is working in THAT one
 * whatever its `BATON_SLUG` says. A subdirectory counts — agents stand in
 * `src/`, not at the worktree root — and the deepest match wins, so a worktree
 * nested inside another is not credited to its parent.
 *
 * `BATON_SLUG` is the fallback for the ordinary hub case: an agent invoked at
 * the repo root holds a task whose worktree is elsewhere on disk.
 *
 * Exported for test/mcp-worktrees.test.ts.
 */
export function ownWorktreeSlug(
  rows: readonly Pick<WorktreeRow, 'slug' | 'worktreePath'>[],
  cwd: string,
  taskSlug?: string,
): string | null {
  const here = realPath(cwd);
  let best: { slug: string; len: number } | null = null;
  for (const r of rows) {
    const wt = realPath(r.worktreePath);
    if (!contains(wt, here)) continue;
    if (!best || wt.length > best.len) best = { slug: r.slug, len: wt.length };
  }
  if (best) return best.slug;
  if (taskSlug && rows.some((r) => r.slug === taskSlug)) return taskSlug;
  return null;
}

/**
 * Rows → the answer. Pure, so the projection is testable without a daemon.
 *
 * `health` is COPIED, never recomputed. There is exactly one definition of it
 * in this codebase (`worktrees.ts:deriveHealth`) and this function is not
 * allowed to become a second one — in particular `unknown` travels through
 * untouched. The read-model fails closed on purpose, and softening that here
 * ("probably fine") would launder dead work into looking fresh one layer
 * further out, which is the reported bug.
 *
 * An unrecognised filter is REFUSED rather than resolved to nothing: "no
 * worktrees matched" and "you typed a health that does not exist" read
 * identically as an empty list, and the first of those is the most dangerous
 * answer this tool can give.
 *
 * Exported for test/mcp-worktrees.test.ts.
 */
export function worktreeBrief(
  rows: readonly WorktreeRow[],
  opts: { cwd: string; taskSlug?: string; filter?: string },
): { worktrees: WorktreeBrief[]; mine: string | null } | { refused: string } {
  const asked = opts.filter?.trim().toLowerCase();
  let health: WorktreeHealth | null = null;
  if (asked) {
    const match = WORKTREE_HEALTHS.find((h) => h === asked);
    if (!match) {
      return { refused: `unknown health ${quoted(opts.filter ?? '', 40)} — use one of: ${WORKTREE_HEALTHS.join(', ')}` };
    }
    health = match;
  }
  // Baton's own rows only, and BEFORE `ownWorktreeSlug`: a main checkout
  // contains the repo root, so an agent standing there would otherwise be
  // handed the main row as `mine` instead of its BATON_SLUG fallback. The
  // route has already paid for listing every repo; this drops that half.
  // An orphan's `~` id does reach agents, and `take_task` refuses it.
  const baton = rows.filter((r) => r.kind === 'task' || r.kind === 'orphan');
  const mine = ownWorktreeSlug(baton, opts.cwd, opts.taskSlug);
  const worktrees = baton
    .filter((r) => health === null || r.health === health)
    .map((r) => ({
      slug: r.slug,
      branch: r.branch,
      state: r.state,
      health: r.health,
      // The record's claim first: "codex claimed this" is the useful half of
      // "codex claimed this and no codex is running" (health `abandoned`).
      holder: r.claimedBy ?? r.agent,
      holderRunning: r.holderRunning,
      quietForMs: r.quietForMs,
      ...(r.slug === mine ? { mine: true as const } : {}),
    }));
  return { worktrees, mine };
}

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

  // The capture nudge rides this same channel (see mcp-nudge.ts): a session
  // that has learned something durable and recorded nothing hears about it on
  // whatever tool it calls next. Deliberately not a tool of its own — a tool
  // costs a schema in every session's `tools/list` forever, and a reminder the
  // agent has to remember to ask for is exactly what a forgetful agent will not
  // ask for. Zero bytes on the wire; the budget test proves it.
  const nudge = nudgeChannel(Date.now());

  const reg = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    (server.registerTool as (...x: unknown[]) => unknown)(
      name,
      config,
      withNotices(cb, { presence: presenceTouch, cancellation: cancellationNotice, nudge }),
    )) as unknown as typeof server.registerTool;

  reg(
    'orient',
    {
      description: TOOL_HELP.orient,
      inputSchema: { topic: z.string().optional().describe('What you are about to work on; biases the facts') },
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
      const { within, skipped } = capPaths(paths);
      const [files, view, project] = await Promise.all([
        checkFiles(root, within, selfSlug),
        remoteClaims(root),
        projectOf(root, selfSlug),
      ]);
      const elsewhere = remoteHoldersFor(view, within, undefined, project);
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
        // Over the cap. Named, never silently dropped: an unasked path is
        // indistinguishable in this answer from a path nobody is editing, and
        // "not busy" is exactly the conclusion this tool exists to prevent an
        // agent from reaching without evidence.
        ...(skipped.length
          ? {
            notChecked: {
              count: skipped.length,
              first: skipped.slice(0, 5),
              note: `Over the ${PATHS_CAP}-path cap for one call — these were NOT checked. Ask again in smaller batches; do not read their absence as "not busy".`,
            },
          }
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
      asText(slug
        // `quoted` because the slug is the caller's own text: a 50 KB one was
        // measured coming straight back out inside this message.
        ? (getReport(root, slug) ?? { error: `no report for '${quoted(slug, 80)}'` })
        : listReports(root, 10).map(reportSummary)),
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

  // Sessions are `list_tasks`; WORKTREES are this. The two are not the same
  // question: a task row says what the board believes, and this says whether
  // the worktree behind it is actually moving, who holds it, and what is at
  // risk if it is not. Everything it serves comes from `collectWorktrees` —
  // one read-model, one definition of health, no second opinion here.
  //
  // Read-only: `collectWorktrees` creates no ref, writes no file and reclaims
  // nothing, so this tool is safe to call from anywhere at any time.
  reg(
    'list_worktrees',
    {
      description: TOOL_HELP.list_worktrees,
      inputSchema: { health: z.string().optional().describe(WORKTREES_FILTER_HELP) },
    },
    // `process.cwd()` is the agent's own worktree when it has one: `baton mcp`
    // runs one process per agent session, started where the agent is working.
    async ({ health }) => asText(worktreeBrief(
      await collectWorktrees(root),
      { cwd: process.cwd(), taskSlug, filter: health },
    )),
  );

  reg(
    'report_progress',
    {
      description: TOOL_HELP.report_progress,
      inputSchema: { note: z.string().describe('One line: what you are doing + progress') },
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
        })).optional().describe('Your full checklist; replaces the stored one'),
        notes: z.array(z.string()).optional().describe('Decisions/findings the next agent needs'),
        next: z.string().optional().describe('Most useful next action for whoever resumes'),
        files: z.array(z.string()).optional().describe('Repo-relative files you edited (accumulated)'),
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
      // A write into state every other agent reads, so both halves are bounded:
      // how many rows one call may add, and what may go in one.
      const { within, skipped } = capPaths(paths);
      const touched: string[] = [];
      const ignored: string[] = [];
      for (const raw of within) {
        const p = repoRelative(raw);
        if (p) touched.push(p);
        else if (raw.trim()) ignored.push(quoted(raw, 80));
      }
      for (const p of touched) recordHookEdit(root, { slug: selfSlug, path: p });
      // ISS-03: keep a resumable HANDOFF.md fresh for agents that reach us via
      // MCP rather than an edit hook (Codex/Gemini). Only for a real task
      // (taskSlug); debounced + best-effort so it never blocks or fails the tool.
      if (taskSlug && touched.length) {
        void snapshotTask(taskSlug, { root, from: process.env.BATON_AGENT?.trim() }).catch(() => {});
      }
      return asText({
        touched,
        as: selfSlug,
        // Previously dropped in silence, which reads as "declared" — the one
        // reading under which an agent goes on to edit a file nobody knows it
        // holds. A refused path is said out loud, with the rule it broke.
        ...(ignored.length || skipped.length
          ? {
            ...(ignored.length ? { ignored: ignored.slice(0, 5) } : {}),
            ...(skipped.length ? { overCap: skipped.length } : {}),
            why: `Declare repo-relative paths only: no absolute or \`..\` paths, no control or invisible characters, ${PATHS_CAP} per call. \`./a\`, \`a//b\` and \`a\\b\` are accepted and recorded as \`a/b\` — one file is one signal.`,
          }
          : {}),
      });
    },
  );

  reg(
    'search_history',
    {
      description: TOOL_HELP.search_history,
      inputSchema: {
        query: z.string().describe('Keywords: symbols, file names, message words'),
        limit: z.number().optional().describe('Max hits (default 10, max 25)'),
      },
    },
    async ({ query, limit }) => asText({ hits: searchHistory(root, query, historyLimit(limit)) }),
  );

  reg(
    'create_handoff',
    {
      description: TOOL_HELP.create_handoff,
      inputSchema: {
        title: z.string().describe('One line: what this work is'),
        done: z.array(z.string()).optional().describe('Completed items'),
        pending: z.array(z.string()).optional().describe('Remaining items, most important first'),
        next: z.string().optional().describe('Most useful next action for whoever resumes'),
        decisions: z.array(z.string()).optional().describe('Decisions and gotchas git cannot show'),
        suggested_skills: z.array(z.string()).optional().describe('Skills the next agent should invoke, e.g. "bug-fix"'),
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
        fact: z.string().describe('The fact: 1-3 sentences, why + how to apply'),
        type: z.enum(MEMORY_TYPES as [string, ...string[]]).optional().describe('Which kind of fact this is'),
        files: z.array(z.string()).optional().describe('Repo-relative files this fact is about (anchors, max 8)'),
        agent: z.string().optional().describe('Your agent name, e.g. "claude"'),
        task: z.string().optional().describe('Task slug you are working on'),
        local_only: z.boolean().optional().describe('Keep out of git: private to this machine. Not for secrets — those are refused'),
      },
    },
    async ({ fact, type, files, agent, task, local_only }) => {
      try {
        // memory.ts resolves the MAIN repo root internally (worktree-safe).
        const saved = await saveMemory(memRoot, { fact, type, files, agent, task, localOnly: local_only });
        // This session's memory is current again, so the capture reminder goes
        // quiet for another interval. Only a real save counts: a rejected one
        // recorded nothing.
        nudge.saved();
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
        topic: z.string().optional().describe('What you are working on; ranks facts by relevance'),
        limit: z.number().optional().describe('Max facts to return (default 10, max 50)'),
        ids: z.array(z.string()).optional().describe('Fetch these facts in full (hydrates previews)'),
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
    'suggest_skills',
    {
      description: TOOL_HELP.suggest_skills,
      inputSchema: { task: z.string().describe('What you are about to do') },
    },
    async ({ task }) => asText({ skills: await suggestSkills(root, String(task ?? '')) }),
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
        slug: z.string().describe('The brief you finished; next_handoff names it'),
        note: z.string().optional().describe('What you did, for whoever reviews it: outcome, what you verified, what is left'),
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

  // Every answer goes out through here, so the tools/list trim happens once,
  // at the one place that sees the finished payload.
  const transport = new StdioServerTransport();
  const deliver = transport.send.bind(transport);
  transport.send = async (...args: Parameters<typeof transport.send>) => {
    stripWireFat(args[0]);
    return deliver(...args);
  };
  await server.connect(transport);
}
