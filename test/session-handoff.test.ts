// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { createSessionHandoff } from '../src/handoff/session-brief.js';
import { addTask } from '../src/store.js';
import { listBriefs, setBriefStatusAt } from '../src/handoff/resume.js';

/**
 * H1 — the manual-relay flow: ANY session (Cursor at 99% usage, a root Claude
 * terminal with no worktree, Codex) writes a structured handoff brief on
 * request. The brief is what the next agent pastes/reads to continue — it must
 * carry done / pending / next / decisions verbatim and survive round-tripping
 * through listBriefs (H4).
 */
describe('createSessionHandoff — brief for any session', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-handoff-'));
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a session brief under .baton/handoffs for a root session (no task)', async () => {
    const r = await createSessionHandoff(root, {
      slug: 'sess-p1234',
      agent: 'cursor',
      title: 'Fix auth token expiry',
      done: ['reproduced the 401 on refresh', 'found root cause in token.ts:42'],
      pending: ['write regression test', 'apply the fix'],
      next: 'write the failing test in test/token.test.ts first',
      decisions: ['keep the 5-min clock skew allowance — mobile clients need it'],
    });

    expect(r.path).toBe(join(root, '.baton', 'handoffs', 'sess-p1234.md'));
    expect(existsSync(r.path)).toBe(true);

    const parsed = matter(await readFile(r.path, 'utf-8'));
    expect(parsed.data.baton).toBe(1);
    expect(parsed.data.status).toBe('ready');
    expect(parsed.data.from).toBe('cursor');
    expect(parsed.content).toContain('Fix auth token expiry');
    expect(parsed.content).toContain('- [x] reproduced the 401 on refresh');
    expect(parsed.content).toContain('- [ ] write regression test');
    expect(parsed.content).toContain('write the failing test in test/token.test.ts first');
    expect(parsed.content).toContain('5-min clock skew');
    // The pickup instruction must point at baton resume.
    expect(r.resume).toContain('baton resume sess-p1234');
  });

  it('renders a "Suggested skills" section telling the next agent what to invoke', async () => {
    const r = await createSessionHandoff(root, {
      slug: 'sess-sk', agent: 'cursor', title: 'Migrate the data store',
      next: 'run the migration script',
      suggestedSkills: ['stack-migration', 'bug-fix'],
    });
    const body = matter(await readFile(r.path, 'utf-8')).content;
    expect(body).toContain('## Suggested skills');
    expect(body).toContain('stack-migration');
    expect(body).toContain('bug-fix');
  });

  it('writes into the task worktree HANDOFF.md when the slug is a baton task (so `baton take` works)', async () => {
    const wt = join(root, 'wt-fix-auth');
    await mkdir(wt, { recursive: true });
    await addTask(root, {
      slug: 'fix-auth', task: 'fix auth', branch: 'baton/fix-auth', baseBranch: 'main',
      worktreePath: wt, createdAt: new Date().toISOString(), agent: 'claude', status: 'in-progress',
    } as never);

    const r = await createSessionHandoff(root, { slug: 'fix-auth', title: 'Fix auth', next: 'run tests' });
    expect(r.path).toBe(join(wt, 'HANDOFF.md'));
    expect(existsSync(r.path)).toBe(true);
  });

  it('sanitizes hostile slugs so the brief cannot escape .baton/handoffs', async () => {
    const r = await createSessionHandoff(root, { slug: '../../etc/passwd', title: 'x', next: 'y' });
    expect(r.path.startsWith(join(root, '.baton', 'handoffs') + '/')).toBe(true);
    expect(r.path).not.toContain('..');
  });

  it('rejects an empty title', async () => {
    await expect(createSessionHandoff(root, { slug: 's1', title: '   ' })).rejects.toThrow(/title/i);
  });

  it('caps runaway lists so a brief stays a brief', async () => {
    const r = await createSessionHandoff(root, {
      slug: 's2', title: 'big one',
      done: Array.from({ length: 60 }, (_, i) => `item ${i}`),
    });
    const shown = (r.markdown.match(/- \[x\]/g) ?? []).length;
    expect(shown).toBeLessThanOrEqual(30);
    expect(r.markdown).toContain('more not shown');
  });
});

describe('auto-capture: handoff decisions become memory facts (M4, zero LLM cost)', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-handoffmem-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'token.ts'), 'export const t = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
    // A dirty file — the handoff's ground truth of where the work happened.
    await writeFile(join(root, 'src', 'token.ts'), 'export const t = 2;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves each substantial decision as an anchored memory fact', async () => {
    const { listMemories } = await import('../src/memory.js');
    const r = await createSessionHandoff(root, {
      slug: 'sess-m4', agent: 'cursor', title: 'Fix expiry',
      decisions: ['keep the 5-min clock skew allowance because mobile clients drift'],
    });
    expect(r.capturedFacts).toHaveLength(1);
    const facts = await listMemories(root);
    const captured = facts.find((f) => f.fact.includes('clock skew'));
    expect(captured).toBeDefined();
    expect(captured!.type).toBe('decision');
    expect(captured!.task).toBe('sess-m4');
    expect(captured!.agent).toBe('cursor');
    expect(captured!.anchors.files.map((a) => a.path)).toContain('src/token.ts');
  });

  it('anchors a decision to the files it MENTIONS, not the whole session (precision beats churn)', async () => {
    const { listMemories } = await import('../src/memory.js');
    // A second dirty file the decision does not talk about.
    await writeFile(join(root, 'src', 'other.ts'), 'export const o = 1;\n');
    const r = await createSessionHandoff(root, {
      slug: 'sess-m6', agent: 'claude', title: 'Skew work',
      decisions: ['token.ts keeps the clock-skew allowance because mobile clients drift'],
    });
    expect(r.capturedFacts).toHaveLength(1);
    const fact = (await listMemories(root)).find((f) => f.fact.includes('clock-skew'))!;
    const paths = fact.anchors.files.map((a) => a.path);
    expect(paths).toContain('src/token.ts');
    expect(paths).not.toContain('src/other.ts');
  });

  it('falls back to the session files when a decision mentions none of them', async () => {
    const { listMemories } = await import('../src/memory.js');
    const r = await createSessionHandoff(root, {
      slug: 'sess-m6b', agent: 'claude', title: 'General call',
      decisions: ['we standardize on streaming exports so nothing buffers whole reports'],
    });
    expect(r.capturedFacts).toHaveLength(1);
    const fact = (await listMemories(root)).find((f) => f.fact.includes('streaming exports'))!;
    expect(fact.anchors.files.map((a) => a.path)).toContain('src/token.ts');
  });

  it('skips trivial one-word decisions and secret-looking ones — handoff still succeeds', async () => {
    const { listMemories } = await import('../src/memory.js');
    const r = await createSessionHandoff(root, {
      slug: 'sess-m4b', agent: 'codex', title: 'Rotate keys',
      decisions: ['use jwt', 'the deploy token is ghp_' + 'a'.repeat(30) + ' for CI pushes only'],
    });
    expect(r.capturedFacts).toHaveLength(0);
    const facts = await listMemories(root);
    expect(facts.some((f) => f.fact.includes('ghp_'))).toBe(false);
    expect(facts.some((f) => f.fact === 'use jwt')).toBe(false);
  });

  /*
   * This is Baton's ONLY autonomous memory writer, so it is where the
   * anti-capture gate matters most: a decisions list is exactly where "in this
   * session we…" gets written down and then outlives the session it describes.
   * A refused decision must be REPORTED, not silently dropped — the agent that
   * wrote it is the only party who can restate it durably.
   */
  it('refuses an undurable decision, reports it back, and still captures the durable one', async () => {
    const { listMemories } = await import('../src/memory.js');
    const r = await createSessionHandoff(root, {
      slug: 'sess-m4d', agent: 'claude', title: 'Mixed decisions',
      decisions: [
        'In this session we rewrote the expiry handling twice before it stuck',
        'token.ts keeps a 5-minute skew allowance because mobile clocks drift',
      ],
    });
    expect(r.capturedFacts).toHaveLength(1);
    expect(r.skippedFacts).toHaveLength(1);
    expect(r.skippedFacts[0].decision).toContain('In this session');
    expect(r.skippedFacts[0].reason).toMatch(/not durable knowledge \(narrative/);
    expect((await listMemories(root)).some((f) => f.fact.includes('In this session'))).toBe(false);
    expect(existsSync(r.path)).toBe(true); // the brief itself still lands
  });

  it('never quotes back a decision refused for containing a credential', async () => {
    // skippedFacts is echoed to the caller; the credential rejection is a
    // DIFFERENT error class precisely so it can never travel that path.
    const r = await createSessionHandoff(root, {
      slug: 'sess-m4e', agent: 'claude', title: 'Key rotation',
      decisions: ['the deploy token is ghp_' + 'b'.repeat(30) + ' for CI pushes only'],
    });
    expect(r.capturedFacts).toHaveLength(0);
    expect(r.skippedFacts).toHaveLength(0);
    expect(JSON.stringify(r.skippedFacts)).not.toContain('ghp_');
  });

  it('a handoff outside any git repo still works — capture is silently skipped', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'baton-handoffnogit-'));
    await mkdir(join(bare, '.baton'), { recursive: true });
    try {
      const r = await createSessionHandoff(bare, {
        slug: 'sess-m4c', title: 'No repo here',
        decisions: ['a perfectly substantial decision that cannot be anchored anywhere'],
      });
      expect(r.capturedFacts).toHaveLength(0);
      expect(existsSync(r.path)).toBe(true);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('listBriefs / setBriefStatusAt — the resume side (H4)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-resume-'));
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists session briefs and task briefs together', async () => {
    await createSessionHandoff(root, { slug: 'sess-a', agent: 'cursor', title: 'A work', next: 'n' });

    const wt = join(root, 'wt-b');
    await mkdir(wt, { recursive: true });
    await addTask(root, {
      slug: 'task-b', task: 'B work', branch: 'baton/task-b', baseBranch: 'main',
      worktreePath: wt, createdAt: new Date().toISOString(), agent: 'claude', status: 'in-progress',
    } as never);
    await createSessionHandoff(root, { slug: 'task-b', title: 'B work', next: 'n' });

    const briefs = await listBriefs(root);
    const slugs = briefs.map((b) => b.slug).sort();
    expect(slugs).toEqual(['sess-a', 'task-b']);
    const sess = briefs.find((b) => b.slug === 'sess-a')!;
    expect(sess.kind).toBe('session');
    expect(sess.status).toBe('ready');
    expect(sess.title).toContain('A work');
    expect(briefs.find((b) => b.slug === 'task-b')!.kind).toBe('task');
  });

  it('flips status in place for any brief path', async () => {
    const r = await createSessionHandoff(root, { slug: 'sess-c', title: 'C', next: 'n' });
    expect(await setBriefStatusAt(r.path, 'in-progress')).toBe(true);
    const briefs = await listBriefs(root);
    expect(briefs.find((b) => b.slug === 'sess-c')!.status).toBe('in-progress');
  });

  it('ignores a done brief file that is not a baton brief', async () => {
    await mkdir(join(root, '.baton', 'handoffs'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, '.baton', 'handoffs', 'junk.md'), '# not a brief\n', 'utf-8');
    const briefs = await listBriefs(root);
    expect(briefs.find((b) => b.slug === 'junk')).toBeUndefined();
  });
});
