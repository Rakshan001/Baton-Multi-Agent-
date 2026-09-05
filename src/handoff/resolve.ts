// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Close a handoff brief when the work is done.
 *
 * Until this existed, nothing ever wrote `status: done`. The API filters closed
 * briefs out of the pickup list, but no code path ever closed one — so briefs
 * accumulated forever and the panel filled with work that had already shipped.
 *
 * Closing **appends**, never replaces: the original brief is the record of what
 * was asked, and the completion note is the record of what happened. A reviewer
 * needs both.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseFrontmatter } from '../util/frontmatter.js';
import { listBriefs } from './resume.js';
import { fenceUntrusted } from './untrusted.js';

export interface ResolveOptions {
  /** Agent or person closing it — recorded as `resolvedBy`. */
  by: string;
  /** What actually happened, for whoever reads this next. */
  note?: string;
}

/** Set a scalar frontmatter key, replacing any existing line for it. */
function setKey(lines: string[], key: string, value: string): string[] {
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i === -1) return [...lines, `${key}: ${value}`];
  const next = [...lines];
  next[i] = `${key}: ${value}`;
  return next;
}

const COMPLETED_HEADING = '## Completed';

/**
 * Strip markdown heading syntax from quoted text.
 *
 * Fencing says "this is untrusted"; this stops it being *structural*. A heading
 * inside a note would otherwise render as a real section of the brief, so a
 * note containing "## Next step" would give the next agent a second next step
 * with no way to tell which one the author actually wrote.
 */
function demoteHeadings(text: string): string {
  return text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
}

/**
 * Mark a brief done and append a completion report.
 *
 * Idempotent: resolving twice updates the existing report rather than stacking
 * a second one, because an agent retrying after a timeout must not corrupt the
 * record.
 */
export async function resolveBrief(path: string, opts: ResolveOptions): Promise<void> {
  const raw = await readFile(path, 'utf-8');

  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch {
    throw new Error(`not a baton brief: ${path}`);
  }
  if (parsed.data.baton !== 1) throw new Error(`not a baton brief: ${path}`);

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) throw new Error(`not a baton brief: ${path}`);

  let keys = fm[1].split(/\r?\n/);
  keys = setKey(keys, 'status', 'done');
  keys = setKey(keys, 'resolvedBy', opts.by);
  keys = setKey(keys, 'resolvedAt', new Date().toISOString());

  // Drop any previous report so a re-resolve replaces it instead of appending.
  let body = parsed.content.trimEnd();
  const prior = body.indexOf(`\n${COMPLETED_HEADING}`);
  if (prior !== -1) body = body.slice(0, prior).trimEnd();

  // The note travels between agents, so it is quoted as data. Fencing marks it
  // as untrusted; demoting its headings stops it creating document structure —
  // a note containing "## Next step" must not become a second next step that
  // the following agent reads as the brief's own instruction.
  const report = [
    COMPLETED_HEADING,
    `_Closed by ${opts.by} at ${new Date().toISOString()}._`,
    ...(opts.note ? ['', fenceUntrusted('completion note', demoteHeadings(opts.note))] : []),
  ].join('\n');

  await writeFile(path, `---\n${keys.join('\n')}\n---\n\n${body}\n\n${report}\n`, 'utf-8');
}

export interface ResolveBySlugResult {
  closed: boolean;
  /** The brief's title, so the caller can say what it just closed. */
  title?: string;
  path?: string;
  error?: string;
}

/**
 * Close a brief by the slug an agent actually knows it by.
 *
 * The slug is matched against **enumerated** briefs and never joined into a
 * path, so a hostile slug (`../../SECRET`) cannot reach a file outside the
 * handoff store. Shared by the MCP tool and the HTTP endpoint so the two cannot
 * disagree about which brief a name refers to.
 */
export async function resolveBriefBySlug(
  root: string,
  slug: string,
  opts: ResolveOptions,
): Promise<ResolveBySlugResult> {
  const open = (await listBriefs(root)).filter((b) => b.status !== 'done');
  const brief = open.find((b) => b.slug === slug);
  // A closed brief has already left the list, so this covers both "never
  // existed" and "already done" — neither is an error worth throwing at an
  // agent that is simply reporting finished work.
  if (!brief) return { closed: false, error: `no handoff '${slug}' is open` };
  try {
    await resolveBrief(brief.path, opts);
  } catch (e) {
    return { closed: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { closed: true, title: brief.title, path: brief.path };
}
