// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which plans a human has actually read.
 *
 * `baton dispatch` starts real agents against real API keys from a markdown
 * file, and that file can arrive by `git pull` from a branch nobody reviewed.
 * So approval is recorded against the plan's exact bytes: approving a plan and
 * then dispatching a changed one is the case this exists to stop (P3-E1).
 *
 * Every failure direction is closed. An unreadable trust file approves nothing
 * — the cost is a re-approval, and the other direction's cost is a machine that
 * dispatches whatever it is handed.
 *
 * This is also the plan-trust gate `docs/superpowers/specs/
 * 2026-08-05-task-pipeline-design.md` §7.2 specified and never implemented.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';
import { withLock } from './util/lock.js';

export const TRUST_FILE = 'trusted-plans.json';

export interface TrustRecord {
  planId: string;
  sha256: string;
  approvedBy: string;
  /** ISO timestamp of the approval. */
  at: string;
}

export type TrustVerdict =
  | { ok: true; record: TrustRecord }
  | { ok: false; code: 'unapproved' | 'changed'; reason: string };

/**
 * The digest an approval is recorded against.
 *
 * CRLF is normalized and trailing newlines are dropped, because `core.autocrlf`
 * rewrites line endings on checkout and an editor may or may not leave a final
 * newline. Neither changes a single instruction in the plan, and demanding a
 * fresh approval for them trains people to approve without reading — which
 * costs far more than it protects. Nothing else is normalized: leading and
 * interior whitespace stay significant.
 */
export function planDigest(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function trustVerdict(record: TrustRecord | null, digest: string): TrustVerdict {
  if (!record) {
    return {
      ok: false, code: 'unapproved',
      reason: 'this plan has not been approved. Read it, then run `baton plan approve <plan>`.',
    };
  }
  if (record.sha256 !== digest) {
    return {
      ok: false, code: 'changed',
      reason: `the plan changed since ${record.approvedBy} approved it on ${record.at}`
        + ` (approved ${record.sha256.slice(0, 12)}…, on disk ${digest.slice(0, 12)}…).`
        + ' Read the change, then run `baton plan approve <plan>` again.',
    };
  }
  return { ok: true, record };
}

function isRecord(v: unknown, planId: string): v is TrustRecord {
  const r = v as Partial<TrustRecord> | null;
  return !!r && typeof r === 'object'
    && r.planId === planId
    && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)
    && typeof r.approvedBy === 'string'
    && typeof r.at === 'string';
}

function trustPath(root: string): string {
  return join(batonDir(root), TRUST_FILE);
}

/**
 * Every approval on this machine. Anything unreadable or misshapen is absent.
 *
 * The map has NO PROTOTYPE, because its keys are plan names — which come off a
 * directory listing and out of an HTTP path, and `constructor.md` is a legal
 * plan name under the id grammar. On a plain `{}`, `trust['constructor']` hands
 * back the Object constructor instead of undefined, and `trustVerdict` reads
 * that record's missing `sha256` as drift: "the plan changed since undefined
 * approved it on undefined", on a machine where nobody approved anything. It
 * failed closed, which is the only reason this was a lie rather than a hole.
 */
export async function loadTrust(root: string): Promise<Record<string, TrustRecord>> {
  const empty = (): Record<string, TrustRecord> => Object.create(null) as Record<string, TrustRecord>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(trustPath(root), 'utf8'));
  } catch {
    return empty();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
  const out = empty();
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    // A null-prototype target also makes `out['__proto__'] = rec` an ordinary
    // key rather than a prototype swap. `isRecord` would still have to accept
    // it, but the assignment is no longer the interesting part.
    if (isRecord(rec, id)) out[id] = rec;
  }
  return out;
}

/**
 * Write one approval. tmp + rename, so a crash never leaves a half-read file.
 *
 * Serialized on the file it writes, because this is a read-modify-write with an
 * await in the middle and the daemon serves concurrent requests. Two approvals
 * made at the same moment used to collide on the same tmp path: one of them
 * renamed the OTHER one's file into place and the loser crashed with ENOENT,
 * having told a human their approval was recorded. Same lock every other
 * registry file in this repo uses, keyed by path.
 *
 * In-process only, which is where the daemon's race lives. A CLI writing this
 * file while a daemon runs is still last-write-wins between processes; the
 * random tmp suffix keeps that case to a lost approval rather than a corrupt
 * file or a thrown rename.
 */
export async function recordApproval(root: string, record: TrustRecord): Promise<void> {
  const path = trustPath(root);
  return withLock(path, async () => {
    const all = await loadTrust(root);
    all[record.planId] = record;
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ ...all }, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  });
}

/** How git names one person: a display name and an address. Either may be absent. */
export interface Committer {
  name: string | null;
  email: string | null;
}

/**
 * P3-E2 — the plan may have arrived from somebody else's branch.
 *
 * Advisory, never a refusal: plenty of legitimate plans are written by a
 * teammate. What makes it useful is that it stays quiet on your own work, so
 * both identities git records are checked — `resolveAuthor` returns
 * `git config user.email`, but its fallback is a `user@host` handle that
 * matches the commit's *name* instead. Comparing only one axis warned on every
 * plan the user had written themselves, and a warning that fires on your own
 * work is one you learn to scroll past.
 *
 * Silent when git has no answer, because a freshly written and uncommitted plan
 * has no committer at all.
 */
export function authorWarning(committer: Committer, author: string): string | null {
  const me = author.trim().toLowerCase();
  const name = committer.name?.trim() ?? '';
  const email = committer.email?.trim() ?? '';
  if (!name && !email) return null;
  if (name.toLowerCase() === me || email.toLowerCase() === me) return null;
  return `this plan's last commit is by '${name || email}', not you ('${author}') — read it before approving.`;
}
