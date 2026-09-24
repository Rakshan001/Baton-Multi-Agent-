// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One attribution rule for every parser: the longest matching worktree wins;
 * two tasks on one worktree path go to the latest task created at or before
 * the session started (else the oldest); anything else inside the repo is the
 * repo itself; anything outside it is not this repo's spend. Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessions, slugForCwd } from '../src/usage.js';
import { codexSessions } from '../src/usage/codex.js';
import { encodeCwd } from '../src/handoff/claude-session.js';
import type { Task } from '../src/store.js';

const ROOT = '/fx/repo';
const task = (slug: string, worktreePath: string, createdAt?: string) => ({ slug, worktreePath, createdAt }) as Task;

let projects: string;
beforeEach(async () => { projects = await mkdtemp(join(tmpdir(), 'baton-usage-attr-')); });
afterEach(async () => { await rm(projects, { recursive: true, force: true }); });

/** One transcript in the project dir Claude Code would use for `dirCwd`. */
async function session(dirCwd: string, id: string, cwd: string | null, at = '2026-09-01T00:00:00Z') {
  const d = join(projects, encodeCwd(dirCwd));
  await mkdir(d, { recursive: true });
  const line = { type: 'assistant', timestamp: at, ...(cwd ? { cwd } : {}), message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 1 } } };
  await writeFile(join(d, `${id}.jsonl`), JSON.stringify(line) + '\n', 'utf-8');
}
const slugs = async (tasks: Task[] = []) =>
  Object.fromEntries((await claudeSessions(ROOT, tasks, projects)).map((s) => [s.sessionId, s.slug]));

describe('claudeSessions finds every session for the repo, once', () => {
  it('counts a session started in a subfolder, as the repo', async () => {
    await session(`${ROOT}/web`, 'web', `${ROOT}/web`);
    expect(await slugs()).toEqual({ web: null });
  });

  it('excludes a sibling repo that only shares the dir-name prefix', async () => {
    await session(`${ROOT}-vault`, 'vault', `${ROOT}-vault`);
    expect(await slugs()).toEqual({});
  });

  it('credits a worktree whose task is gone to the repo root', async () => {
    await session(`${ROOT}/.baton/wt/gone`, 'gone', `${ROOT}/.baton/wt/gone`);
    expect(await slugs()).toEqual({ gone: null });
  });

  it('counts a session once when two tasks share its worktree path', async () => {
    const wt = `${ROOT}/.baton/wt/x`;
    await session(wt, 'shared', wt, '2026-03-01T00:00:00Z');
    const got = await claudeSessions(ROOT, [task('old', wt, '2026-01-01T00:00:00Z'), task('new', wt, '2026-02-01T00:00:00Z')], projects);
    expect(got.map((s) => [s.sessionId, s.slug])).toEqual([['shared', 'new']]);
  });

  it('falls back to the dir it was found in when a transcript has no cwd', async () => {
    const wt = `${ROOT}/.baton/wt/fix`;
    await session(wt, 'nocwd', null);
    expect(await slugs([task('fix', wt)])).toEqual({ nocwd: 'fix' });
  });
});

describe('codex follows the same rule', () => {
  it('credits a gone task\'s worktree to the repo root', async () => {
    const dir = join(projects, 'codex');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rollout-1.jsonl'), [
      JSON.stringify({ timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { cwd: `${ROOT}/.baton/wt/gone`, session_id: 'c1' } }),
      JSON.stringify({ timestamp: '2026-09-01T00:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } } } }),
    ].join('\n') + '\n', 'utf-8');
    const got = await codexSessions(ROOT, [], dir);
    expect(got.map((s) => s.slug)).toEqual([null]);
  });
});

describe('slugForCwd', () => {
  it('prefers the longest matching worktree path', () => {
    const tasks = [task('outer', `${ROOT}/wt`), task('inner', `${ROOT}/wt/nested`)];
    expect(slugForCwd(`${ROOT}/wt/nested/src`, ROOT, tasks)).toBe('inner');
    expect(slugForCwd(`${ROOT}/wt/src`, ROOT, tasks)).toBe('outer');
  });

  it('on a shared path, picks the latest task created at or before the session', () => {
    const wt = `${ROOT}/wt`;
    const tasks = [task('a', wt, '2026-01-01T00:00:00Z'), task('b', wt, '2026-02-01T00:00:00Z')];
    expect(slugForCwd(wt, ROOT, tasks, '2026-03-01T00:00:00Z')).toBe('b');
    expect(slugForCwd(wt, ROOT, tasks, '2026-01-15T00:00:00Z')).toBe('a');
    // Before either task existed, or with no usable time: the oldest.
    expect(slugForCwd(wt, ROOT, tasks, '2025-12-01T00:00:00Z')).toBe('a');
    expect(slugForCwd(wt, ROOT, tasks, null)).toBe('a');
    expect(slugForCwd(wt, ROOT, tasks, 'garbage')).toBe('a');
    expect(slugForCwd(wt, ROOT, [...tasks].reverse())).toBe('a');
  });

  it('keeps today\'s result for tasks with no createdAt (the first listed)', () => {
    const wt = `${ROOT}/wt`;
    const tasks = [task('first', wt), task('second', wt)];
    expect(slugForCwd(wt, ROOT, tasks)).toBe('first');
    expect(slugForCwd(wt, ROOT, tasks, '2026-03-01T00:00:00Z')).toBe('first');
  });
});
