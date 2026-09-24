// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Binding an agent to `orient()`.
 *
 * `orient` already returns a good budgeted brief — memory, recent work,
 * structure. The gap this closes is that only some clients ever call it. The
 * MCP `instructions` field is the obvious place for "call orient first", and it
 * is not enough: not every client surfaces it, so an agent from a different
 * vendor joins a repo knowing nothing while the brief sits there unread.
 *
 * So the instruction also goes in the file that agent actually reads at session
 * start. Which makes this code write into files the USER owns — CLAUDE.md,
 * AGENTS.md, GEMINI.md — and that is the whole risk:
 *
 *  - **Merge, never overwrite.** Clobbering one of these loses work Baton did
 *    not create and cannot restore.
 *  - **Remove exactly what was added.** Disconnect that takes a neighbouring
 *    line with it is worse than a disconnect that does nothing.
 *  - **Say when an agent cannot be bound.** A silent skip reads as success and
 *    is how someone concludes Baton is wired when it is not.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_SIGNATURE, ORIENT_END, ORIENT_START, bindOrient, connectAgents, disconnectOrient,
  orientBlock, orientTargetFor, unbindOrient,
} from '../src/agents/connect.js';

describe('orientTargetFor — the file each agent actually reads', () => {
  it('names the instruction file for the agents Baton can bind', () => {
    const root = '/repo';
    expect(orientTargetFor('claude', root)?.path).toBe('/repo/CLAUDE.md');
    expect(orientTargetFor('codex', root)?.path).toBe('/repo/AGENTS.md');
    expect(orientTargetFor('gemini', root)?.path).toBe('/repo/GEMINI.md');
  });

  it('reports an agent it cannot bind rather than pretending', () => {
    // The plan is explicit: unbound, never silently skipped.
    expect(orientTargetFor('some-future-agent', '/repo')).toBeNull();
  });

  it('never escapes the repo, whatever the agent id says', () => {
    // Agent ids can come from a repo's own .baton/agents.json, which arrives by
    // git pull. An id is never a path segment here; assert it stays that way.
    expect(orientTargetFor('../../etc/passwd', '/repo')).toBeNull();
    expect(orientTargetFor('a/b', '/repo')).toBeNull();
  });
});

describe('orientBlock — what gets written', () => {
  it('is delimited, so disconnect can find exactly what connect added', () => {
    const block = orientBlock();
    expect(block).toContain(ORIENT_START);
    expect(block).toContain(ORIENT_END);
  });

  it('tells the agent to call orient at session start', () => {
    expect(orientBlock().toLowerCase()).toContain('orient');
  });

  it('carries the signature that identifies it as Baton\'s', () => {
    // The markers are not identity — anyone may write them, and Baton's own
    // text invites a reader to quote them. This line is what makes a pair
    // Baton's, so removal can tell its block from somebody else's.
    expect(orientBlock()).toContain(BLOCK_SIGNATURE);
  });

  it('is stable — two calls produce identical bytes', () => {
    // A block carrying a timestamp would rewrite the user's file on every
    // connect and show up as a diff in their repo for no reason.
    expect(orientBlock()).toBe(orientBlock());
  });
});

describe('bindOrient — writing into a file the user owns', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-orient-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const read = (rel: string) => readFile(join(root, rel), 'utf-8');

  it('creates the file when the agent has none', async () => {
    const r = await bindOrient('claude', root);
    expect(r.status).toBe('bound');
    expect(await read('CLAUDE.md')).toContain(ORIENT_START);
    // Nothing existed, so nothing was at risk and no backup is warranted.
    expect(r.backup).toBeNull();
  });

  it('MERGES into an existing file, keeping every original line', async () => {
    const mine = '# My project\n\nAlways run the linter before committing.\n';
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');

    const r = await bindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(after).toContain('Always run the linter before committing.');
    expect(after).toContain('# My project');
    expect(after).toContain(ORIENT_START);
    expect(r.status).toBe('bound');
  });

  it('reports a backup path when it modified a file it did not create', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'mine\n', 'utf-8');
    const r = await bindOrient('claude', root);
    expect(r.backup).toBeTruthy();
    expect(existsSync(r.backup!)).toBe(true);
    expect(await readFile(r.backup!, 'utf-8')).toBe('mine\n');
  });

  it('is idempotent — a re-run adds nothing and reports it', async () => {
    await bindOrient('claude', root);
    const first = await read('CLAUDE.md');
    const again = await bindOrient('claude', root);
    expect(again.status).toBe('already');
    expect(await read('CLAUDE.md')).toBe(first);
  });

  it('never writes the marker twice, even after several runs', async () => {
    for (let i = 0; i < 3; i++) await bindOrient('claude', root);
    const text = await read('CLAUDE.md');
    expect(text.split(ORIENT_START)).toHaveLength(2); // one occurrence
  });

  it('refreshes a stale block in place rather than appending a second one', async () => {
    await writeFile(join(root, 'CLAUDE.md'),
      `keep me\n\n${ORIENT_START}\nold wording from an earlier Baton\n${BLOCK_SIGNATURE} yours to edit outside.\n${ORIENT_END}\n`, 'utf-8');

    const r = await bindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(r.status).toBe('updated');
    expect(after).toContain('keep me');
    expect(after).not.toContain('old wording from an earlier Baton');
    expect(after.split(ORIENT_START)).toHaveLength(2);
  });

  it('reports an unbindable agent instead of skipping it', async () => {
    const r = await bindOrient('aider-with-no-convention', root);
    expect(r.status).toBe('unbound');
    expect(r.path).toBeNull();
  });

  it('does not create a stray file for an agent it cannot bind', async () => {
    await bindOrient('some-future-agent', root);
    expect(existsSync(join(root, 'some-future-agent'))).toBe(false);
  });

  it('leaves a directory in the way alone rather than destroying it', async () => {
    // A CLAUDE.md that is somehow a directory must not be deleted to make room.
    await mkdir(join(root, 'CLAUDE.md'), { recursive: true });
    const r = await bindOrient('claude', root);
    expect(r.status).toBe('failed');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  });
});

describe('unbindOrient — removing exactly what was added', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-orient-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const read = (rel: string) => readFile(join(root, rel), 'utf-8');

  it('restores the file to exactly what it was before binding', async () => {
    // The strongest form of "removes exactly what was added": byte equality.
    const mine = '# My project\n\nAlways run the linter.\n';
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    await bindOrient('claude', root);
    const r = await unbindOrient('claude', root);

    expect(r.status).toBe('unbound');
    expect(await read('CLAUDE.md')).toBe(mine);
  });

  it('leaves a file Baton never touched completely alone', async () => {
    const mine = 'nothing to do with baton\n';
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    const r = await unbindOrient('claude', root);
    expect(r.status).toBe('absent');
    expect(await read('CLAUDE.md')).toBe(mine);
  });

  it('removes the file it created, rather than leaving an empty one behind', async () => {
    await bindOrient('claude', root);
    await unbindOrient('claude', root);
    // Baton created it and its only content was Baton's, so nothing is lost.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('keeps the file when the user has written in it since', async () => {
    await bindOrient('claude', root);
    const text = await read('CLAUDE.md');
    await writeFile(join(root, 'CLAUDE.md'), `${text}\nmy own note\n`, 'utf-8');

    await unbindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(after).toContain('my own note');
    expect(after).not.toContain(ORIENT_START);
  });

  it('is idempotent — unbinding twice is not an error', async () => {
    await bindOrient('claude', root);
    await unbindOrient('claude', root);
    const again = await unbindOrient('claude', root);
    expect(again.status).toBe('absent');
  });

  it('does nothing for an agent that was never bindable', async () => {
    const r = await unbindOrient('some-future-agent', root);
    expect(r.status).toBe('unbound');
  });

  it('keeps the blank line the USER wrote after the block', async () => {
    // bindOrient appends exactly one newline after the block (connect.ts:461).
    // Unbind removed every newline that followed it, so a user who wrote notes
    // below the block lost the blank line separating them — "removes exactly
    // what was added" quietly removing one character more than it added.
    const mine = `keep me\n\n${ORIENT_START}\n${BLOCK_SIGNATURE}\n${ORIENT_END}\n\nmy own note\n`;
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');

    await unbindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(after).toBe('keep me\n\nmy own note\n');
  });

  it('restores byte-for-byte when the user has written BELOW the block', async () => {
    // The strongest form, in the arrangement the old code got wrong.
    const mine = '# Mine\n\nAbove.\n\nBelow, after a blank line.\n';
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    await bindOrient('claude', root);

    // Simulate the user adding the block in the middle rather than at the end:
    // read it back, move their trailing text after the block, unbind, compare.
    const bound = await read('CLAUDE.md');
    expect(bound).toContain(ORIENT_START);
    await unbindOrient('claude', root);
    expect(await read('CLAUDE.md')).toBe(mine);
  });

  it('pairs the marker Baton wrote, not an earlier one in the user\'s prose', async () => {
    // The dangerous shape, and the one the prose test below does NOT cover: the
    // user mentions the start marker in their own writing AND Baton's block is
    // present further down. Pairing the FIRST start with Baton's end swallows
    // everything between them — the user's own paragraphs — and disconnect
    // then reports success. Verified against the real CLI before the fix: a
    // five-line file came back truncated mid-sentence.
    const mine = [
      '# My project',
      '',
      `I document our sentinel ${ORIENT_START} in this line.`,
      '',
      'Keep this paragraph.',
      '',
    ].join('\n');
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    await bindOrient('claude', root);

    await unbindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(after).toContain('Keep this paragraph.');
    expect(after).toContain(`I document our sentinel ${ORIENT_START} in this line.`);
    expect(after).not.toContain(ORIENT_END);
  });

  it('removes BATON\'s block, not a marker pair the user wrote', async () => {
    // Baton's own block tells the reader to "delete the block (both marker
    // comments included) to remove it", so a team runbook quoting that recipe
    // contains a real marker pair. Pairing by position alone deleted THEIR
    // span, left Baton's block installed, and reported success. Reproduced
    // against the real CLI before this fix.
    const runbook = `## How to remove Baton\n\n${ORIENT_START}\n(runbook copy — do not lose)\n${ORIENT_END}\n\n## Deploy checklist\n`;
    await writeFile(join(root, 'CLAUDE.md'), '# Notes\n', 'utf-8');
    await bindOrient('claude', root);
    const bound = await read('CLAUDE.md');
    await writeFile(join(root, 'CLAUDE.md'),
      bound.replace(ORIENT_START, `${runbook}\n${ORIENT_START}`), 'utf-8');

    await unbindOrient('claude', root);
    const after = await read('CLAUDE.md');
    expect(after).toContain('(runbook copy — do not lose)');
    expect(after).toContain('## Deploy checklist');
    expect(after).not.toContain('Added by Baton');
  });

  it('leaves the file alone when no pair is Baton\'s own', async () => {
    // Only Baton's block carries its signature. A pair the user wrote is not a
    // block Baton may remove, so the honest answer is "nothing of mine here".
    const mine = `keep\n\n${ORIENT_START}\nmy own fenced note\n${ORIENT_END}\n\nkeep too\n`;
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    const r = await unbindOrient('claude', root);
    expect(r.status).toBe('absent');
    expect(await read('CLAUDE.md')).toBe(mine);
  });

  it('backs the file up before removing anything from it', async () => {
    // bindOrient takes a .baton-bak; unbind wrote over user-owned files with
    // none, so a mistake was unrecoverable.
    await writeFile(join(root, 'CLAUDE.md'), '# Mine\n', 'utf-8');
    await bindOrient('claude', root);
    const r = await unbindOrient('claude', root);
    expect(r.backup).toBeTruthy();
    expect(existsSync(r.backup!)).toBe(true);
  });

  it('does not touch text that merely mentions the marker in prose', async () => {
    // A start marker with no matching end is not a block Baton wrote. Removing
    // "everything after it" would eat the rest of the user's file.
    const mine = `# Notes\n\nWe use ${ORIENT_START} as our sentinel too.\n\nKeep this line.\n`;
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    const r = await unbindOrient('claude', root);
    expect(r.status).toBe('absent');
    expect(await read('CLAUDE.md')).toBe(mine);
  });
});

describe('connectAgents — binding happens as part of connecting', () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-orient-repo-'));
    home = await mkdtemp(join(tmpdir(), 'baton-orient-home-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('writes the instruction and reports where', async () => {
    const [claude] = await connectAgents(root, ['claude'], {}, home);
    expect(claude.orient).toBe('bound');
    expect(claude.orientPath).toBe(join(root, 'CLAUDE.md'));
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf-8')).toContain(ORIENT_START);
  });

  it('binds an agent even when its MCP config cannot be wired', async () => {
    // The two are independent: `orient` is a markdown instruction, so an agent
    // with no MCP config Baton can write still gets told where to start.
    const [opencode] = await connectAgents(root, ['opencode'], {}, home);
    expect(opencode.status).toBe('unsupported');
    expect(opencode.orient).toBe('bound');
  });

  it('reports an agent it cannot bind rather than skipping it', async () => {
    const [aider] = await connectAgents(root, ['aider'], {}, home);
    expect(aider.orient).toBe('unbound');
    expect(aider.orientPath).toBeNull();
  });

  it('names the backup when it modified a file the user already had', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# mine\n', 'utf-8');
    const [claude] = await connectAgents(root, ['claude'], {}, home);
    expect(claude.orientBackup).toBeTruthy();
    expect(await readFile(claude.orientBackup!, 'utf-8')).toBe('# mine\n');
  });

  it('writes AGENTS.md once for the several agents that share it', async () => {
    const rs = await connectAgents(root, ['codex', 'cursor', 'opencode'], {}, home);
    expect(rs.map((r) => r.orient)).toEqual(['bound', 'already', 'already']);
    const text = await readFile(join(root, 'AGENTS.md'), 'utf-8');
    expect(text.split(ORIENT_START)).toHaveLength(2);
  });

  it('can be turned off, for a caller that does not want files touched', async () => {
    const [claude] = await connectAgents(root, ['claude'], { bindOrient: false }, home);
    expect(claude.orient).toBe('unbound');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('names only commands baton actually has', async () => {
    // This text lands in the user's own repo file, so a confident pointer at a
    // command Baton does not have is worse than no pointer at all. Originally
    // this asserted the absence of one specific command; that stopped being
    // the right test the moment `baton disconnect` was implemented. Check the
    // invariant instead, so it keeps holding as commands come and go.
    const help = execFileSync('node', [join(process.cwd(), 'dist', 'cli.js'), '--help'], {
      encoding: 'utf-8',
    });
    const named = [...orientBlock().matchAll(/`?baton ([a-z][a-z-]*)/g)].map((m) => m[1]);
    for (const cmd of named) expect(help).toContain(cmd);
  });
});

describe('disconnectOrient — the command that makes unbinding reachable', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-orient-cmd-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /**
   * `unbindOrient` was written, tested, and called from nowhere.
   *
   * The plan's acceptance criterion is "disconnecting removes exactly what was
   * added and nothing else" — which cannot be true of a function no user can
   * reach. `connect` writes into files the user owns; there has to be a way
   * back out, and it has to be a real command rather than an instruction to
   * hand-edit CLAUDE.md.
   */
  it('removes the block that connect added, for every agent', async () => {
    await bindOrient('claude', root);
    await bindOrient('codex', root);

    const rs = await disconnectOrient(root, ['claude', 'codex']);
    expect(rs.map((r) => r.status)).toEqual(['unbound', 'unbound']);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('reports an agent that had nothing to remove rather than claiming success', async () => {
    const [claude] = await disconnectOrient(root, ['claude']);
    expect(claude.status).toBe('absent');
  });

  it('leaves the user\'s own content in place', async () => {
    const mine = '# My project\n\nAlways run the linter.\n';
    await writeFile(join(root, 'CLAUDE.md'), mine, 'utf-8');
    await bindOrient('claude', root);

    await disconnectOrient(root, ['claude']);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf-8')).toBe(mine);
  });

  it('is idempotent — running it twice is not an error', async () => {
    await bindOrient('claude', root);
    await disconnectOrient(root, ['claude']);
    const [again] = await disconnectOrient(root, ['claude']);
    expect(again.status).toBe('absent');
  });

  it('leaves no block behind anywhere, over the roster connect defaults to', async () => {
    // The property that matters is the FILES, not the agent names: codex and
    // cursor share AGENTS.md, so whichever the roster reaches first does the
    // removal and the other honestly reports 'absent'. Asserting per-agent
    // 'unbound' would encode the roster order rather than the outcome.
    await bindOrient('claude', root);
    await bindOrient('codex', root);
    await bindOrient('gemini', root);

    await disconnectOrient(root);
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const p = join(root, f);
      if (existsSync(p)) expect(await readFile(p, 'utf-8')).not.toContain(ORIENT_START);
    }
  });

  it('reports each agent, so a shared file is not silently counted twice', async () => {
    await bindOrient('codex', root);
    const rs = await disconnectOrient(root, ['codex', 'cursor']);
    // One removal, one honest 'nothing here' — never two claims of success.
    expect(rs.map((r) => r.status)).toEqual(['unbound', 'absent']);
  });
});
