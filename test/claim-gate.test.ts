// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gate at the moment of the write.
 *
 * Both barriers — a phase that has not landed, a dependency whose commits have
 * not reached this machine — were enforced only where work is *offered*:
 * `baton next`, and the no-slug form of `take`. Naming the slug went straight
 * to `claimTask`, which called `claim()` with no options at all, so `baton next`
 * refused a task and `baton take <that same task>` claimed it and built its
 * worktree. An agent told "not yet" by one command and "yes" by the next has no
 * barrier; it has a suggestion.
 *
 * These run against real repositories because both halves of the gate ask git —
 * one for ancestry, one for a remote. A mocked gate would pass here and still
 * ship the bug, since the bug was never in the gate.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { saveTasks, type Task } from '../src/store.js';
import { claimTask, ClaimRefused } from '../src/commands/claim.js';
import { clearFetchableCache } from '../src/fetchable.js';

let dir: string;
let repo: string;

const WHO = { agent: 'tester', sessionSlug: 'sess-1' };

/** A pipeline row, with only the fields these cases actually turn on. */
function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug,
    task: `${slug} work`,
    branch: `baton/${slug}`,
    worktreePath: join(repo, '.baton', 'wt', slug),
    baseBranch: 'main',
    baseCommit: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    state: 'queued',
    ...over,
  } as Task;
}

/** Did a worktree get built? The claim and the directory must agree. */
async function claimed(slug: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await claimTask(repo, slug, WHO);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ClaimRefused)) throw e;
    return { ok: false, message: e.message };
  }
}

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'baton-claim-gate-')));
  repo = join(dir, 'work');
  await mkdir(repo, { recursive: true });
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t.dev'], repo);
  await git(['config', 'user.name', 't'], repo);
  await writeFile(join(repo, '.gitignore'), '.baton/\n', 'utf-8');
  await writeFile(join(repo, 'a.ts'), 'base\n', 'utf-8');
  await git(['add', '.'], repo);
  await git(['commit', '-qm', 'init'], repo);
  clearFetchableCache();
});

afterEach(async () => {
  clearFetchableCache();
  await rm(dir, { recursive: true, force: true });
});

describe('claimTask — the integration barrier', () => {
  it('refuses a task in a phase locked by an unlanded one, named by slug', async () => {
    // The reproduction. Phase 1 is done and its branch is not on main; phase 2
    // must not start, whether or not the caller knew to ask `baton next` first.
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim();
    await saveTasks(repo, [
      task('schema', { phase: 1, state: 'done', baseCommit: head }),
      task('api', { phase: 2 }),
    ]);

    const r = await claimed('api');
    expect(r.ok).toBe(false);
    // And it says which phase and what to run — "not startable yet" alone sends
    // someone to a second command to find out something we already know.
    expect(r.message).toMatch(/phase 1 is finished but not integrated/);
    expect(r.message).toMatch(/baton integrate/);
  });

  it('allows the same task once the phase has landed', async () => {
    // The other half of the guard: it must open again, or it is not a barrier
    // but a wall. Phase 1's branch merged into main makes it integrated.
    await git(['checkout', '-q', '-b', 'baton/schema'], repo);
    await writeFile(join(repo, 'db.ts'), 'schema\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-qm', 'schema'], repo);
    const branchTip = (await git(['rev-parse', 'HEAD'], repo)).trim();
    await git(['checkout', '-q', 'main'], repo);
    await git(['merge', '-q', '--no-ff', '-m', 'land schema', 'baton/schema'], repo);

    await saveTasks(repo, [
      task('schema', { phase: 1, state: 'done', baseCommit: branchTip }),
      task('api', { phase: 2 }),
    ]);

    expect(await claimed('api')).toEqual({ ok: true });
  });
});

describe('claimTask — reachability', () => {
  it('refuses a dependent whose done dependency was never pushed', async () => {
    const origin = join(dir, 'origin.git');
    await git(['init', '-q', '--bare', '-b', 'main', origin], dir);
    await git(['remote', 'add', 'origin', origin], repo);
    await git(['push', '-q', 'origin', 'main'], repo);

    await saveTasks(repo, [
      task('schema', { phase: 1, state: 'done' }),   // no pushedSha — never left here
      task('api', { phase: 1, dependsOn: ['schema'] }),
    ]);

    const r = await claimed('api');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/waiting for 'schema' to be pushed/);
  });

  it('allows it once the dependency is on the remote', async () => {
    const origin = join(dir, 'origin.git');
    await git(['init', '-q', '--bare', '-b', 'main', origin], dir);
    await git(['remote', 'add', 'origin', origin], repo);
    await git(['push', '-q', 'origin', 'main'], repo);
    const pushedSha = (await git(['rev-parse', 'HEAD'], repo)).trim();

    await saveTasks(repo, [
      task('schema', { phase: 1, state: 'done', pushedSha }),
      task('api', { phase: 1, dependsOn: ['schema'] }),
    ]);

    expect(await claimed('api')).toEqual({ ok: true });
  });

  it('gates nothing in a repo with no remote', async () => {
    // Solo use predates team mode and must be untouched: a done dependency that
    // was obviously never pushed anywhere still lets its dependent start.
    await saveTasks(repo, [
      task('schema', { phase: 1, state: 'done' }),
      task('api', { phase: 1, dependsOn: ['schema'] }),
    ]);

    expect(await claimed('api')).toEqual({ ok: true });
  });
});
