// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Continuation head — the tiny, must-read "resume this task" block injected into
 * a freshly-launched agent session so it can pick up where a limited-out session
 * stopped, WITHOUT re-reading the whole HANDOFF.md up front (ADD-03 tiered
 * handoff / ISS-08 context rot).
 *
 * It is a pure function of a HANDOFF.md's frontmatter + body: objective, the
 * next open action, where to work, and positive-phrased guardrails (ISS-07 —
 * "do this" survives a long session better than "do NOT that"). Everything
 * heavier (full plan, files touched, graph excerpt) stays in HANDOFF.md, pulled
 * just-in-time. Kept under a hard char budget so it never bloats the injection.
 */
import type { HandoffMeta } from './brief.js';
import { guardrailOneLine } from './guardrails.js';
import { fenceOverhead, fenceUntrusted, isFenceScaffolding } from './untrusted.js';

/** Trim quoted text to a budget at a word boundary. Never applied to a rendered fence. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** ~700 tokens-worth of chars: enough for objective + next action + guardrails, no more. */
export const CONTINUATION_MAX_CHARS = 800;

export interface HandoffFacts {
  objective: string;
  /** First still-open checklist item, or '' when the plan is done/absent. */
  nextAction: string;
  /** `cd <path>` target extracted from the brief, or ''. */
  workdir: string;
  /** Task slug, recovered from the `baton done <slug>` line, or ''. */
  slug: string;
}

/**
 * Extract the few fields the head needs from a rendered HANDOFF.md body. The
 * brief body is dense (single-newline separated — brief.ts filters blank lines),
 * so a line scan is reliable. Never throws; missing sections yield ''.
 */
export function parseHandoffFacts(body: string): HandoffFacts {
  const lines = body.split('\n');
  let objective = '';
  let nextAction = '';
  let workdir = '';
  let slug = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!objective && line === '## Objective') {
      // First following line that is real prose (skip a "> note" quote line).
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j++) {
        const cand = lines[j].trim();
        // The objective is quoted (see handoff/untrusted.ts), so skip the
        // quoting itself — otherwise the head reads back the opening marker.
        if (cand && !cand.startsWith('>') && !isFenceScaffolding(cand)) { objective = cand; break; }
      }
    }

    if (!nextAction && line === '## Plan') {
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j++) {
        const m = lines[j].trim().match(/^-\s*\[ \]\s*(.+)$/);
        if (m) { nextAction = m[1].trim(); break; }
      }
    }

    if (!workdir) {
      const cd = line.match(/^cd\s+(.+)$/);
      if (cd) workdir = cd[1].trim();
    }

    if (!slug) {
      const done = line.match(/baton done ([\w.-]+)/);
      if (done) slug = done[1].trim();
    }
  }

  return { objective, nextAction, workdir, slug };
}

/**
 * Render the must-read continuation head from a HANDOFF's meta + body. Returns
 * '' only when there is genuinely nothing to resume (no objective at all).
 */
export function renderContinuationHead(
  meta: Partial<HandoffMeta>,
  body: string,
  maxChars: number = CONTINUATION_MAX_CHARS,
): string {
  const facts = parseHandoffFacts(body);
  if (!facts.objective) return '';

  const branch = meta.branch ? ` (branch \`${meta.branch}\`)` : '';
  const doneCmd = facts.slug ? `\`baton done ${facts.slug}\`` : 'mark HANDOFF.md done';

  /*
   * Ordering here is a security property, not formatting.
   *
   * This head is the highest-authority channel Baton writes: `.cursor/rules`
   * with `alwaysApply: true`, and Claude Code's SessionStart `additionalContext`
   * via `baton orient --auto`. The objective and next action are lifted out of
   * HANDOFF.md's fence (parseHandoffFacts skips the scaffolding on purpose, so
   * the reader sees the task rather than the quoting) — which means printing
   * them beside Baton's imperatives would launder attacker-controlled plan text
   * into Baton's own voice, and fencing HANDOFF.md would be protection in name
   * only.
   *
   * So: everything carrying Baton's authority goes FIRST, and the untrusted
   * spans go last, back inside a fence.
   */
  const ours = [
    '## ▶ Resume this task (active handoff)',
    ...(facts.workdir ? [`**Work in:** \`cd ${facts.workdir}\`${branch}`] : []),
    'Read **HANDOFF.md** in full before re-planning — it holds the plan, files already edited, and prior notes.',
    // Positive-phrased guardrails (ISS-07): requirement form outlasts prohibition
    // form. Sourced from the one shared place so wording never drifts.
    guardrailOneLine(doneCmd),
  ].join('\n');

  const nextAction = facts.nextAction || 'continue the objective — read HANDOFF.md for the plan.';

  // Budget the QUOTED TEXT, never the rendered block: truncating the block could
  // cut the terminator off the fence we just opened, which is the one edit that
  // turns quoting into an escape hatch.
  const room = Math.max(0, maxChars - ours.length - fenceOverhead('handoff.resume'));
  const quoted = clip(`Objective: ${facts.objective}\nNext action: ${nextAction}`, room);

  return `${ours}\n${fenceUntrusted('handoff.resume', quoted)}`;
}

/** Worktree-relative path of the Cursor auto-load rule (git-excluded by the writer). */
export const CURSOR_RULE_REL = '.cursor/rules/baton-continuation.mdc';

/**
 * Wrap the continuation head as an always-applied Cursor rule (`.mdc`). Cursor
 * auto-loads `.cursor/rules/*.mdc` into every session's context — this is
 * Cursor's equivalent of Claude's SessionStart injection, so a manually-launched
 * Cursor session in the worktree resumes the task without a paste step (ISS-01).
 * Returns '' when there is no head to inject.
 */
export function renderCursorRule(head: string): string {
  if (!head) return '';
  return [
    '---',
    'description: Baton — resume the in-progress task in this worktree',
    'alwaysApply: true',
    '---',
    '',
    head,
    '',
  ].join('\n');
}
