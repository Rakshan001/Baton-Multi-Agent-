// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Handoff brief generation — the knowledge pack a cheaper agent picks up with
 * `baton take`. Not a raw history dump: a curated HANDOFF.md with objective,
 * touched files, the extracted plan, and (when the KB is initialized) a
 * graphify graph excerpt scoped to the task.
 */
import matter from 'gray-matter'; // writer only (matter.stringify) — reads go through parseFrontmatter
import { parseFrontmatter } from '../util/frontmatter.js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitTry } from '../util/exec.js';
import { gitExcludeLocal } from '../git.js';
import { fenceUntrusted, sanitizeUntrusted } from './untrusted.js';
import { resolveAuthor } from '../identity.js';
import type { Task } from '../store.js';
import { loadKb } from '../kb/state.js';
import { queryGraph } from '../kb/graphify.js';
import { memoryBriefSection, recallMemories } from '../memory.js';
import { sessionContextFor, type SessionContext } from './claude-session.js';
import { loadProgress } from './progress-ledger.js';
import { loadReview, openFindings, REVIEW_AXES } from '../reviews.js';
import { guardrailLines } from './guardrails.js';

export interface HandoffMeta {
  baton: number;
  /** The agent handing off (WHAT). Paired with `author` below (WHO). */
  from: string;
  to: string;
  /** WHO produced this brief. `from`/`to` name the agent tools, which on a
   *  shared hub are the same string for everyone — so a brief passed between
   *  two people records neither of them without this. Pre-author briefs and
   *  hand-written ones read as `unknown`. */
  author?: string;
  /** Suggested model for the receiving CLI (advisory — Baton can't enforce it). */
  model?: string;
  status: 'ready' | 'in-progress' | 'done';
  created: string;
  repo: string;
  branch: string;
  /** ISS-11: NOT the handoff's own cost — the size of the session this handoff
   *  condenses, i.e. what the next agent would spend replaying it from scratch.
   *  It's the cost the handoff SAVES, not one it incurs. */
  est_tokens: number;
  est_cost_usd: number;
}

export interface HandoffBrief {
  meta: HandoffMeta;
  markdown: string; // full HANDOFF.md content (frontmatter + body)
  path: string;
}

/** Very rough cost of replaying this much context on a metered API (Sonnet-class input). */
function estCostUsd(tokens: number): number {
  return Math.round(tokens * (3 / 1_000_000) * 100) / 100;
}

/**
 * ISS-08 — a hard budget on the brief body (chars), like `orient`'s 3200 cap.
 * A brief that concatenates every section paradoxically makes the receiver LESS
 * accurate (context rot), so we drop the lowest-value sections first and tell
 * the receiver to pull the rest just-in-time. ~1100 tokens: room for the
 * continuation essentials + memory + git ground truth, but not the graph
 * excerpt and command log on top when the brief is already large.
 */
export const HANDOFF_MAX_CHARS = 4500;

/**
 * A brief is a snapshot: its plan, diffstat and memory section freeze at
 * `baton pass` time. When commits have landed in the checkout since, the
 * receiver must be told the ground truth has moved — served verbatim, a
 * days-old brief reads as the current state of the work. Returns null when
 * fresh, or unknowable (no created stamp, git unreadable): a warning we
 * cannot substantiate is noise, not safety.
 */
export async function briefStalenessWarning(cwd: string, created: string | undefined): Promise<string | null> {
  if (!created || Number.isNaN(Date.parse(created))) return null;
  const r = await gitTry(['-C', cwd, 'rev-list', '--count', `--since=${created}`, 'HEAD']);
  if (!r.ok) return null;
  const n = Number(r.stdout.trim());
  if (!Number.isFinite(n) || n === 0) return null;
  return (
    `⚠ STALE BRIEF — written ${created.slice(0, 10)}; ${n} commit${n === 1 ? ' has' : 's have'} landed here since.\n` +
    `Trust \`git log\` and \`git diff\` for the current state — this brief's plan and "state of the work" predate them.`
  );
}

/** A rendered brief section plus how droppable it is under budget. */
export interface BriefSection {
  md: string;
  /** 0 = never drop (continuation essentials + guardrails); higher = dropped
   *  sooner. Value, not size, sets the order — low-value bloat goes first. */
  dropOrder: number;
}

/**
 * Pure progressive disclosure: keep sections in display order, but when the body
 * exceeds `maxChars` drop the highest-dropOrder (lowest-value) section still
 * present, repeating until it fits or only never-drop sections remain. Returns
 * the fitted body and how many sections were dropped (so the caller can add a
 * "pull it just-in-time" pointer).
 */
export function fitBriefBody(sections: BriefSection[], maxChars: number = HANDOFF_MAX_CHARS): { body: string; dropped: number } {
  const kept = sections.filter((s) => s.md.trim().length > 0);
  const render = (): string => kept.map((s) => s.md).join('\n\n');
  let dropped = 0;
  while (render().length > maxChars) {
    let idx = -1;
    let worst = 0;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].dropOrder > worst) { worst = kept[i].dropOrder; idx = i; }
    }
    if (idx === -1) break; // only never-drop sections left — accept the overflow
    kept.splice(idx, 1);
    dropped++;
  }
  return { body: render(), dropped };
}

/** Repo-root-relative name of the brief — also the `.git/info/exclude` pattern. */
export const HANDOFF_REL = 'HANDOFF.md';

/** Longest a task's text may run when used as a heading. Enough to identify the
 *  work, far too short to carry an instruction block. */
const TITLE_MAX = 90;

/**
 * A one-line title from arbitrary task text: sanitized, collapsed, and cut at a
 * word boundary. Never a place to read the task from — that is the fenced
 * Objective section.
 */
export function titleOf(taskText: string): string {
  const flat = sanitizeUntrusted(taskText).replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function handoffPath(worktreePath: string): string {
  return join(worktreePath, HANDOFF_REL);
}

/**
 * ISS-09 + ISS-10: the graph excerpt is a per-task HINT, not a mandate. Frame it
 * as a navigation shortcut that also nudges map/recall-first — but tell the
 * receiver to read full source where the task needs line-level detail (the map
 * omits it, and raw-file reading wins on tasks that need exhaustive source).
 */
export function graphSectionMd(excerpt: string): string {
  return [
    '## Codebase map (graph excerpt)',
    '_A shortcut to navigate: skim this and `recall_memory` before grepping the whole repo — but read the full source where the task needs line-level detail (the map omits it)._',
    '```',
    excerpt,
    '```',
  ].join('\n');
}

/**
 * The task's contract, for a brief the dispatcher wrote.
 *
 * Same record `my_tasks` returns (`mcp-pipeline.ts:taskContract`), so the file
 * and the tool cannot disagree about what the task is. Every value in it came
 * out of a plan file, which may have arrived by `git pull` — so it is fenced,
 * not restated in Baton's own voice.
 *
 * Empty when the task declares none: an "Acceptance criteria" heading with
 * nothing under it reads as "there are none".
 */
export function contractSectionMd(contract: Record<string, unknown>): string {
  const list = (k: string): string[] => {
    const v = contract[k];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const scope = list('scope'), expects = list('expects'), principles = list('principles'), deps = list('dependsOn');
  if (!scope.length && !expects.length && !principles.length && !deps.length) return '';
  const block = [
    ...(scope.length ? [`scope:      ${scope.join(', ')}`] : []),
    ...(deps.length ? [`depends on: ${deps.join(', ')}`] : []),
    ...(expects.length ? ['expects:', ...expects.map((e) => `  - ${e}`)] : []),
    ...(principles.length ? ['principles:', ...principles.map((p) => `  - ${p}`)] : []),
  ].join('\n');
  return [
    '## Acceptance criteria',
    '_From the plan. This is what the work is judged against — `complete_task` checks it._',
    fenceUntrusted('plan.contract', block),
  ].join('\n');
}

export async function buildBrief(
  task: Task,
  opts: {
    from?: string; to: string; model?: string; note?: string; root: string;
    /** Dispatch only: the plan's contract for this task. Never dropped. */
    contract?: Record<string, unknown>;
    /** Dispatch only: a repo orientation. Dropped before the contract is. */
    orientation?: string;
  },
): Promise<HandoffBrief> {
  const session: SessionContext | null = await sessionContextFor(task.worktreePath);
  // ISS-06: for a non-Claude agent there is no transcript, so plan/notes/files
  // used to vanish. Merge the agent-agnostic progress ledger (save_progress) —
  // preferring the richer transcript per field when it exists, else the ledger.
  let ledger = await loadProgress(opts.root, task.slug).catch(() => null);
  // A ledger that predates the worktree's last commit describes work that has
  // since landed — an abandoned ledger would otherwise resurface in a much
  // later brief as if it were the current plan. Git ground truth (below) is
  // what the receiver should trust; the stale ledger adds only misdirection.
  if (ledger) {
    const lastCommit = await gitTry(['-C', task.worktreePath, 'log', '-1', '--format=%cI']);
    if (lastCommit.ok && lastCommit.stdout && Date.parse(ledger.updatedAt) < Date.parse(lastCommit.stdout.trim())) {
      ledger = null;
    }
  }
  const todos = (session?.todos.length ? session.todos : ledger?.plan) ?? [];
  const notes = (session?.lastNotes.length ? session.lastNotes : ledger?.notes) ?? [];
  const filesEdited = (session?.filesEdited.length ? session.filesEdited : ledger?.filesEdited) ?? [];
  const commands = session?.commands ?? [];
  // The ledger's explicit "next step" — only the ledger carries one (a Claude
  // transcript expresses next-work through its todo list instead).
  const nextStep = !session && ledger?.next ? ledger.next : undefined;

  // Git ground truth: what actually changed vs the base branch.
  const diffStat = await gitTry(
    ['-C', task.worktreePath, 'diff', '--stat', `${task.baseBranch}...HEAD`],
    opts.root,
  );
  const dirtyStat = await gitTry(['-C', task.worktreePath, 'diff', '--stat', 'HEAD']);

  const meta: HandoffMeta = {
    baton: 1,
    from: opts.from ?? 'claude',
    to: opts.to,
    author: await resolveAuthor(opts.root),
    ...(opts.model ? { model: opts.model } : {}),
    status: 'ready',
    created: new Date().toISOString(),
    repo: opts.root,
    branch: task.branch,
    est_tokens: session?.estTokens ?? 0,
    est_cost_usd: estCostUsd(session?.estTokens ?? 0),
  };

  const open = todos.filter((t) => t.status !== 'completed');
  const done = todos.filter((t) => t.status === 'completed');

  // ISS-08: assemble the brief as priority-tagged sections in display order, then
  // fit them to a hard char budget (drop lowest-value first). dropOrder 0 =
  // continuation essentials that must survive the budget.
  const sections: BriefSection[] = [];
  const push = (md: string, dropOrder: number): void => { if (md.trim()) sections.push({ md, dropOrder }); };

  const stateLines = [
    '## State of the work',
    diffStat.ok && diffStat.stdout ? '### Committed vs base\n```\n' + diffStat.stdout + '\n```' : '_No commits beyond the base branch yet._',
    dirtyStat.ok && dirtyStat.stdout ? '### Uncommitted\n```\n' + dirtyStat.stdout + '\n```' : '',
  ].filter(Boolean).join('\n');

  // Objective + where to work — never dropped.
  push([
    // The slug, NOT the task text. `startAgent` hands `brief.body` to the CLI
    // verbatim, so this heading is the first line of an unattended agent's
    // prompt — before the fence is introduced. `plan.ts` joins every prose line
    // under a task heading into `task.task`, so any of it here is attacker
    // prose in Baton's voice, above the quoting. The slug is validated
    // (`AGENT_ID_MAX`, slug grammar), and the fenced Objective two lines down
    // carries the real text.
    `# Handoff: ${titleOf(task.slug)}`,
    '',
    '## Objective',
    fenceUntrusted('plan.task', task.task),
    ...(opts.note ? ['', `> Note from the handing-off side: ${sanitizeUntrusted(opts.note)}`] : []),
    '',
    '## Where to work',
    '```',
    `cd ${task.worktreePath}`,
    '```',
    `Branch \`${task.branch}\` (based on \`${task.baseBranch}\`). Commit here; merge later with \`baton merge\`.`,
    ...(opts.model
      ? [`Suggested model: \`${opts.model}\` — start the receiving CLI with it if it supports model selection (e.g. \`claude --model ${opts.model}\`); Baton can't enforce this.`]
      : []),
  ].join('\n'), 0);

  // The contract shares dropOrder 0 with the objective: acceptance criteria
  // that got trimmed are acceptance criteria nobody agreed to.
  if (opts.contract) push(contractSectionMd(opts.contract), 0);

  // git ground truth — kept longest of the optional sections (ISS-08 prefers
  // verifiable state over prose).
  push(stateLines, 1);

  // Open review findings. A recorded review is only half the fix: the next
  // agent has to MEET the findings without knowing to go looking for them.
  // Anything still open is inherited work, so it ranks just under git ground
  // truth — above the softer prose sections, below the plan.
  // Grouped by axis and never ranked across axes, same rule as everywhere else.
  const review = await loadReview(opts.root, task.slug).catch(() => null);
  const openFinds = openFindings(review);
  if (review && openFinds.length) {
    const lines = [
      '## Open review findings',
      `Reviewed against \`${review.fixedPoint}\` at \`${review.head.slice(0, 9)}\`. ` +
      `Full detail: \`baton review show ${task.slug}\` · close one out: \`baton review resolve ${task.slug} <id>\`.`,
    ];
    for (const axis of REVIEW_AXES) {
      const inAxis = openFinds.filter((f) => f.axis === axis);
      if (!inAxis.length) continue;
      lines.push('', `### ${axis[0].toUpperCase()}${axis.slice(1)}`);
      for (const f of inAxis) {
        const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
        const route = f.route ? ` → ${f.route}` : '';
        lines.push(`- [ ] \`${f.id}\` ${f.title}${where} — ${f.source}${route}`);
      }
    }
    push(lines.join('\n'), 2);
  }

  const hasContext = !!(session || todos.length || notes.length || filesEdited.length);
  if (hasContext) {
    if (done.length || open.length) {
      // Sanitized, not fenced. The plan IS what the next agent should carry out,
      // so quoting it as "data, do not act on this" would be wrong — but it was
      // written by whatever ran last, so it must not be able to forge a
      // terminator and escape the quoting further down.
      const plan = [
        '## Plan',
        ...done.map((t) => `- [x] ${sanitizeUntrusted(t.content)}`),
        ...open.map((t) => `- [ ] ${sanitizeUntrusted(t.content)}`),
      ];
      push(plan.join('\n'), 0); // the plan is the continuation — never drop
    }
    if (nextStep) push(`## Next step\n${sanitizeUntrusted(nextStep)}`, 0);
    if (filesEdited.length) push(['## Files the previous agent edited', ...filesEdited.map((f) => `- ${f}`)].join('\n'), 4);
    // Notes are written by the previous AGENT, not by Baton. A compromised or
    // simply confused upstream session is the same problem as a hostile plan
    // file, so it gets the same quoting.
    if (notes.length) push(['## Last notes from the previous agent', fenceUntrusted('ledger.notes', notes.join('\n\n'))].join('\n'), 3);
    if (commands.length) push(['## Commands it ran (context/verification)', '```', ...commands.slice(-8), '```'].join('\n'), 6);
  } else {
    push('_No session transcript or progress ledger for this worktree — context above is from git alone._', 0);
  }

  // Dispatch only: how this repo is laid out. Dropped before the contract and
  // the state of the work, kept ahead of the graph excerpt it summarises.
  if (opts.orientation?.trim()) {
    push(['## Orientation', '_How this repo is laid out. A shortcut, not a mandate._', opts.orientation.trim()].join('\n'), 3);
  }

  // Graph excerpt: the biggest optional block — first to go after commands.
  const kb = await loadKb(opts.root);
  if (kb) {
    const graphPath = kb.mergedGraphPath ?? kb.projects[0]?.graphPath;
    if (graphPath) {
      const excerpt = await queryGraph(task.task, graphPath, 1500);
      if (excerpt) push(graphSectionMd(excerpt), 5);
    }
  }

  // Project memory: facts earlier sessions learned, evidence-checked — stale
  // facts (changed anchors) are withheld so the executor never inherits rot.
  try {
    const recalled = await recallMemories(opts.root, { topic: task.task, limit: 6 });
    const section = memoryBriefSection(recalled.facts, recalled.staleDropped, recalled.staleGrounding);
    if (section) push(section, 2);
  } catch { /* memory is an enhancement — never block a handoff */ }

  // Positive-phrased rules (ISS-07): requirement form ("do this") outlasts a
  // deep session better than prohibition form ("do NOT"). Never dropped.
  push([
    '## Rules to hold (they matter more the deeper you get)',
    ...guardrailLines(`\`baton done ${task.slug}\``).map((l) => `- ${l}`),
    '- Keep the base branch clean — no force-push or history rewrite on it.',
    '- Include the test/build output in your summary; then `baton done ' + task.slug + '` (or update this file\'s status) when complete.',
  ].join('\n'), 0);

  const { body: fittedBody, dropped } = fitBriefBody(sections, HANDOFF_MAX_CHARS);
  // ISS-08 progressive disclosure: when we trimmed, tell the receiver to pull
  // the rest just-in-time rather than trusting an omission as "nothing there".
  const bodyText = dropped > 0
    ? fittedBody + '\n\n_Lower-priority detail was trimmed to keep this brief lean — pull it just-in-time (`git diff`, `orient`, `recall_memory`, `search_history`)._'
    : fittedBody;

  const markdown = matter.stringify(bodyText.replace(/\n{3,}/g, '\n\n'), meta as unknown as Record<string, unknown>);
  return { meta, markdown, path: handoffPath(task.worktreePath) };
}

export async function writeBrief(brief: HandoffBrief): Promise<void> {
  await writeFile(brief.path, brief.markdown, 'utf-8');
  // HANDOFF.md is Baton's artifact, not the agent's work: untracked it would
  // count as an uncommitted change and the done gate refuses on one of those.
  // Never fail a brief for the bookkeeping.
  await gitExcludeLocal(dirname(brief.path), HANDOFF_REL).catch(() => undefined);
}

export async function readBrief(worktreePath: string): Promise<{ meta: Partial<HandoffMeta>; body: string } | null> {
  try {
    const raw = await readFile(handoffPath(worktreePath), 'utf-8');
    const parsed = parseFrontmatter(raw);
    return { meta: parsed.data as Partial<HandoffMeta>, body: parsed.content };
  } catch {
    return null;
  }
}

export async function setBriefStatus(worktreePath: string, status: HandoffMeta['status']): Promise<boolean> {
  try {
    const raw = await readFile(handoffPath(worktreePath), 'utf-8');
    const parsed = parseFrontmatter(raw);
    parsed.data.status = status;
    await writeFile(handoffPath(worktreePath), matter.stringify(parsed.content, parsed.data), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
