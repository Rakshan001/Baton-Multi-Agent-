import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { expandTerms, rankFacts } from '../src/memory-rank.js';
import { saveMemory, recallMemories, type MemoryFact } from '../src/memory.js';

/**
 * M1 — BM25 recall. The old scorer gave +1 per matched topic word, so a rare
 * discriminative term (`csrf`) weighed the same as a common one (`exec`), and
 * "login" could never find a fact that only says "auth". BM25 (FTS5, in-memory,
 * porter-stemmed) + a small synonym map + identifier splitting fix all three at
 * zero token cost and zero new dependencies.
 */

const mk = (id: string, fact: string, opts: Partial<MemoryFact> = {}): MemoryFact => ({
  id,
  type: 'decision',
  fact,
  agent: null,
  task: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  anchors: { commit: null, files: [] },
  supersedes: null,
  fingerprint: 'f',
  ...opts,
});

describe('expandTerms (query expansion — mechanical, no LLM)', () => {
  it('splits camelCase and snake_case query tokens', () => {
    const t = expandTerms('gitRoot resolve_path');
    expect(t).toContain('gitroot');
    expect(t).toContain('git');
    expect(t).toContain('root');
    expect(t).toContain('resolve');
    expect(t).toContain('path');
  });

  it('adds domain synonyms (login → auth)', () => {
    expect(expandTerms('login flow')).toContain('auth');
    expect(expandTerms('database migrations')).toContain('sqlite');
  });

  it('never emits FTS syntax characters', () => {
    for (const t of expandTerms('x" OR NOT (b* AND c)')) {
      expect(t).not.toMatch(/["()*]/);
    }
  });
});

describe('rankFacts (BM25 + recency RRF)', () => {
  it('ranks a rare-term match above common-term matches (IDF weighting)', () => {
    const facts = [
      mk('a', 'The csrf guard rejects cross-origin posts to the daemon.', { createdAt: '2026-01-01T00:00:00.000Z' }),
      mk('b', 'All exec calls are shell-free and hardened for safety.', { createdAt: '2026-03-01T00:00:00.000Z' }),
      mk('c', 'Never exec git directly, use the exec wrapper module.', { createdAt: '2026-03-02T00:00:00.000Z' }),
      mk('d', 'The exec timeout defaults to thirty seconds for long jobs.', { createdAt: '2026-03-03T00:00:00.000Z' }),
    ];
    // Old scorer: a=1, b=1 tie → newest (d) wins. BM25: csrf is rare → a wins.
    const ranked = rankFacts(facts, 'exec csrf handling');
    expect(ranked[0]?.id).toBe('a');
  });

  it('finds an auth fact from a "login" topic (synonym expansion)', () => {
    const facts = [
      mk('auth', 'Token refresh revalidates the auth session on every rotation.'),
      mk('csv', 'CSV export streams rows and never buffers the report.'),
    ];
    const ranked = rankFacts(facts, 'login flow');
    expect(ranked.map((f) => f.id)).toContain('auth');
    expect(ranked.map((f) => f.id)).not.toContain('csv');
  });

  it('matches identifiers across naming styles (topic "git root" ↔ fact "gitRoot()")', () => {
    const facts = [mk('g', 'gitRoot() resolves the main checkout even from a worktree.')];
    expect(rankFacts(facts, 'git root resolution').map((f) => f.id)).toContain('g');
    // And the reverse: an identifier-shaped topic finds prose.
    const prose = [mk('p', 'The git root is resolved through the common dir.')];
    expect(rankFacts(prose, 'gitRoot').map((f) => f.id)).toContain('p');
  });

  it('matches morphological variants via stemming (cache ↔ caching)', () => {
    const facts = [mk('c', 'Response caching keeps the board endpoint cheap.')];
    expect(rankFacts(facts, 'cache behavior').map((f) => f.id)).toContain('c');
  });

  it('breaks equal-relevance ties by recency (RRF)', () => {
    const facts = [
      mk('old', 'The dashboard polls the board endpoint every minute.', { createdAt: '2026-01-01T00:00:00.000Z' }),
      mk('new', 'The dashboard renders the board with live updates.', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(rankFacts(facts, 'dashboard board')[0]?.id).toBe('new');
  });

  it('returns nothing for a topic that matches nothing, and never non-matches', () => {
    const facts = [mk('a', 'The csrf guard rejects cross-origin posts.')];
    expect(rankFacts(facts, 'kubernetes ingress yaml')).toEqual([]);
  });

  it('survives hostile FTS syntax in the topic', () => {
    const facts = [mk('a', 'The csrf guard rejects cross-origin posts.')];
    expect(() => rankFacts(facts, 'csrf" OR NOT (x* AND "y')).not.toThrow();
    expect(rankFacts(facts, 'csrf" OR NOT (x* AND "y').map((f) => f.id)).toContain('a');
  });

  it('matches against anchored file paths, like the old scorer did', () => {
    const facts = [
      mk('f', 'Origin checking gates every mutating endpoint.', {
        anchors: { commit: null, files: [{ path: 'src/server.ts', hash: 'x' }] },
      }),
    ];
    expect(rankFacts(facts, 'server endpoint').map((f) => f.id)).toContain('f');
  });
});

describe('recallMemories uses BM25 ranking (integration)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memrank-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'auth.ts'), 'export const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
    await saveMemory(root, {
      fact: 'Auth tokens rotate on every session refresh to limit replay windows.',
      type: 'gotcha',
      files: ['src/auth.ts'],
    });
    await saveMemory(root, {
      fact: 'CSV export streams rows and never buffers the whole report.',
      type: 'convention',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a "login" topic recalls the auth fact (synonyms reach storage)', async () => {
    const r = await recallMemories(root, { topic: 'login handling' });
    expect(r.facts.some((f) => f.fact.includes('Auth tokens'))).toBe(true);
    expect(r.facts.some((f) => f.fact.includes('CSV'))).toBe(false);
  });
});
