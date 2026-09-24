// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Subagent transcripts (`<sessionId>/subagents/agent-*.jsonl`) are part of
 * their parent session's spend: merged into the parent's row, under the
 * parent's slug. Synthetic fixtures only, in a tmp projects dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSessionUsage, claudeSessions, type ParsedSession } from '../src/usage.js';
import { encodeCwd, listSessionFiles, subagentTranscripts, transcriptsIn } from '../src/handoff/claude-session.js';
import type { Task } from '../src/store.js';

const ROOT = '/fx/repo';
let projects: string;
let sessDir: string;
beforeEach(async () => {
  projects = await mkdtemp(join(tmpdir(), 'baton-usage-sub-'));
  sessDir = join(projects, encodeCwd(ROOT));
  await mkdir(sessDir, { recursive: true });
});
afterEach(async () => { await rm(projects, { recursive: true, force: true }); });

const msg = (id: string, input: number, cwd = ROOT, model = 'claude-opus-5') =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z', cwd, message: { id, model, usage: { input_tokens: input } } });
const write = async (file: string, lines: string[]) => {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, lines.join('\n') + '\n', 'utf-8');
};
const sub = (sid: string, name: string) => join(sessDir, sid, 'subagents', `${name}.jsonl`);

describe('subagent transcripts are merged into their parent session', () => {
  it('sums a subagent into its parent row under the parent slug', async () => {
    await write(join(sessDir, 'p1.jsonl'), [msg('a', 100)]);
    await write(sub('p1', 'agent-x'), [msg('b', 10), msg('c', 1)]);
    const got = await claudeSessions(ROOT, [], projects);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe('p1');
    expect(got[0].turns).toBe(3);
    expect(got[0].inputTokens).toBe(111);
    expect(got[0].slug).toBeNull();
  });

  it('credits the parent slug even when the subagent ran in a subfolder', async () => {
    await write(join(sessDir, 'p1.jsonl'), [msg('a', 100)]);
    await write(sub('p1', 'agent-docs'), [msg('b', 10, `${ROOT}/docs`)]);
    const tasks = [{ slug: 'docs-task', worktreePath: `${ROOT}/docs` } as Task];
    const got = await claudeSessions(ROOT, tasks, projects);
    expect(got).toHaveLength(1);
    expect(got[0].slug).toBeNull();
    expect(got[0].turns).toBe(2);
  });

  it('ignores a subagent file whose parent transcript is gone', async () => {
    await write(sub('orphan', 'agent-x'), [msg('b', 10)]);
    expect(await claudeSessions(ROOT, [], projects)).toEqual([]);
  });

  it('keeps a priced parent\'s cost when its subagent spent nothing', async () => {
    await write(join(sessDir, 'p1.jsonl'), [msg('a', 1_000_000)]);
    await write(sub('p1', 'agent-syn'), [msg('s', 0, ROOT, '<synthetic>')]);
    const [s] = await claudeSessions(ROOT, [], projects);
    expect(s.estCostUsd).toBe(5);
  });

  it('re-reads only the subagent that changed; the cached parent is not re-parsed or mutated', async () => {
    const parent = join(sessDir, 'p1.jsonl');
    const agent = sub('p1', 'agent-x');
    await write(parent, [msg('a', 100)]);
    await write(agent, [msg('b', 10)]);
    const [first] = await claudeSessions(ROOT, [], projects);
    const cachedParent = await cachedSessionUsage(parent);

    await write(agent, [msg('b', 10), msg('c', 5)]);
    await utimes(agent, new Date(), new Date(Date.now() + 5000));
    const [second] = await claudeSessions(ROOT, [], projects);

    expect(first.inputTokens).toBe(110);
    expect(second.inputTokens).toBe(115);
    expect(await cachedSessionUsage(parent)).toBe(cachedParent); // same object: not re-parsed
    expect(cachedParent?.inputTokens).toBe(100); // and the merge did not write into it
  });
});

describe('the transcript listings', () => {
  it('listSessionFiles still returns only top-level transcripts (handoff briefs read [0])', async () => {
    const home = await mkdtemp(join(tmpdir(), 'baton-usage-home-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const d = join(home, '.claude', 'projects', encodeCwd(ROOT));
      await write(join(d, 'p1.jsonl'), [msg('a', 1)]);
      await write(join(d, 'p1', 'subagents', 'agent-x.jsonl'), [msg('b', 1)]);
      expect(await listSessionFiles(ROOT)).toEqual([join(d, 'p1.jsonl')]);
    } finally {
      process.env.HOME = prev;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('subagentTranscripts lists <sessionId>/subagents/*.jsonl, [] when none', async () => {
    await write(join(sessDir, 'p1.jsonl'), [msg('a', 1)]);
    await write(sub('p1', 'agent-x'), [msg('b', 1)]);
    await writeFile(join(sessDir, 'p1', 'subagents', 'agent-x.meta.json'), '{}');
    expect(await subagentTranscripts(join(sessDir, 'p1.jsonl'))).toEqual([sub('p1', 'agent-x')]);
    expect(await subagentTranscripts(join(sessDir, 'none.jsonl'))).toEqual([]);
  });

  it('transcriptsIn keeps the rest of a dir when one file vanishes mid-listing', async () => {
    await write(join(sessDir, 'p1.jsonl'), [msg('a', 1)]);
    await symlink(join(sessDir, 'gone.jsonl'), join(sessDir, 'dangling.jsonl')); // listed, but stat fails
    expect(await transcriptsIn(sessDir)).toEqual([join(sessDir, 'p1.jsonl')]);
  });
});

describe('cachedSessionUsage is single-flight per file', () => {
  const parsed = (file: string): ParsedSession => ({
    sessionId: file, agent: 'claude', attribution: 'measured', model: null, turns: 1,
    inputTokens: 1, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    totalTokens: 1, consumedTokens: 1, estCostUsd: null, firstAt: null, lastAt: null,
  });

  it('shares one parse between concurrent callers', async () => {
    const file = join(sessDir, 'sf.jsonl');
    await write(file, [msg('a', 1)]);
    let calls = 0;
    const parse = async (f: string) => { calls++; await new Promise((r) => setTimeout(r, 20)); return parsed(f); };
    const [a, b] = await Promise.all([cachedSessionUsage(file, parse), cachedSessionUsage(file, parse)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('returns null for a rejected parse, and a later call parses again', async () => {
    const file = join(sessDir, 'sf-fail.jsonl');
    await write(file, [msg('a', 1)]);
    let calls = 0;
    const failing = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); throw new Error('boom'); };
    const got = await Promise.all([cachedSessionUsage(file, failing), cachedSessionUsage(file, failing)]);
    expect(got).toEqual([null, null]);
    expect(calls).toBe(1);
    expect(await cachedSessionUsage(file, async (f) => parsed(f))).not.toBeNull(); // the entry was cleared
  });

  it('does not hand a stale in-flight parse to a caller that saw a newer mtime', async () => {
    const file = join(sessDir, 'sf-new.jsonl');
    await write(file, [msg('a', 1)]);
    let calls = 0;
    const slow = async (f: string) => { calls++; await new Promise((r) => setTimeout(r, 30)); return parsed(f); };
    const first = cachedSessionUsage(file, slow);
    await new Promise((r) => setTimeout(r, 5));
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    const second = cachedSessionUsage(file, slow);
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
});
