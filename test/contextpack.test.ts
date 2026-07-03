import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  estTokens, extractOverview, extractConventionBullets, redactSecrets, chatbotFits,
  buildContextPack, UnknownProjectError,
} from '../src/kb/contextpack.js';
import type { KbState } from '../src/kb/state.js';

describe('estTokens', () => {
  it('is chars/4 rounded', () => {
    expect(estTokens('abcd')).toBe(1);
    expect(estTokens('abcdef')).toBe(2); // 6/4 = 1.5 → 2
    expect(estTokens('')).toBe(0);
  });
});

describe('extractOverview', () => {
  const README = [
    '<div align="center">',
    '',
    '# 🪄 Baton',
    '',
    '### Plan on your expensive agent.',
    '',
    '**Baton is a local coordination hub** for AI agents.',
    '',
    '![status](https://img.shields.io/badge/status-active-2ea043) ![license](https://img.shields.io/badge/license-MIT-blue)',
    '',
    '</div>',
    '',
    '---',
    '',
    'Developers increasingly run two or three AI coding tools at once.',
    '',
    '```bash',
    'npm install',
    '```',
    '',
    '> One file. No server lock-in.',
    '',
    'Third real paragraph here.',
  ].join('\n');

  it('keeps prose, skips headings/badges/HTML/fences/rules', () => {
    const paras = extractOverview(README, 4);
    expect(paras[0]).toBe('**Baton is a local coordination hub** for AI agents.');
    expect(paras[1]).toBe('Developers increasingly run two or three AI coding tools at once.');
    expect(paras[2]).toBe('One file. No server lock-in.'); // blockquote marker stripped
    expect(paras[3]).toBe('Third real paragraph here.');
    expect(paras.join(' ')).not.toContain('img.shields.io');
    expect(paras.join(' ')).not.toContain('npm install');
  });

  it('caps at maxParagraphs', () => {
    expect(extractOverview(README, 2)).toHaveLength(2);
  });

  it('joins wrapped lines within a paragraph and normalizes CRLF', () => {
    const md = 'First line\r\nsecond line of same paragraph.\r\n\r\nNext.';
    expect(extractOverview(md, 4)[0]).toBe('First line second line of same paragraph.');
  });

  it('returns [] for empty input', () => {
    expect(extractOverview('', 4)).toEqual([]);
  });
});

describe('extractConventionBullets', () => {
  it('takes list items only, capped', () => {
    const md = '# Rules\n\nProse here.\n- rule one\n* rule two\n- rule three\n';
    expect(extractConventionBullets(md, 2)).toEqual(['rule one', 'rule two']);
  });
});

describe('redactSecrets', () => {
  it('redacts AWS keys, PEM headers, assignments, and vendor tokens', () => {
    const input = [
      'key AKIAIOSFODNN7EXAMPLE here',
      '-----BEGIN RSA PRIVATE KEY-----',
      'api_key = "sk_live_abcdef123456789"',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n');
    const { text, redactions } = redactSecrets(input);
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('sk_live_abcdef123456789');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(text).toContain('[REDACTED]');
    expect(redactions).toBeGreaterThanOrEqual(4);
  });

  it('leaves normal pack prose alone', () => {
    const prose = '_~2,100 tokens (approximate, chars/4). Pastes into: ChatGPT free._\n- `npm run build` → `tsc`';
    const { text, redactions } = redactSecrets(prose);
    expect(text).toBe(prose);
    expect(redactions).toBe(0);
  });
});

describe('chatbotFits', () => {
  it('applies 8k/32k/128k thresholds inclusively', () => {
    const at8k = chatbotFits(8000);
    expect(at8k).toEqual([
      { id: 'chatgpt-free', label: 'ChatGPT free', limit: 8000, ok: true },
      { id: 'grok-free', label: 'Grok free', limit: 32000, ok: true },
      { id: 'deepseek', label: 'DeepSeek', limit: 128000, ok: true },
    ]);
    const over = chatbotFits(8001);
    expect(over[0].ok).toBe(false);
    expect(over[1].ok).toBe(true);
    expect(chatbotFits(200000).every((f) => !f.ok)).toBe(true);
  });
});

describe('buildContextPack', () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true });
  });

  async function makeProject(name: string, opts: { readme?: string; graph?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `ctx-${name}-`));
    tmps.push(dir);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, scripts: { build: 'tsc' }, dependencies: { react: '^18' } }));
    if (opts.readme !== undefined) await writeFile(join(dir, 'README.md'), opts.readme);
    if (opts.graph) {
      await mkdir(join(dir, 'graphify-out'), { recursive: true });
      await writeFile(join(dir, 'graphify-out', 'graph.json'), JSON.stringify({
        nodes: [
          { id: 'a', label: 'createThing', file_type: 'function', source_file: 'src/index.ts', source_location: 'L1' },
          { id: 'b', label: 'helper', file_type: 'function', source_file: 'src/index.ts' },
        ],
        links: [{ source: 'a', target: 'b' }],
      }));
    }
    return dir;
  }

  const FIXED = { generatedAt: '2026-07-04' };

  it('renders a single project with no KB state (synthetic project)', async () => {
    const dir = await makeProject('solo', { readme: 'Solo is a test project that does things.\n' });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.markdown).toContain('Full source code is NOT included');
    expect(pack.markdown).toContain('Solo is a test project that does things.');
    expect(pack.markdown).toContain('## Folder structure');
    expect(pack.markdown).toContain('index.ts');
    expect(pack.markdown).toContain('**Stack:** node · react');
    expect(pack.markdown).toContain('knowledge graph not built'); // no graph fixture
    expect(pack.markdown).toContain('Pastes into:');
    expect(pack.tokens).toBeGreaterThan(0);
    expect(pack.fits).toHaveLength(3);
    expect(pack.redactions).toBe(0);
  });

  it('is byte-deterministic for fixed generatedAt', async () => {
    const dir = await makeProject('det', { readme: 'Deterministic project.\n' });
    const a = await buildContextPack(dir, null, FIXED);
    const b = await buildContextPack(dir, null, FIXED);
    expect(a.markdown).toBe(b.markdown);
  });

  it('includes key symbols when the graph exists', async () => {
    const dir = await makeProject('graphed', { readme: 'Has a graph.\n', graph: true });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('Key code symbols');
    expect(pack.markdown).toContain('`createThing` — src/index.ts:1');
  });

  it('falls back gracefully with no README', async () => {
    const dir = await makeProject('bare');
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('No README found');
  });

  it('throws UnknownProjectError listing valid ids', async () => {
    const dir = await makeProject('known', { readme: 'x\n' });
    const state: KbState = {
      root: dir, mergedGraphPath: null, lastBuiltAt: null,
      projects: [{ id: 'known', name: 'known', path: dir, graphPath: join(dir, 'graphify-out', 'graph.json') }],
    };
    await expect(buildContextPack(dir, state, { ...FIXED, project: 'nope' }))
      .rejects.toThrowError(UnknownProjectError);
    await expect(buildContextPack(dir, state, { ...FIXED, project: 'nope' }))
      .rejects.toThrowError(/known/);
  });

  it('renders hub mode: relate list + per-project sections; skips missing paths', async () => {
    const a = await makeProject('alpha', { readme: 'Alpha does A.\n' });
    const b = await makeProject('beta', { readme: 'Beta does B.\n' });
    const hub = await mkdtemp(join(tmpdir(), 'ctx-hub-'));
    tmps.push(hub);
    const state: KbState = {
      root: hub, mergedGraphPath: null, lastBuiltAt: null,
      projects: [
        { id: 'alpha', name: 'alpha', path: a, graphPath: join(a, 'graphify-out', 'graph.json') },
        { id: 'beta', name: 'beta', path: b, graphPath: join(b, 'graphify-out', 'graph.json') },
        { id: 'ghost', name: 'ghost', path: join(hub, 'gone'), graphPath: join(hub, 'gone', 'g.json') },
      ],
    };
    const pack = await buildContextPack(hub, state, FIXED);
    expect(pack.markdown).toContain('## How the repos relate');
    expect(pack.markdown).toContain('## alpha');
    expect(pack.markdown).toContain('## beta');
    expect(pack.markdown).toContain('Alpha does A.');
    expect(pack.markdown).toContain("skipped — path not found");
    expect(pack.omitted).toContain('ghost: path missing');
  });

  it('trims to the budget and records omissions', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with quite a few words in it to inflate the pack size for the trim test.`).join('\n\n');
    const dir = await makeProject('big', { readme: long, graph: true });
    const pack = await buildContextPack(dir, null, { ...FIXED, maxTokens: 100 });
    expect(pack.omitted.length).toBeGreaterThan(0);
    expect(pack.markdown).toContain('omitted to fit the token budget');
    // header + footer are never trimmed
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.markdown).toContain('Pastes into:');
  });

  it('redacts secrets found in the README and prepends a banner', async () => {
    const dir = await makeProject('leaky', { readme: 'Deploy with api_key = "sk_live_abcdef123456789" set.\n' });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.redactions).toBeGreaterThanOrEqual(1);
    expect(pack.markdown).not.toContain('sk_live_abcdef123456789');
    expect(pack.markdown.startsWith('> ⚠️')).toBe(true);
  });
});
