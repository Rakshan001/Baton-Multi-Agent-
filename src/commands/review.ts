/**
 * `baton review` — persist and inspect code-review findings.
 *
 * The `code-review` skill runs its axes as sub-agents and would otherwise end
 * at "print two reports in chat", which dies with the session. These commands
 * are how a review becomes durable shared state: another agent, `baton resume`,
 * and the daemon all read the same record.
 *
 *   baton review save <slug> < findings.json   # stdin JSON, the skill's last step
 *   baton review list                          # every recorded review
 *   baton review show <slug>                   # findings, grouped by axis
 *   baton review resolve <slug> <n> [--dismiss]
 *
 * Findings are printed grouped by axis and NEVER ranked across axes — the whole
 * point of the two/three-axis split is that one axis passing can't mask another
 * failing, and a combined "worst issue" would undo that.
 */
import { gitRoot, headCommit } from '../git.js';
import { bus } from '../events.js';
import {
  countByAxis, isReviewStale, listReviews, loadReview, openFindings, resolveFinding,
  REVIEW_AXES, saveReview, type ReviewAxis, type ReviewFinding, type ReviewRecord,
} from '../reviews.js';

const AXIS_LABEL: Record<ReviewAxis, string> = {
  standards: 'Standards',
  spec: 'Spec',
  security: 'Security',
};

const STATUS_MARK: Record<string, string> = { open: '○', fixed: '●', dismissed: '·' };

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function printFinding(f: ReviewFinding, index: number): void {
  const mark = STATUS_MARK[f.status] ?? '○';
  const where = f.file ? `  ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  // A documented-standard breach is binding; everything else is a judgement
  // call. Keeping them visually distinct is a rule of the skill, not a nicety.
  const kind = f.hard ? 'VIOLATION' : 'judgement';
  console.log(`  [${index}] ${mark} ${kind}  ${f.title}${where}`);
  console.log(`        source: ${f.source}`);
  if (f.detail) console.log(`        ${f.detail.split('\n')[0]}`);
  if (f.route && f.status === 'open') console.log(`        → next: ${f.route}`);
}

function printRecord(rec: ReviewRecord, currentHead: string): void {
  const open = openFindings(rec);
  const counts = countByAxis(open);
  console.log(`${rec.slug} — ${rec.fixedPoint}...${rec.head.slice(0, 9)}${rec.agent ? ` · ${rec.agent}` : ''}`);
  console.log(`  reviewed ${rec.updatedAt.split('T')[0]} · open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);

  if (isReviewStale(rec, currentHead)) {
    console.log(`  ⚠ STALE: reviewed at ${rec.head.slice(0, 9)}, HEAD is now ${currentHead.slice(0, 9)} — findings may already be fixed`);
  }
  if (rec.partial) console.log(`  ⚠ PARTIAL: ${rec.partial}`);
  for (const s of rec.skipped) console.log(`  — ${AXIS_LABEL[s.axis]} axis skipped: ${s.why}`);
  console.log('');

  // Grouped by axis, printed in a fixed order. No cross-axis ranking.
  for (const axis of REVIEW_AXES) {
    const inAxis = rec.findings.map((f, i) => [f, i] as const).filter(([f]) => f.axis === axis);
    if (!inAxis.length) continue;
    console.log(`  ## ${AXIS_LABEL[axis]}`);
    for (const [f, i] of inAxis) printFinding(f, i);
    console.log('');
  }
}

/** `baton review save <slug>` — read a findings JSON payload on stdin. */
export async function reviewSaveCmd(slug: string): Promise<void> {
  const root = await gitRoot();
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('✗ nothing on stdin — pipe the review JSON: baton review save <slug> < findings.json');
    process.exitCode = 1;
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`✗ stdin is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const rec = await saveReview(root, slug, {
      fixedPoint: String(payload.fixedPoint ?? ''),
      head: String(payload.head ?? ((await headCommit(root).catch(() => null)) ?? '')),
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      skipped: Array.isArray(payload.skipped) ? payload.skipped as never : [],
      partial: payload.partial ? String(payload.partial) : undefined,
      agent: payload.agent ? String(payload.agent) : process.env.BATON_AGENT?.trim(),
    });
    const counts = countByAxis(openFindings(rec));
    bus.publish({ type: 'review.completed', slug: rec.slug, ...counts });
    console.log(`✓ review saved: ${rec.slug} (${rec.findings.length} finding${rec.findings.length === 1 ? '' : 's'})`);
    console.log(`  open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);
    for (const s of rec.skipped) console.log(`  — ${AXIS_LABEL[s.axis]} axis skipped: ${s.why}`);
    console.log(`  see: baton review show ${rec.slug}`);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

/** `baton review list` — every recorded review, newest first. */
export async function reviewListCmd(): Promise<void> {
  const root = await gitRoot();
  const all = await listReviews(root);
  if (!all.length) {
    console.log('No reviews recorded.');
    console.log('Agents running the code-review skill persist findings with `baton review save <slug>`.');
    return;
  }
  const head = (await headCommit(root).catch(() => null)) ?? '';
  console.log(`${all.length} recorded review${all.length === 1 ? '' : 's'}:\n`);
  for (const rec of all) {
    const counts = countByAxis(openFindings(rec));
    const stale = isReviewStale(rec, head) ? '  ⚠ stale' : '';
    console.log(`  ${rec.slug}  ${rec.updatedAt.split('T')[0]}  ${rec.fixedPoint}...${rec.head.slice(0, 9)}${stale}`);
    console.log(`      open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);
  }
  console.log('\n  Detail: baton review show <slug>');
}

/** `baton review show <slug>` — findings grouped by axis. */
export async function reviewShowCmd(slug: string): Promise<void> {
  const root = await gitRoot();
  const rec = await loadReview(root, slug);
  if (!rec) {
    console.error(`No review recorded for '${slug}'. See: baton review list`);
    process.exitCode = 1;
    return;
  }
  printRecord(rec, (await headCommit(root).catch(() => null)) ?? '');
}

/** `baton review resolve <slug> <index>` — mark a finding fixed (or dismissed). */
export async function reviewResolveCmd(slug: string, indexArg: string, opts: { dismiss?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const index = Number.parseInt(indexArg, 10);
  if (!Number.isInteger(index) || index < 0) {
    console.error(`✗ '${indexArg}' is not a finding index — see the [n] markers in: baton review show ${slug}`);
    process.exitCode = 1;
    return;
  }
  const status = opts.dismiss ? 'dismissed' : 'fixed';
  const rec = await resolveFinding(root, slug, index, status);
  if (!rec) {
    console.error(`✗ no finding [${index}] in review '${slug}'. See: baton review show ${slug}`);
    process.exitCode = 1;
    return;
  }
  const counts = countByAxis(openFindings(rec));
  console.log(`✓ finding [${index}] marked ${status}`);
  console.log(`  open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);
}
