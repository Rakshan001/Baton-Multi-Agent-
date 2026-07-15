import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask } from '../src/store.js';
import { registerHookSession, touchHookSession, PRESENCE_WINDOW_MIN, WATCHER_HEARTBEAT_STALE_MS } from '../src/signals.js';
import { collectPresence } from '../src/board.js';

/**
 * ADD-07/B — connected agents that have no Baton task worktree (plain terminals,
 * MCP-connected codex/gemini) must surface on the dashboard, since the
 * worktree-only board structurally can't show them (ISS-12/ISS-14).
 */
describe('collectPresence — surfaces the session registry, deduped against tasks', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-presence-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns a registered session that has no task worktree', async () => {
    registerHookSession(root, 'sess-cursor1', 'cursor', '/repo/checkout-a');
    const presence = await collectPresence(root);
    expect(presence).toHaveLength(1);
    expect(presence[0]).toMatchObject({ slug: 'sess-cursor1', agent: 'cursor', root: '/repo/checkout-a', live: true });
  });

  it('drops a session whose slug IS a task worktree (already on the board)', async () => {
    await addTask(root, {
      slug: 'add-hourly', task: 'add hourly buckets', branch: 'baton/add-hourly',
      baseBranch: 'main', worktreePath: join(root, '.baton', 'wt', 'add-hourly'),
      createdAt: new Date().toISOString(), agent: 'claude', status: 'in-progress',
    } as never);
    registerHookSession(root, 'add-hourly', 'claude', join(root, '.baton', 'wt', 'add-hourly'));
    registerHookSession(root, 'sess-codex1', 'codex', '/repo/checkout-b');

    const presence = await collectPresence(root);
    expect(presence.map((p) => p.slug)).toEqual(['sess-codex1']); // the task-slugged one is excluded
  });

  it('windows out a session last seen beyond the presence window', async () => {
    const stale = new Date(Date.now() - (PRESENCE_WINDOW_MIN + 5) * 60_000).toISOString();
    registerHookSession(root, 'sess-old', 'gemini', '/repo/checkout-c', stale);
    expect(await collectPresence(root)).toHaveLength(0);
  });

  it('marks a recently-seen session live and an idle-but-connected one not', async () => {
    const idle = new Date(Date.now() - WATCHER_HEARTBEAT_STALE_MS - 30_000).toISOString();
    registerHookSession(root, 'sess-fresh', 'cursor', '/repo/a');
    registerHookSession(root, 'sess-idle', 'cursor', '/repo/b', idle);

    const byslug = new Map((await collectPresence(root)).map((p) => [p.slug, p]));
    expect(byslug.get('sess-fresh')!.live).toBe(true);   // seen just now → actively working
    expect(byslug.get('sess-idle')!.live).toBe(false);   // within window but past heartbeat → idle-connected
  });

  // Finding #5: a connected agent that only reads (no edits) must not fade out —
  // any tool call touches its session, bringing it back to live.
  it('touchHookSession refreshes a read-only agent back to live', async () => {
    const idle = new Date(Date.now() - WATCHER_HEARTBEAT_STALE_MS - 30_000).toISOString();
    registerHookSession(root, 'sess-reader', 'codex', '/repo/x', idle);
    expect((await collectPresence(root)).find((p) => p.slug === 'sess-reader')!.live).toBe(false);

    touchHookSession(root, 'sess-reader'); // stands in for any MCP tool call
    expect((await collectPresence(root)).find((p) => p.slug === 'sess-reader')!.live).toBe(true);
  });

  it('touchHookSession never fabricates presence for an unregistered (task) slug', async () => {
    touchHookSession(root, 'some-task'); // never registered a hook_sessions row
    expect(await collectPresence(root)).toHaveLength(0);
  });
});
