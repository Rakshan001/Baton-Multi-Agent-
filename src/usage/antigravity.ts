// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Antigravity (Gemini CLI) session logs, read from
 * `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
 *
 * This is the honest-gap parser. What the format DOES provide, per step:
 *   - `step_index`, `source` (USER / MODEL / SYSTEM), `type`
 *     (PLANNER_RESPONSE, RUN_COMMAND, VIEW_FILE, …), `status`
 *   - `created_at` — so first/last activity and a turn count are real
 *   - `tool_calls[].args` — including the absolute paths the agent worked in
 *     (`Cwd`, `DirectoryPath`, `AbsolutePath`, `TargetFile`, `SearchPath`,
 *     `SearchDirectory`), each value itself a JSON-encoded string
 *
 * What it DOES NOT provide, and what therefore comes back null:
 *   - input tokens, output tokens, cache reads, cache writes — there is no
 *     token accounting of any kind in the step records
 *   - the model name, so there is no price to apply: **cost is always null**
 *   - a session cwd (see attribution below)
 *
 * Checked against every transcript on the machine this was written on:
 * 6,345 steps across 27 sessions, and not one structured token field. The
 * plan's expected sparse `tokenCount` turned out to be text inside command
 * output, not a field. Support for it is kept below anyway — if a future CLI
 * emits a bare `tokenCount` per step, it is summed and reported as the session
 * total and as consumed (none of it is a cache read), with the input/output
 * split and the cost still absent. Nothing
 * here is ever derived from character counts or message lengths: a made-up
 * number in a spend table is worse than a blank.
 *
 * (There is also a per-conversation SQLite store at
 * `~/.gemini/antigravity-cli/conversations/<id>.db`, whose rows are opaque
 * protobuf blobs with no field names. If Antigravity's token counts exist
 * anywhere on disk, that is where to look next.)
 *
 * ATTRIBUTION — INFERRED, and it says so. The format records no session cwd,
 * so a session is placed by the absolute paths its own tool calls touched.
 * That is evidence from the log rather than a guess about spend, but it is
 * still a deduction: the alternatives are dropping every Antigravity session
 * (the turns and timestamps here are real, and losing them hides an agent that
 * IS working in this repo) or attributing them all to the repo (which would
 * quietly claim other projects' sessions). So the session is placed, and
 * carries `attribution: 'inferred'` all the way to the screen, which labels it
 * — inferred placement never renders as if it had been measured.
 *
 * Placement goes to wherever MOST of those paths live: agents read across
 * repos, and one glance at a file here does not make another project's session
 * this repo's. A session whose work mostly happened elsewhere, or that left no
 * path at all, is not reported here.
 *
 * Streamed line by line — a long session's transcript runs to megabytes.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readLines } from '../handoff/claude-session.js';
import { cachedSessionUsage, countOf, slugForCwd, widenSpan, type ParsedSession, type SessionUsage } from '../usage.js';
import type { Task } from '../store.js';

/** A parsed transcript, plus the paths it touched (how it maps to a task). */
export interface AntigravitySession extends ParsedSession {
  paths: string[];
}

/** Where this parser reads from, for the dashboard's roster. Display only —
 *  the real directory comes from `antigravityBrainDir()`. */
export const ANTIGRAVITY_READ_FROM =
  '~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl';

/** Where the Antigravity CLI keeps its per-session working directories. */
export function antigravityBrainDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'brain');
}

const TRANSCRIPT = join('.system_generated', 'logs', 'transcript.jsonl');

/** One transcript per brain session directory ([] when there is no brain dir). */
async function listTranscripts(brainDir: string): Promise<string[]> {
  try {
    const entries = await readdir(brainDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(brainDir, e.name, TRANSCRIPT)).sort();
  } catch {
    return []; // no Antigravity on this machine
  }
}

/** Tool-call argument keys that carry an absolute path. */
const PATH_ARGS = ['Cwd', 'DirectoryPath', 'AbsolutePath', 'TargetFile', 'SearchPath', 'SearchDirectory'];

/** Args arrive as JSON-encoded strings: `"\"/some/path\""`. */
function unquote(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.startsWith('"') && v.endsWith('"') && v.length > 1 ? v.slice(1, -1) : v;
  return s.startsWith('/') ? s : null;
}

interface Step {
  source?: string;
  type?: string;
  created_at?: string;
  tokenCount?: unknown;
  tool_calls?: Array<{ args?: Record<string, unknown> }>;
}

/** Parse one transcript. Defensive: unknown or truncated lines are skipped. */
export async function parseAntigravityTranscript(file: string): Promise<AntigravitySession> {
  const paths: string[] = [];
  const out: AntigravitySession = {
    sessionId: basename(dirname(dirname(dirname(file)))),
    paths,
    agent: 'antigravity',
    // Deduced from the paths the tool calls touched — see ATTRIBUTION above.
    // Marked so the screen can label it rather than showing it as measured.
    attribution: 'inferred',
    // No model is recorded, so no price applies — see the header.
    model: null,
    turns: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    // A bare `tokenCount` counts here too: it has no split, but none of it is a cache read.
    consumedTokens: null,
    estCostUsd: null,
    firstAt: null,
    lastAt: null,
  };
  try {
    for await (const line of readLines(file)) {
      let s: Step;
      try {
        s = JSON.parse(line);
      } catch {
        continue; // truncated tail of a session still being written
      }
      if (s.created_at) widenSpan(out, s.created_at);
      if (s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE') out.turns++;
      const count = countOf(s.tokenCount);
      if (count != null) {
        out.totalTokens = (out.totalTokens ?? 0) + count;
        out.consumedTokens = out.totalTokens; // not cache reads, so all of it was consumed
      }
      for (const call of s.tool_calls ?? []) {
        for (const key of PATH_ARGS) {
          const p = unquote(call.args?.[key]);
          if (p && !paths.includes(p)) paths.push(p);
        }
      }
    }
  } catch {
    /* unreadable mid-file — keep what we have */
  }
  return out;
}

/** Vote keys for the two slots that are not a task slug. A slug is a safe
 *  path segment, so a NUL prefix can never collide with one. */
const ELSEWHERE = '\0elsewhere';
const REPO = '\0repo';

/** Specificity for tie-breaks: task worktree > repo > another project. */
const rank = (key: string): number => (key === ELSEWHERE ? 0 : key === REPO ? 1 : 2);

/**
 * Where most of a session's paths live: a task slug, `null` for the repo
 * itself, or `undefined` when the plurality lies outside this repo (or there
 * is nothing to go on). Ties go to the more specific slot — a task worktree
 * over the repo, and the repo over another project.
 */
function placeByPaths(paths: string[], root: string, tasks: Task[], at: string | null): string | null | undefined {
  const votes = new Map<string, number>();
  for (const p of paths) {
    const slot = slugForCwd(p, root, tasks, at);
    const key = slot === undefined ? ELSEWHERE : (slot ?? REPO);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  let best = ELSEWHERE;
  let bestCount = 0;
  for (const [key, count] of votes) {
    if (count > bestCount || (count === bestCount && rank(key) > rank(best))) [best, bestCount] = [key, count];
  }
  if (bestCount === 0 || best === ELSEWHERE) return undefined;
  return best === REPO ? null : best;
}

/**
 * Antigravity sessions that worked in `root` or one of its task worktrees.
 * Their token columns are null by design: this agent's logs do not carry the
 * numbers, and saying so is the point.
 *
 * `brainDir` exists so tests can point at a committed fixture tree.
 */
export async function antigravitySessions(
  root: string,
  tasks: Task[],
  brainDir = antigravityBrainDir(),
): Promise<SessionUsage[]> {
  const sessions: SessionUsage[] = [];
  for (const file of await listTranscripts(brainDir)) {
    const usage = (await cachedSessionUsage(file, parseAntigravityTranscript)) as AntigravitySession | null;
    if (!usage || usage.turns === 0) continue;
    const slug = placeByPaths(usage.paths, root, tasks, usage.firstAt);
    if (slug === undefined) continue; // worked elsewhere, or left no trace of where it worked
    const { paths: _paths, ...rest } = usage;
    sessions.push({ ...rest, slug });
  }
  return sessions;
}
