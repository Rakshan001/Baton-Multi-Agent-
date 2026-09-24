// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  listMemories, parseFactFile, pruneUnclaimedAnchors, readJournal, removeMemory, repairMemories,
  saveMemory, slugifyId,
} from '../src/memory.js';

/**
 * A fact's id is a FILE NAME.
 *
 * `baton/memory/facts/` is tracked in git, so a fact file arrives the same way
 * a plan file does: by `git pull` from a branch nobody on this machine read.
 * Its frontmatter is attacker-controlled text, and `id` came straight out of it
 * — into `join(dir, `${id}.md`)` in `writeFactFile`, from both `repairMemories`
 * and `pruneUnclaimedAnchors`. An id of `../../../escaped` therefore wrote a
 * file wherever it pointed: the repo root, `.git/hooks/`, or anything else the
 * daemon can reach. Neither pass asks a human first — recall repairs on its own
 * schedule.
 *
 * `archiveFact` already stripped an id before touching a path; the two write
 * paths did not. The fix is at the READ boundary instead, so every path
 * downstream inherits it: a fact whose id could not have been produced by
 * `slugifyId` is not a fact.
 */
describe('a fact file cannot name a path outside the store', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  /** A fact with anchors its own text never claims — what `prune` rewrites. */
  const poison = (id: string) => [
    '---',
    `id: ${JSON.stringify(id)}`,
    'type: gotcha',
    'agent: claude',
    'author: attacker',
    'task: null',
    "created: '2026-01-01T00:00:00.000Z'",
    'commit: null',
    'files:',
    '  - .gitignore@0000000000',
    'supersedes: null',
    'fingerprint: poison',
    '---',
    '',
    'the release blocks on a signed manifest from the vendor',
    '',
  ].join('\n');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-factid-'));
    await mkdir(join(root, 'baton', 'memory', 'facts'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('writes nothing outside the facts directory when anchors are pruned', async () => {
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison.md'), poison('../../../escaped'));

    await pruneUnclaimedAnchors(root);

    expect(existsSync(join(root, 'escaped.md'))).toBe(false);
    // The temp file `writeFactFile` renames FROM escapes too, one level higher.
    expect((await readdir(join(root, 'baton'))).filter((n) => n !== 'memory')).toEqual([]);
  });

  it('writes nothing outside the facts directory when a fact is repaired', async () => {
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison2.md'), poison('../../../repaired'));

    await repairMemories(root);

    expect(existsSync(join(root, 'repaired.md'))).toBe(false);
    expect((await readdir(join(root, 'baton'))).filter((n) => n !== 'memory')).toEqual([]);
  });

  it('never serves a fact whose id is not a usable file name', async () => {
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison3.md'), poison('../../../escaped'));
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison4.md'), poison('__proto__'));
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison5.md'), poison('a/b'));
    await writeFile(join(root, 'baton', 'memory', 'facts', 'poison6.md'), poison(`x${'y'.repeat(400)}`));

    expect(await listMemories(root)).toEqual([]);
  });

  it('still reads the ids Baton itself writes', () => {
    for (const id of ['mem-the-full-test-suite-is-timing', 'mc-09330fbdfe9a', 'f1']) {
      expect(parseFactFile(poison(id))?.id, id).toBe(id);
    }
  });
});

/**
 * A retire is the one irreversible-looking thing memory does, and it takes an
 * id — a STRING — and turns it into a file it deletes from the working tree.
 * Two separate lies were possible in that translation:
 *
 *   - the id was SANITISED rather than checked, so `mem-a_b` and `../../../x`
 *     were silently rewritten into some OTHER fact's file name. Stripping is
 *     not injective: several distinct ids collapse onto one path, and the fact
 *     living at that path had nothing to do with the request.
 *   - the file at that path was never asked what it was. A fact's identity has
 *     two independent sources — the file NAME (what `areaOf` resolves) and the
 *     frontmatter `id` (what `listMemoryFacts` serves) — and nothing reconciled
 *     them. A file whose name and contents disagree therefore had one identity
 *     for reads and another for deletes.
 *
 * Both end the same way: knowledge disappears from the store and the journal
 * names a fact that was never touched, so the loss is not even traceable. The
 * retire path therefore FAILS CLOSED — it refuses anything it cannot prove is
 * the fact it was asked to retire. Reads are deliberately untouched: a fact
 * that becomes invisible is the same loss with no journal line at all.
 */
describe('a retire only ever destroys the fact it was asked to destroy', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });
  const facts = () => join(root, 'baton', 'memory', 'facts');

  /** A well-formed fact file. `name` and `id` are separate on purpose. */
  const plant = async (name: string, id: string, body: string): Promise<void> => {
    await writeFile(join(facts(), `${name}.md`), [
      '---', `id: ${JSON.stringify(id)}`, 'type: reference', 'agent: null', 'author: T',
      'task: null', "created: '2026-01-01T00:00:00.000Z'", 'commit: null', 'files: []',
      'supersedes: null', '---', '', body, '',
    ].join('\n'), 'utf-8');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-retire-'));
    await mkdir(facts(), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('refuses an id that is not a usable file name instead of stripping it into one', async () => {
    await plant('mem-real', 'mem-real', 'The daemon binds to 127.0.0.1 and nothing else.');

    // Stripping turned this into `mem-real`, so a traversal string retired a
    // real, unrelated fact — and the journal recorded the traversal string.
    expect(await removeMemory(root, '../../../mem-real')).toBe(false);

    expect(existsSync(join(facts(), 'mem-real.md'))).toBe(true);
    expect((await listMemories(root)).map((f) => f.id)).toEqual(['mem-real']);
    expect(await readJournal(root)).toEqual([]);
  });

  it('does not retire the neighbour an id collapses onto once the strip is gone', async () => {
    await plant('mem-ab', 'mem-ab', 'Releases are cut from main on a friday.');
    await plant('mem-a_b', 'mem-a_b', 'The integration suite needs docker running first.');

    expect(await removeMemory(root, 'mem-a_b')).toBe(true);

    // `mem-a_b` -> strip `_` -> `mem-ab`: the fact that went was the one nobody
    // named, and the one that was named stayed live.
    expect(existsSync(join(facts(), 'mem-a_b.md'))).toBe(false);
    expect(existsSync(join(facts(), 'mem-ab.md'))).toBe(true);
    expect((await listMemories(root)).map((f) => f.id)).toEqual(['mem-ab']);
  });

  it('refuses to archive a file whose frontmatter declares a different fact', async () => {
    // The file NAME impersonates one fact; the knowledge inside it is another's.
    // `areaOf` resolves by name, so the retire aimed at a file it never read.
    await plant('mem-victim', 'mem-impostor', 'Deploys wait on a signed manifest from the vendor.');

    expect(await removeMemory(root, 'mem-victim')).toBe(false);

    expect(existsSync(join(facts(), 'mem-victim.md'))).toBe(true);
    // The knowledge that would have gone is still served, under its own id.
    expect((await listMemories(root)).map((f) => f.id)).toEqual(['mem-impostor']);
    // And nothing claims a retire happened.
    expect(await readJournal(root)).toEqual([]);
  });
});

/**
 * The id validator and the id MINTER have to agree.
 *
 * `SAFE_FACT_ID` caps an id at 128 characters, on the stated grounds that
 * "every id Baton itself mints comes from `slugifyId`, so refusing anything
 * that could not have come from there costs nothing". That premise was false:
 * `slugifyId` joins the first six whitespace-free tokens with no length bound
 * at all, and six long camelCase identifiers — an entirely ordinary thing to
 * write a fact ABOUT in this codebase — mint an id of 150+ characters.
 *
 * Nothing on the write path checked. `saveMemory` reported the id it had just
 * written as saved, the file landed in the TRACKED store and rode `git push`
 * to every clone, and then `parseFactFile` refused it on the way back in: the
 * fact was never listed, never recalled, never counted against the cap, and
 * `removeMemory` could not retire it. Silent, replicated, unrecoverable — the
 * exact knowledge loss the read-side guard was written to prevent.
 */
describe('an id Baton mints is always an id Baton can serve', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  // Six long tokens, no whitespace inside any of them: `slugifyId` takes six
  // and joins them, so this is the shape that overruns. It is also a fact a
  // person would plausibly write about this repo.
  const LONG_FACT =
    'getMemoryConsolidationStatus getRealUsageSnapshot getSessionsPresenceList ' +
    'getHandoffInboxBriefs getPipelineSwimlanesView getKnowledgeGraphNeighbours ' +
    'all short-circuit demo mode before touching the network';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-idlen-'));
    await mkdir(join(root, 'baton', 'memory', 'facts'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('bounds a minted id to something parseFactFile will accept', () => {
    const id = slugifyId(LONG_FACT);
    // Room for the `-<sha1>` suffix `saveMemory` appends on a slug collision,
    // so the DEDUPED id fits too — not merely the first one.
    expect(id.length, `minted id was ${id.length} chars`).toBeLessThanOrEqual(123);
    expect(parseFactFile(`---\nid: ${id}\n---\n\nbody\n`)).not.toBeNull();
  });

  it('serves a fact whose text mints a long id, and lets it be retired', async () => {
    const saved = await saveMemory(root, { fact: LONG_FACT, type: 'gotcha', agent: 'claude' });
    const id = saved.id;
    expect(id, 'saveMemory reported an id').toBeTruthy();

    // The claim `saveMemory` made must survive a round trip through the store.
    expect((await listMemories(root)).map((f) => f.id)).toEqual([id]);
    expect(await removeMemory(root, id)).toBe(true);
  });

  it('still distinguishes two facts that share their first six long tokens', async () => {
    // Same six leading tokens — so the same truncated slug — but genuinely
    // different knowledge, well under the supersede similarity threshold, so
    // the store is meant to keep BOTH. (Two near-identical facts collapsing is
    // the supersede feature working, not a truncation bug; that is why these
    // tails are disjoint rather than a one-word edit.)
    const head = LONG_FACT.split(' ').slice(0, 6).join(' ');
    const a = await saveMemory(root, {
      fact: `${head} short-circuit demo mode before the network is ever touched`,
      type: 'gotcha', agent: 'claude',
    });
    const b = await saveMemory(root, {
      fact: `${head} were renamed during the dashboard swimlane rewrite last quarter`,
      type: 'gotcha', agent: 'claude',
    });

    // Truncation must not collapse two distinct facts onto one id.
    expect(a.id).not.toBe(b.id);
    expect((await listMemories(root)).map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
  });
});
