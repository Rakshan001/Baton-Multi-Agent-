/**
 * `Baton-Task:` commit trailers — lineage that lives in git.
 *
 * The storage model has one load-bearing claim: losing `.baton/` costs nothing
 * permanent, because `baton history reindex` can rebuild the index by walking
 * git. That claim is only true if each commit says which task produced it, in
 * the commit itself, where a clone carries it and a deleted database cannot take
 * it with it.
 *
 * Everything here is pure. The hook that applies it is in hooks-git.ts and the
 * walk that reads it back is in commands/reindex.ts, so the format — the one
 * thing both halves must agree on forever — is a set of unit tests.
 *
 * Trailers are git's own convention (`git interpret-trailers`): `Key: value`
 * lines in the last paragraph. We write ours the same way so `git log
 * --format=%(trailers)` and every other tool already understands it.
 */

export const TASK_TRAILER = 'Baton-Task';

/** Matches our trailer anywhere in a message, capturing the slug. */
const TRAILER_RE = new RegExp(`^${TASK_TRAILER}:[ \\t]*(\\S+)[ \\t]*$`, 'im');

/**
 * A trailer paragraph is the LAST block of the message, and every line in it
 * must look like a trailer. `Signed-off-by: x` qualifies; a prose line does not,
 * which is what stops us appending into the middle of someone's paragraph.
 */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]|^[A-Za-z][A-Za-z0-9-]*:$/;

/** The slug this commit message claims, or null. */
export function taskOf(message: string): string | null {
  const m = TRAILER_RE.exec(message);
  return m ? m[1]! : null;
}

/**
 * Add the trailer, unless the message already claims a task.
 *
 * Idempotent on purpose: `git commit --amend`, a rebase and a `commit-msg` hook
 * all run over messages that may already carry one, and a commit stamped twice
 * would make the same task look like two.
 */
export function withTaskTrailer(message: string, slug: string): string {
  const existing = taskOf(message);
  if (existing) return message;                       // already claimed — never restamp

  // Strip trailing whitespace but keep the body's own shape.
  const body = message.replace(/\s+$/, '');
  if (!body) return `${TASK_TRAILER}: ${slug}\n`;     // nothing to attach to

  const lines = body.split('\n');
  // Where does the last paragraph start?
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.trim() !== '') start--;
  const last = lines.slice(start).filter((l) => l.trim() !== '');
  // Only join an existing trailer block; otherwise open a new one. Appending to
  // a prose paragraph would put `Baton-Task:` inside a sentence, and git would
  // then not read it as a trailer at all.
  const joinable = start > 0 && last.length > 0 && last.every((l) => TRAILER_LINE.test(l));
  return joinable ? `${body}\n${TASK_TRAILER}: ${slug}\n` : `${body}\n\n${TASK_TRAILER}: ${slug}\n`;
}

/**
 * Which of these commits may be trusted to name their own task?
 *
 * §7.5, trailer poisoning: anyone who can push can write `Baton-Task: anything`
 * into a commit message. A reindex that believed them would let a stranger's
 * commit attribute itself to any task in the project — and attribution is what
 * `who_touched` answers when an agent asks who to ask about a file.
 *
 * So a trailer is evidence, never authority: it is honored only when the slug
 * names a task this repository actually created. Unknown slugs are dropped
 * rather than repaired, and reported by the caller — a forged trailer is worth
 * seeing, not worth silently discarding.
 */
export function trustedLineage(
  commits: readonly { sha: string; message: string }[],
  knownSlugs: ReadonlySet<string>,
): { trusted: { sha: string; slug: string }[]; rejected: { sha: string; slug: string }[] } {
  const trusted: { sha: string; slug: string }[] = [];
  const rejected: { sha: string; slug: string }[] = [];
  for (const c of commits) {
    const slug = taskOf(c.message);
    if (!slug) continue;                              // no claim is not a lie
    (knownSlugs.has(slug) ? trusted : rejected).push({ sha: c.sha, slug });
  }
  return { trusted, rejected };
}
