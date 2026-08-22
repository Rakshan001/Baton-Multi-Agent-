// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Three things setup got wrong about choice.
 *
 * 1. A folder of five repos offered "all of them, or each on its own". Nobody
 *    with five repos wants either half the time: the common shape is three that
 *    belong together and two that do not.
 *
 * 2. It reported an installed Cursor as "not installed", because it probed for
 *    `cursor-agent` — Cursor's separate terminal CLI. Someone using the Cursor
 *    *editor* has no such binary, and does not need one: the question being
 *    asked is whether to write an MCP entry, which needs no CLI at all. The
 *    probe was answering a different question than the one on screen.
 *
 * 3. Twelve bundled skills were all-or-nothing.
 */
import { describe, it, expect } from 'vitest';
import { agentPresenceHint, excludedRepoNote, type AgentPresence } from '../src/commands/setup.js';

describe('agentPresenceHint', () => {
  it('names the binary it actually found', () => {
    expect(agentPresenceHint('cli', 'claude')).toContain('claude');
    expect(agentPresenceHint('cli', 'claude')).toMatch(/PATH/i);
  });

  // The bug: an installed editor described as missing.
  it('credits an editor install rather than calling it missing', () => {
    const hint = agentPresenceHint('config', 'cursor-agent');
    expect(hint).not.toMatch(/not installed|not detected/i);
    expect(hint).toMatch(/config|editor/i);
  });

  // Wiring an agent you have not installed is still worth doing — the config is
  // waiting for the day you install it — so this must not read as a warning.
  it('says wiring still works when nothing is found', () => {
    const hint = agentPresenceHint('none', 'codex');
    expect(hint).toMatch(/still work/i);
  });

  it('gives every state a hint, so no row renders bare', () => {
    for (const state of ['cli', 'config', 'none'] as AgentPresence[]) {
      expect(agentPresenceHint(state, 'x').length).toBeGreaterThan(0);
    }
  });
});

describe('excludedRepoNote', () => {
  const ALL = ['billing_app', 'billing_backend', 'billing_frontend', 'apps/billing_app'];

  it('says nothing when the hub covers everything', () => {
    expect(excludedRepoNote(ALL, ALL)).toBeNull();
  });

  // Unchecking a repo must not cause work to happen to it — the note exists so
  // that "nothing was written there" is stated rather than assumed.
  it('names what was left out', () => {
    const note = excludedRepoNote(ALL, ['billing_app', 'billing_backend']);
    expect(note).toContain('billing_frontend');
    expect(note).toContain('apps/billing_app');
  });

  it('does not name what was included', () => {
    const note = excludedRepoNote(ALL, ['billing_app', 'billing_backend']) ?? '';
    expect(note).not.toContain('billing_backend,');
  });

  it('tells you how to add them later', () => {
    expect(excludedRepoNote(ALL, ['billing_app'])).toMatch(/baton setup/);
  });

  it('says nothing when nothing was found to exclude', () => {
    expect(excludedRepoNote([], [])).toBeNull();
  });
});
