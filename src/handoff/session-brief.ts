/**
 * Session handoff briefs (H1) — the manual relay flow. ANY session can write
 * one on request: a root terminal with no worktree, Cursor at 99% of its usage
 * limit, Codex mid-task. Unlike buildBrief (which reconstructs context from a
 * task worktree + Claude transcripts), here the AGENT supplies done / pending /
 * next / decisions — it knows its own state best. Git adds ground truth
 * (branch, dirty files) and live edit signals add the files in flight.
 *
 * Task sessions write to the worktree's HANDOFF.md so the existing
 * `baton take` flow picks them up; sessions without a task write to
 * .baton/handoffs/<slug>.md and are picked up with `baton resume <slug>`.
 */
import matter from 'gray-matter';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gitTry } from '../util/exec.js';
import { batonDir, getTask } from '../store.js';
import { handoffPath } from './brief.js';
import { recordHandoff } from '../commands/pass.js';
import { getSignals } from '../signals.js';
import { saveMemory } from '../memory.js';
import { bus } from '../events.js';

/** A brief must stay a brief — cap every agent-supplied list. */
const LIST_CAP = 30;
const ITEM_MAX = 300;
const NEXT_MAX = 600;

export interface SessionHandoffInput {
  /** Session or task slug (the caller's own identity — selfSlug in MCP). */
  slug: string;
  /** Agent handing off, e.g. "cursor". */
  agent?: string;
  /** One line: what this work is. Required — the brief is useless without it. */
  title: string;
  done?: string[];
  pending?: string[];
  /** The single most useful next action for whoever resumes. */
  next?: string;
  /** Decisions made / gotchas found — the things git can't show. */
  decisions?: string[];
  /** Receiving agent, if known. */
  to?: string;
  note?: string;
  /** Where the session works (worktree or repo root); defaults sensibly. */
  cwd?: string;
}

export interface SessionHandoffResult {
  path: string;
  markdown: string;
  /** The command the next agent (or the user) runs to pick this up. */
  resume: string;
  /** Memory fact ids harvested from `decisions` (M4) — the agent already wrote
   *  that text, so capturing it costs zero extra tokens. */
  capturedFacts: string[];
}

function cleanList(items: string[] | undefined): { items: string[]; more: number } {
  const cleaned = (items ?? []).map((s) => s.trim().slice(0, ITEM_MAX)).filter(Boolean);
  return { items: cleaned.slice(0, LIST_CAP), more: Math.max(0, cleaned.length - LIST_CAP) };
}

/** Filename-safe slug — never lets a hostile slug escape .baton/handoffs. */
function safeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

/** `git status --porcelain` line → repo-relative path ('R  old -> new' → new).
 *  Parsed by token, not position — exec output trimming can eat the leading
 *  status space, so slicing a fixed column count would corrupt the path. */
function porcelainPath(line: string): string {
  const p = line.trim().replace(/^\S{1,2}\s+/, '');
  const renamed = p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p;
  return renamed.replace(/^"|"$/g, '').trim();
}

/** Decisions shorter than this carry no reusable knowledge ("use jwt"). */
const CAPTURE_MIN_CHARS = 20;

/**
 * M4 — zero-LLM auto-capture: the decisions the agent wrote for the brief are
 * exactly the "things git cannot show", so persist each as an anchored memory
 * fact. Strictly best-effort: validation rejects (secrets, too short), the
 * fact cap, or a non-git cwd skip the item — a handoff must never fail
 * because capture did.
 */
async function captureDecisions(
  cwd: string,
  decisions: string[],
  anchors: string[],
  agent: string | undefined,
  slug: string,
): Promise<string[]> {
  const captured: string[] = [];
  for (const d of decisions) {
    if (d.length < CAPTURE_MIN_CHARS) continue;
    // Precision over coverage: anchor to the files the decision actually
    // names when it names any — a fact anchored to the whole session's file
    // set goes stale the moment ANY of them changes (churn, not evidence).
    const mentioned = anchors.filter((a) => d.includes(a) || d.includes(basename(a)));
    try {
      // saveMemory resolves the MAIN repo from cwd itself (worktree-safe).
      captured.push((await saveMemory(cwd, {
        fact: d, type: 'decision', files: mentioned.length ? mentioned : anchors, agent, task: slug,
      })).id);
    } catch { /* capture is a bonus, never a blocker */ }
  }
  return captured;
}

export async function createSessionHandoff(root: string, input: SessionHandoffInput): Promise<SessionHandoffResult> {
  const title = input.title?.trim();
  if (!title) throw new Error('A handoff needs a title — one line on what this work is.');

  const slug = safeSlug(input.slug);
  const task = await getTask(root, slug).catch(() => undefined);
  const cwd = input.cwd ?? task?.worktreePath ?? root;

  const done = cleanList(input.done);
  const pending = cleanList(input.pending);
  const decisions = cleanList(input.decisions);
  const next = input.next?.trim().slice(0, NEXT_MAX);

  // Git ground truth — fail-safe: outside a git repo these sections are skipped.
  const branch = await gitTry(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = await gitTry(['-C', cwd, 'status', '--porcelain']);
  const dirtyFiles = dirty.ok && dirty.stdout ? dirty.stdout.split('\n').filter(Boolean) : [];

  // Files this session declared it is editing (live signals).
  let inFlight: string[] = [];
  try {
    inFlight = (await getSignals(root))
      .filter((s) => s.holders.some((h) => h.slug === slug))
      .map((s) => s.path)
      .slice(0, LIST_CAP);
  } catch { /* signals are an enhancement — never block a handoff */ }

  const meta: Record<string, unknown> = {
    baton: 1,
    kind: task ? 'task' : 'session',
    title,
    from: input.agent ?? 'unknown',
    to: input.to ?? 'any',
    status: 'ready',
    created: new Date().toISOString(),
    repo: root,
    ...(branch.ok && branch.stdout ? { branch: branch.stdout.trim() } : {}),
  };

  const body: string[] = [`# Handoff: ${title}`];
  if (input.note?.trim()) body.push('', `> Note from the handing-off side: ${input.note.trim()}`);

  if (done.items.length) {
    body.push('', '## Done');
    for (const d of done.items) body.push(`- [x] ${d}`);
    if (done.more) body.push(`- …${done.more} more not shown`);
  }
  if (pending.items.length) {
    body.push('', '## Pending');
    for (const p of pending.items) body.push(`- [ ] ${p}`);
    if (pending.more) body.push(`- …${pending.more} more not shown`);
  }
  if (next) body.push('', '## Next step', next);
  if (decisions.items.length) {
    body.push('', '## Decisions & gotchas');
    for (const d of decisions.items) body.push(`- ${d}`);
    if (decisions.more) body.push(`- …${decisions.more} more not shown`);
  }

  body.push('', '## Where to work', '```', `cd ${cwd}`, '```');
  if (branch.ok && branch.stdout) body.push(`Branch \`${branch.stdout.trim()}\`.`);
  if (dirtyFiles.length) {
    body.push('', '## Uncommitted changes in the tree', '```', ...dirtyFiles.slice(0, 20), '```');
    if (dirtyFiles.length > 20) body.push(`…${dirtyFiles.length - 20} more files.`);
  }
  if (inFlight.length) {
    body.push('', '## Files this session was editing', ...inFlight.map((f) => `- ${f}`));
  }

  const resume = task ? `baton take ${slug}` : `baton resume ${slug}`;
  body.push('', '## Pick up with', '```', resume, '```');

  const markdown = matter.stringify(body.join('\n').replace(/\n{3,}/g, '\n\n'), meta);

  let path: string;
  if (task) {
    path = handoffPath(task.worktreePath);
  } else {
    const dir = join(batonDir(root), 'handoffs');
    await mkdir(dir, { recursive: true });
    path = join(dir, `${slug}.md`);
  }
  await writeFile(path, markdown, 'utf-8');

  try {
    recordHandoff(root, { slug, from: String(meta.from), to: String(meta.to), createdAt: String(meta.created), status: 'ready' });
  } catch { /* the ledger is best-effort — the brief file is the source of truth */ }
  bus.publish({ type: 'handoff.created', slug, toAgent: String(meta.to) });

  // Anchor harvested decisions to where the work actually happened: files this
  // session declared (signals) + the tree's dirty files at handoff time.
  const anchors = [...new Set([...inFlight, ...dirtyFiles.map(porcelainPath)])].slice(0, 8);
  const capturedFacts = await captureDecisions(cwd, decisions.items, anchors, input.agent, slug);

  return { path, markdown, resume, capturedFacts };
}
