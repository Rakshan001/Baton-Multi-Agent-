/**
 * `baton pass [slug] --to <agent>` — package the current session into a
 * HANDOFF.md brief so another agent (Cursor/Codex/Gemini…) can continue.
 * The core of the session-limit story: plan on the expensive agent, pass
 * the baton to the cheap one.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitRoot } from '../git.js';
import { gitTry } from '../util/exec.js';
import { batonDir, getTask, loadTasks, type Task } from '../store.js';
import { buildBrief, readBrief, writeBrief, type HandoffBrief } from '../handoff/brief.js';
import { loadRouting, suggestAgent, type RoutingSuggestion } from '../routing.js';
import { bus } from '../events.js';

const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null = null;
function sqlite(): typeof import('node:sqlite') {
  return (_sqlite ??= nodeRequire('node:sqlite') as typeof import('node:sqlite'));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS handoffs (
  slug TEXT,
  from_agent TEXT,
  to_agent TEXT,
  created_at TEXT,
  status TEXT
);
`;

function getDb(root: string): DatabaseSync {
  const dir = batonDir(root);
  mkdirSync(dir, { recursive: true });
  const db = new (sqlite().DatabaseSync)(join(dir, 'history.db'));
  db.exec(SCHEMA);
  return db;
}

export function recordHandoff(root: string, args: { slug: string; from: string; to: string; createdAt: string; status: string }): void {
  getDb(root)
    .prepare(`INSERT INTO handoffs (slug, from_agent, to_agent, created_at, status) VALUES (?, ?, ?, ?, ?)`)
    .run(args.slug, args.from, args.to, args.createdAt, args.status);
}

/** Resolve a task from an explicit slug or from being cd'd into its worktree. */
export async function resolveTask(root: string, slug?: string, cwd = process.cwd()): Promise<Task | null> {
  if (slug) return (await getTask(root, slug)) ?? null;
  const here = resolve(cwd);
  const tasks = await loadTasks(root);
  return tasks.find((t) => here === resolve(t.worktreePath) || here.startsWith(resolve(t.worktreePath) + '/')) ?? null;
}

export interface PassOptions {
  /** Receiving agent. Omitted (or "auto") → routed via baton.config.json rules. */
  to?: string;
  note?: string;
  /** Quiet hook mode: no-op outside a worktree, skip if a fresh brief exists. */
  auto?: boolean;
  commitPending?: boolean;
  from?: string;
}

export interface PassResult {
  brief: HandoffBrief;
  routed: RoutingSuggestion | null; // set when the target came from routing, not --to
}

/** Core pass pipeline, shared by CLI and POST /api/tasks/:slug/handoff. */
export async function passTask(slug: string | undefined, opts: PassOptions, root?: string): Promise<PassResult | null> {
  const repoRoot = root ?? (await gitRoot());
  const task = await resolveTask(repoRoot, slug);
  if (!task) {
    if (opts.auto) return null; // hook fired outside a baton worktree — fine
    throw new Error(slug ? `No task '${slug}'` : 'Not inside a baton worktree — pass a slug: baton pass <slug>');
  }

  // No explicit target → route by task type (committable rules in baton.config.json).
  let routed: RoutingSuggestion | null = null;
  let to = opts.to;
  let model: string | undefined;
  if (!to || to === 'auto') {
    const { config } = await loadRouting(repoRoot);
    routed = suggestAgent(task.task, config);
    to = routed.agent;
    model = routed.model;
  }

  // --auto debounce: don't churn a fresh, untaken brief on every hook fire.
  if (opts.auto) {
    const existing = await readBrief(task.worktreePath);
    if (existing?.meta.status === 'ready') {
      try {
        const st = await stat(join(task.worktreePath, 'HANDOFF.md'));
        if (Date.now() - st.mtimeMs < 10 * 60_000) return null;
      } catch { /* rewrite it */ }
    }
  }

  // Checkpoint uncommitted work so the next agent starts from a real commit.
  if (opts.commitPending !== false) {
    const dirty = await gitTry(['-C', task.worktreePath, 'status', '--porcelain']);
    if (dirty.ok && dirty.stdout) {
      await gitTry(['-C', task.worktreePath, 'add', '-A']);
      await gitTry(['-C', task.worktreePath, 'commit', '-m', 'chore: checkpoint before handoff']);
    }
  }

  const brief = await buildBrief(task, { from: opts.from ?? 'claude', to: to ?? 'any', model, note: opts.note, root: repoRoot });
  await writeBrief(brief);
  recordHandoff(repoRoot, { slug: task.slug, from: brief.meta.from, to: brief.meta.to, createdAt: brief.meta.created, status: 'ready' });
  bus.publish({ type: 'handoff.created', slug: task.slug, toAgent: brief.meta.to });
  return { brief, routed };
}

export async function passCmd(slug: string | undefined, opts: PassOptions): Promise<void> {
  try {
    const result = await passTask(slug, opts);
    if (!result) return; // silent no-op (--auto)
    const { brief, routed } = result;
    console.log(`✓ handoff brief ready → ${brief.path}`);
    if (routed) {
      const why = routed.source === 'rule' ? `matched ${routed.matched.map((m) => `'${m}'`).join(', ')}` : 'default route';
      console.log(`  routed → ${routed.agent}${routed.model ? ` (model: ${routed.model})` : ''} · ${why} · override with --to <agent>`);
    }
    console.log(`  to: ${brief.meta.to} · session ≈ ${brief.meta.est_tokens.toLocaleString()} tokens (≈ $${brief.meta.est_cost_usd} to replay raw)`);
    console.log('');
    console.log('  Next agent picks it up with:');
    console.log(`    cd ${brief.path.replace(/\/HANDOFF\.md$/, '')} && baton take`);
  } catch (e) {
    if (opts.auto) return; // hooks must never fail the host agent
    throw e;
  }
}
