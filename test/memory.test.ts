import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  detectSecret, fingerprintOf, listMemories, memoryBriefSection, parseFactFile,
  recallMemories, renderFactFile, saveMemory, scoreMemory, slugifyId,
  MemoryValidationError, type MemoryFact,
} from '../src/memory.js';

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

  it('same-fingerprint save supersedes the old fact', async () => {
    const first = await saveMemory(root, { fact: 'Deploys happen from main every friday afternoon.' });
    const second = await saveMemory(root, { fact: 'Deploys happen from main every friday at 15:00 UTC, never on holidays.' });
    expect(second.supersedes).toBe(first.id);
    const all = await listMemories(root);
    expect(all.find((f) => f.id === first.id)).toBeUndefined();
    expect(all.find((f) => f.id === second.id)).toBeDefined();
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
});
