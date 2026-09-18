// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `list_worktrees` — the MCP half of the worktree-flow feature.
 *
 * The reported failure is that agents cannot see each other's worktrees, so a
 * sibling that stopped mid-task looks exactly like one that is working. No
 * dashboard fixes that: agents do not read the dashboard. This is the tool that
 * answers "what worktrees exist, who holds them, and which have gone quiet"
 * inside the agent's own session.
 *
 * Two things are under test here and nothing else:
 *
 *  1. The projection. `health` must arrive from `src/worktrees.ts` UNCHANGED —
 *     there is exactly one definition of health in this codebase and this file
 *     is not allowed to become a second one. The rows below are therefore built
 *     with the read-model's own `buildWorktreeRow`, so a drift in the ladder
 *     shows up here as a changed expectation rather than as two models agreeing
 *     with each other and disagreeing with git.
 *  2. `unknown` must survive the trip. The read-model fails closed on purpose
 *     (worktrees.ts:deriveHealth rung 1); flattening that to something
 *     reassuring on the way to the agent would reintroduce the exact bug —
 *     dead work rendering as fresh — one layer further out.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKTREE_HEALTHS, ownWorktreeSlug, worktreeBrief } from '../src/mcp.js';
import { buildWorktreeRow, deriveHealth, type WorktreeFacts, type WorktreeRow } from '../src/worktrees.js';
import { WORKTREES_FILTER_HELP, TOOL_HELP, TOOL_HELP_BUDGET } from '../src/mcp-help.js';

const NOW = 1_800_000_000_000;

function facts(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    slug: 'a',
    branch: 'baton/a',
    worktreePath: '/wt/a',
    state: 'active',
    git: { status: 'clean', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    localOnlyCommits: 0,
    agent: 'claude',
    claimedBy: 'claude',
    holderRunning: true,
    lastActivityAt: NOW - 1_000,
    planId: null,
    phase: null,
    dependsOn: [],
    orphan: false,
    wipRef: null,
    ...over,
  };
}

const row = (over: Partial<WorktreeFacts> = {}): WorktreeRow => buildWorktreeRow(facts(over), NOW);

describe('list_worktrees — the projection', () => {
  it('lists every worktree with slug, branch, holder, state, health and quiet time', () => {
    const rows = [
      row({ slug: 'a', branch: 'baton/a' }),
      row({ slug: 'b', branch: 'baton/b', worktreePath: '/wt/b', claimedBy: 'codex', agent: null, holderRunning: false }),
    ];
    const out = worktreeBrief(rows, { cwd: '/elsewhere' });
    expect('refused' in out).toBe(false);
    if ('refused' in out) return;
    expect(out.worktrees).toHaveLength(2);
    expect(out.worktrees[0]).toMatchObject({
      slug: 'a',
      branch: 'baton/a',
      state: 'active',
      holder: 'claude',
      holderRunning: true,
      health: 'working',
      quietForMs: 1_000,
    });
    expect(out.worktrees[1]).toMatchObject({ slug: 'b', holder: 'codex', holderRunning: false });
  });

  it('reports the health the read-model derived, never one of its own', () => {
    // Held, no process, work that exists nowhere else: the terminal state the
    // whole feature exists to name.
    const f = facts({ holderRunning: false, agent: null, git: { status: 'dirty', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 2, insertions: 30, deletions: 4 } });
    const r = buildWorktreeRow(f, NOW);
    expect(r.health).toBe('abandoned'); // pin what the read-model says
    const out = worktreeBrief([r], { cwd: '/elsewhere' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees[0]!.health).toBe(deriveHealth(f, NOW));
    expect(out.worktrees[0]!.health).toBe('abandoned');
  });

  it('passes `unknown` through and never launders it into working or ok', () => {
    const r = buildWorktreeRow(facts({ git: null }), NOW);
    expect(r.health).toBe('unknown');
    const out = worktreeBrief([r], { cwd: '/elsewhere' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees[0]!.health).toBe('unknown');
    expect(['working', 'ok']).not.toContain(out.worktrees[0]!.health);
  });

  it('serves a null quiet time rather than a zero when there is no evidence', () => {
    const r = buildWorktreeRow(facts({ lastActivityAt: 0 }), NOW);
    const out = worktreeBrief([r], { cwd: '/elsewhere' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees[0]!.quietForMs).toBeNull();
  });
});

describe('list_worktrees — the caller\'s own worktree', () => {
  it('marks the worktree the caller is standing in as mine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-wt-'));
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a); mkdirSync(b);
    const rows = [row({ slug: 'a', worktreePath: a }), row({ slug: 'b', worktreePath: b })];
    const out = worktreeBrief(rows, { cwd: b });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.mine).toBe('b');
    expect(out.worktrees.find((w) => w.slug === 'b')!.mine).toBe(true);
    expect(out.worktrees.find((w) => w.slug === 'a')!.mine).toBeUndefined();
  });

  it('marks it from a SUBDIRECTORY of the worktree, which is where an agent actually stands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-wt-'));
    const a = join(dir, 'a');
    mkdirSync(join(a, 'src'), { recursive: true });
    const out = worktreeBrief([row({ slug: 'a', worktreePath: a })], { cwd: join(a, 'src') });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.mine).toBe('a');
  });

  it('is not fooled by a sibling directory whose name is a string prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-wt-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'a-two'));
    const rows = [row({ slug: 'a', worktreePath: join(dir, 'a') })];
    expect(ownWorktreeSlug(rows, join(dir, 'a-two'))).toBeNull();
  });

  it('picks the innermost worktree when one is nested inside another', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-wt-'));
    const outer = join(dir, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    const rows = [row({ slug: 'outer', worktreePath: outer }), row({ slug: 'inner', worktreePath: inner })];
    expect(ownWorktreeSlug(rows, inner)).toBe('inner');
  });

  it('falls back to the session task slug when the caller is not inside any worktree', () => {
    const rows = [row({ slug: 'a', worktreePath: '/gone/a' }), row({ slug: 'b', worktreePath: '/gone/b' })];
    expect(ownWorktreeSlug(rows, '/elsewhere', 'b')).toBe('b');
  });

  it('marks nothing when the caller is outside every worktree and holds no task', () => {
    const rows = [row({ slug: 'a', worktreePath: '/gone/a' })];
    const out = worktreeBrief(rows, { cwd: '/elsewhere' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.mine).toBeNull();
    expect(out.worktrees.every((w) => w.mine === undefined)).toBe(true);
  });
});

describe('list_worktrees — the one filter it takes', () => {
  const rows = [
    row({ slug: 'a' }),
    row({ slug: 'b', worktreePath: '/wt/b', holderRunning: false, agent: null, git: { status: 'dirty', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 1, insertions: 9, deletions: 0 } }),
  ];

  it('returns everything when no filter is given', () => {
    const out = worktreeBrief(rows, { cwd: '/elsewhere' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees.map((w) => w.slug).sort()).toEqual(['a', 'b']);
  });

  it('keeps only the named health, case-insensitively', () => {
    const out = worktreeBrief(rows, { cwd: '/elsewhere', filter: ' Abandoned ' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees.map((w) => w.slug)).toEqual(['b']);
  });

  it('a valid filter that matches nothing is an empty list, not a refusal', () => {
    const out = worktreeBrief(rows, { cwd: '/elsewhere', filter: 'missing' });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.worktrees).toEqual([]);
  });

  it('refuses an unknown filter LOUDLY, naming the vocabulary', () => {
    // Resolving a typo to the empty set would present as "no worktrees exist",
    // which is the most dangerous possible answer this tool can give.
    const out = worktreeBrief(rows, { cwd: '/elsewhere', filter: 'stale' });
    if (!('refused' in out)) throw new Error('a typo\'d filter was accepted');
    expect(out.refused).toMatch(/stale/);
    for (const h of WORKTREE_HEALTHS) expect(out.refused).toContain(h);
  });
});

describe('list_worktrees — the vocabulary and the context budget', () => {
  it('knows every health the read-model can derive', () => {
    const cases: WorktreeFacts[] = [
      facts({ git: null }),
      facts({ git: { status: 'missing', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 } }),
      facts({ orphan: true }),
      facts({ localOnlyCommits: null }),
      facts({ holderRunning: false, agent: null, localOnlyCommits: 2 }),
      facts({ git: { status: 'conflict', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 } }),
      facts({ git: { status: 'clean', repoState: 'rebasing', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 } }),
      facts({}),
      facts({ lastActivityAt: NOW - 20 * 60_000 }),
      facts({ lastActivityAt: NOW - 24 * 60 * 60_000 }),
      facts({ state: null, claimedBy: null, git: { status: 'dirty', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 1, insertions: 1, deletions: 0 } }),
      facts({ state: null, claimedBy: null }),
    ];
    const seen = new Set(cases.map((f) => deriveHealth(f, NOW)));
    for (const h of seen) expect(WORKTREE_HEALTHS).toContain(h);
    // And the vocabulary is not padded with values nothing can produce beyond
    // the two the cases above cannot reach without a real repo.
    expect(WORKTREE_HEALTHS.length).toBeGreaterThanOrEqual(seen.size);
  });

  it('pays for its description, and does not spend anyone else\'s budget', () => {
    // The description is a key of `TOOL_HELP` like every other tool's, so it is
    // counted by the budget that polices them all rather than sitting beside it
    // uncounted. A description kept outside the registry to dodge the budget
    // assertion is how the registry stops meaning anything.
    // Counted in the unit TOOL_HELP_BUDGET is stated in — chars, which is what
    // mcp-help.ts measures today. If that budget ever moves to bytes, this line
    // moves with it; what must stay true is that the two agree.
    const total = Object.values(TOOL_HELP).reduce((n, d) => n + d.length, 0);
    expect(total).toBe(TOOL_HELP_BUDGET);

    // …and that the new tool is held to the same per-tool ceiling as the rest.
    expect(TOOL_HELP.list_worktrees.length).toBeLessThanOrEqual(300);
    expect(TOOL_HELP.list_worktrees.trim().length).toBeGreaterThan(20);
    // One filter argument. No pagination, no sort, no field selector: every
    // byte of schema is paid by every agent in every session, called or not.
    expect(Buffer.byteLength(WORKTREES_FILTER_HELP, 'utf8')).toBeLessThanOrEqual(60);
  });

  it('names the two facts an agent cannot get anywhere else', () => {
    expect(TOOL_HELP.list_worktrees).toMatch(/worktree/i);
    expect(TOOL_HELP.list_worktrees).toMatch(/stalled|abandoned|quiet/i);
  });
});
