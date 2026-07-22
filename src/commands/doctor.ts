/**
 * `baton doctor` — audit junk (orphaned worktrees, branches, tmux sessions,
 * leaked temp files). `baton clean [--fix]` — reclaim it (dry-run by default).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitRoot } from '../git.js';
import { auditJunk, cleanJunk, type AuditReport, type JunkItem } from '../cleanup.js';
import { scanDocSprawl, listRepoFiles, lastCommitDate, type SprawlFinding } from '../kb/sprawl.js';
import { batonDir, loadTasks, resolveBatonRoot } from '../store.js';
import { loadKb } from '../kb/state.js';
import { auditKb, type KbFinding } from '../kb/health.js';

const KIND_LABEL: Record<JunkItem['kind'], string> = {
  'orphan-worktree-task': 'orphaned worktree (stale task)',
  'orphan-worktree-disk': 'orphaned worktree (on disk)',
  'orphan-branch': 'orphaned branch',
  'orphan-tmux': 'orphaned tmux session',
  'tmp-file': 'leaked temp file',
  'tmp-upload': 'stale upload',
};

function printReport(report: AuditReport): void {
  if (!report.items.length) {
    console.log('✓ no junk found — nothing to clean');
    return;
  }
  console.log(`Found ${report.items.length} item${report.items.length === 1 ? '' : 's'}:\n`);
  for (const it of report.items) {
    const blocked = it.blocked ? `  ⚠ ${it.blocked}` : '';
    console.log(`  • [${KIND_LABEL[it.kind]}] ${it.id}${blocked}`);
    console.log(`      ${it.reason}`);
    if (it.path) console.log(`      ${it.path}`);
  }
}

const KB_GLYPH: Record<KbFinding['level'], string> = { error: '✗', warn: '⚠', info: '·' };

/**
 * The KB section. Printed even when it is healthy, because the failure this
 * exists to catch is silent: the graph answers with nothing and looks fine.
 */
function printKb(findings: KbFinding[]): void {
  if (!findings.length) {
    console.log('✓ knowledge base looks healthy');
    return;
  }
  console.log('Knowledge base:\n');
  for (const f of findings) {
    console.log(`  ${KB_GLYPH[f.level]} ${f.message}`);
    if (f.fix) console.log(`      → ${f.fix}`);
  }
}

export async function doctorCmd(opts: { docs?: boolean; fix?: boolean } = {}): Promise<void> {
  if (opts.docs) return doctorDocsCmd();
  const report = await auditJunk(await gitRoot());
  printReport(report);
  if (report.items.length) {
    const dirty = report.items.some((i) => i.blocked === 'dirty');
    console.log(`\n  Reclaim with: baton clean --fix${dirty ? '   (add --force to remove worktrees with uncommitted changes)' : ''}`);
  }
  const root = await resolveBatonRoot();
  console.log('');
  printKb(await auditKb(root));
  await reportShadowBatons(root, !!opts.fix);
}

/**
 * ADD-07/C (ISS-13) — a `.baton` planted INSIDE a hub sub-project (older buggy
 * build, or an agent that mis-resolved before the store.ts fix). It splits the
 * store: tasks/presence written there are invisible to the daemon reading the
 * hub `.baton`.
 */
export interface ShadowBaton {
  projectId: string;
  path: string;        // the shadow `.baton` dir
  projectPath: string; // the sub-project checkout it sits in
  tasks: number;
  hasMemory: boolean;
  hasKb: boolean;
  /** No durable state (only ephemeral presence / locks) → safe to delete. */
  removable: boolean;
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Shadow `.baton` dirs sitting inside this hub's sub-projects. Empty for a
 * single repo (no sub-projects to shadow) or a coherent hub. A shadow is
 * `removable` only when it holds no durable state — the ephemeral `history.db`
 * (30-min-TTL presence) and locks don't count; tasks, memory facts, and a
 * project `kb.json` do, and keep it report-only.
 */
export async function scanShadowBatons(hubRoot: string): Promise<ShadowBaton[]> {
  const kb = await loadKb(hubRoot);
  if (!kb || kb.projects.length === 0) return [];
  const shadows: ShadowBaton[] = [];
  for (const p of kb.projects) {
    const shadow = batonDir(p.path);
    if (!(await exists(shadow))) continue;
    const tasks = (await loadTasks(p.path)).length;
    const facts = await readdir(join(shadow, 'memory', 'facts')).catch(() => [] as string[]);
    const hasMemory = facts.some((f) => f.endsWith('.md'));
    const hasKb = await exists(join(shadow, 'kb.json'));
    shadows.push({
      projectId: p.id,
      path: shadow,
      projectPath: p.path,
      tasks,
      hasMemory,
      hasKb,
      removable: tasks === 0 && !hasMemory && !hasKb,
    });
  }
  return shadows;
}

/**
 * Reconcile shadows: delete only the removable (ephemeral-only) ones when
 * `apply` is set; never touch a shadow holding real state — folding tasks or
 * memory across two stores is a human call. Returns what was (or would be)
 * removed and what was kept.
 */
export async function reconcileShadowBatons(
  hubRoot: string,
  apply: boolean,
): Promise<{ removed: ShadowBaton[]; kept: ShadowBaton[] }> {
  const shadows = await scanShadowBatons(hubRoot);
  const removed = shadows.filter((s) => s.removable);
  const kept = shadows.filter((s) => !s.removable);
  if (apply) {
    for (const s of removed) await rm(s.path, { recursive: true, force: true });
  }
  return { removed, kept };
}

function describeState(s: ShadowBaton): string {
  if (s.removable) return 'ephemeral presence only';
  return [
    s.tasks ? `${s.tasks} task${s.tasks === 1 ? '' : 's'}` : '',
    s.hasMemory ? 'memory facts' : '',
    s.hasKb ? 'kb.json' : '',
  ].filter(Boolean).join(', ');
}

async function reportShadowBatons(hubRoot: string, fix: boolean): Promise<void> {
  const shadows = await scanShadowBatons(hubRoot);
  if (!shadows.length) return; // single repo or coherent hub — stay quiet
  const removable = shadows.filter((s) => s.removable);
  const real = shadows.filter((s) => !s.removable);
  console.log(`\nHub coherence — ${shadows.length} shadow .baton dir${shadows.length === 1 ? '' : 's'} inside sub-projects (splits the store, ISS-13):\n`);
  for (const s of shadows) {
    console.log(`  • [${s.projectId}] ${s.path}`);
    console.log(`      ${s.removable ? 'safe to remove' : 'HOLDS REAL STATE'}: ${describeState(s)}`);
  }
  if (!fix) {
    if (removable.length) console.log(`\n  ${removable.length} removable — re-run with: baton doctor --fix`);
    if (real.length) console.log(`\n  ${real.length} hold real state — move their tasks/memory into the hub .baton, then delete the shadow.`);
    return;
  }
  const { removed } = await reconcileShadowBatons(hubRoot, true);
  for (const s of removed) console.log(`\n  ✓ removed shadow [${s.projectId}] ${s.path}`);
  if (real.length) console.log(`\n  ${real.length} shadow${real.length === 1 ? '' : 's'} left untouched (real state) — migrate manually before removing.`);
}

const SPRAWL_LABEL: Record<SprawlFinding['kind'], string> = {
  'memory-bank': 'scattered memory-bank',
  'stray-notes': 'stray notes / TODO files',
  'duplicate-rules': 'competing per-agent rule files',
};

/**
 * Propose-only scan for scattered `.md` sprawl a fresh agent would otherwise
 * ingest. Never mutates — importing to memory or moving docs is a human call
 * (see sprawl.ts for why bulk import can't be auto-applied).
 */
export async function doctorDocsCmd(): Promise<void> {
  const root = await gitRoot();
  const findings = scanDocSprawl(await listRepoFiles(root));
  if (!findings.length) {
    console.log('✓ no doc sprawl found — the knowledge base is the single source');
    return;
  }
  const total = findings.reduce((n, f) => n + f.paths.length, 0);
  console.log(`Found ${total} file${total === 1 ? '' : 's'} of doc sprawl:\n`);
  for (const f of findings) {
    console.log(`  • [${SPRAWL_LABEL[f.kind]}]`);
    for (const p of f.paths) {
      const date = await lastCommitDate(root, p);
      console.log(`      ${p}${date ? `  (last touched ${date})` : ''}`);
    }
    console.log(`      → ${f.suggestion}\n`);
  }
  console.log('  These are suggestions only — Baton will not move or delete anything.');
}

export async function cleanCmd(opts: { fix?: boolean; force?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const report = await auditJunk(root);
  if (!report.items.length) {
    console.log('✓ no junk found — nothing to clean');
    return;
  }
  const result = await cleanJunk(root, report, { apply: !!opts.fix, force: !!opts.force });

  if (!opts.fix) {
    console.log(`Would remove ${result.removed.length} item${result.removed.length === 1 ? '' : 's'} (dry-run):\n`);
    for (const it of result.removed) console.log(`  • [${KIND_LABEL[it.kind]}] ${it.id}`);
    if (result.skipped.length) {
      console.log(`\n  ${result.skipped.length} would be skipped:`);
      for (const s of result.skipped) console.log(`  • ${s.item.id} — ${s.why}`);
    }
    console.log('\n  Re-run with --fix to actually delete.');
    return;
  }

  console.log(`✓ removed ${result.removed.length} item${result.removed.length === 1 ? '' : 's'}`);
  for (const it of result.removed) console.log(`  • [${KIND_LABEL[it.kind]}] ${it.id}`);
  if (result.skipped.length) {
    console.log(`\n  skipped ${result.skipped.length}:`);
    for (const s of result.skipped) console.log(`  • ${s.item.id} — ${s.why}`);
  }
}
