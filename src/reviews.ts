/**
 * Durable code-review findings (`.baton/reviews/<slug>.json`).
 *
 * A review that only prints to a chat window dies with the session: the next
 * agent has no idea it ran, the dashboard can't show it, and `baton resume`
 * can't tell whoever picks the work up that six findings are still open. That
 * is the same evaporation problem handoff briefs and the progress ledger exist
 * to solve — so review findings get the same treatment.
 *
 * The `code-review` skill produces findings on two-or-three axes that are
 * deliberately NEVER merged (Standards / Spec / Security), so the record keeps
 * them tagged by axis and never ranks across them. `openFindings` is what a
 * brief or the dashboard asks for.
 *
 * Deliberately NOT an MCP tool: reviews are occasional, and a 14th tool would
 * breach TOOL_HELP_BUDGET — a context tax every agent session pays forever.
 * Agents persist via `baton review save` (stdin JSON) instead.
 *
 * Stored as small, capped JSON, written atomically (tmp + rename) so two agents
 * reviewing at once can't tear the file.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';
import { detectSecret } from './memory.js';

/** The axes the code-review skill runs. Kept separate at every layer — a
 *  combined score is exactly what the skill exists to prevent. */
export const REVIEW_AXES = ['standards', 'spec', 'security'] as const;
export type ReviewAxis = (typeof REVIEW_AXES)[number];

export type FindingStatus = 'open' | 'fixed' | 'dismissed';

/** Where a finding should go next. Mirrors the skill's routing table: a Spec
 *  "implemented but wrong" is a BUG and belongs in systematic-debugging, not in
 *  an inline patch off a review comment. */
export const FINDING_ROUTES = ['fix-directly', 'systematic-debugging', 'bug-fix', 'implement'] as const;
export type FindingRoute = (typeof FINDING_ROUTES)[number];

export interface ReviewFinding {
  /** Stable identity across re-reviews — derived from axis+file+title, NOT from
   *  position. A positional index is not a handle: a re-review reorders the
   *  array, and an index resolved afterwards lands on a different finding. */
  id: string;
  axis: ReviewAxis;
  /** One line: what is wrong. */
  title: string;
  /** Repo-relative path, when the finding is anchored to one. */
  file?: string;
  line?: number;
  /** The citation that makes this a finding and not an opinion: a repo standard
   *  + rule, a named baseline smell, or a quoted spec line. */
  source: string;
  /** The quoted hunk / explanation. */
  detail?: string;
  /** True only for a documented-standard breach. Baseline smells are always
   *  judgement calls — the skill's rule, enforced here so it survives storage. */
  hard: boolean;
  status: FindingStatus;
  route?: FindingRoute;
}

/** An axis that did not run, and why — an unreported skip reads as a clean pass. */
export interface AxisSkip {
  axis: ReviewAxis;
  why: string;
}

export interface ReviewRecord {
  slug: string;
  /** What HEAD was compared against (commit, branch, tag, merge-base). */
  fixedPoint: string;
  /** The HEAD sha reviewed — findings are about THIS diff, not a later one. */
  head: string;
  /** Axes that actually produced findings. */
  axes: ReviewAxis[];
  skipped: AxisSkip[];
  findings: ReviewFinding[];
  /** True when the diff was too large to review whole — a silent partial
   *  review reads as a clean one, so this is recorded and surfaced. */
  partial?: string;
  agent?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInput {
  fixedPoint: string;
  head: string;
  findings: Partial<ReviewFinding>[];
  skipped?: AxisSkip[];
  partial?: string;
  agent?: string;
}

/* ---- caps: a review record is a summary, never a transcript ---- */
const FINDING_CAP = 60;
const TITLE_MAX = 200;
const SOURCE_MAX = 300;
const DETAIL_MAX = 800;
const PARTIAL_MAX = 300;

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}

/** Filename-safe slug — never lets a hostile slug escape .baton/reviews. */
export function safeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'review';
}

function reviewsDir(root: string): string {
  return join(batonDir(root), 'reviews');
}
function reviewPath(root: string, slug: string): string {
  return join(reviewsDir(root), `${safeSlug(slug)}.json`);
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/**
 * Findings quote raw diff hunks, so a hunk touching a config file can carry a
 * live credential straight to disk. `memory.ts` refuses such text outright, but
 * refusing here would be wrong: "you hardcoded a key at line 42" is precisely
 * what the Security axis exists to report, and dropping it would blind the one
 * check that catches it. So the field is redacted and the finding is kept —
 * location and citation survive, the secret does not.
 */
function redact(text: string): string {
  const what = detectSecret(text);
  return what ? `[redacted: ${what} — see the file itself]` : text;
}

function isAxis(v: unknown): v is ReviewAxis {
  return typeof v === 'string' && (REVIEW_AXES as readonly string[]).includes(v);
}
function isRoute(v: unknown): v is FindingRoute {
  return typeof v === 'string' && (FINDING_ROUTES as readonly string[]).includes(v);
}
function isStatus(v: unknown): v is FindingStatus {
  return v === 'open' || v === 'fixed' || v === 'dismissed';
}

/**
 * Stable identity for a finding: what makes it *this* finding rather than
 * another one — the axis it came from, the file it anchors to, and its title.
 * Deliberately excludes `detail`, `line`, `status` and `route`: a re-review may
 * reword the explanation or the line may drift by an edit, and neither makes it
 * a different finding. Without this, resolution state cannot survive a rewrite.
 */
export function findingId(f: Pick<ReviewFinding, 'axis' | 'title'> & { file?: string }): string {
  return createHash('sha1')
    .update(`${f.axis}\0${f.file ?? ''}\0${f.title}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * Normalize one finding. A finding with no axis, no title, or no source is
 * dropped rather than stored: an uncited finding is an opinion, and the whole
 * value of the record is that every entry carries its citation.
 */
export function cleanFinding(raw: Partial<ReviewFinding>): ReviewFinding | null {
  const axis = raw.axis;
  if (!isAxis(axis)) return null;
  // Redact before the emptiness check, so a title that is nothing but a secret
  // still yields a usable (redacted) title rather than dropping the finding.
  const title = redact(str(raw.title, TITLE_MAX));
  const source = redact(str(raw.source, SOURCE_MAX));
  if (!title || !source) return null;

  const rawFile = str(raw.file, 300);
  const file = rawFile && !rawFile.startsWith('/') && !rawFile.includes('..') ? rawFile : '';
  const line = typeof raw.line === 'number' && Number.isFinite(raw.line) && raw.line > 0
    ? Math.floor(raw.line)
    : undefined;

  return {
    id: findingId({ axis, title, file: file || undefined }),
    axis,
    title,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    source,
    ...(str(raw.detail, DETAIL_MAX) ? { detail: redact(str(raw.detail, DETAIL_MAX)) } : {}),
    // Only a documented-standard breach can be hard. Anything on the Spec or
    // Security axis, or any baseline smell, stays a judgement call.
    hard: raw.hard === true && axis === 'standards',
    status: isStatus(raw.status) ? raw.status : 'open',
    ...(isRoute(raw.route) ? { route: raw.route } : {}),
  };
}

function cleanSkips(raw: AxisSkip[] | undefined): AxisSkip[] {
  return (raw ?? [])
    .filter((s) => s && isAxis(s.axis))
    .map((s) => ({ axis: s.axis, why: str(s.why, 200) || 'not run' }))
    .slice(0, REVIEW_AXES.length);
}

/** The persisted review for a task/slug, or null when none was ever written. */
export async function loadReview(root: string, slug: string): Promise<ReviewRecord | null> {
  try {
    const raw = await readFile(reviewPath(root, slug), 'utf-8');
    const r = JSON.parse(raw) as Partial<ReviewRecord>;
    const findings = (Array.isArray(r.findings) ? r.findings : [])
      .map(cleanFinding)
      .filter((f): f is ReviewFinding => f !== null)
      .slice(0, FINDING_CAP);
    return {
      slug: str(r.slug, 80) || safeSlug(slug),
      fixedPoint: str(r.fixedPoint, 200),
      head: str(r.head, 80),
      axes: [...new Set(findings.map((f) => f.axis))],
      skipped: cleanSkips(r.skipped),
      findings,
      ...(str(r.partial, PARTIAL_MAX) ? { partial: str(r.partial, PARTIAL_MAX) } : {}),
      ...(str(r.agent, 60) ? { agent: str(r.agent, 60) } : {}),
      createdAt: str(r.createdAt, 40) || new Date(0).toISOString(),
      updatedAt: str(r.updatedAt, 40) || new Date(0).toISOString(),
    };
  } catch {
    return null; // absent or corrupt — callers fall back to "no review recorded"
  }
}

/**
 * Write a review record. Replaces any prior record for the slug (a re-review
 * supersedes the old one — stale findings against an older HEAD are worse than
 * none), but preserves `createdAt` so the first-reviewed time survives.
 */
export async function saveReview(root: string, slug: string, input: ReviewInput): Promise<ReviewRecord> {
  const fixedPoint = str(input.fixedPoint, 200);
  const head = str(input.head, 80);
  if (!fixedPoint) throw new ReviewValidationError('fixedPoint is required — a review without a pinned comparison point is meaningless');
  if (!head) throw new ReviewValidationError('head is required — findings must be tied to the sha they were found against');

  const fresh = (input.findings ?? [])
    .map(cleanFinding)
    .filter((f): f is ReviewFinding => f !== null)
    .slice(0, FINDING_CAP);

  const prev = await loadReview(root, slug);

  /*
   * Carry triage decisions across a re-review — but only the ones that are
   * still true.
   *
   * `dismissed` is a human judgement ("this is not a problem"). It must
   * survive, or every re-review makes someone re-triage the same noise.
   *
   * `fixed` must NOT survive. If the reviewer reports the finding again, it
   * demonstrably is not fixed; the fresh report is ground truth, and carrying
   * `fixed` would hide a live problem behind a stale claim. It reverts to open.
   */
  const dismissed = new Set(
    (prev?.findings ?? []).filter((f) => f.status === 'dismissed').map((f) => f.id),
  );
  const findings = fresh.map((f) => (dismissed.has(f.id) ? { ...f, status: 'dismissed' as const } : f));
  const now = new Date().toISOString();
  const record: ReviewRecord = {
    slug: safeSlug(slug),
    fixedPoint,
    head,
    axes: [...new Set(findings.map((f) => f.axis))],
    skipped: cleanSkips(input.skipped),
    findings,
    ...(str(input.partial, PARTIAL_MAX) ? { partial: str(input.partial, PARTIAL_MAX) } : {}),
    ...(str(input.agent, 60) ? { agent: str(input.agent, 60) } : {}),
    createdAt: prev?.createdAt && prev.createdAt !== new Date(0).toISOString() ? prev.createdAt : now,
    updatedAt: now,
  };

  const path = reviewPath(root, slug);
  await mkdir(reviewsDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
  await rename(tmp, path);
  return record;
}

/** Every recorded review, newest first. */
export async function listReviews(root: string): Promise<ReviewRecord[]> {
  let files: string[] = [];
  try {
    files = (await readdir(reviewsDir(root))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ReviewRecord[] = [];
  for (const f of files.sort()) {
    const rec = await loadReview(root, f.replace(/\.json$/, ''));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Findings still needing attention — what a brief or the dashboard asks for. */
export function openFindings(record: ReviewRecord | null): ReviewFinding[] {
  return (record?.findings ?? []).filter((f) => f.status === 'open');
}

/** Per-axis open counts. Never summed into one number: the axes are separate by
 *  design, and a single total is the cross-axis ranking the skill forbids. */
export function countByAxis(findings: ReviewFinding[]): Record<ReviewAxis, number> {
  const out = { standards: 0, spec: 0, security: 0 } as Record<ReviewAxis, number>;
  for (const f of findings) out[f.axis] += 1;
  return out;
}

/**
 * Mark one finding fixed or dismissed.
 *
 * `ref` is a stable finding id (preferred — survives a re-review) or a
 * positional index (kept for CLI ergonomics: typing `2` off a printed list is
 * what people actually do). Returns null when the slug or ref doesn't resolve.
 */
export async function resolveFinding(
  root: string,
  slug: string,
  ref: string | number,
  status: Exclude<FindingStatus, 'open'>,
): Promise<ReviewRecord | null> {
  const rec = await loadReview(root, slug);
  if (!rec) return null;

  const index = typeof ref === 'number'
    ? ref
    : rec.findings.findIndex((f) => f.id === ref);
  // Number.isInteger, not just a range check: 1.5 and NaN both PASS `index < 0
  // || index >= length` (NaN compares false to everything), and the assignment
  // below then creates a named property (`findings['1.5']`) instead of touching
  // an element — so the caller got a successful-looking record back, the file
  // was rewritten, and nothing was actually resolved.
  if (!Number.isInteger(index) || index < 0 || index >= rec.findings.length) return null;
  rec.findings[index] = { ...rec.findings[index], status };
  rec.updatedAt = new Date().toISOString();

  const path = reviewPath(root, slug);
  await mkdir(reviewsDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf-8');
  await rename(tmp, path);
  return rec;
}

/**
 * Is this review still about the current HEAD? Findings against an older sha
 * may already be fixed — surfaced as a warning rather than silently trusted,
 * the same discipline memory staleness uses.
 */
export function isReviewStale(record: ReviewRecord, currentHead: string): boolean {
  return !!record.head && !!currentHead && record.head !== currentHead;
}
