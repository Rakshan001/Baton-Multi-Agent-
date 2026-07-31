/**
 * Who wrote this — the person/account behind a write, as distinct from `agent`
 * (which tool produced it). Pure helpers are unit-tested; only `resolveAuthor`
 * touches git.
 *
 * The two are not interchangeable, which is the whole reason this exists. On a
 * shared knowledge base two people both run "claude", so `agent: 'claude'` on a
 * memory fact cannot tell you whose claim it is — and a fact you cannot
 * attribute is a fact you cannot challenge. Author answers "whose judgement was
 * this", agent answers "what wrote it down".
 *
 * Identity is deliberately weak: `git config user.email` is a self-declared
 * string, trivially set to anything. It is a LABEL for coordination, never an
 * authentication claim, and nothing may authorize on it. Real member identity
 * arrives with the token registry (team-mode Phase 4); this field is designed so
 * that a verified member id can later supersede the label without a migration.
 */
import { hostname, userInfo } from 'node:os';
import { gitTry } from './util/exec.js';

/** Authors are labels, not prose. Long enough for `first.last@company.example`. */
export const AUTHOR_MAX = 120;

/** What an unattributable write records. Also what a pre-author record reads as. */
export const UNKNOWN_AUTHOR = 'unknown';

/**
 * Flatten a raw identity string into a single safe line.
 *
 * Memory facts serialize to YAML frontmatter, so a value carrying a newline or a
 * control character can terminate the scalar early and corrupt every field after
 * it — the fact would then fail to parse and be dropped on read, silently losing
 * knowledge. Cheap to prevent, and it also keeps the value printable in a log or
 * a dashboard cell.
 */
export function sanitizeAuthor(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AUTHOR_MAX);
}

/**
 * `user@host` from the OS, for when git has no configured email. `userInfo()`
 * throws when the uid has no passwd entry (common in containers run with an
 * arbitrary `--user`), so the env vars are a real fallback, not paranoia.
 */
export function systemAuthor(env: NodeJS.ProcessEnv = process.env): string {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    /* no passwd entry for this uid */
  }
  user = sanitizeAuthor(user || env.USER || env.LOGNAME || env.USERNAME || '');
  let host = '';
  try {
    host = sanitizeAuthor(hostname());
  } catch {
    /* unreachable in practice; a hostname-less box still gets an author */
  }
  if (user && host) return sanitizeAuthor(`${user}@${host}`);
  return user || host || UNKNOWN_AUTHOR;
}

/**
 * The author to stamp on a write made from `cwd`.
 *
 * Repo-scoped `git config user.email` first, so a hub whose projects use
 * different identities attributes each one correctly. Never throws and never
 * returns empty: an unattributable write records `unknown` rather than failing,
 * because losing the fact is strictly worse than losing the label.
 */
export async function resolveAuthor(cwd?: string): Promise<string> {
  const r = await gitTry(['config', 'user.email'], cwd);
  const email = r.ok ? sanitizeAuthor(r.stdout) : '';
  return email || systemAuthor();
}

/** Read an author off a persisted record. Absent/!string → `unknown` (no migration). */
export function readAuthor(v: unknown): string {
  return (typeof v === 'string' ? sanitizeAuthor(v) : '') || UNKNOWN_AUTHOR;
}
