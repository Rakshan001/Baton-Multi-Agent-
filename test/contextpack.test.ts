import { describe, it, expect } from 'vitest';
import {
  estTokens, extractOverview, extractConventionBullets, redactSecrets, chatbotFits,
} from '../src/kb/contextpack.js';

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
