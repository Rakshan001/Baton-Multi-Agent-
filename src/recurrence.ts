/**
 * Bug-recurrence lookup (S6). "This symptom was fixed before — has something
 * since re-broken it?" Composes what Baton already records: memory facts left by
 * the bug-fix skill (root cause + the files it touched, evidence-anchored) and
 * the commit/file history (src/history.ts). No new storage.
 *
 * The recurrence signal is twofold:
 *  1. A matching bug-fix fact that is now STALE — the file it anchored to changed
 *     since, so the fix may have been undone (Baton's staleness model, for free).
 *  2. The specific later commits that touched those same files — the suspects.
 */
import { listMemories, scoreMemory, type MemoryStatus } from './memory.js';
import { queryFile, type FileHit } from './history.js';

export interface Suspect {
  sha: string;
  slug: string;
  task: string;
  message: string;
  at: string;
  /** Which of the fix's files this commit touched. */
  files: string[];
}

/**
 * Commits that touched the fix's files AFTER it landed — deduped by commit,
 * newest first, excluding the fixing task's own commits. Pure + unit-tested.
 */
export function recurrenceSuspects(
  fixAt: string,
  fixFiles: string[],
  hits: FileHit[],
  opts: { excludeSlug?: string } = {},
): Suspect[] {
  const inFix = new Set(fixFiles);
  const fixTime = Date.parse(fixAt);
  const bySha = new Map<string, Suspect>();
  for (const h of hits) {
    if (!inFix.has(h.path)) continue;
    if (!(Date.parse(h.at) > fixTime)) continue; // strictly after the fix
    if (opts.excludeSlug && h.slug === opts.excludeSlug) continue;
    const existing = bySha.get(h.sha);
    if (existing) {
      if (!existing.files.includes(h.path)) existing.files.push(h.path);
    } else {
      bySha.set(h.sha, { sha: h.sha, slug: h.slug, task: h.task, message: h.message, at: h.at, files: [h.path] });
    }
  }
  return [...bySha.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export interface PriorFix {
  fact: MemoryStatus;
  files: string[];
  suspects: Suspect[];
}

/** A fact reads like a bug fix if it's a gotcha or its text names a fix/root cause. */
function looksLikeBugFix(f: MemoryStatus): boolean {
  if (f.anchors.files.length === 0) return false; // no files → nothing to trace
  if (f.type === 'gotcha') return true;
  return /\b(bug|fix(ed|es)?|root cause|regression|broke|crash)\b/i.test(f.fact);
}

/**
 * Bug/fix vocabulary appears in EVERY fix fact, so matching a symptom on those
 * words is noise ("some symptom never fixed" would match everything). Strip them
 * and score only the substantive terms.
 */
const BUG_STOPWORDS = new Set([
  'fix', 'fixed', 'fixes', 'fixing', 'bug', 'bugs', 'issue', 'issues', 'error', 'errors',
  'broke', 'broken', 'break', 'breaks', 'regression', 'regressions', 'problem', 'problems',
  'symptom', 'symptoms', 'crash', 'crashes', 'again', 'never', 'some', 'the', 'when', 'happens',
]);
export function substantiveTerms(symptom: string): string[] {
  return [...new Set(symptom.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !BUG_STOPWORDS.has(w)))];
}

/**
 * Find prior fixes for a symptom and the commits that may have reintroduced them.
 * Ranks bug-fix facts by relevance to the symptom (staleness NOT withheld — a
 * stale fix is the strongest recurrence signal), then traces each fix's files
 * through history for later suspect commits.
 */
export async function findRecurrence(root: string, symptom: string, limit = 5): Promise<PriorFix[]> {
  const terms = substantiveTerms(symptom);
  if (!terms.length) return []; // only generic bug words → nothing specific to match
  const cleaned = terms.join(' ');
  const facts = await listMemories(root);
  const ranked = facts
    .filter(looksLikeBugFix)
    .map((f) => ({ f, score: scoreMemory(f, cleaned) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ f }) => {
    const files = f.anchors.files.map((a) => a.path);
    const hits = files.flatMap((p) => queryFile(root, p));
    const suspects = recurrenceSuspects(f.createdAt, files, hits, { excludeSlug: f.task ?? undefined });
    return { fact: f, files, suspects };
  });
}
