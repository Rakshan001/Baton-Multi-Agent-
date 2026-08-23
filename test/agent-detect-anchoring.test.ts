// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who Baton thinks is calling decides who may claim a task.
 *
 * `resolveAgentId` reads the process table when `BATON_AGENT` is unset, and the
 * answer is matched against a task's `assignee`. So a detect pattern that fires
 * on the *word* rather than on a running program hands someone else's assigned
 * task to whoever happened to mention it.
 *
 * Found by running `baton take <slug>` on an `@antigravity` task from an
 * ordinary shell: the claim succeeded, and the row recorded `antigravity`,
 * because the shell's own command line contained the word. Every sibling
 * pattern is anchored; this one had an unanchored alternative.
 */
import { describe, it, expect } from 'vitest';
import { firstAgentIn } from '../src/agents.js';

describe('agent detection is about programs, not words', () => {
  it('still detects the CLI', () => {
    expect(firstAgentIn(['/opt/homebrew/bin/agy'])).toBe('antigravity');
    expect(firstAgentIn(['agy --version'])).toBe('antigravity');
  });

  it('still detects the desktop app', () => {
    expect(firstAgentIn(['/Applications/Antigravity.app/Contents/MacOS/Antigravity'])).toBe('antigravity');
  });

  it('does not read a shell script that merely mentions the agent', () => {
    // This is the actual failure: a plan being applied from a shell whose
    // command line contains `@antigravity` made every claim from that shell
    // resolve as Antigravity.
    expect(firstAgentIn(['zsh -c printf "### t-a @antigravity" > plan.md'])).toBeNull();
  });

  it('does not read a directory named after it', () => {
    expect(firstAgentIn(['node build.js --out ~/antigravity-docs/site'])).toBeNull();
  });

  it('leaves every other agent\'s anchoring alone', () => {
    expect(firstAgentIn(['/usr/local/bin/claude --print'])).toBe('claude');
    expect(firstAgentIn(['node /x/aider-notes/index.js'])).toBeNull();
    expect(firstAgentIn(['/usr/bin/codex exec'])).toBe('codex');
  });
});
