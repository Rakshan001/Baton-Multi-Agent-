// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Real token usage, parsed from the session logs each agent leaves behind —
 * input/output/cache tokens plus an estimated cost per session, mapped back to
 * baton tasks. This replaces guesswork with the numbers the agents actually
 * burned, so you can see what the knowledge base is saving you.
 *
 * Schema/approach adapted from Orca's claude-usage fetcher (MIT) — concept
 * only, no code vendored. See NOTICE. The Claude parser lives here; the other
 * agents' log formats differ enough to get their own modules (`./usage/`),
 * and every one of them lands in the same `SessionUsage` shape.
 *
 * The rule the whole file is built around: **absent is not zero.** A `null`
 * means the format never reported that number; a `0` means it reported zero.
 * A spend table that renders "not measured" as `$0.00` is lying, so every
 * count and every cost here is nullable and stays null all the way through
 * aggregation.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { claudeProjectsDir, encodeCwd, readLines, subagentTranscripts, transcriptsIn } from './handoff/claude-session.js';
// Each other agent's parser lands in the SessionUsage shape defined below.
// (The import cycle is deliberate and safe: those modules only call back into
// this one at query time, long after both module bodies have run.)
import { CODEX_READ_FROM, codexSessions } from './usage/codex.js';
import { ANTIGRAVITY_READ_FROM, antigravitySessions } from './usage/antigravity.js';
import type { Task } from './store.js';

/** Token counts as reported. `null` = the format does not provide this field. */
export interface TokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Grand total — the sum of whatever the format did report, or a total it
   *  reported directly when it gives no input/output split at all. */
  totalTokens: number | null;
  /** input + output + cache writes, whatever was reported; cache reads
   *  excluded (they dwarf everything else). null = none reported. */
  consumedTokens: number | null;
}

/**
 * How a session was tied to its slug.
 *
 * `measured` — the log recorded the working directory the session ran in
 * (Claude's per-project session dirs, Codex's `session_meta.cwd`).
 * `inferred` — the format records no cwd, so Baton DEDUCED the placement from
 * the paths the session's own tool calls touched (Antigravity). Evidence, but
 * not the same kind of fact, so it is carried through to the screen and
 * labelled there rather than blending into the measured rows.
 */
export type Attribution = 'measured' | 'inferred';

export interface SessionUsage extends TokenCounts {
  sessionId: string;
  /** Task slug when the session ran inside a baton worktree; null = main repo. */
  slug: string | null;
  /** Measured from a logged cwd, or inferred from the paths it touched. */
  attribution: Attribution;
  /** Agent id from `src/agents/registry.ts` — 'claude', 'codex', 'antigravity'… */
  agent: string;
  model: string | null;
  turns: number;
  /** null when the model has no price here — never a guessed or zeroed cost. */
  estCostUsd: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** One session's parse, before it is attributed to a task. */
export type ParsedSession = Omit<SessionUsage, 'slug'>;

export interface UsageTotals extends TokenCounts {
  sessions: number;
  turns: number;
  estCostUsd: number | null;
  /** Sessions that reported tokens but have no price, so `estCostUsd` leaves
   *  them out. > 0 means the cost is partial, and the screen says so. */
  unpricedSessions: number;
}

/**
 * One task's spend. Served rather than grouped in the browser: this rollup is
 * where "absent is not zero" is enforced, and a second copy of that loop in the
 * dashboard would eventually disagree with this one in front of the user.
 */
export interface TaskUsage {
  /** Task slug, or null for the repo itself. */
  slug: string | null;
  /** Agents that contributed, first-seen order. */
  agents: string[];
  totals: UsageTotals;
  /** True when ANY contributing session was placed by inference. One guessed
   *  session makes the row a guess, so the screen can say so at the number. */
  inferred: boolean;
}

/** An agent whose session logs Baton knows how to read, and where from. */
export interface ReadableAgent {
  agent: string;
  /** The path pattern this agent's sessions are read from, for display. */
  readFrom: string;
}

export interface RepoUsage {
  sessions: SessionUsage[];
  totals: UsageTotals;
  byModel: Record<string, UsageTotals>;
  /** Only agents with at least one parsed session appear — an agent whose logs
   *  could not be read contributes no row, rather than a row of zeros. */
  byAgent: Record<string, UsageTotals>;
  /** Per task (and the repo itself), highest measured spend first. */
  byTask: TaskUsage[];
  /** Which agents Baton can read at all, so the dashboard does not have to
   *  keep its own copy of the roster. An agent listed here with no `byAgent`
   *  row was looked for and not found — which is not a spend of zero. */
  readable: ReadableAgent[];
  /** The date the price table was read (`PRICES_AS_OF`), so the screen does
   *  not keep its own copy. Optional: an older daemon does not send it. */
  pricesAsOf?: string;
}

/** The date the price table below was read. Shown next to every cost. */
export const PRICES_AS_OF = '2026-09-24';

/**
 * USD per million tokens, Anthropic first-party API list prices, from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-09-24).
 * Absolute rates per model — the cache-read ratio differs between models.
 *
 * Looked up by EXACT id (after `modelKey`), never by family: a future
 * `claude-opus-4-9` must show as unpriced, not borrow an older row. A model
 * that is not here has no cost, not a cost of zero: see `estimateCostUsd`.
 * Not modelled: fast mode, batch, `inference_geo` surcharges, Bedrock/Vertex
 * rates, and any long-context premium on models before 4.6.
 */
interface Price { in: number; w5m: number; w1h: number; read: number; out: number }
const PRICE_ROWS: Array<[string[], Price]> = [
  [['claude-fable-5-1', 'claude-mythos-5-1'], { in: 10, w5m: 12.5, w1h: 20, read: 0.25, out: 50 }],
  [['claude-fable-5', 'claude-mythos-5'], { in: 10, w5m: 12.5, w1h: 20, read: 1, out: 50 }],
  [['claude-opus-5-5'], { in: 4, w5m: 5, w1h: 8, read: 0.2, out: 20 }],
  [['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 }],
  [['claude-opus-4-1', 'claude-opus-4', 'claude-opus-4-0'], { in: 15, w5m: 18.75, w1h: 30, read: 1.5, out: 75 }],
  [['claude-sonnet-5'], { in: 2, w5m: 2.5, w1h: 4, read: 0.2, out: 10 }],
  [['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-4-0'],
    { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 }],
  [['claude-haiku-4-5'], { in: 1, w5m: 1.25, w1h: 2, read: 0.1, out: 5 }],
  [['claude-3-5-haiku', 'claude-haiku-3-5'], { in: 0.8, w5m: 1, w1h: 1.6, read: 0.08, out: 4 }],
];
const PRICES = new Map(PRICE_ROWS.flatMap(([ids, p]) => ids.map((id) => [id, p] as const)));

/** `claude-opus-4-8[1m]` → `claude-opus-4-8`; `claude-opus-4-1-20250805` → `claude-opus-4-1`. */
const modelKey = (model: string): string => model.toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');

/** Counts to price, plus the 1-hour slice of cache writes when the log split it out. */
type Priceable = Partial<Pick<TokenCounts, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>> & {
  cacheWrite1hTokens?: number | null;
};

/**
 * Unrounded USD, or null when it cannot honestly be said: nothing was
 * reported, or tokens were spent on a model the table does not list (an
 * OpenAI or Gemini model priced at Claude's rates would be fiction). Zero
 * tokens cost $0 only where a price could apply — a priced Claude id, or no
 * real model (null / `<synthetic>`); an unpriced model stays unknown, so a
 * zero-count Codex session shows "—", not `$0.00`.
 */
function costUsd(model: string | null, u: Priceable): number | null {
  const measured = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (measured.every((n) => n == null)) return null;
  const real = model != null && model !== '<synthetic>';
  const p = real ? PRICES.get(modelKey(model)) : undefined;
  if (measured.every((n) => !n)) return p || !real ? 0 : null;
  if (!p) return null;
  const cw = u.cacheWriteTokens ?? 0;
  const h = Math.min(u.cacheWrite1hTokens ?? 0, cw);
  return ((u.inputTokens ?? 0) * p.in + (u.outputTokens ?? 0) * p.out + (u.cacheReadTokens ?? 0) * p.read +
    (cw - h) * p.w5m + h * p.w1h) / 1e6;
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** Estimated USD to the cent, or `null` — see `costUsd`. */
export function estimateCostUsd(model: string | null, u: Priceable): number | null {
  const c = costUsd(model, u);
  return c == null ? null : cents(c);
}

/**
 * One reported count, or null when the line did not report a usable one.
 *
 * Absent is not the only way a field fails to be a measurement. A token count
 * that arrives as a string, a NaN, an Infinity or a negative was not measured
 * either, and every parser here has to say so rather than add it to a counter:
 *
 *   - `(out[k] ?? 0) + "500"` is the STRING `"0500"` in a field typed
 *     `number | null`. One such line priced a session at $30,000.
 *   - `1e999` is valid JSON that parses to `Infinity`. It propagates through
 *     the session into `aggregate`, and `JSON.stringify` writes a non-finite
 *     number as `null` — which is this file's wire encoding for "never
 *     measured". A single corrupt line made the whole repo's spend render as a
 *     dash, taking every honestly-measured session with it.
 *   - A negative subtracts from real spend, which understates the bill.
 *
 * So: a value that is not a finite, non-negative number is absent, and the
 * counts reported beside it are kept.
 */
export function countOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Widen a session's `[firstAt, lastAt]` span to include `ts`.
 *
 * First-seen/last-seen is not the same as earliest/latest. Transcripts are
 * appended to by more than one writer (sidechains, resumed sessions), so an
 * out-of-order line used to leave `firstAt` AFTER `lastAt` — a negative
 * duration on screen — and could bury a live session at the bottom of a list
 * `usageForRepo` sorts on `lastAt`.
 *
 * Compared as instants, because these formats are not all UTC: `+05:30` sorts
 * after `Z` as a string and before it on the clock. Stamps neither side can
 * parse fall back to string order, which is the best available.
 */
export function widenSpan(out: { firstAt: string | null; lastAt: string | null }, ts: string): void {
  const before = (a: string, b: string): boolean => {
    const [x, y] = [Date.parse(a), Date.parse(b)];
    return Number.isFinite(x) && Number.isFinite(y) ? x < y : a < b;
  };
  if (out.firstAt == null || before(ts, out.firstAt)) out.firstAt = ts;
  if (out.lastAt == null || before(out.lastAt, ts)) out.lastAt = ts;
}

/** Sum of the counts that were actually reported; null when none were. */
export function totalOf(u: Omit<TokenCounts, 'totalTokens' | 'consumedTokens'>): number | null {
  return sumReported([u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens]);
}

/** Input + output + cache writes that were reported (cache reads excluded); null when none were. */
export function consumedOf(u: Omit<TokenCounts, 'totalTokens' | 'consumedTokens'>): number | null {
  return sumReported([u.inputTokens, u.outputTokens, u.cacheWriteTokens]);
}

function sumReported(xs: Array<number | null>): number | null {
  const parts = xs.filter((n): n is number => n != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** True if `cwd` is `dir` or nested inside it. */
function within(cwd: string, dir: string): boolean {
  return cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Which slot a session's working directory belongs to:
 * a task slug, `null` for the repo itself, or `undefined` when the cwd is not
 * this repo at all (another project's sessions are not this repo's spend).
 * Worktrees are checked first — a worktree may live inside the repo root —
 * and the most specific (longest) matching worktree wins.
 *
 * Two tasks can share one worktree path (a slot reused after a task ended).
 * The session goes to the latest task created at or before `at` (when the
 * session started); with no usable `at`, or a session older than every such
 * task, to the oldest. A task whose `createdAt` does not parse counts as the
 * oldest possible; exact ties keep list order.
 */
export function slugForCwd(cwd: string, root: string, tasks: Task[], at?: string | null): string | null | undefined {
  const when = at ? Date.parse(at) : NaN;
  const created = (t: Task): number => { const n = Date.parse(t.createdAt); return Number.isFinite(n) ? n : -Infinity; };
  const started = (t: Task): boolean => created(t) <= when; // false for a NaN `when`
  const preferred = (t: Task, b: Task): boolean =>
    started(t) !== started(b) ? started(t) : started(t) ? created(t) > created(b) : created(t) < created(b);
  let best: Task | undefined;
  for (const t of tasks) {
    if (!t.worktreePath || !within(cwd, t.worktreePath)) continue;
    if (!best || t.worktreePath.length > best.worktreePath.length ||
        (t.worktreePath.length === best.worktreePath.length && preferred(t, best))) best = t;
  }
  if (best) return best.slug;
  return within(cwd, root) ? null : undefined;
}

const epoch = (s: SessionUsage): number => { const n = s.lastAt ? Date.parse(s.lastAt) : NaN; return Number.isFinite(n) ? n : -Infinity; };
/** Newest first by instant (stamps carry offsets, so not by string); unparseable or missing last. */
export const newestFirst = (a: SessionUsage, b: SessionUsage): number => epoch(b) - epoch(a) || 0;

interface UsageLine {
  type?: string;
  timestamp?: string;
  /** The directory the session was running in when it wrote this line. */
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number };
    };
  };
}

/** A parsed Claude transcript, plus the directory it was launched in. */
export interface ClaudeSession extends ParsedSession {
  /** The first `cwd` any line logged; null when none did (old transcripts). */
  cwd: string | null;
}

/** One API message: the per-field max across the lines that share its id. */
interface MessageUsage {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
}
const MESSAGE_COUNTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/**
 * Parse one Claude Code session transcript. Defensive: unknown lines are skipped.
 *
 * Claude Code writes one line per content block, and every line of one API
 * message carries the same `message.id` and a copy of its `usage` — except
 * `output_tokens`, which grows as the message streams (and a trailing copy is
 * sometimes zeroed). So lines are merged per id keeping the MAX of each field;
 * summing them counted each message 2-3×, and keeping the first line seen
 * under-counts output. A line with no id counts once, on its own.
 *
 * Cost is priced per message at that message's own model, summed, and rounded
 * once. `<synthetic>` lines (zero-usage placeholders Claude Code writes) never
 * set a model. If any message that spent tokens has no price, the session has
 * no cost: an honest blank, not a silently partial figure.
 */
export async function parseSessionUsage(file: string): Promise<ClaudeSession> {
  const out: ClaudeSession = {
    cwd: null,
    sessionId: basename(file, '.jsonl'),
    agent: 'claude',
    // The session file lives under the project directory it ran in, so the cwd
    // is recorded, not deduced.
    attribution: 'measured',
    model: null,
    turns: 0,
    // null, not 0 — "the transcript never mentioned this" and "this measured
    // zero" are different facts, and only the second is a measurement. Starting
    // at 0 also made every `?? 0` below dead code, and made `coverageOf` in the
    // dashboard call a partially-reported session "full".
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
  const byId = new Map<string, MessageUsage>();
  const anonymous: MessageUsage[] = []; // a line with no id counts once, as it always did
  try {
    for await (const line of readLines(file)) {
      let m: UsageLine;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m?.cwd === 'string') out.cwd ??= m.cwd; // any line kind: user lines log it first
      if (m.type !== 'assistant') continue;
      const u = m.message?.usage;
      if (!u) continue;
      const id = typeof m.message?.id === 'string' ? m.message.id : null;
      let e = id ? byId.get(id) : undefined;
      if (!e) {
        e = { model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheWrite1hTokens: null };
        if (id) byId.set(id, e);
        else anonymous.push(e);
      }
      // Only a field the transcript actually carried a USABLE number in moves
      // its counter off null — see `countOf`. A malformed field is absent, and
      // the fields reported beside it are kept.
      const msg = e;
      const hi = (k: Exclude<keyof MessageUsage, 'model'>, v: unknown) => {
        const n = countOf(v);
        if (n != null) msg[k] = Math.max(msg[k] ?? 0, n);
      };
      hi('inputTokens', u.input_tokens);
      hi('outputTokens', u.output_tokens);
      hi('cacheReadTokens', u.cache_read_input_tokens);
      hi('cacheWriteTokens', u.cache_creation_input_tokens);
      hi('cacheWrite1hTokens', u.cache_creation?.ephemeral_1h_input_tokens);
      const model = m.message?.model;
      if (model && model !== '<synthetic>') {
        msg.model ??= model;
        out.model = model;
      }
      if (m.timestamp) widenSpan(out, m.timestamp);
    }
  } catch {
    /* truncated/locked transcript — keep what we have */
  }
  let usd = 0;
  let priced = false;
  let unpriced = false;
  for (const e of [...byId.values(), ...anonymous]) {
    out.turns++;
    for (const k of MESSAGE_COUNTS) if (e[k] != null) out[k] = (out[k] ?? 0) + (e[k] as number);
    const c = costUsd(e.model ?? out.model, e); // a message with no model falls back to the session's
    if (c != null) {
      usd += c;
      priced = true;
    } else if (MESSAGE_COUNTS.some((k) => (e[k] ?? 0) > 0)) unpriced = true;
  }
  out.totalTokens = totalOf(out);
  out.consumedTokens = consumedOf(out);
  out.estCostUsd = priced && !unpriced ? cents(usd) : null;
  return out;
}

/** mtime-keyed cache: a session file is only re-parsed after it changes.
 *  Shared by every agent's parser — the key is the file path. */
const cache = new Map<string, { mtimeMs: number; usage: ParsedSession }>();
/** Parses in progress, so concurrent polls share one parse per file. The
 *  mtime is kept so a caller that saw a newer file does not reuse a stale one. */
const inflight = new Map<string, { mtimeMs: number; parse: Promise<ParsedSession> }>();

/** Parse `file` with `parse`, reusing the last result while its mtime holds.
 *  Returns null when the file cannot be read at all. */
export async function cachedSessionUsage(
  file: string,
  parse: (f: string) => Promise<ParsedSession> = parseSessionUsage,
): Promise<ParsedSession | null> {
  try {
    const st = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.usage;
    let run = inflight.get(file);
    if (!run || run.mtimeMs !== st.mtimeMs) {
      const p: Promise<ParsedSession> = parse(file)
        .then((usage) => {
          cache.set(file, { mtimeMs: st.mtimeMs, usage });
          return usage;
        })
        .finally(() => {
          if (inflight.get(file)?.parse === p) inflight.delete(file);
        });
      run = { mtimeMs: st.mtimeMs, parse: p };
      inflight.set(file, run);
    }
    return await run.parse;
  } catch {
    return null;
  }
}

const emptyTotals = (): UsageTotals => ({
  sessions: 0, turns: 0, inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, consumedTokens: null, estCostUsd: null,
  unpricedSessions: 0,
});

const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'consumedTokens'] as const;

function addTo(t: UsageTotals, s: ParsedSession): void {
  t.sessions++;
  t.turns += s.turns;
  // A field stays null until some session reports it: absent ≠ zero.
  for (const k of COUNTS) if (s[k] != null) t[k] = (t[k] ?? 0) + (s[k] as number);
  if (s.estCostUsd != null) t.estCostUsd = cents((t.estCostUsd ?? 0) + s.estCostUsd);
  else if ((s.totalTokens ?? 0) > 0) t.unpricedSessions++;
}

/** Nothing to price: no counts reported, or all of them zero. */
const nothingToPrice = (s: ParsedSession): boolean => s.totalTokens == null || s.totalTokens === 0;

/**
 * A subagent's parse folded into its parent's. Returns a NEW object — both
 * inputs may be cached results. Costs sum when both sides are priced; a side
 * with nothing to price never blanks the other's cost; otherwise null.
 */
function mergeSession<T extends ParsedSession>(a: T, b: ParsedSession): T {
  const m: T = { ...a, turns: a.turns + b.turns, model: a.model ?? b.model };
  for (const k of COUNTS) if (b[k] != null) m[k] = (a[k] ?? 0) + (b[k] as number);
  if (b.firstAt) widenSpan(m, b.firstAt);
  if (b.lastAt) widenSpan(m, b.lastAt);
  m.estCostUsd = a.estCostUsd != null && b.estCostUsd != null ? cents(a.estCostUsd + b.estCostUsd)
    : nothingToPrice(b) ? a.estCostUsd
    : nothingToPrice(a) ? b.estCostUsd
    : null;
  return m;
}

/** Roll sessions up into totals, per model, per agent and per task. */
export function aggregate(sessions: SessionUsage[]): Omit<RepoUsage, 'sessions' | 'readable'> {
  const totals = emptyTotals();
  const byModel: Record<string, UsageTotals> = {};
  const byAgent: Record<string, UsageTotals> = {};
  // A slug is a safe path segment, so a NUL prefix cannot collide with one.
  const REPO_KEY = '\0repo';
  const tasks = new Map<string, TaskUsage>();
  for (const s of sessions) {
    addTo(totals, s);
    const model = s.model ?? 'unknown';
    byModel[model] ??= emptyTotals();
    addTo(byModel[model], s);
    byAgent[s.agent] ??= emptyTotals();
    addTo(byAgent[s.agent], s);

    const key = s.slug ?? REPO_KEY;
    let row = tasks.get(key);
    if (!row) tasks.set(key, (row = { slug: s.slug, agents: [], totals: emptyTotals(), inferred: false }));
    addTo(row.totals, s);
    if (!row.agents.includes(s.agent)) row.agents.push(s.agent);
    if (s.attribution === 'inferred') row.inferred = true;
  }
  // Biggest measured spend first; a row nobody measured sorts last rather than
  // sorting as if it had spent zero.
  const byTask = [...tasks.values()].sort((a, b) => (b.totals.totalTokens ?? -1) - (a.totals.totalTokens ?? -1));
  return { totals, byModel, byAgent, byTask };
}

/** Where the Claude parser looks (top-level transcripts and their
 *  `<id>/subagents/*.jsonl`) — see `claudeSessions`. Display only. */
export const CLAUDE_READ_FROM = '~/.claude/projects/**/*.jsonl';

/**
 * Every agent `usageForRepo` can parse, and where each one is read from.
 *
 * The one place that knows the roster. The dashboard used to hold a second
 * copy of these ids and paths, which made adding a parser a four-file edit and
 * a silent gap on the screen whenever someone forgot the browser half.
 */
export function readableAgents(): ReadableAgent[] {
  return [
    { agent: 'claude', readFrom: CLAUDE_READ_FROM },
    { agent: 'codex', readFrom: CODEX_READ_FROM },
    { agent: 'antigravity', readFrom: ANTIGRAVITY_READ_FROM },
  ];
}

/**
 * Claude Code sessions for the repo root, anything under it (subfolders,
 * `.baton/wt/*`) and every task worktree, each with its subagent transcripts
 * merged in and credited to the parent's slug.
 *
 * Project dirs are pre-screened by encoded-name prefix, then confirmed by the
 * `cwd` the transcript itself logged: the dir name is lossy (`<root>-vault`
 * encodes like a subfolder of `<root>`), the logged cwd is not. A transcript
 * with no cwd falls back to the exact target dir it was found in. Each dir is
 * read once, so two tasks sharing a worktree cannot double count it.
 *
 * `projects` exists so tests can point at a tmp tree.
 */
export async function claudeSessions(root: string, tasks: Task[], projects = claudeProjectsDir()): Promise<SessionUsage[]> {
  const targets = [root, ...tasks.map((t) => t.worktreePath).filter(Boolean)];
  const prefixes = [...new Set(targets.map(encodeCwd))];
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return [];
  }
  const sessions: SessionUsage[] = [];
  for (const d of dirs) {
    if (!prefixes.some((p) => d === p || d.startsWith(p + '-'))) continue;
    for (const file of await transcriptsIn(join(projects, d))) {
      const main = (await cachedSessionUsage(file)) as ClaudeSession | null;
      if (!main) continue;
      const cwd = main.cwd ?? targets.find((t) => encodeCwd(t) === d) ?? null;
      if (cwd == null || slugForCwd(cwd, root, tasks) === undefined) continue; // not this repo
      let s: ClaudeSession = main;
      for (const sub of await subagentTranscripts(file)) {
        const u = await cachedSessionUsage(sub);
        if (u) s = mergeSession(s, u);
      }
      if (s.turns === 0) continue;
      const { cwd: _cwd, ...rest } = s;
      sessions.push({ ...rest, slug: slugForCwd(cwd, root, tasks, s.firstAt) ?? null });
    }
  }
  return sessions;
}

/** Usage for the repo root + every task worktree, across every agent we can read. */
export async function usageForRepo(root: string, tasks: Task[]): Promise<RepoUsage> {
  const sessions = [
    ...(await claudeSessions(root, tasks)),
    ...(await codexSessions(root, tasks)),
    ...(await antigravitySessions(root, tasks)),
  ];
  sessions.sort(newestFirst);
  return { sessions, ...aggregate(sessions), readable: readableAgents(), pricesAsOf: PRICES_AS_OF };
}
