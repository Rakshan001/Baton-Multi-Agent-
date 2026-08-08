// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  detectSecret, factSimilarity, fingerprintOf, listMemories, memoryBriefSection, parseFactFile,
  recallMemories, renderFactFile, saveMemory, scoreMemory, slugifyId,
  deriveProject, factsToPrune,
  MemoryValidationError, UndurableFactError, type MemoryFact, type MemoryStatus,
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

  /**
   * The original seven patterns matched exact prefixes and a QUOTED assignment,
   * which between them missed every shape probed here — including the likeliest
   * one, a line pasted straight out of a .env file. Memories are plain files
   * read by every agent, and once the KB is git-tracked a missed key is one
   * that gets pushed, so a leak stops being local.
   */
  it('catches the shapes that actually leak', () => {
    const cases: Array<[string, string]> = [
      ['Stripe secret key', 'the billing key is sk_live_EXAMPLENOTAREALKEY'],
      ['unquoted assignment', 'set DATABASE_PASSWORD=hunter2correcthorse in the env'],
      // `_` is a word char, so \bsecret\b never matched inside AWS_SECRET_ACCESS_KEY.
      ['.env line', 'AWS_SECRET_ACCESS_KEY=EXAMPLE/NOTAREAL/SECRETVALUE'],
      ['database password in a URL', 'connect via postgres://admin:s3cr3tP4ss@db.internal:5432/app'],
      ['mongodb URL', 'mongodb+srv://user:MyP4ssw0rd123@cluster0.mongodb.net'],
      ['Google API key', 'the maps key is AIzaEXAMPLENOTAREALGOOGLEAPIKEYXXX'],
      ['bearer token', 'send Authorization: Bearer EXAMPLENOTAREALBEARERTOKEN'],
      ['npm token', 'npm_EXAMPLENOTAREALNPMTOKENVALUEXX'],
      ['GitHub token', 'ghp_EXAMPLENOTAREALGITHUBTOKENXX'],
    ];
    for (const [name, text] of cases) expect(detectSecret(text), name).toBeTruthy();
  });

  /**
   * False positives cost more than they look: this gate has no override, so a
   * wrongly refused fact is knowledge permanently lost. Every one of these is a
   * thing an engineering memory legitimately says.
   */
  it('stays silent on facts that merely TALK about credentials', () => {
    const fine = [
      'The member token is hashed with scrypt and never logged in full.',
      'Password reset flows live in src/auth/reset.ts and expire after 1 hour.',
      "apiKey: z.string().describe('the caller key')", // code shape, not a value
      'token: string',
      'The API key is stored in 1Password under Engineering, never in the repo.',
      'the base commit was 9f8c2b1a4d6e0f37a5b8c9d0e1f2a3b4c5d6e7f8 on baton/fix.',
      'anchor hash 9f8c2b1a4d6e0f37a5b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0',
      'docs live at https://baton.dev/guide/memory',
      'clone git@github.com:Rakshan001/Baton.git over ssh',
    ];
    for (const text of fine) expect(detectSecret(text), text.slice(0, 40)).toBeNull();
  });
});

describe('fact file round-trip', () => {
  const fact: MemoryFact = {
    id: 'mem-test-fact',
    type: 'gotcha',
    fact: 'The SSE ring buffer holds only 200 events; terminal output is excluded.',
    agent: 'claude',
    author: 'dev@example.com',
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
    expect(parsed!.author).toBe('dev@example.com');
    expect(parsed!.anchors.commit).toBe('abc123');
    expect(parsed!.anchors.files).toEqual([{ path: 'src/events.ts', hash: 'deadbeef0000' }]);
  });

  it('parse rejects garbage', () => {
    expect(parseFactFile('not a fact file')).toBeNull();
  });

  // Facts written before author existed must still load. Reading them as
  // `unknown` is the whole reason there is no migration step.
  it('a fact file with no author field reads as unknown, not undefined', () => {
    const legacy = [
      '---', 'id: legacy-fact', 'type: gotcha', 'agent: claude', 'task: null',
      "created: '2026-01-01T00:00:00.000Z'", 'commit: abc123', 'files: []',
      'supersedes: null', 'fingerprint: legacy', '---', '', 'A fact from before authorship existed.',
    ].join('\n');
    const parsed = parseFactFile(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.author).toBe('unknown');
  });

  // Regression: js-yaml throws on an undefined value (it dumps null fine), so an
  // author that went missing would abort the write and lose the entire fact.
  it('renders even when author is missing at runtime', () => {
    const noAuthor = { ...fact, author: undefined as unknown as string };
    const parsed = parseFactFile(renderFactFile(noAuthor));
    expect(parsed).not.toBeNull();
    expect(parsed!.author).toBe('unknown');
    expect(parsed!.fact).toBe(fact.fact);
  });
});

describe('scoreMemory', () => {
  const fact: MemoryFact = {
    id: 'mem-x', type: 'convention', agent: null, author: 'dev@example.com', task: 'fix-auth-flow',
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

  /*
   * The anti-capture gate (memory-durability.ts) at the write path. Truth is
   * checked on every READ via anchors; this is the question that comes before
   * it — knowledge that was never about the code cannot be policed by hashing
   * the code, so it must not be stored at all.
   */
  describe('anti-capture gate', () => {
    it('refuses a never-durable fact and writes nothing', async () => {
      const before = (await listMemories(root)).length;
      await expect(saveMemory(root, { fact: 'In this session I fixed the guard and pushed the branch.' }))
        .rejects.toThrow(/not durable knowledge \(narrative/);
      expect(await listMemories(root)).toHaveLength(before);
    });

    it('names the phrase and the rewrite, so a rejection is one edit from a save', async () => {
      await expect(saveMemory(root, { fact: 'The playwright MCP server is broken, so skip it entirely.' }))
        .rejects.toThrow(/"is broken".*hardens into a refusal/s);
      // Same knowledge, stated durably — accepted.
      const ok = await saveMemory(root, {
        fact: 'The playwright MCP server fails to attach under a hub root; drive the dashboard with curl instead.',
      });
      expect(ok.id).toMatch(/^mem-/);
    });

    it('EXPLICIT file anchors waive the evidence-backed classes', async () => {
      const saved = await saveMemory(root, {
        fact: 'The a.txt fast path does not work once the file is rewritten by the release script.',
        files: ['a.txt'],
      });
      expect(saved.anchors.files.map((f) => f.path)).toEqual(['a.txt']);
    });

    it('a filename merely MENTIONED does not waive it — only an asserted anchor does', async () => {
      // Anchors derived from the prose (deriveFileAnchors) would find a.txt here,
      // which would make the waiver self-serving: every claim naming any real
      // file would exempt itself. The caller has to vouch for the evidence.
      await expect(saveMemory(root, { fact: 'The a.txt loader is broken and always has been.' }))
        .rejects.toThrow(/not durable knowledge \(tool-disparagement/);
    });

    it('does not waive a session narrative or a self-resolved flake, anchored or not', async () => {
      await expect(saveMemory(root, { fact: 'In this session we rewrote a.txt twice.', files: ['a.txt'] }))
        .rejects.toThrow(/narrative/);
      await expect(saveMemory(root, { fact: 'The a.txt check failed once, then it passed on the second run.', files: ['a.txt'] }))
        .rejects.toThrow(/transient/);
    });

    it('an anchor that does not resolve is not evidence, so it grants no waiver', async () => {
      // A missing file hashes to '' and stays '' forever, so it never trips the
      // staleness check. Honouring it would hand out a waiver that also opts the
      // fact out of the very verification the waiver is justified by — i.e. the
      // gate would be bypassable by naming any path at all.
      await expect(saveMemory(root, {
        fact: 'The uploader is broken and always has been, top to bottom.',
        files: ['does-not-exist.ts'],
      })).rejects.toThrow(/not durable knowledge/);
    });

    it('is a distinct error class, so callers can tell "restate this" from "that had a credential in it"', async () => {
      await expect(saveMemory(root, { fact: 'In this session I rewrote the loader.' }))
        .rejects.toThrow(UndurableFactError);
      // Both are still MemoryValidationError — every existing catch keeps working.
      await expect(saveMemory(root, { fact: 'In this session I rewrote the loader.' }))
        .rejects.toThrow(MemoryValidationError);
      // The credential rejection must NOT be the durable-rewrite class.
      await expect(saveMemory(root, { fact: 'The deploy key is ghp_abcdefghijklmnopqrstuvwxyz012345 for CI.' }))
        .rejects.not.toThrow(UndurableFactError);
    });

    it('reports a secret before durability, so a rejected fact is never echoed back with a token in it', async () => {
      await expect(saveMemory(root, {
        fact: 'In this session the CI token ghp_abcdefghijklmnopqrstuvwxyz012345 stopped working.',
      })).rejects.toThrow(/refusing to store/);
    });
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

// ISS-05: without a running daemon, recall must self-heal — a stale-but-still-
// true fact (its verifiable terms survive the anchored-file change) is re-anchored
// the first time it is recalled, not withheld forever. Debounced so back-to-back
// recalls don't each pay the repair cost.
describe('recall-time opportunistic repair (ISS-05)', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-repair-'));
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, 'config.ts'), 'export const MAX_RETRIES = 3;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('re-anchors a stale-but-still-true fact on recall when no daemon is running', async () => {
    await saveMemory(root, {
      fact: 'The retry ceiling `MAX_RETRIES` lives in `config.ts`; bump it there, not inline.',
      type: 'convention',
      files: ['config.ts'],
    });
    // Edit the anchored file but KEEP every verifiable term (MAX_RETRIES, config.ts):
    // the file hash changes → the fact goes stale, though what it asserts is still true.
    await writeFile(join(root, 'config.ts'), '// tuned for prod\nexport const MAX_RETRIES = 5;\n');
    expect((await listMemories(root))[0].freshness).toBe('stale');

    // First recall with no daemon: the opportunistic repair pass heals it in place.
    const recalled = await recallMemories(root, { topic: 'retry ceiling' });
    expect(recalled.facts).toHaveLength(1);            // served, not withheld
    expect(recalled.facts[0].freshness).toBe('fresh'); // re-anchored
    expect(recalled.staleDropped).toBe(0);
    expect((await listMemories(root))[0].freshness).toBe('fresh'); // persisted to disk
  });

  it('debounces: a fact that goes stale again within the window is NOT re-repaired', async () => {
    // The prior test just ran repair → the debounce marker is fresh. Make the
    // (now fresh) fact go stale again; recall must withhold it, proving the
    // repair pass is gated and not paid on every recall.
    await writeFile(join(root, 'config.ts'), '// unrelated churn\nexport const MAX_RETRIES = 5;\nconst other = 1;\n');
    expect((await listMemories(root))[0].freshness).toBe('stale');

    const recalled = await recallMemories(root, {});
    expect(recalled.facts).toHaveLength(0);        // withheld — repair debounced
    expect(recalled.staleDropped).toBe(1);
    expect(recalled.staleGrounding).toHaveLength(1); // still an ISS-04 pointer, not a silent gap
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
