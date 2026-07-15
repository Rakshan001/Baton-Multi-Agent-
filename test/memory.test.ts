import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  detectSecret, factSimilarity, fingerprintOf, listMemories, memoryBriefSection, parseFactFile,
  recallMemories, renderFactFile, saveMemory, scoreMemory, slugifyId,
  deriveProject, factsToPrune,
  MemoryValidationError, type MemoryFact, type MemoryStatus,
} from '../src/memory.js';

describe('deriveProject (per-server scoping)', () => {
  const projects = [{ id: 'api', rel: 'fatfox-api-server' }, { id: 'web', rel: 'fatfox-website' }];
  it('maps a fact to the project owning all its files', () => {
    expect(deriveProject(['fatfox-api-server/src/x.ts'], projects)).toBe('api');
  });
  it('is unscoped when files span projects or fall outside', () => {
    expect(deriveProject(['fatfox-api-server/a.ts', 'fatfox-website/b.ts'], projects)).toBeNull();
    expect(deriveProject(['shared/c.ts'], projects)).toBeNull();
    expect(deriveProject([], projects)).toBeNull();
  });
  it('is unscoped when there are no real sub-projects (single repo)', () => {
    expect(deriveProject(['src/x.ts'], [{ id: 'root', rel: '.' }])).toBeNull();
  });
});

describe('factsToPrune (retention policy)', () => {
  const NOW = Date.parse('2026-06-17T00:00:00Z');
  const mk = (id: string, days: number, freshness: MemoryStatus['freshness']): MemoryStatus => ({
    id, type: 'reference', fact: id, agent: null, task: null,
    createdAt: new Date(NOW - days * 86_400_000).toISOString(),
    anchors: { commit: null, files: [] }, supersedes: null, fingerprint: id,
    freshness, staleReason: null, commitsBehind: null, project: null,
  });
  const facts = [mk('old-fresh', 40, 'fresh'), mk('new-fresh', 1, 'fresh'), mk('aging', 5, 'aging'), mk('stale', 2, 'stale')];

  it('prunes by max age', () => {
    expect(factsToPrune(facts, { maxAgeDays: 30 }, NOW)).toEqual(['old-fresh']);
  });
  it('prunes stale and/or aging when asked', () => {
    expect(factsToPrune(facts, { dropStale: true }, NOW)).toEqual(['stale']);
    expect(factsToPrune(facts, { dropAging: true, dropStale: true }, NOW).sort()).toEqual(['aging', 'stale']);
  });
  it('removes nothing for an empty policy', () => {
    expect(factsToPrune(facts, {}, NOW)).toEqual([]);
  });
});

describe('fingerprintOf / slugifyId', () => {
  it('same opening words → same fingerprint (supersede trigger)', () => {
    expect(fingerprintOf('The daemon must stay zero-dependency always'))
      .toBe(fingerprintOf('The daemon must stay zero-dependency, per convention!'));
  });

  it('different facts → different fingerprints', () => {
    expect(fingerprintOf('Use SSE for realtime events')).not.toBe(fingerprintOf('Demo mode defaults on in dev'));
  });

  it('slugifyId is filename-safe', () => {
    expect(slugifyId('Crazy: chars / here!')).toMatch(/^mem-[a-z0-9-]+$/);
  });
});

describe('factSimilarity', () => {
  it('is high for an updated version of the same fact, low for distinct facts', () => {
    const update = factSimilarity('Deploys happen from main every friday afternoon.', 'Deploys happen from main every friday at 15:00 UTC, never on holidays.');
    const distinct = factSimilarity('The authentication middleware validates the JWT signature using RS256 public keys.', 'The authentication middleware validates the JWT expiry and audience claims separately.');
    expect(update).toBeGreaterThanOrEqual(0.5);
    expect(distinct).toBeLessThan(0.5);
  });
  it('is 0 when either side has no significant words', () => {
    expect(factSimilarity('', 'anything here')).toBe(0);
  });
});

describe('detectSecret', () => {
  it('rejects obvious credentials', () => {
    expect(detectSecret('key is AKIAIOSFODNN7EXAMPLE ok')).toBeTruthy();
    expect(detectSecret('token: sk-abcdefghijklmnopqrstuvwx')).toBeTruthy();
    expect(detectSecret('-----BEGIN RSA PRIVATE KEY-----')).toBeTruthy();
    expect(detectSecret(`password = "hunter2hunter2"`)).toBeTruthy();
  });

  it('allows normal engineering facts', () => {
    expect(detectSecret('The auth middleware lives in src/auth.ts and reads JWT_SECRET from env')).toBeNull();
    expect(detectSecret('Merge with --no-squash keeps history')).toBeNull();
  });
});

describe('fact file round-trip', () => {
  const fact: MemoryFact = {
    id: 'mem-test-fact',
    type: 'gotcha',
    fact: 'The SSE ring buffer holds only 200 events; terminal output is excluded.',
    agent: 'claude',
    task: 'some-task',
    createdAt: '2026-06-12T00:00:00.000Z',
    anchors: { commit: 'abc123', files: [{ path: 'src/events.ts', hash: 'deadbeef0000' }] },
    supersedes: null,
    fingerprint: fingerprintOf('The SSE ring buffer holds only 200 events; terminal output is excluded.'),
  };

  it('render → parse preserves everything', () => {
    const parsed = parseFactFile(renderFactFile(fact));
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(fact.id);
    expect(parsed!.type).toBe('gotcha');
    expect(parsed!.fact).toBe(fact.fact);
    expect(parsed!.anchors.commit).toBe('abc123');
    expect(parsed!.anchors.files).toEqual([{ path: 'src/events.ts', hash: 'deadbeef0000' }]);
  });

  it('parse rejects garbage', () => {
    expect(parseFactFile('not a fact file')).toBeNull();
  });
});

describe('scoreMemory', () => {
  const fact: MemoryFact = {
    id: 'mem-x', type: 'convention', agent: null, task: 'fix-auth-flow',
    fact: 'All git calls go through util/exec.ts — shell-free, hardened.',
    createdAt: '2026-06-12T00:00:00.000Z',
    anchors: { commit: null, files: [{ path: 'src/util/exec.ts', hash: 'aa' }] },
    supersedes: null, fingerprint: 'x',
  };

  it('matches topic words against fact text, task, and anchored paths', () => {
    expect(scoreMemory(fact, 'how do git calls work')).toBeGreaterThan(0);
    expect(scoreMemory(fact, 'auth flow')).toBeGreaterThan(0); // task slug hit
    expect(scoreMemory(fact, 'css styling colors')).toBe(0);
  });
});

describe('memory store (real temp git repo)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-mem-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, 'a.txt'), 'original\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves a fact with commit + file anchors and recalls it fresh', async () => {
    const saved = await saveMemory(root, {
      fact: 'a.txt holds the canonical greeting; change it only via the release script.',
      type: 'convention',
      files: ['a.txt'],
      agent: 'claude',
    });
    expect(saved.id).toMatch(/^mem-/);
    expect(saved.anchors.files[0].hash).not.toBe('');

    const all = await listMemories(root);
    expect(all).toHaveLength(1);
    expect(all[0].freshness).toBe('fresh');

    const recalled = await recallMemories(root, { topic: 'greeting release' });
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.staleDropped).toBe(0);
  });

  it('flags the fact stale when its anchored file changes, and recall withholds it', async () => {
    await writeFile(join(root, 'a.txt'), 'changed!\n');
    const all = await listMemories(root);
    expect(all[0].freshness).toBe('stale');
    expect(all[0].staleReason).toContain('a.txt changed');

    const recalled = await recallMemories(root, {});
    expect(recalled.facts).toHaveLength(0);
    expect(recalled.staleDropped).toBe(1);
  });

  // ISS-04: a withheld stale fact must arrive as a re-grounding POINTER (what it
  // was, when it was true, what to re-check) — not just as a bare count, which
  // reads as a gap and invites a confident wrong re-derivation.
  it('surfaces withheld stale facts as re-grounding pointers (not just a count)', async () => {
    const recalled = await recallMemories(root, {}); // a.txt is changed → 1 stale
    expect(recalled.staleDropped).toBe(1); // count still there (back-compat)
    expect(recalled.staleGrounding).toHaveLength(1);
    const p = recalled.staleGrounding[0];
    expect(p.was).toContain('canonical greeting'); // what it claimed
    expect(p.verify).toContain('a.txt');           // the file to re-check
    expect(p.reason).toContain('a.txt changed');   // why it went stale
    expect(p.trueAsOf).toMatch(/^[0-9a-f]{7,}$/);  // short commit it was true at
    expect(p.id).toMatch(/^mem-/);
  });

  it('scopes re-grounding pointers to the topic when one is given', async () => {
    // The stale fact is about the greeting; an unrelated topic should not ground it.
    expect((await recallMemories(root, { topic: 'greeting release' })).staleGrounding).toHaveLength(1);
    expect((await recallMemories(root, { topic: 'kubernetes deployment yaml' })).staleGrounding).toHaveLength(0);
  });

  it('same-fingerprint save supersedes the old fact', async () => {
    const first = await saveMemory(root, { fact: 'Deploys happen from main every friday afternoon.' });
    const second = await saveMemory(root, { fact: 'Deploys happen from main every friday at 15:00 UTC, never on holidays.' });
    expect(second.supersedes).toBe(first.id);
    const all = await listMemories(root);
    expect(all.find((f) => f.id === first.id)).toBeUndefined();
    expect(all.find((f) => f.id === second.id)).toBeDefined();
  });

  it('does NOT supersede two distinct facts that merely share their opening words', async () => {
    // Same first-6-word fingerprint, but different knowledge — both must survive.
    const a = await saveMemory(root, { fact: 'The authentication middleware validates the JWT signature using RS256 public keys.' });
    const b = await saveMemory(root, { fact: 'The authentication middleware validates the JWT expiry and audience claims separately.' });
    expect(a.fingerprint).toBe(b.fingerprint); // collision on opening words
    expect(b.supersedes).toBeNull();            // but not treated as an update
    const all = await listMemories(root);
    expect(all.find((f) => f.id === a.id)).toBeDefined();
    expect(all.find((f) => f.id === b.id)).toBeDefined();
  });

  it('rejects secrets and too-short facts', async () => {
    await expect(saveMemory(root, { fact: 'too short' })).rejects.toThrow(MemoryValidationError);
    await expect(saveMemory(root, { fact: 'The deploy key is ghp_abcdefghijklmnopqrstuvwxyz012345 for CI.' }))
      .rejects.toThrow(/refusing to store/);
  });

  it('ignores absolute and traversal file anchors', async () => {
    const saved = await saveMemory(root, {
      fact: 'Anchors must stay inside the repository for the staleness check to mean anything.',
      files: ['/etc/passwd', '../outside.txt', 'a.txt'],
    });
    expect(saved.anchors.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('resolves the MAIN repo store even when called with a worktree path', async () => {
    // Reproduces the `baton pass`-from-Stop-hook scenario: cwd is the worktree.
    const wt = join(root, '.baton', 'wt', 'task-x');
    await execa('git', ['worktree', 'add', '-b', 'baton/task-x', wt], { cwd: root });

    const saved = await saveMemory(wt, { fact: 'Saved from inside a worktree; must land in the shared main-repo store.' });
    expect(saved.id).toMatch(/^mem-/);

    // Visible from the main root AND from the worktree — one shared store.
    const fromMain = await listMemories(root);
    const fromWt = await listMemories(wt);
    expect(fromMain.some((f) => f.id === saved.id)).toBe(true);
    expect(fromWt.some((f) => f.id === saved.id)).toBe(true);

    // And nothing was written into a per-worktree shadow store.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(wt, '.baton', 'memory'))).toBe(false);
  });
});

describe('memoryBriefSection', () => {
  it('renders a compact, token-cheap block and notes withheld stale facts', () => {
    const section = memoryBriefSection([
      {
        id: 'mem-a', type: 'gotcha', fact: 'Line one.\nLine two ignored in brief.', agent: null, task: null,
        createdAt: '', anchors: { commit: null, files: [] }, supersedes: null, fingerprint: 'a',
        freshness: 'aging', staleReason: null, commitsBehind: 3,
      },
    ], 2);
    expect(section).toContain('## Project memory');
    expect(section).toContain('[gotcha] Line one. (3 commits old)');
    expect(section).not.toContain('Line two');
    expect(section).toContain('2 stale memories were withheld');
  });

  it('returns empty when there is nothing fresh to say', () => {
    expect(memoryBriefSection([], 0)).toBe('');
  });

  // ISS-04: when grounding pointers are supplied, the brief shows re-grounding
  // lines (what/when/verify) capped for budget, not a bare withheld count.
  it('renders capped re-grounding pointers when grounding is provided', () => {
    const section = memoryBriefSection([], 3, [
      { id: 'mem-x', was: 'Daemon stays zero-dependency', trueAsOf: 'aed3292', verify: ['src/server.ts'], reason: 'src/server.ts changed' },
      { id: 'mem-y', was: 'Realtime is SSE not socket.io', trueAsOf: 'ee02853', verify: ['src/events.ts'], reason: 'src/events.ts changed' },
      { id: 'mem-z', was: 'should be capped out', trueAsOf: null, verify: ['x.ts'], reason: 'x.ts changed' },
    ]);
    expect(section).toContain('re-ground before trusting');
    expect(section).toContain('was true @ aed3292: Daemon stays zero-dependency');
    expect(section).toContain('verify `src/server.ts`');
    expect(section).toContain('+1 more withheld'); // 3 total − 2 shown
    expect(section).not.toContain('should be capped out'); // beyond BRIEF cap of 2
  });
});
