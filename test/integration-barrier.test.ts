// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The integration barrier, against real git.
 *
 * A phase is not over when its last task is marked done — it is over when its
 * branches are on the base. Between those moments the branches exist only side
 * by side, never combined, and two of them can each be correct while still not
 * composing. The whole point of this check is to find that out BEFORE the next
 * phase branches from a base that cannot be built.
 *
 * The pure gating lives in pipeline.ts and is unit-tested there. This file
 * covers the half that has to ask git, so it uses real repositories: a trial
 * integration that lies is worse than none at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitTry } from '../src/util/exec.js';
import { parseMergeTreeConflicts, trialIntegrate } from '../src/git.js';

let repo: string;

/** A branch off main that rewrites one file. */
async function branchWith(name: string, file: string, body: string) {
  await git(['checkout', '-q', 'main'], repo);
  await git(['checkout', '-q', '-b', name], repo);
  await writeFile(join(repo, file), body, 'utf-8');
  await git(['commit', '-qam', `${name}: ${file}`], repo);
  await git(['checkout', '-q', 'main'], repo);
}

beforeEach(async () => {
  repo = realpathSync(await mkdtemp(join(tmpdir(), 'baton-barrier-')));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t.dev'], repo);
  await git(['config', 'user.name', 't'], repo);
  await writeFile(join(repo, 'db.ts'), 'base\n', 'utf-8');
  await writeFile(join(repo, 'api.ts'), 'base\n', 'utf-8');
  await git(['add', '.'], repo);
  await git(['commit', '-qm', 'init'], repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('trialIntegrate', () => {
  it('passes a phase whose branches touch different files', async () => {
    await branchWith('baton/schema', 'db.ts', 'schema\n');
    await branchWith('baton/api', 'api.ts', 'api\n');

    const r = await trialIntegrate('main', ['baton/schema', 'baton/api'], repo);
    expect(r.conflict).toBe(null);
    expect(r.ok).toEqual(['baton/schema', 'baton/api']);
  });

  it('catches two branches that each merge cleanly but not together', async () => {
    /*
     * The spec's own example, and the reason this is cumulative rather than
     * per-branch. Both of these merge into main without complaint; it is only
     * the second onto the FIRST that clashes. A per-branch check reports
     * all-clear here and opens the next phase on a base that never built.
     */
    await branchWith('baton/db-seed', 'db.ts', 'SEED\n');
    await branchWith('baton/config', 'db.ts', 'CONFIG\n');

    // Each alone against main: clean. This is the trap, so pin it.
    expect((await trialIntegrate('main', ['baton/db-seed'], repo)).conflict).toBe(null);
    expect((await trialIntegrate('main', ['baton/config'], repo)).conflict).toBe(null);

    const r = await trialIntegrate('main', ['baton/db-seed', 'baton/config'], repo);
    expect(r.conflict?.branch).toBe('baton/config');
    expect(r.conflict?.files).toEqual(['db.ts']);
    expect(r.ok).toEqual(['baton/db-seed']);   // says how far it got
  });

  it('accepts a phase once the clash is resolved by merging the earlier branch in', async () => {
    /*
     * The ordinary way a human clears the conflict above: merge the first branch
     * into the second and fix the file once. The trial must then pass — and it
     * did not, because each synthetic step carried only the accumulated head as
     * a parent. With no ancestry link to the branch just merged, the next step
     * computed its merge base against the ORIGINAL base, saw both sides had
     * edited db.ts, and reported the same conflict forever. Nothing the user did
     * could clear it. Caught by running the flow end to end, not by unit tests,
     * which is why this one exists.
     */
    await branchWith('baton/db-seed', 'db.ts', 'SEED\n');
    await branchWith('baton/config', 'db.ts', 'CONFIG\n');

    await git(['checkout', '-q', 'baton/config'], repo);
    await gitTry(['merge', 'baton/db-seed'], repo);            // conflicts, as above
    await writeFile(join(repo, 'db.ts'), 'SEED\nCONFIG\n', 'utf-8');
    await git(['add', 'db.ts'], repo);
    await git(['commit', '-qm', 'resolve db.ts'], repo);
    await git(['checkout', '-q', 'main'], repo);

    const r = await trialIntegrate('main', ['baton/db-seed', 'baton/config'], repo);
    expect(r.conflict).toBe(null);
    expect(r.ok).toEqual(['baton/db-seed', 'baton/config']);
  });

  it('leaves the repository untouched — no branch, no commit, no working tree change', async () => {
    // The barrier runs on a 2s poll and on every `baton next`. If it moved
    // anything, it would be the most destructive code in the project.
    await branchWith('baton/db-seed', 'db.ts', 'SEED\n');
    await branchWith('baton/config', 'db.ts', 'CONFIG\n');

    const headBefore = (await gitTry(['rev-parse', 'main'], repo)).stdout;
    const branchesBefore = (await gitTry(['branch', '--format=%(refname)'], repo)).stdout;

    await trialIntegrate('main', ['baton/db-seed', 'baton/config'], repo);

    expect((await gitTry(['rev-parse', 'main'], repo)).stdout).toBe(headBefore);
    expect((await gitTry(['branch', '--format=%(refname)'], repo)).stdout).toBe(branchesBefore);
    expect((await gitTry(['status', '--porcelain'], repo)).stdout).toBe('');
  });

  it('integrates nothing and complains about nothing when the phase is empty', async () => {
    // A phase whose tasks were all cancelled has no branches. Per §9 it opens
    // the next phase rather than erroring.
    const r = await trialIntegrate('main', [], repo);
    expect(r).toEqual({ ok: [], conflict: null });
  });

  it('throws on a bad ref rather than calling it a conflict', async () => {
    // "conflict with 0 files" would read as "something clashed but we cannot
    // say what", and would hold the barrier forever on a typo.
    await expect(trialIntegrate('main', ['baton/does-not-exist'], repo)).rejects.toThrow();
  });
});

describe('parseMergeTreeConflicts', () => {
  it('reads paths from the stage lines, not the prose', async () => {
    const raw = [
      '9092803645d9ae57a84ecd586191bbfa829779f5',
      '100644 a29bdeb434d874c9b1d8969c40c42161b03fafdc 1\tsrc/db.ts',
      '100644 43d5a8ed6ef6c00ff775008633f95787d088285d 2\tsrc/db.ts',
      '100644 ba629238ca89489f2b350e196ca445e09d8bb834 3\tsrc/db.ts',
      '',
      'Auto-merging src/db.ts',
      'CONFLICT (content): Merge conflict in src/db.ts',
    ].join('\n');
    // Three stages, one file — deduped, and the path keeps its directory.
    expect(parseMergeTreeConflicts(raw)).toEqual(['src/db.ts']);
  });

  it('finds nothing in output that carries no stage lines', () => {
    expect(parseMergeTreeConflicts('fatal: not something we can merge')).toEqual([]);
  });
});
