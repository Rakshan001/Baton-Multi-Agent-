// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Baton must not index, or leave untracked, the files Baton itself writes.
 *
 * Two failures were reported from the same setup run on a clean machine, and
 * they share a cause: the ignore rules were written from the perspective of
 * Baton's own repo, where `.gitignore` happened to list `graphify-out/` and
 * `.baton/` by hand long before any of this existed. A user's repo does not.
 *
 * 1. `.graphifyignore` is seeded by MIRRORING `.gitignore` — but `kb init`
 *    seeds it BEFORE it adds Baton's own entries to `.gitignore`. On a fresh
 *    repo the mirror is therefore taken from a `.gitignore` that does not yet
 *    mention `graphify-out/` or `.baton/`, and `composeGraphifyIgnore` then
 *    declines to touch a managed file again — so the omission is permanent.
 *    The observed effect was the graph eating its own output: a second `setup`
 *    on an unchanged repo went from 1020 nodes / 82 communities to 1910 / 179.
 *
 *    The fix is not to re-order the mirror (the share question, which decides
 *    part of the block, is asked later and should not move before a long
 *    extraction). It is to stop depending on the mirror for Baton's own paths:
 *    the managed block names them itself, in the plainest syntax there is.
 *
 * 2. `setup` writes MCP config for three agents, and the gitignore block named
 *    only one of them. The Claude user got a clean `git status`; the Cursor and
 *    Antigravity users did not. Those files can also carry a Baton MCP token —
 *    `baton kb mcp --agent cursor` prints a snippet with `/mcp/g/<token>/` in
 *    it and tells you to paste it into `.cursor/mcp.json`. Ignoring `.mcp.json`
 *    for that reason while leaving its two siblings tracked is half a rule.
 */
import { describe, it, expect } from 'vitest';
import { composeGraphifyIgnore, GRAPHIFY_IGNORE_MARKER } from '../src/kb/graphifyignore.js';
import { composeBatonGitignore, batonFootprint, untrackCommand } from '../src/kb/batonignore.js';

const LEGACY = `${GRAPHIFY_IGNORE_MARKER}\nCODEBASE.md\nAGENTS.md\nkb/\n`;

describe('.graphifyignore names Baton output itself', () => {
  // The bug, stated as the thing that must be true regardless of .gitignore.
  it('excludes graphify-out/ and .baton/ even with no .gitignore to mirror', () => {
    const out = composeGraphifyIgnore('', null)!;
    expect(out).toContain('graphify-out/');
    expect(out).toContain('.baton/');
  });

  it('excludes them when the .gitignore being mirrored does not mention them', () => {
    const out = composeGraphifyIgnore('', 'node_modules/\ndist/\n')!;
    expect(out).toContain('graphify-out/');
    expect(out).toContain('.baton/');
  });

  // Everyone who ran setup before this fix has the stale file on disk. It has
  // to repair itself on the next run, or the fix only helps new users.
  it('upgrades an existing managed file in place', () => {
    const out = composeGraphifyIgnore(LEGACY, null);
    expect(out).not.toBeNull();
    expect(out!).toContain('graphify-out/');
    expect(out!).toContain('.baton/');
  });

  it('upgrades a managed file that also carries a mirror', () => {
    const mirrored = `# mirrored from .gitignore so graphify keeps honouring it\nnode_modules/\n\n${LEGACY}`;
    const out = composeGraphifyIgnore(mirrored, 'node_modules/\n');
    expect(out).not.toBeNull();
    expect(out!).toContain('graphify-out/');
    expect(out!).toContain('node_modules/');       // mirror survives the upgrade
  });

  it('keeps the user lines when it upgrades a file they added to', () => {
    const out = composeGraphifyIgnore(`${LEGACY}\nmy-own-dir/\n`, null);
    expect(out!).toContain('my-own-dir/');
    expect(out!).toContain('graphify-out/');
  });

  it('settles — an upgraded file is not rewritten again', () => {
    const once = composeGraphifyIgnore(LEGACY, null)!;
    expect(composeGraphifyIgnore(once, null)).toBeNull();
  });
});

describe('.gitignore covers every agent config setup writes', () => {
  it('ignores all three project-scoped MCP configs, not just Claude’s', () => {
    const out = composeBatonGitignore('', false)!;
    for (const f of ['.mcp.json', '.cursor/mcp.json', '.agents/mcp_config.json']) {
      expect(out).toContain(f);
    }
  });

  // A monorepo with one git root and several project dirs: `.baton/*` has a
  // slash, so git anchors it to the root and a nested one stays untracked.
  it('reaches a nested .baton/ in a monorepo', () => {
    const out = composeBatonGitignore('', false)!;
    expect(out).toContain('**/.baton/*');
    expect(out).toContain('!**/.baton/agents.json');
  });
});

describe('batonFootprint — what is tracked that we now ignore', () => {
  // Adding a line to .gitignore does nothing to a file git already tracks.
  // Saying "✓ .gitignore updated" while that is true is the misleading part.
  it('picks Baton files out of the tracked-and-ignored list', () => {
    const found = batonFootprint(['.baton/kb.json', '.mcp.json', 'src/app.ts', 'graphify-out/graph.json']);
    expect(found).toEqual(['.baton/kb.json', '.mcp.json', 'graphify-out/graph.json']);
  });

  it('does not claim agents.json, which is meant to be committed', () => {
    expect(batonFootprint(['.baton/agents.json'])).toEqual([]);
  });

  it('finds nested copies too', () => {
    expect(batonFootprint(['apps/web/.baton/kb.json', 'apps/web/.cursor/mcp.json'])).toHaveLength(2);
  });

  it('leaves a user file that merely lives near ours alone', () => {
    expect(batonFootprint(['.cursor/rules/my-rule.mdc', 'docs/baton.md'])).toEqual([]);
  });

  it('says nothing when nothing is tracked', () => {
    expect(batonFootprint([])).toEqual([]);
  });
});

describe('untrackCommand', () => {
  // Baton reports; the user runs it. `git rm --cached` on someone's repo
  // unasked is not a setup step.
  it('keeps the files on disk (--cached)', () => {
    expect(untrackCommand(['.baton/kb.json'])).toContain('--cached');
  });

  it('lists the directories once, not every file inside them', () => {
    const cmd = untrackCommand(['.baton/kb.json', '.baton/tasks.json', 'graphify-out/graph.json']);
    expect(cmd).toContain('.baton');
    expect(cmd).toContain('graphify-out');
    expect(cmd).not.toContain('tasks.json');
  });

  // Collapsing `.baton/kb.json` to `.baton` is what makes the command short —
  // and it is also what would sweep away the one file in there that teams are
  // told to commit. The exclusion is the price of the collapse.
  it('spares agents.json when it collapses the .baton directory', () => {
    const cmd = untrackCommand(['.baton/kb.json', '.baton/tasks.json']);
    expect(cmd).toContain(':(exclude).baton/agents.json');
  });

  it('excludes the nested agents.json too', () => {
    expect(untrackCommand(['apps/web/.baton/kb.json'])).toContain(':(exclude)apps/web/.baton/agents.json');
  });

  it('adds no exclusion when no .baton directory is collapsed', () => {
    expect(untrackCommand(['graphify-out/g.json', '.mcp.json'])).not.toContain('exclude');
  });

  it('is a single runnable line', () => {
    const cmd = untrackCommand(['.mcp.json']);
    expect(cmd.startsWith('git rm')).toBe(true);
    expect(cmd).not.toContain('\n');
  });
});
