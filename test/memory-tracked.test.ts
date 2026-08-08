// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * §12: memory moves into git — `baton/memory/facts`, tracked, alongside plans.
 *
 * The point is that a fact one agent learns should reach the next clone instead
 * of dying with one laptop. The risk is the exact mirror of it (§7.1): a fact
 * that used to sit on one disk is now pushed, and a credential discovered after
 * a push is a key rotation, not a file deletion.
 *
 * So the properties worth pinning are less about the move than about its edges:
 *
 *  - reads merge BOTH areas, always, so a part-migrated repo recalls exactly
 *    what it did before and no fact is invisible pending a command
 *  - the migration is explicit, re-scans on the way through, and REFUSES to
 *    publish key-shaped text — without destroying it
 *  - `--local-only` exists so a false positive costs a flag, not the fact
 *  - repair, removal and supersede respect the area a fact is actually in,
 *    rather than quietly promoting a private note into git
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  saveMemory, listMemories, migrateMemory, removeMemory,
  trackedMemoryDir, localMemoryDir, archiveDir,
} from '../src/memory.js';

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-tracked-'));
  const g = (args: string[]) => execa('git', args, { cwd: root });
  await g(['init', '-q']);
  await g(['config', 'user.email', 't@t.t']);
  await g(['config', 'user.name', 'T']);
  await g(['commit', '-qm', 'init', '--allow-empty']);
  return root;
}

/**
 * Plant a fact straight into the local area, bypassing `saveMemory`.
 *
 * Not a shortcut — it is the realistic case the migration exists to handle. The
 * secret gate has grown patterns over time and facts predate it, so the store
 * genuinely holds text no live save would accept today. There is no other way
 * to construct that state, because `saveMemory` correctly refuses it.
 */
async function plantLocal(root: string, id: string, fact: string): Promise<void> {
  const dir = localMemoryDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), [
    '---', `id: ${id}`, 'type: reference', 'agent: null', 'author: T', 'task: null',
    'created: 2026-01-01T00:00:00.000Z', 'commit: null', 'files: []',
    'supersedes: null', 'fingerprint: planted', '---', '', fact, '',
  ].join('\n'), 'utf-8');
}

describe('where a fact is written', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('goes to tracked baton/memory/facts by default', async () => {
    const saved = await saveMemory(root, { fact: 'Deploys run from main every friday at 15:00 UTC.' });
    expect(saved.area).toBe('tracked');
    expect(existsSync(join(trackedMemoryDir(root), `${saved.id}.md`))).toBe(true);
    // And NOT in the old place — a fact written to both would be served twice
    // and would diverge the moment one copy was edited.
    expect(existsSync(join(localMemoryDir(root), `${saved.id}.md`))).toBe(false);
  });

  it('--local-only keeps it out of git', async () => {
    const saved = await saveMemory(root, {
      fact: 'This machine needs the VPN up before the integration suite will pass.',
      localOnly: true,
    });
    expect(saved.area).toBe('local');
    expect(existsSync(join(localMemoryDir(root), `${saved.id}.md`))).toBe(true);
    expect(existsSync(join(trackedMemoryDir(root), `${saved.id}.md`))).toBe(false);
  });

  it('still refuses a credential outright — --local-only is not an override', async () => {
    /*
     * §7.1 gives the flag for FALSE positives, not for real ones. If it also
     * waved through genuine keys it would be the override the secret gate
     * deliberately does not have, and the first thing anyone would reach for on
     * being refused.
     */
    await expect(saveMemory(root, {
      fact: 'The staging deploy key is AKIAIOSFODNN7EXAMPLE, keep it handy.',
      localOnly: true,
    })).rejects.toThrow(/AWS access key id/);
  });
});

describe('reading a part-migrated repo', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('merges both areas, so nothing is invisible mid-migration', async () => {
    await plantLocal(root, 'old-one', 'The build cache lives under .turbo and is safe to delete.');
    const fresh = await saveMemory(root, { fact: 'Migrations run before the app boots, never after.' });

    const ids = (await listMemories(root)).map((f) => f.id);
    expect(ids).toContain('old-one');
    expect(ids).toContain(fresh.id);
  });

  it('marks which area each fact came from', async () => {
    await plantLocal(root, 'old-one', 'The build cache lives under .turbo and is safe to delete.');
    const fresh = await saveMemory(root, { fact: 'Migrations run before the app boots, never after.' });

    const byId = new Map((await listMemories(root)).map((f) => [f.id, f.area]));
    expect(byId.get('old-one')).toBe('local');
    expect(byId.get(fresh.id)).toBe('tracked');
  });

  it('a tracked fact shadows a local one with the same id', async () => {
    // The one moment both can exist is right after a move. Serving two rows for
    // one id would double-count it in recall and in the cap.
    await plantLocal(root, 'dupe', 'The local copy, which is the stale one.');
    await mkdir(trackedMemoryDir(root), { recursive: true });
    await writeFile(join(trackedMemoryDir(root), 'dupe.md'), [
      '---', 'id: dupe', 'type: reference', 'agent: null', 'author: T', 'task: null',
      'created: 2026-02-01T00:00:00.000Z', 'commit: null', 'files: []',
      'supersedes: null', 'fingerprint: planted', '---', '',
      'The tracked copy, which is the one everyone else has.', '',
    ].join('\n'), 'utf-8');

    const hits = (await listMemories(root)).filter((f) => f.id === 'dupe');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.area).toBe('tracked');
    expect(hits[0]!.fact).toMatch(/everyone else has/);
  });
});

describe('baton memory migrate', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('moves local facts into the tracked area', async () => {
    await plantLocal(root, 'one', 'The build cache lives under .turbo and is safe to delete.');
    await plantLocal(root, 'two', 'Integration tests need docker running before they will start.');

    const r = await migrateMemory(root);
    expect(r.moved.map((m) => m.id).sort()).toEqual(['one', 'two']);
    expect(existsSync(join(trackedMemoryDir(root), 'one.md'))).toBe(true);
    // Moved, not copied. A leftover in the gitignored area is a second copy
    // that stops following the tracked one the first time either is edited.
    expect(existsSync(join(localMemoryDir(root), 'one.md'))).toBe(false);
  });

  it('--dry-run reports the same move and writes nothing', async () => {
    await plantLocal(root, 'one', 'The build cache lives under .turbo and is safe to delete.');

    const r = await migrateMemory(root, { dryRun: true });
    expect(r.moved.map((m) => m.id)).toEqual(['one']);
    expect(r.dryRun).toBe(true);
    expect(existsSync(join(localMemoryDir(root), 'one.md'))).toBe(true);
    expect(existsSync(join(trackedMemoryDir(root), 'one.md'))).toBe(false);
  });

  it('will not publish a credential — keeps it local and says why', async () => {
    /*
     * The assertion this whole file is here for. The fact predates the gate, so
     * it is sitting in the store; migrating it blindly would put a live key in
     * a commit and then on a remote, where deleting the file fixes nothing.
     */
    await plantLocal(root, 'leaky', 'Use AKIAIOSFODNN7EXAMPLE for the staging bucket.');
    await plantLocal(root, 'clean', 'Integration tests need docker running before they will start.');

    const r = await migrateMemory(root);
    expect(r.moved.map((m) => m.id)).toEqual(['clean']);
    expect(existsSync(join(trackedMemoryDir(root), 'leaky.md'))).toBe(false);

    const kept = r.kept.find((k) => k.id === 'leaky');
    expect(kept?.keptLocal).toMatch(/AWS access key id/);
    // Refused, NOT destroyed. Losing the fact would be its own kind of damage,
    // and the operator still needs to see it to know the key is in there.
    expect(existsSync(join(localMemoryDir(root), 'leaky.md'))).toBe(true);
  });

  it('never publishes a fact saved with --local-only', async () => {
    /*
     * Found by live-probing the CLI, after every test in this file was green:
     * the dry run cheerfully listed a `--local-only` fact as one it would move
     * into git. The flag said "keep this out of git" and the migration was
     * about to override it — the user would have found out from `git log`.
     *
     * The fix is why `localOnly` is PERSISTED while `area` is derived: intent
     * has to outlive location, or any later move silently revokes it.
     */
    const priv = await saveMemory(root, {
      fact: 'This machine needs the VPN up before the integration suite will pass.',
      localOnly: true,
    });
    await plantLocal(root, 'shareable', 'Integration tests need docker running before they will start.');

    const r = await migrateMemory(root);
    expect(r.moved.map((m) => m.id)).toEqual(['shareable']);
    expect(r.kept.find((k) => k.id === priv.id)?.keptLocal).toMatch(/--local-only/);
    expect(existsSync(join(trackedMemoryDir(root), `${priv.id}.md`))).toBe(false);
    expect(existsSync(join(localMemoryDir(root), `${priv.id}.md`))).toBe(true);
  });

  it('never clobbers a tracked fact that already has the id', async () => {
    await plantLocal(root, 'dupe', 'The local copy, which nobody else has seen.');
    await mkdir(trackedMemoryDir(root), { recursive: true });
    await writeFile(join(trackedMemoryDir(root), 'dupe.md'), [
      '---', 'id: dupe', 'type: reference', 'agent: null', 'author: T', 'task: null',
      'created: 2026-02-01T00:00:00.000Z', 'commit: null', 'files: []',
      'supersedes: null', 'fingerprint: planted', '---', '',
      'The shared copy every clone already has.', '',
    ].join('\n'), 'utf-8');

    const r = await migrateMemory(root);
    expect(r.moved).toEqual([]);
    expect(r.kept.find((k) => k.id === 'dupe')?.keptLocal).toMatch(/already has this id/);
    // Overwriting from one machine would be a silent, unreviewable edit to
    // knowledge every other clone is reading.
    expect(await readFile(join(trackedMemoryDir(root), 'dupe.md'), 'utf-8')).toMatch(/every clone already has/);
  });

  it('is a no-op on a repo with nothing local', async () => {
    await saveMemory(root, { fact: 'Migrations run before the app boots, never after.' });
    const r = await migrateMemory(root);
    expect(r.moved).toEqual([]);
    expect(r.kept).toEqual([]);
  });
});

describe('lifecycle respects the area', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('removing a TRACKED fact takes it out of the working tree', async () => {
    const saved = await saveMemory(root, { fact: 'Deploys run from main every friday at 15:00 UTC.' });
    expect(await removeMemory(root, saved.id)).toBe(true);

    // Once memory is in git, a removal that left the file behind would keep
    // serving the fact to every other clone — removal has to mean removal.
    expect(existsSync(join(trackedMemoryDir(root), `${saved.id}.md`))).toBe(false);
    // Archived under gitignored .baton/, so lineage survives without the
    // retired fact travelling to anyone.
    expect(existsSync(join(archiveDir(root), `${saved.id}.md`))).toBe(true);
    expect((await listMemories(root)).find((f) => f.id === saved.id)).toBeUndefined();
  });

  it('supersede works across areas — a tracked fact can retire a local one', async () => {
    const local = await saveMemory(root, {
      fact: 'Deploys happen from main every friday afternoon.',
      localOnly: true,
    });
    const tracked = await saveMemory(root, {
      fact: 'Deploys happen from main every friday at 15:00 UTC, never on holidays.',
    });
    expect(tracked.supersedes).toBe(local.id);
    expect(existsSync(join(localMemoryDir(root), `${local.id}.md`))).toBe(false);
    expect(existsSync(join(archiveDir(root), `${local.id}.md`))).toBe(true);
  });
});
