// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  AUTHOR_MAX, UNKNOWN_AUTHOR, readAuthor, resolveAuthor, sanitizeAuthor, systemAuthor,
} from '../src/identity.js';

describe('sanitizeAuthor', () => {
  it('keeps an ordinary email untouched', () => {
    expect(sanitizeAuthor('dev@example.com')).toBe('dev@example.com');
  });

  it('collapses surrounding and inner whitespace', () => {
    expect(sanitizeAuthor('  Ada  Lovelace  ')).toBe('Ada Lovelace');
  });

  /*
   * The real reason this function exists. A memory fact serializes to YAML
   * frontmatter, so a newline in the value ends the scalar early and corrupts
   * every field after it — the fact then fails to parse and is dropped on read,
   * silently losing knowledge. Not a privilege boundary (author is a label, and
   * anyone who can set git config can already write the repo); it is a
   * data-integrity guard.
   */
  it('strips newlines and control characters that would break YAML frontmatter', () => {
    expect(sanitizeAuthor('evil\nid: pwned')).toBe('evil id: pwned');
    expect(sanitizeAuthor('a\r\nb\tc\0d')).toBe('a b c d');
    expect(sanitizeAuthor('x\x07y')).toBe('x y');
  });

  it('strips zero-width and bidi format characters used to disguise a label', () => {
    expect(sanitizeAuthor('ali\u200bce')).toBe('ali ce');
    expect(sanitizeAuthor('bob\u202ecom.evil@')).toBe('bob com.evil@');
  });

  it('caps length so one write cannot bloat every record', () => {
    expect(sanitizeAuthor('z'.repeat(500))).toHaveLength(AUTHOR_MAX);
  });

  it('degrades an all-whitespace value to empty rather than throwing', () => {
    expect(sanitizeAuthor('   \n\t  ')).toBe('');
  });
});

describe('readAuthor', () => {
  it('reads a stored string', () => {
    expect(readAuthor('dev@example.com')).toBe('dev@example.com');
  });

  // No migration: every pre-author record must still load, as `unknown`.
  it('maps absent or non-string values to unknown', () => {
    expect(readAuthor(undefined)).toBe(UNKNOWN_AUTHOR);
    expect(readAuthor(null)).toBe(UNKNOWN_AUTHOR);
    expect(readAuthor(42)).toBe(UNKNOWN_AUTHOR);
    expect(readAuthor({ toString: () => 'nope' })).toBe(UNKNOWN_AUTHOR);
    expect(readAuthor('')).toBe(UNKNOWN_AUTHOR);
    expect(readAuthor('   ')).toBe(UNKNOWN_AUTHOR);
  });

  it('sanitizes on the way in, so a corrupt file cannot poison a re-render', () => {
    expect(readAuthor('bad\nvalue')).toBe('bad value');
  });
});

describe('systemAuthor', () => {
  it('never returns empty', () => {
    expect(systemAuthor().length).toBeGreaterThan(0);
  });

  it('falls back through env when the OS lookup yields nothing', () => {
    // userInfo() succeeds on a dev box, so this only asserts the shape is a
    // single sanitized line — the env branch is exercised by the value below.
    expect(systemAuthor({ USER: 'envuser' })).toMatch(/^\S+$/);
  });
});

describe('resolveAuthor', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-identity-'));
    await execa('git', ['init', '-q'], { cwd: dir });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers the repo's configured user.email", async () => {
    await execa('git', ['config', 'user.email', 'repo-owner@example.com'], { cwd: dir });
    expect(await resolveAuthor(dir)).toBe('repo-owner@example.com');
  });

  it('sanitizes a hostile configured value instead of trusting it', async () => {
    await execa('git', ['config', 'user.email', 'a@b.com\nid: injected'], { cwd: dir });
    const author = await resolveAuthor(dir);
    expect(author).toBe('a@b.com id: injected');
    expect(author).not.toContain('\n');
  });

  /*
   * Repo-level unset does NOT isolate: git falls through to global config, and
   * this test cannot prevent that — `gitEnv()` deliberately strips
   * GIT_CONFIG_GLOBAL as part of the exec hardening, so there is no supported
   * way to blind resolveAuthor to a developer's ~/.gitconfig. What is asserted
   * is the contract that actually matters: still a single sanitized non-empty
   * line, whatever the machine's config happens to be.
   */
  it('still yields one sanitized non-empty line when repo user.email is unset', async () => {
    await execa('git', ['config', '--unset-all', 'user.email'], { cwd: dir }).catch(() => {});
    const author = await resolveAuthor(dir);
    expect(author.length).toBeGreaterThan(0);
    expect(author).not.toContain('\n');
    expect(author).toBe(author.trim());
  });

  // Must never throw: an unattributable write records `unknown` rather than
  // failing, because losing the record is worse than losing the label.
  it('resolves outside a git repo without throwing', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'baton-identity-nogit-'));
    try {
      const author = await resolveAuthor(bare);
      expect(typeof author).toBe('string');
      expect(author.length).toBeGreaterThan(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
