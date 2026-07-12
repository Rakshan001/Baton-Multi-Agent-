import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { sessionSlug, recordHookEdit, getSignals, checkFiles } from '../src/signals.js';

/**
 * G2 — root-session coordination. The edit-guard hook WRITES a signal for every
 * edit (it used to only read), so sessions running at the repo root — outside
 * any baton worktree, with no daemon running — still see each other. A root
 * session is identified by the agent's own session id (`sess-<8>`); its edits
 * reconcile against its checkout's dirty state like task signals do (P6).
 */
describe('sessionSlug', () => {
  it('derives a stable, short pseudo-slug from a session id', () => {
    expect(sessionSlug('abc12345-6789-4def-a012-3456789abcde')).toBe('sess-abc12345');
    expect(sessionSlug('abc12345-6789-4def-a012-3456789abcde')).toBe(sessionSlug('abc12345-6789-4def-a012-3456789abcde'));
  });
  it('sanitizes weird ids instead of trusting them', () => {
    expect(sessionSlug('../..\\nasty ID!!')).toMatch(/^sess-[a-z0-9-]+$/);
  });
});

describe('hook-written signals for root sessions', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-hooksig-'));
    await git(['init', '-q'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'src.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-q', '-m', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('a root session edit shows up in getSignals with its agent, no daemon involved', async () => {
    // the file is actually dirty (the edit happened), so reconciliation keeps it
    await writeFile(join(root, 'src.ts'), 'export const a = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'sess-abc12345', path: 'src.ts', session: { agent: 'claude', sessionRoot: root } });

    const signals = await getSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0].path).toBe('src.ts');
    expect(signals[0].holders[0].slug).toBe('sess-abc12345');
    expect(signals[0].holders[0].agent).toBe('claude');
  });

  it('two root sessions on the same file → overlap warning; check_files sees the other', async () => {
    await writeFile(join(root, 'src.ts'), 'export const a = 3;\n', 'utf-8');
    recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: 'src.ts', session: { agent: 'claude', sessionRoot: root } });
    recordHookEdit(root, { slug: 'sess-bbbbbbbb', path: 'src.ts', session: { agent: 'cursor', sessionRoot: root } });

    const signals = await getSignals(root);
    expect(signals[0].level).toBe('warning');

    // session A asks "is src.ts busy?" — its OWN signal is excluded, B's remains
    const check = await checkFiles(root, ['src.ts'], 'sess-aaaaaaaa');
    expect(check['src.ts'].busy).toBe(true);
    expect(check['src.ts'].by.map((h) => h.slug)).toEqual(['sess-bbbbbbbb']);
  });

  it('reconciles a settled root-session signal away once the grace period passes', async () => {
    // Signal recorded 60s ago for a file that is NOT dirty (committed/reverted) → pruned.
    const old = new Date(Date.now() - 60_000).toISOString();
    recordHookEdit(root, { slug: 'sess-cccccccc', path: 'src.ts', at: old, session: { agent: 'claude', sessionRoot: root } });
    expect(await getSignals(root)).toHaveLength(0);
  });

  it('keeps a brand-new signal even before the edit lands on disk (grace period)', async () => {
    // The guard fires BEFORE the tool writes the file — the path is not dirty yet.
    recordHookEdit(root, { slug: 'sess-dddddddd', path: 'src.ts', session: { agent: 'claude', sessionRoot: root } });
    const signals = await getSignals(root);
    expect(signals).toHaveLength(1); // too fresh to verify → kept, not dropped
  });
});
