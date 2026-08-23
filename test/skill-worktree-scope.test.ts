// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Q22's second clause: P30's Done-when says an install "lands in the worktree",
 * and the HTTP route installed into the daemon's root instead. One daemon
 * serves a repo, agents work in worktrees under it, and Orca can have a
 * worktree open that is not the main checkout — so "install this skill" from
 * that window wrote to somewhere the reader was not looking.
 *
 * The reason this is not simply "pass the path through": the path arrives over
 * HTTP and decides where files get WRITTEN. It is only honoured when git itself
 * lists it as a worktree of the served repo, and anything else is refused. It
 * fails closed on purpose — a refusal is an inconvenience, and a write outside
 * the repo is not.
 */
import { describe, it, expect } from 'vitest';
import { resolveSkillRoot } from '../src/skills/install.js';

const WORKTREES = [
  { path: '/repo', branch: 'main', head: null },
  { path: '/repo/.baton/wt/fix-login', branch: 'fix-login', head: null },
];

describe('resolveSkillRoot', () => {
  it('installs into the served root when no worktree is asked for', () => {
    expect(resolveSkillRoot('/repo', undefined, WORKTREES)).toEqual({ ok: true, root: '/repo' });
    expect(resolveSkillRoot('/repo', '', WORKTREES)).toEqual({ ok: true, root: '/repo' });
  });

  it('installs into a worktree git actually lists', () => {
    expect(resolveSkillRoot('/repo', '/repo/.baton/wt/fix-login', WORKTREES)).toEqual({
      ok: true,
      root: '/repo/.baton/wt/fix-login',
    });
  });

  it('ignores a trailing slash rather than refusing a correct path over it', () => {
    expect(resolveSkillRoot('/repo', '/repo/.baton/wt/fix-login/', WORKTREES)).toEqual({
      ok: true,
      root: '/repo/.baton/wt/fix-login',
    });
  });

  // 🔴 The whole point. This decides where files are written.
  it('refuses any path git does not list as a worktree', () => {
    for (const path of [
      '/etc',
      '/repo/../elsewhere',
      '/repo/.baton/wt/fix-login/../../../..',
      '/repo/src',
      '~/.ssh',
      'relative/path',
    ]) {
      const out = resolveSkillRoot('/repo', path, WORKTREES);
      expect(out.ok, `${path} must be refused`).toBe(false);
    }
  });

  it('names what it would accept, so the refusal is actionable', () => {
    const out = resolveSkillRoot('/repo', '/etc', WORKTREES);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.reason).toContain('/repo/.baton/wt/fix-login');
  });

  it('refuses when git lists no worktrees at all rather than falling back', () => {
    // An empty list means the question could not be answered; honouring the
    // path anyway would make the check decorative exactly when it matters.
    const out = resolveSkillRoot('/repo', '/repo/somewhere', []);
    expect(out.ok).toBe(false);
  });
});

/**
 * The read and the write are scoped by the same function and treat a bad answer
 * differently on purpose. A GET that refused would blank the panel over a
 * scoping detail — a client may reasonably name a directory inside the repo
 * that is not itself a worktree. A POST that fell back would write files
 * somewhere other than where it was told.
 */
describe('the caller decides what a refusal costs', () => {
  it('gives the write everything it needs to refuse', () => {
    const out = resolveSkillRoot('/repo', '/tmp/elsewhere', WORKTREES);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.reason).toContain('/tmp/elsewhere');
  });

  it('is the same decision either way — leniency belongs to the caller, not here', () => {
    // If this ever returned a fallback root itself, the write would silently
    // install somewhere other than the path it was given.
    const out = resolveSkillRoot('/repo', '/tmp/elsewhere', WORKTREES);
    expect('root' in out).toBe(false);
  });
})
