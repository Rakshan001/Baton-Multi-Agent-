/**
 * Handoff brief generation — the knowledge pack a cheaper agent picks up with
 * `baton take`. Not a raw history dump: a curated HANDOFF.md with objective,
 * touched files, the extracted plan, and (when the KB is initialized) a
 * graphify graph excerpt scoped to the task.
 */
import matter from 'gray-matter';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitTry } from '../util/exec.js';
import type { Task } from '../store.js';
import { loadKb } from '../kb/state.js';
import { queryGraph } from '../kb/graphify.js';
import { memoryBriefSection, recallMemories } from '../memory.js';
import { sessionContextFor, type SessionContext } from './claude-session.js';
import { loadProgress } from './progress-ledger.js';

export interface HandoffMeta {
  baton: number;
  from: string;
  to: string;
  /** Suggested model for the receiving CLI (advisory — Baton can't enforce it). */
  model?: string;
  status: 'ready' | 'in-progress' | 'done';
  created: string;
  repo: string;
  branch: string;
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

export function handoffPath(worktreePath: string): string {
  return join(worktreePath, 'HANDOFF.md');
}

export async function buildBrief(
  task: Task,
  opts: { from?: string; to: string; model?: string; note?: string; root: string },
): Promise<HandoffBrief> {
  const session: SessionContext | null = await sessionContextFor(task.worktreePath);
  // ISS-06: for a non-Claude agent there is no transcript, so plan/notes/files
  // used to vanish. Merge the agent-agnostic progress ledger (save_progress) —
  // preferring the richer transcript per field when it exists, else the ledger.
  const ledger = await loadProgress(opts.root, task.slug).catch(() => null);
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

  const body: string[] = [
    `# Handoff: ${task.task}`,
    '',
    '## Objective',
    task.task,
    ...(opts.note ? ['', `> Note from the handing-off side: ${opts.note}`] : []),
    '',
    '## Where to work',
    '```',
    `cd ${task.worktreePath}`,
    '```',
    `Branch \`${task.branch}\` (based on \`${task.baseBranch}\`). Commit here; merge later with \`baton merge\`.`,
    ...(opts.model
      ? [`Suggested model: \`${opts.model}\` — start the receiving CLI with it if it supports model selection (e.g. \`claude --model ${opts.model}\`); Baton can't enforce this.`]
      : []),
    '',
    '## State of the work',
    diffStat.ok && diffStat.stdout ? '### Committed vs base\n```\n' + diffStat.stdout + '\n```' : '_No commits beyond the base branch yet._',
    dirtyStat.ok && dirtyStat.stdout ? '### Uncommitted\n```\n' + dirtyStat.stdout + '\n```' : '',
  ];

  const hasContext = !!(session || todos.length || notes.length || filesEdited.length);
  if (hasContext) {
    if (done.length || open.length) {
      body.push('', '## Plan');
      for (const t of done) body.push(`- [x] ${t.content}`);
      for (const t of open) body.push(`- [ ] ${t.content}`);
    }
    if (nextStep) body.push('', '## Next step', nextStep);
    if (filesEdited.length) {
      body.push('', '## Files the previous agent edited', ...filesEdited.map((f) => `- ${f}`));
    }
    if (notes.length) {
      body.push('', '## Last notes from the previous agent', ...notes.map((n) => `> ${n.replace(/\n/g, '\n> ')}`));
    }
    if (commands.length) {
      body.push('', '## Commands it ran (context/verification)', '```', ...commands.slice(-8), '```');
    }
  } else {
    body.push('', '_No session transcript or progress ledger for this worktree — context above is from git alone._');
  }

  // Graph excerpt: a token-budgeted map of the code relevant to this task.
  const kb = await loadKb(opts.root);
  if (kb) {
    const graphPath = kb.mergedGraphPath ?? kb.projects[0]?.graphPath;
    if (graphPath) {
      const excerpt = await queryGraph(task.task, graphPath, 1500);
      if (excerpt) body.push('', '## Codebase map (graph excerpt)', '```', excerpt, '```');
    }
  }

  // Project memory: facts earlier sessions learned, evidence-checked — stale
  // facts (changed anchors) are withheld so the executor never inherits rot.
  try {
    const recalled = await recallMemories(opts.root, { topic: task.task, limit: 6 });
    const section = memoryBriefSection(recalled.facts, recalled.staleDropped, recalled.staleGrounding);
    if (section) body.push('', section);
  } catch { /* memory is an enhancement — never block a handoff */ }

  body.push(
    '',
    '## Before you finish',
    '- Run the project tests/build and include the output in your summary.',
    `- \`baton done ${task.slug}\` (or update this file's status) when complete.`,
    '',
    '## Do NOT',
    '- Touch files outside this worktree.',
    '- Force-push or rewrite history on the base branch.',
    '- Re-plan from scratch — execute the plan above; flag blockers instead.',
  );

  const markdown = matter.stringify(body.filter((l) => l !== '').join('\n').replace(/\n{3,}/g, '\n\n'), meta as unknown as Record<string, unknown>);
  return { meta, markdown, path: handoffPath(task.worktreePath) };
}

export async function writeBrief(brief: HandoffBrief): Promise<void> {
  await writeFile(brief.path, brief.markdown, 'utf-8');
}

export async function readBrief(worktreePath: string): Promise<{ meta: Partial<HandoffMeta>; body: string } | null> {
  try {
    const raw = await readFile(handoffPath(worktreePath), 'utf-8');
    const parsed = matter(raw);
    return { meta: parsed.data as Partial<HandoffMeta>, body: parsed.content };
  } catch {
    return null;
  }
}

export async function setBriefStatus(worktreePath: string, status: HandoffMeta['status']): Promise<boolean> {
  try {
    const raw = await readFile(handoffPath(worktreePath), 'utf-8');
    const parsed = matter(raw);
    parsed.data.status = status;
    await writeFile(handoffPath(worktreePath), matter.stringify(parsed.content, parsed.data), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
