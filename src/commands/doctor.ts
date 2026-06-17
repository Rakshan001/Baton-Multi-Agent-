/**
 * `baton doctor` — audit junk (orphaned worktrees, branches, tmux sessions,
 * leaked temp files). `baton clean [--fix]` — reclaim it (dry-run by default).
 */
import { gitRoot } from '../git.js';
import { auditJunk, cleanJunk, type AuditReport, type JunkItem } from '../cleanup.js';

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

export async function doctorCmd(): Promise<void> {
  const report = await auditJunk(await gitRoot());
  printReport(report);
  if (report.items.length) {
    const dirty = report.items.some((i) => i.blocked === 'dirty');
    console.log(`\n  Reclaim with: baton clean --fix${dirty ? '   (add --force to remove worktrees with uncommitted changes)' : ''}`);
  }
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
