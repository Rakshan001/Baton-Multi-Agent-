// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P3 step 3 — the approval gate.
 *
 * A plan is a file that can arrive by `git pull` from a branch nobody read, and
 * dispatching it starts real agents with real money attached. So approval is
 * recorded against the plan's exact bytes: approving once and dispatching a
 * different file afterwards is the whole thing this prevents (P3-E1).
 *
 * Fails closed everywhere. An unreadable trust file is "not approved", never
 * "approved" — the direction that costs a re-approval instead of a launch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorWarning, loadTrust, planDigest, recordApproval, trustVerdict, TRUST_FILE,
} from '../src/plan-trust.js';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-trust-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});

const PLAN = '---\nplan: auth\n---\n\n## Phase 1\n\n### a\nDo it.\n';

describe('planDigest', () => {
  it('is stable for the same bytes', () => {
    expect(planDigest(PLAN)).toBe(planDigest(PLAN));
    expect(planDigest(PLAN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a single character does', () => {
    expect(planDigest(PLAN)).not.toBe(planDigest(PLAN.replace('Do it.', 'Do it!')));
  });

  it('survives a CRLF checkout — the same plan on Windows is the same plan', () => {
    // git core.autocrlf rewrites line endings on checkout. Digesting them raw
    // would demand a fresh approval every time the repo changed platform, which
    // trains people to approve without reading.
    expect(planDigest(PLAN.replace(/\n/g, '\r\n'))).toBe(planDigest(PLAN));
  });

  it('ignores only trailing newlines, never leading or interior whitespace', () => {
    expect(planDigest(PLAN + '\n\n')).toBe(planDigest(PLAN));
    expect(planDigest(' ' + PLAN)).not.toBe(planDigest(PLAN));
    expect(planDigest(PLAN.replace('### a', '###  a'))).not.toBe(planDigest(PLAN));
  });
});

describe('trustVerdict', () => {
  const rec = { planId: 'auth', sha256: planDigest(PLAN), approvedBy: 'rakshan', at: '2026-08-22T10:00:00.000Z' };

  it('accepts the exact plan that was approved', () => {
    expect(trustVerdict(rec, planDigest(PLAN))).toEqual({ ok: true, record: rec });
  });

  it('refuses a plan nobody approved', () => {
    expect(trustVerdict(null, planDigest(PLAN))).toMatchObject({ ok: false, code: 'unapproved' });
  });

  it('refuses a plan that changed after approval, and names the drift (P3-E1)', () => {
    const v = trustVerdict(rec, planDigest(PLAN + '\n### b\nAnd this.\n'));
    expect(v).toMatchObject({ ok: false, code: 'changed' });
    expect(v.ok === false && v.reason).toContain(rec.sha256.slice(0, 12));
    expect(v.ok === false && v.reason).toMatch(/approve/);
  });

  it('names who approved it and when, so a stale approval is visible', () => {
    const v = trustVerdict(rec, planDigest(PLAN + 'x'));
    expect(v.ok === false && v.reason).toContain('rakshan');
  });
});

describe('the trust file', () => {
  it('records an approval and reads it back', async () => {
    await recordApproval(root, { planId: 'auth', sha256: planDigest(PLAN), approvedBy: 'rakshan', at: '2026-08-22T10:00:00.000Z' });
    expect((await loadTrust(root))['auth']).toMatchObject({ approvedBy: 'rakshan' });
  });

  it('keeps other plans when a second one is approved', async () => {
    await recordApproval(root, { planId: 'a', sha256: 'a1'.repeat(32), approvedBy: 'me', at: 'now' });
    await recordApproval(root, { planId: 'b', sha256: 'b2'.repeat(32), approvedBy: 'me', at: 'now' });
    expect(Object.keys(await loadTrust(root)).sort()).toEqual(['a', 'b']);
  });

  it('re-approving one plan replaces its record rather than appending', async () => {
    await recordApproval(root, { planId: 'a', sha256: 'a1'.repeat(32), approvedBy: 'me', at: 't1' });
    await recordApproval(root, { planId: 'a', sha256: 'c3'.repeat(32), approvedBy: 'me', at: 't2' });
    expect((await loadTrust(root))['a']!.sha256).toBe('c3'.repeat(32));
  });

  it('a missing trust file is "nothing is approved", not an error', async () => {
    expect(await loadTrust(root)).toEqual({});
  });

  it('a corrupt trust file approves nothing', async () => {
    // Fail closed. The other direction turns a truncated write into a machine
    // that dispatches every plan it is handed.
    await writeFile(join(root, '.baton', TRUST_FILE), '{ this is not json');
    expect(await loadTrust(root)).toEqual({});
  });

  it('ignores a record that is not shaped like an approval', async () => {
    await writeFile(join(root, '.baton', TRUST_FILE), JSON.stringify({ a: 'yes', b: { sha256: 5 }, c: { planId: 'c', sha256: 'a1'.repeat(32), approvedBy: 'me', at: 't' } }));
    expect(Object.keys(await loadTrust(root))).toEqual(['c']);
  });

  it('writes the file only after it is complete', async () => {
    // tmp + rename: a crash mid-write must not leave a half-parsed trust file,
    // which the rule above would then read as "nothing is approved" and silently
    // un-approve every plan on the machine.
    await recordApproval(root, { planId: 'a', sha256: 'a1'.repeat(32), approvedBy: 'me', at: 'now' });
    const raw = await readFile(join(root, '.baton', TRUST_FILE), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('authorWarning — P3-E2', () => {
  it('warns when the plan\'s last committer is nobody this machine knows as itself', () => {
    expect(authorWarning({ name: 'someone-else', email: 'them@corp.com' }, 'rakshan@laptop')).toMatch(/someone-else/);
  });

  it('says nothing when the committer email is this author', () => {
    // `resolveAuthor` returns `git config user.email`, so the email is the axis
    // that actually matches. Comparing it against the commit's *name* warned on
    // every plan the user wrote themselves -- and a warning that fires on your
    // own work is a warning you learn to scroll past.
    expect(authorWarning({ name: 'Rakshan Shetty', email: 'rakshan@laptop' }, 'rakshan@laptop')).toBeNull();
  });

  it('says nothing when the committer name is this author', () => {
    // The fallback identity is `user@host`, not an email, so a name can match too.
    expect(authorWarning({ name: 'rakshan', email: 'other@corp.com' }, 'rakshan')).toBeNull();
  });

  it('says nothing when git could not answer — a guess is worse than silence', () => {
    // An uncommitted plan file has no committer. Warning "written by unknown"
    // on every freshly-authored plan is how a real warning gets ignored.
    expect(authorWarning({ name: null, email: null }, 'rakshan')).toBeNull();
  });

  it('compares case-insensitively — git names are not identifiers', () => {
    expect(authorWarning({ name: 'Rakshan', email: null }, 'rakshan')).toBeNull();
  });

  it('names the human, not the address, when it does warn', () => {
    const w = authorWarning({ name: 'Ada Lovelace', email: 'ada@corp.com' }, 'me@laptop');
    expect(w).toContain('Ada Lovelace');
  });
});
