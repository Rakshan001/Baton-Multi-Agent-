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
import { loadRouting, resolveChain, suggestRoute, type RouteSuggestion } from '../routing.js';
import { agentInstalled } from '../agents/roster.js';
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

// Cached per root — passTask runs inside the long-lived daemon, and an
// uncached connection per handoff is a file-handle leak.
const conns = new Map<string, DatabaseSync>();

function getDb(root: string): DatabaseSync {
  const cached = conns.get(root);
  if (cached) return cached;
  const dir = batonDir(root);
  mkdirSync(dir, { recursive: true });
  const db = new (sqlite().DatabaseSync)(join(dir, 'history.db'));
  db.exec(SCHEMA);
  conns.set(root, db);
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
  /** Model override for the receiving CLI (advisory in the brief frontmatter). */
  model?: string;
  note?: string;
  /** Quiet hook mode: no-op outside a worktree, skip if a fresh brief exists. */
  auto?: boolean;
  commitPending?: boolean;
  from?: string;
}

export interface PassResult {
  brief: HandoffBrief;
  routed: RouteSuggestion | null; // set when the target came from routing, not --to
  /** Chain agents skipped because their CLI isn't installed. */
  skipped: string[];
}

/** Core pass pipeline, shared by CLI and POST /api/tasks/:slug/handoff. */
export async function passTask(slug: string | undefined, opts: PassOptions, root?: string): Promise<PassResult | null> {
  const repoRoot = root ?? (await gitRoot());
  const task = await resolveTask(repoRoot, slug);
  if (!task) {
    if (opts.auto) return null; // hook fired outside a baton worktree — fine
    throw new Error(slug ? `No task '${slug}'` : 'Not inside a baton worktree — pass a slug: baton pass <slug>');
  }

  // --auto debounce FIRST: don't churn a fresh, untaken brief (or run routing)
  // on every hook fire.
  if (opts.auto) {
    const existing = await readBrief(task.worktreePath);
    if (existing?.meta.status === 'ready') {
      try {
        const st = await stat(join(task.worktreePath, 'HANDOFF.md'));
        if (Date.now() - st.mtimeMs < 10 * 60_000) return null;
      } catch { /* rewrite it */ }
    }
  }

  // No explicit target → route by task type + severity (committable rules in
  // baton.config.json). The suggestion's fallback chain is walked so an
  // uninstalled first choice (e.g. Ollama down) falls through, never fails.
  let routed: RouteSuggestion | null = null;
  let skipped: string[] = [];
  let to = opts.to;
  let model = opts.model;
  if (!to || to === 'auto') {
    const { config } = await loadRouting(repoRoot);
    routed = suggestRoute(task.task, config);
    const resolved = await resolveChain(routed.chain, (agent) => agentInstalled(agent));
    const pick = resolved?.entry ?? routed.chain[0];
    skipped = resolved?.skipped ?? [];
    to = pick.agent;
    model = opts.model ?? pick.model;
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
  return { brief, routed, skipped };
}

export async function passCmd(slug: string | undefined, opts: PassOptions): Promise<void> {
  try {
    const result = await passTask(slug, opts);
    if (!result) return; // silent no-op (--auto)
    const { brief, routed, skipped } = result;
    console.log(`✓ handoff brief ready → ${brief.path}`);
    if (routed) {
      const why =
        routed.source === 'rule' ? `matched ${routed.matched.map((m) => `'${m}'`).join(', ')}`
        : routed.source === 'severity' ? `severity ${routed.severity}/100 → ${routed.tier} tier`
        : routed.source === 'single' ? 'single-agent mode'
        : 'default route';
      console.log(`  routed → ${brief.meta.to}${brief.meta.model ? ` (model: ${brief.meta.model})` : ''} · ${why} · override with --to <agent>`);
      if (skipped.length) console.log(`  skipped (CLI not installed): ${skipped.join(', ')}`);
      if (routed.mode === 'manual') console.log(`  note: routing mode is "manual" — this is only a suggestion; pick with --to`);
      if (routed.confidence === 'low' && routed.source !== 'single') console.log(`  confidence: low — double-check the target`);
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
