/**
 * Team mode's reachability gate, against a real remote.
 *
 * The property that matters is asymmetric. Saying "not fetchable" about work
 * that IS on the remote costs a wait. Saying "fetchable" about work that is
 * not means an agent starts building on commits no other machine has, and
 * finds out at merge time. So the interesting cases here are the ones that
 * could produce a false yes: a local commit that was never pushed, and a task
 * with no recorded sha at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { clearFetchableCache, fetchableProbe } from '../src/fetchable.js';

let dir: string;
let origin: string;
let clone: string;

/** Commit a file on the current branch and return the new sha. */
async function commit(repo: string, file: string, body: string): Promise<string> {
  await writeFile(join(repo, file), body, 'utf-8');
  await git(['add', '.'], repo);
  await git(['commit', '-qm', `${file}`], repo);
  return (await git(['rev-parse', 'HEAD'], repo)).trim();
}

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'baton-fetchable-')));
  origin = join(dir, 'origin.git');
  clone = join(dir, 'work');

  await git(['init', '-q', '--bare', '-b', 'main', origin], dir);
  await git(['clone', '-q', origin, clone], dir);
  await git(['config', 'user.email', 't@t.dev'], clone);
  await git(['config', 'user.name', 't'], clone);
  await commit(clone, 'a.ts', 'one\n');
  await git(['push', '-q', 'origin', 'main'], clone);
  clearFetchableCache();
});

afterEach(async () => {
  clearFetchableCache();
  await rm(dir, { recursive: true, force: true });
});

describe('fetchableProbe', () => {
  it('says yes to a commit that is on the remote', async () => {
    const sha = (await git(['rev-parse', 'HEAD'], clone)).trim();
    const isFetchable = await fetchableProbe(clone, [sha]);
    expect(isFetchable).not.toBe(null);
    expect(isFetchable!(sha)).toBe(true);
  });

  it('says NO to a local commit that was never pushed', async () => {
    // The dangerous direction. This commit exists right here, so any check based
    // on "is the object present" would wrongly pass it — and a teammate would
    // start against work living on exactly one laptop.
    const unpushed = await commit(clone, 'b.ts', 'two\n');
    const isFetchable = await fetchableProbe(clone, [unpushed]);
    expect(isFetchable!(unpushed)).toBe(false);
  });

  it('says no to a task that has no recorded sha at all', async () => {
    // `pushedSha` absent means never pushed. Treating undefined as "unknown, let
    // it through" would open the gate for every task that never reached it.
    const isFetchable = await fetchableProbe(clone, [undefined]);
    expect(isFetchable!(undefined)).toBe(false);
  });

  it('returns null in solo mode, so nothing is gated', async () => {
    // A repo with no remote must behave exactly as it did before team mode
    // existed — not "everything unreachable", which would wedge every plan.
    const solo = join(dir, 'solo');
    await git(['init', '-q', '-b', 'main', solo], dir);
    expect(await fetchableProbe(solo, ['deadbeef'])).toBe(null);
  });

  it('sees a teammate push without waiting for the process to restart', async () => {
    // Caching only positive answers is what makes this work. If "no" were
    // remembered, a colleague pushing 10 seconds later would stay invisible for
    // the life of the process — indistinguishable from a wedged pipeline.
    const sha = await commit(clone, 'c.ts', 'three\n');
    expect((await fetchableProbe(clone, [sha]))!(sha)).toBe(false);

    await git(['push', '-q', 'origin', 'HEAD:main'], clone);
    // A later query, past the TTL, must re-fetch and change its mind.
    const later = await fetchableProbe(clone, [sha], Date.now() + 60_000);
    expect(later!(sha)).toBe(true);
  });

  it('answers repeated queries without re-fetching inside the TTL', async () => {
    // The reason this module exists: `baton next` runs per agent turn and the
    // board polls every 2s. One fetch has to serve all of them.
    const sha = (await git(['rev-parse', 'HEAD'], clone)).trim();
    const at = Date.now();
    const first = await fetchableProbe(clone, [sha], at);
    expect(first!(sha)).toBe(true);

    // Push something new straight into the bare repo, behind our back.
    const other = join(dir, 'other');
    await git(['clone', '-q', origin, other], dir);
    await git(['config', 'user.email', 'u@t.dev'], other);
    await git(['config', 'user.name', 'u'], other);
    const theirs = await commit(other, 'd.ts', 'four\n');
    await git(['push', '-q', 'origin', 'HEAD:main'], other);

    // Same TTL window: we must NOT have gone to the network again, so their
    // brand-new commit is still unknown here.
    const cached = await fetchableProbe(clone, [theirs], at + 1_000);
    expect(cached!(theirs)).toBe(false);

    // Past the TTL it refreshes.
    const fresh = await fetchableProbe(clone, [theirs], at + FETCH_WINDOW);
    expect(fresh!(theirs)).toBe(true);
  });
});

/** Comfortably past FETCH_TTL_MS without coupling the test to its exact value. */
const FETCH_WINDOW = 120_000;
