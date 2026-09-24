// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I9 + I10 — the presence upsert never lets a null replace a known
 * name on the same host, and the board folds a session's hook row into its MCP
 * row only on an exact (agent, host_pid) match with exactly one MCP row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerHookSession, liveSessions, migrateHistoryDb, isMcpSessionSlug } from '../src/signals.js';
import { collectPresence } from '../src/board.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-pmerge-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const row = (slug: string) => liveSessions(root).find((s) => s.slug === slug);

describe('registerHookSession upsert (I9 / D11)', () => {
  it('stores source, client name and host pid', () => {
    registerHookSession(root, 'sess-p10', 'claude', root, undefined, { source: 'env', clientName: 'claude-code\n', hostPid: 10 });
    expect(row('sess-p10')).toMatchObject({ agent: 'claude', agentSource: 'env', clientName: 'claude-code', hostPid: 10 });
  });

  it('a null never replaces a known name on the same host; a name does', () => {
    registerHookSession(root, 'sess-p10', 'claude', root, undefined, { source: 'env', hostPid: 10 });
    registerHookSession(root, 'sess-p10', null, root, undefined, { source: 'none', hostPid: 10 });
    expect(row('sess-p10')).toMatchObject({ agent: 'claude', agentSource: 'env' });
    registerHookSession(root, 'sess-p10', 'codex', root, undefined, { source: 'env', hostPid: 10 });
    expect(row('sess-p10')).toMatchObject({ agent: 'codex', agentSource: 'env' });
  });

  it('a null on a DIFFERENT host (pid reuse = a new process) does replace', () => {
    registerHookSession(root, 'sess-p10', 'claude', root, undefined, { source: 'env', hostPid: 10 });
    registerHookSession(root, 'sess-p10', null, root, undefined, { source: 'none', hostPid: 99 });
    expect(row('sess-p10')).toMatchObject({ agent: null, hostPid: 99 });
  });

  it('a null host on both sides still counts as the same host (NULL-safe IS)', () => {
    registerHookSession(root, 'sess-p11', 'claude', root);
    registerHookSession(root, 'sess-p11', null, root);
    expect(row('sess-p11')?.agent).toBe('claude');
  });

  it('a null row is upgraded once the real name resolves', () => {
    registerHookSession(root, 'sess-p12', null, root, undefined, { source: 'none', hostPid: 12 });
    registerHookSession(root, 'sess-p12', 'cursor', root, undefined, { source: 'ancestry', hostPid: 12 });
    expect(row('sess-p12')).toMatchObject({ agent: 'cursor', agentSource: 'ancestry' });
  });

  it('an edit write (same agent, no host) keeps the stored source and host', () => {
    // The guard writes `ancestry-inferred` + null host on every edit, before its
    // host walk; a walk cut short by the budget must not leave the row "(inferred)".
    registerHookSession(root, 'sess-e1', 'claude', root, undefined, { source: 'ancestry', hostPid: 30 });
    registerHookSession(root, 'sess-e1', 'claude', root, undefined, { source: 'ancestry-inferred' });
    expect(row('sess-e1')).toMatchObject({ agent: 'claude', agentSource: 'ancestry', hostPid: 30 });
  });

  it('a different agent with no host still replaces the source', () => {
    registerHookSession(root, 'sess-e2', 'claude', root, undefined, { source: 'ancestry', hostPid: 30 });
    registerHookSession(root, 'sess-e2', 'codex', root, undefined, { source: 'env' });
    expect(row('sess-e2')).toMatchObject({ agent: 'codex', agentSource: 'env' });
  });
});

describe('additive migration of an old history.db', () => {
  const OLD = `CREATE TABLE edit_signals (slug TEXT, path TEXT, at TEXT, settledAt TEXT, PRIMARY KEY (slug, path));
    CREATE TABLE hook_sessions (slug TEXT PRIMARY KEY, agent TEXT, root TEXT, at TEXT);`;

  it('adds the columns to a pre-phase-7 DB; the old 4-column INSERT still works', async () => {
    await mkdir(join(root, '.baton'), { recursive: true });
    const old = new DatabaseSync(join(root, '.baton', 'history.db'));
    old.exec(OLD);
    old.prepare(`INSERT INTO hook_sessions (slug, agent, root, at) VALUES (?, ?, ?, ?)`).run('sess-old', 'gemini', root, new Date().toISOString());
    registerHookSession(root, 'sess-p20', 'claude', root, undefined, { source: 'ancestry', hostPid: 20 });
    old.prepare(`INSERT INTO hook_sessions (slug, agent, root, at) VALUES (?, ?, ?, ?)`).run('sess-old2', 'codex', root, new Date().toISOString());
    old.close();
    expect(row('sess-old')).toMatchObject({ agent: 'gemini', agentSource: null, hostPid: null });
    expect(row('sess-old2')?.agent).toBe('codex');
    expect(row('sess-p20')).toMatchObject({ agent: 'claude', hostPid: 20 });
  });

  it('two processes migrating one DB at once: the loser ignores "duplicate column"', async () => {
    const path = join(root, 'race.db');
    const a = new DatabaseSync(path);
    const b = new DatabaseSync(path);
    a.exec(OLD);
    migrateHistoryDb(a);
    expect(() => migrateHistoryDb(b)).not.toThrow();
    const cols = (b.prepare(`PRAGMA table_info(hook_sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['agent_source', 'client_name', 'host_pid']));
    a.close(); b.close();
  });
});

describe('collectPresence merge (I10)', () => {
  const reg = (slug: string, agent: string | null, hostPid: number | null) =>
    registerHookSession(root, slug, agent, root, undefined, { source: 'env', hostPid });
  const slugs = async () => (await collectPresence(root)).map((p) => p.slug).sort();

  it('isMcpSessionSlug tells MCP rows from hook rows', () => {
    expect(isMcpSessionSlug('sess-p10')).toBe(true);
    expect(isMcpSessionSlug('sess-abcd1234')).toBe(false);
    expect(isMcpSessionSlug('t-login')).toBe(false);
  });

  it('MCP + hook row of one session → one row, the MCP slug, with agentSource', async () => {
    reg('sess-p10', 'claude', 10);
    reg('sess-abcd1234', 'claude', 10);
    const p = await collectPresence(root);
    expect(p.map((s) => s.slug)).toEqual(['sess-p10']);
    expect(p[0].agentSource).toBe('env');
  });

  it('a different agent on the same host → not merged', async () => {
    reg('sess-p10', 'claude', 10);
    reg('sess-abcd1234', 'cursor', 10);
    expect(await slugs()).toEqual(['sess-abcd1234', 'sess-p10']);
  });

  it('two sessions in one root, each MCP+hook → two rows', async () => {
    reg('sess-p10', 'claude', 10); reg('sess-aaaa1111', 'claude', 10);
    reg('sess-p20', 'claude', 20); reg('sess-bbbb2222', 'claude', 20);
    expect(await slugs()).toEqual(['sess-p10', 'sess-p20']);
  });

  it('two MCP rows on one host + one hook row → ambiguous, three rows', async () => {
    reg('sess-p31', 'cursor', 30); reg('sess-p32', 'cursor', 30); reg('sess-cccc3333', 'cursor', 30);
    expect(await slugs()).toHaveLength(3);
  });

  it('a null host pid on either side is never merged', async () => {
    reg('sess-p40', 'claude', null); reg('sess-dddd4444', 'claude', null);
    expect(await slugs()).toHaveLength(2);
  });
});
