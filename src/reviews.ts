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
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';

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
 * Normalize one finding. A finding with no axis, no title, or no source is
 * dropped rather than stored: an uncited finding is an opinion, and the whole
 * value of the record is that every entry carries its citation.
 */
export function cleanFinding(raw: Partial<ReviewFinding>): ReviewFinding | null {
  const axis = raw.axis;
  if (!isAxis(axis)) return null;
  const title = str(raw.title, TITLE_MAX);
  const source = str(raw.source, SOURCE_MAX);
  if (!title || !source) return null;

  const file = str(raw.file, 300);
  const line = typeof raw.line === 'number' && Number.isFinite(raw.line) && raw.line > 0
    ? Math.floor(raw.line)
    : undefined;

  return {
    axis,
    title,
    ...(file && !file.startsWith('/') && !file.includes('..') ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    source,
    ...(str(raw.detail, DETAIL_MAX) ? { detail: str(raw.detail, DETAIL_MAX) } : {}),
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

  const findings = (input.findings ?? [])
    .map(cleanFinding)
    .filter((f): f is ReviewFinding => f !== null)
    .slice(0, FINDING_CAP);

  const prev = await loadReview(root, slug);
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
 * Mark one finding fixed or dismissed, by its index in the stored order.
 * Returns null when the slug or index doesn't exist.
 */
export async function resolveFinding(
  root: string,
  slug: string,
  index: number,
  status: Exclude<FindingStatus, 'open'>,
): Promise<ReviewRecord | null> {
  const rec = await loadReview(root, slug);
  if (!rec || index < 0 || index >= rec.findings.length) return null;
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
