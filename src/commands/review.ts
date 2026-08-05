/**
 * `baton review` — persist and inspect code-review findings.
 *
 * The `code-review` skill runs its axes as sub-agents and would otherwise end
 * at "print two reports in chat", which dies with the session. These commands
 * are how a review becomes durable shared state: `buildBrief` carries any OPEN
 * findings into the handoff brief (so `baton take` / `baton resume` surface them
 * without the next agent knowing to look), the daemon serves them at
 * `/api/reviews`, and `baton review show` prints the full record.
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
import { headCommit } from '../git.js';
import { bus } from '../events.js';
import { activeBatonRoot, mutateTasks } from '../store.js';
import {
  countByAxis, isReviewStale, listReviews, loadReview, openFindings, resolveFinding,
  REVIEW_AXES, reviewHeads, saveReview, type ReviewAxis, type ReviewFinding, type ReviewRecord,
} from '../reviews.js';
// Aliased: `reject` is already the name of a Promise callback in this file, and
// a shadowed import is the kind of thing that reads fine and behaves wrong.
import { approve as approveTask, reject as rejectTask, type Outcome, type Who } from '../lifecycle.js';
import { resolveAgentId, resolveSessionSlug } from '../identity.js';

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
  // Both handles: the index is what people type, the id is what survives a
  // re-review (which reorders the list). `resolve` accepts either.
  console.log(`  [${index}] ${f.id}  ${mark} ${kind}  ${f.title}${where}`);
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
  const root = await activeBatonRoot();

  // An interactive terminal never sends EOF on its own, so waiting for 'end'
  // here hangs forever with no output. Fail fast with the usage instead.
  if (process.stdin.isTTY) {
    console.error('✗ no input piped — this command reads the review JSON from stdin:');
    console.error(`    baton review save ${slug} < findings.json`);
    console.error(`    cat findings.json | baton review save ${slug}`);
    process.exitCode = 1;
    return;
  }

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
  const root = await activeBatonRoot();
  const all = await listReviews(root);
  if (!all.length) {
    console.log('No reviews recorded.');
    console.log('Agents running the code-review skill persist findings with `baton review save <slug>`.');
    return;
  }
  const heads = await reviewHeads(root, all.map((r) => r.slug));
  console.log(`${all.length} recorded review${all.length === 1 ? '' : 's'}:\n`);
  for (const rec of all) {
    const counts = countByAxis(openFindings(rec));
    const stale = isReviewStale(rec, heads.get(rec.slug) ?? '') ? '  ⚠ stale' : '';
    console.log(`  ${rec.slug}  ${rec.updatedAt.split('T')[0]}  ${rec.fixedPoint}...${rec.head.slice(0, 9)}${stale}`);
    console.log(`      open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);
  }
  console.log('\n  Detail: baton review show <slug>');
}

/** `baton review show <slug>` — findings grouped by axis. */
export async function reviewShowCmd(slug: string): Promise<void> {
  const root = await activeBatonRoot();
  const rec = await loadReview(root, slug);
  if (!rec) {
    console.error(`No review recorded for '${slug}'. See: baton review list`);
    process.exitCode = 1;
    return;
  }
  printRecord(rec, (await reviewHeads(root, [slug])).get(slug) ?? '');
}

/** `baton review resolve <slug> <index>` — mark a finding fixed (or dismissed). */
export async function reviewResolveCmd(slug: string, refArg: string, opts: { dismiss?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  // A bare number is a positional index; anything else is a stable finding id.
  // Prefer the id when scripting — an index is only valid until the next review.
  const ref: string | number = /^\d+$/.test(refArg.trim()) ? Number.parseInt(refArg, 10) : refArg.trim();
  if (!String(ref).length) {
    console.error(`✗ give a finding index or id — see: baton review show ${slug}`);
    process.exitCode = 1;
    return;
  }
  const status = opts.dismiss ? 'dismissed' : 'fixed';
  const rec = await resolveFinding(root, slug, ref, status);
  if (!rec) {
    console.error(`✗ no finding '${refArg}' in review '${slug}'. See: baton review show ${slug}`);
    process.exitCode = 1;
    return;
  }
  const counts = countByAxis(openFindings(rec));
  console.log(`✓ finding ${refArg} marked ${status}`);
  console.log(`  open: ${REVIEW_AXES.map((a) => `${AXIS_LABEL[a]} ${counts[a]}`).join(' · ')}`);
}

/**
 * The verdict half: `baton review approve|reject <slug>`.
 *
 * Distinct from the findings half above, which records what a review FOUND.
 * This decides what happens to the task — and it is the only layer in the
 * pipeline aimed at whether the code is right rather than whether it exists.
 */
async function verdictCmd(
  slug: string,
  verdict: 'approve' | 'reject',
  opts: { notes?: string; force?: boolean },
): Promise<void> {
  const root = await activeBatonRoot();
  const who: Who = { agent: await resolveAgentId(), sessionSlug: resolveSessionSlug() };
  // Read the findings record outside the lock: it is a different file, and
  // holding the task lock across it would serialize reviews for no gain.
  const open = verdict === 'approve' ? openFindings(await loadReview(root, slug)).length : 0;

  const out = await mutateTasks<Outcome>(root, (tasks) => {
    const now = new Date().toISOString();
    const r = verdict === 'approve'
      ? approveTask(tasks, slug, who, now, { openFindings: open, force: opts.force })
      : rejectTask(tasks, slug, who, opts.notes ?? '', now);
    return { tasks: r.ok ? r.tasks : null, result: r };
  });

  if (!out.ok) {
    console.error(`✗ ${out.refusal.message}`);
    if (out.refusal.code === 'self-review') {
      console.error('  Ask another agent to run this, or judge it yourself as a person (unset BATON_AGENT).');
    }
    process.exitCode = 1;
    return;
  }

  bus.publish({ type: 'task.reviewed', slug, verdict, actor: who.agent });
  if (verdict === 'approve') {
    console.log(`✓ ${slug} approved by ${who.agent} — done.`);
    if (open > 0) console.log(`  ⚠ approved over ${open} open finding${open === 1 ? '' : 's'} (--force).`);
    console.log(`  Merge it:  baton merge ${slug}`);
    return;
  }
  console.log(`✗ ${slug} rejected by ${who.agent} — back to active, branch intact.`);
  console.log(`  reason: ${out.task.reviewedBy?.notes ?? ''}`);
  console.log(`  Whoever picks it up sees this in: baton next`);
}

/** `baton review approve <slug>` — a second agent accepts the work. */
export async function reviewApproveCmd(slug: string, opts: { force?: boolean } = {}): Promise<void> {
  await verdictCmd(slug, 'approve', opts);
}

/** `baton review reject <slug> --notes "<what to fix>"` — send it back. */
export async function reviewRejectCmd(slug: string, opts: { notes?: string } = {}): Promise<void> {
  await verdictCmd(slug, 'reject', opts);
}
