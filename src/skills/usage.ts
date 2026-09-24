// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which skills actually get used.
 *
 * Nothing in Baton recorded that a skill was ever reached for, so "which of
 * these thirty-four earns its place", "which has gone stale" and "which should
 * rank first" were all guesses. This is the raw signal those answers come from:
 * one line per use, aggregated on read.
 *
 * Three decisions, and why:
 *
 * **Append-only JSONL, not a counters object.** `bookmarks.ts` is the precedent
 * for read-failure tolerance and the atomic temp-file write, and this file
 * follows it there — but it deliberately diverges on shape. Bookmarks reads the
 * whole file, edits it and writes it back; doing that with counters in a
 * MULTI-AGENT hub means two agents installing at once each read the same
 * counts and the second write erases the first. An append never reads, so it
 * cannot lose what it never held. It also keeps a user-controlled skill id out
 * of object-key position, where `__proto__` is a hazard rather than a string.
 *
 * **Machine-wide at `~/.baton/`,** for the same reason bookmarks are: a skill
 * installed once is present in every project, so per-project usage would split
 * one skill's history across every repo it was used in.
 *
 * **A sidecar file, never the skill's own frontmatter.** A user-authored
 * SKILL.md is theirs; Baton does not write operational noise into it.
 *
 * Telemetry is never a gate: every write here is best-effort and returns rather
 * than throwing, so a full disk or an unwritable home directory can fail to
 * record an install but can never fail the install.
 *
 * Design borrowed (no code) from hermes-agent's skill ledger — Nous Research,
 * MIT (`tools/skill_usage.py`, `tools/skill_ledger.py`): per-skill use counts
 * with a last-used timestamp, kept beside the skills rather than inside them.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const USAGE_VERSION = 1;

/** What was done with the skill. Recorded so a load can later be told apart
 *  from an install without a second file. */
export type SkillUsageAction = 'install' | 'uninstall' | 'load';

/**
 * The longest line this will write, in UTF-8 bytes. A skill id reaches us from
 * an upload, a URL or a GitHub import — hostile string input — and without a
 * cap one of them could append megabytes. An id that cannot fit is dropped
 * rather than truncated: half an id is a skill that does not exist.
 */
export const MAX_ENTRY_BYTES = 512;

/** Lines the ledger may hold before it is rolled up into one entry per skill. */
export const MAX_LEDGER_LINES = 2000;

/**
 * Size below which compaction does not even look at the line count, so the
 * common append pays one `stat` instead of a full read. Set well under the
 * smallest possible {@link MAX_LEDGER_LINES}-line file (the shortest entry this
 * writes is ~55 bytes), so it can never suppress a real trigger.
 */
const COMPACT_MIN_BYTES = MAX_LEDGER_LINES * 40;

/** An aggregated view of one skill's history. */
export interface SkillUsage {
  count: number;
  /** ISO-8601, the latest `at` seen for this id. */
  lastUsedAt: string;
}

function batonDir(): string {
  return join(homedir(), '.baton');
}

export function usagePath(): string {
  return join(batonDir(), 'skill-usage.jsonl');
}

/**
 * Record one use. Never throws, never rewrites, and never returns a failure —
 * the caller is doing something real and this is a note in the margin.
 *
 * The id is written as a JSON *value*, so a newline in it is escaped rather
 * than becoming a second line: an id cannot forge an entry.
 */
export async function recordUsage(id: string, action: SkillUsageAction): Promise<void> {
  try {
    if (typeof id !== 'string' || !id.trim()) return;
    const line = JSON.stringify({ v: USAGE_VERSION, id, at: new Date().toISOString(), a: action }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) return;
    await mkdir(batonDir(), { recursive: true });
    // O_APPEND: the kernel places the write at the end of the file, so two
    // agents recording at once interleave lines instead of overwriting.
    await appendFile(usagePath(), line, 'utf-8');
    await compactIfNeeded();
  } catch { /* a ledger that cannot be written must not fail what it records */ }
}

/**
 * Aggregate the ledger into per-skill counts and a last-used timestamp.
 *
 * A Map, not an object: skill ids are user-controlled text, and `__proto__` as
 * an object key is a pollution vector where as a Map key it is just a string.
 *
 * A missing file reads as "no usage", and any unparseable line — including the
 * truncated last line a crash mid-append leaves behind — is skipped. One bad
 * line must not make the whole history unreadable.
 */
export async function readUsage(): Promise<Map<string, SkillUsage>> {
  let text: string;
  try {
    text = await readFile(usagePath(), 'utf-8');
  } catch {
    return new Map();
  }
  return aggregate(text.split('\n'));
}

function aggregate(lines: string[]): Map<string, SkillUsage> {
  const out = new Map<string, SkillUsage>();
  for (const line of lines) {
    const e = parseEntry(line);
    if (!e) continue;
    const seen = out.get(e.id);
    if (!seen) out.set(e.id, { count: e.n, lastUsedAt: e.at });
    else {
      seen.count += e.n;
      // Entries arrive from several writers, so the file is not sorted by time.
      if (e.at > seen.lastUsedAt) seen.lastUsedAt = e.at;
    }
  }
  return out;
}

const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * One line, or null if it is not a usable entry.
 *
 * `JSON.parse` defines `__proto__` as an own property rather than assigning
 * through the setter, so a line carrying one cannot reach Object.prototype;
 * every field is then read positively (right type, plausible value) rather than
 * trusted for absence of a problem.
 */
function parseEntry(line: string): { id: string; at: string; n: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try { raw = JSON.parse(trimmed); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const at = typeof o.at === 'string' ? o.at : '';
  if (!id || !ISO_AT.test(at)) return null;
  // `n` exists so a compacted roll-up can stand for the entries it replaced.
  const n = typeof o.n === 'number' && Number.isSafeInteger(o.n) && o.n > 0 ? o.n : 1;
  return { id, at, n };
}

/**
 * Roll the ledger up into one entry per skill once it grows past the cap.
 *
 * Counts and last-used timestamps survive — the detail that is lost is the
 * individual lines, which is the point of a roll-up. Written to a temp file and
 * renamed, so an interrupted compaction leaves the previous ledger intact
 * rather than a half-written one.
 *
 * An entry appended between the read and the rename is dropped; entries that
 * existed before compaction started are not. That is the honest guarantee of a
 * rewrite without a lock, and it costs at most a single use at a moment the
 * ledger is already 2,000 entries deep.
 */
async function compactIfNeeded(): Promise<void> {
  const path = usagePath();
  if ((await stat(path)).size < COMPACT_MIN_BYTES) return;
  const lines = (await readFile(path, 'utf-8')).split('\n');
  if (lines.filter((l) => l.trim()).length <= MAX_LEDGER_LINES) return;

  const rolled = [...aggregate(lines)]
    .map(([id, u]) => JSON.stringify({ v: USAGE_VERSION, id, at: u.lastUsedAt, n: u.count }))
    .join('\n') + '\n';
  // Pid-scoped, like quarantine.ts: a fixed `.tmp` is a shared name, and two
  // agents compacting at once would have one overwrite the other's staged
  // ledger and rename it away — losing the WHOLE file rather than one append.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, rolled, 'utf-8');
  await rename(tmp, path);
}
