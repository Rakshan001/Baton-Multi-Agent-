// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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

/** Where an agent id came from, strongest first. */
export type IdentitySource = 'env' | 'ancestry' | 'client' | 'ancestry-inferred' | 'none';
export interface Identity { agent: string; source: IdentitySource }
/** Nearest agent in this process's ancestry (agents.ts). Declared here so identity
 *  stays cheap to load: agents.js is imported only when a walk is needed. */
export interface AncestryHit { agent: string; strict: boolean; pid: number }

/** Exact MCP `clientInfo.name` → agent id. Seeded ONLY with names actually logged
 *  (hook_sessions.client_name). Empty at ship is correct, not a gap. */
export const CLIENT_NAMES: Readonly<Record<string, string>> = {};

/**
 * A session running at the repo root (no worktree, no task) is identified by
 * the agent's own session id — stable for the session, meaningless after it.
 */
export function sessionSlug(sessionId: string): string {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8) || 'unknown';
  return `sess-${clean}`;
}

// Retries inline: a CLI command resolves once, so a single timed-out `ps` would
// otherwise make it `unknown` for the whole call.
const defaultAncestry = async (root?: string): Promise<AncestryHit | null> =>
  (await import('./agents.js')).detectAncestry(root, undefined, { retry: true });

/**
 * Which tool is running right now. ONE resolver for CLI and MCP, so the
 * self-review ban compares ids produced the same way.
 *
 * Order: declared `BATON_AGENT` → a strict ancestry match → the MCP client's
 * name → a lenient ancestry guess → none. Every source goes through
 * sanitizeAuthor. Never throws: an unidentified caller still gets to work, it
 * just lands in the open pool (and may not review — lifecycle.mayReview).
 */
export async function resolveIdentity(
  env: NodeJS.ProcessEnv = process.env,
  root?: string,
  clientName?: string,
  ancestry: (root?: string) => Promise<AncestryHit | null> = defaultAncestry,
  clientNames: Readonly<Record<string, string>> = CLIENT_NAMES,
): Promise<Identity> {
  const declared = sanitizeAuthor(env.BATON_AGENT ?? '');
  if (declared) return { agent: declared, source: 'env' };
  const hit = await ancestry(root).catch(() => null);
  const guessed = hit ? sanitizeAuthor(hit.agent) : '';
  if (hit?.strict && guessed) return { agent: guessed, source: 'ancestry' };
  const client = sanitizeAuthor(clientName ? (clientNames[sanitizeAuthor(clientName)] ?? '') : '');
  if (client) return { agent: client, source: 'client' };
  if (guessed) return { agent: guessed, source: 'ancestry-inferred' };
  return { agent: UNKNOWN_AUTHOR, source: 'none' };
}

/**
 * The agent id only — the contract every CLI caller already had. Pass `root`
 * when you hold one: without it a project-defined agent (`.baton/agents.json`)
 * is never recognised.
 */
export async function resolveAgentId(env: NodeJS.ProcessEnv = process.env, root?: string): Promise<string> {
  return (await resolveIdentity(env, root)).agent;
}

/** This process's session identity — the SAME `sess-p<pid>` slug its MCP
 *  presence row uses, so a claim's heartbeat is found. Stable for the process.
 *  Known edge (not fixed): a short-lived CLI's pid, later reused by an MCP
 *  server, makes that CLI's old `sess-p<pid>` claim look alive. Rare. */
export function resolveSessionSlug(env: NodeJS.ProcessEnv = process.env): string {
  return sanitizeAuthor(env.BATON_SLUG ?? '') || sessionSlug(`p${process.pid}`);
}

/** A pre-phase-7 claim slug `pid-<n>` → the presence slug it always meant. */
export function presenceSlugOf(claimSlug: string): string {
  const m = /^pid-(\d+)$/.exec(claimSlug);
  return m ? sessionSlug(`p${m[1]}`) : claimSlug;
}

/** Read an author off a persisted record. Absent/!string → `unknown` (no migration). */
export function readAuthor(v: unknown): string {
  return (typeof v === 'string' ? sanitizeAuthor(v) : '') || UNKNOWN_AUTHOR;
}
