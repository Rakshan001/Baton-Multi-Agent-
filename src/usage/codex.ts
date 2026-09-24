// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Codex CLI token usage, parsed from its rollout logs
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`).
 *
 * What this format DOES provide, per model call, in an `event_msg` line whose
 * `payload.type` is `token_count`:
 *   - `input_tokens`      — total prompt tokens, INCLUDING the cached ones
 *   - `cached_input_tokens` — the cached slice of that input
 *   - `cache_write_input_tokens` — newer CLIs only; absent in older rollouts
 *   - `output_tokens` (with `reasoning_output_tokens` already inside it)
 *   - `total_tokens`
 * plus the session's `cwd` and `session_id` in the opening `session_meta`
 * line, and the model in `turn_context`.
 *
 * What it does NOT provide: a price. Codex models are not in the Claude price
 * table, so `estCostUsd` stays null — an OpenAI model billed at Claude's rates
 * would be fiction, and a fictional number in a spend table is worse than a
 * blank.
 *
 * THE TRAP: every `token_count` event carries BOTH `last_token_usage` (this
 * call) and `total_token_usage` (the session so far). Summing both double
 * counts the whole session. Only `last_token_usage` is read here; the running
 * total is deliberately ignored. Verified against real rollouts: the sum of
 * the per-call figures equals the final running total exactly.
 *
 * Streamed line by line — a long session's rollout is megabytes.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readLines } from '../handoff/claude-session.js';
import {
  cachedSessionUsage,
  consumedOf,
  countOf,
  estimateCostUsd,
  slugForCwd,
  totalOf,
  widenSpan,
  type ParsedSession,
  type SessionUsage,
} from '../usage.js';
import type { Task } from '../store.js';

/** A parsed rollout, plus the cwd it ran in (how it maps to a task). */
export interface CodexSession extends ParsedSession {
  cwd: string | null;
}

/** Where this parser reads from, for the dashboard's roster. Display only —
 *  the real directory comes from `codexSessionsDir()`. */
export const CODEX_READ_FROM = '~/.codex/sessions/**/rollout-*.jsonl';

/** Where the Codex CLI keeps its rollouts. */
export function codexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

/** Every `rollout-*.jsonl` under `dir` (it nests by year/month/day). */
async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // no Codex on this machine, or an unreadable day directory
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listRollouts(full)));
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out.sort();
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    cwd?: string;
    session_id?: string;
    model?: string;
    info?: { last_token_usage?: TokenUsage; total_token_usage?: TokenUsage };
  };
}

/** Parse one rollout. Defensive: unknown or truncated lines are skipped. */
export async function parseCodexRollout(file: string): Promise<CodexSession> {
  const out: CodexSession = {
    sessionId: basename(file, '.jsonl'),
    cwd: null,
    agent: 'codex',
    // `session_meta.cwd` is a recorded working directory, not a deduction.
    attribution: 'measured',
    model: null,
    turns: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    consumedTokens: null,
    estCostUsd: null,
    firstAt: null,
    lastAt: null,
  };
  const add =(k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens', n: unknown) => {
    const v = countOf(n); // absent — or malformed, which is the same thing — stays absent
    if (v == null) return;
    out[k] = (out[k] ?? 0) + v;
  };
  try {
    for await (const line of readLines(file)) {
      let m: RolloutLine;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // truncated tail of a session still being written
      }
      const p = m.payload;
      if (m.timestamp) widenSpan(out, m.timestamp);
      if (m.type === 'session_meta') {
        if (typeof p?.cwd === 'string') out.cwd ??= p.cwd;
        if (typeof p?.session_id === 'string') out.sessionId = p.session_id;
        continue;
      }
      if (typeof p?.model === 'string') out.model = p.model;
      // Per-call figures only. `total_token_usage` is the same numbers summed
      // for us already — reading both would double count.
      const u = p?.info?.last_token_usage;
      if (!u) continue;
      out.turns++;
      // `countOf`, not `typeof`: a cached slice of Infinity passes a typeof
      // check, and `input - Infinity` clamps to a measured-looking 0 — a real
      // input measurement replaced by a claim that it used none.
      const cached = countOf(u.cached_input_tokens) ?? 0;
      const input = countOf(u.input_tokens);
      // Claude's shape keeps input and cache-read disjoint; Codex's input
      // includes the cached slice, so subtract it rather than counting twice.
      add('inputTokens', input == null ? undefined : Math.max(0, input - cached));
      add('cacheReadTokens', u.cached_input_tokens);
      add('cacheWriteTokens', u.cache_write_input_tokens);
      add('outputTokens', u.output_tokens);
      add('totalTokens', u.total_tokens);
    }
  } catch {
    /* unreadable mid-file — keep what we have */
  }
  out.totalTokens ??= totalOf(out);
  out.consumedTokens = consumedOf(out); // input is already the uncached slice here
  out.estCostUsd = estimateCostUsd(out.model, out);
  return out;
}

/**
 * Codex sessions belonging to `root` or one of its task worktrees, mapped to
 * slugs the same way Claude's are.
 *
 * A session whose cwd is inside the repo but matches no task worktree IS kept,
 * attributed to the repo itself (`slug: null`) — that is the "matches no task"
 * case, and dropping it would lose real spend. A session whose cwd is another
 * project entirely is a different thing and is left out: this function answers
 * "what did THIS repo cost", and folding another repo's tokens into that total
 * is the same lie as a made-up number. A session whose rollout records no cwd
 * at all cannot be attributed to anything and is left out too — Codex records
 * a cwd, so an absent one is a broken log, not a signal.
 *
 * `dir` exists so tests can point at a committed fixture tree.
 */
export async function codexSessions(root: string, tasks: Task[], dir = codexSessionsDir()): Promise<SessionUsage[]> {
  const sessions: SessionUsage[] = [];
  for (const file of await listRollouts(dir)) {
    const usage = (await cachedSessionUsage(file, parseCodexRollout)) as CodexSession | null;
    if (!usage || usage.turns === 0 || !usage.cwd) continue;
    const slug = slugForCwd(usage.cwd, root, tasks, usage.firstAt);
    if (slug === undefined) continue;
    const { cwd: _cwd, ...rest } = usage;
    sessions.push({ ...rest, slug });
  }
  return sessions;
}
