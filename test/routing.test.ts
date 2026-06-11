import { describe, expect, it } from 'vitest';
import { BUILTIN_ROUTING, suggestAgent, validateRoutingConfig } from '../src/routing.js';

describe('suggestAgent', () => {
  it('routes bug fixes to codex', () => {
    const s = suggestAgent('fix the crash on login', BUILTIN_ROUTING);
    expect(s.agent).toBe('codex');
    expect(s.matched).toEqual(expect.arrayContaining(['fix', 'crash']));
    expect(s.source).toBe('rule');
  });

  it('routes UI work to gemini', () => {
    const s = suggestAgent('redesign the settings page component', BUILTIN_ROUTING);
    expect(s.agent).toBe('gemini');
  });

  it('routes planning to claude with opus model', () => {
    const s = suggestAgent('plan the architecture for payments', BUILTIN_ROUTING);
    expect(s.agent).toBe('claude');
    expect(s.model).toBe('opus');
  });

  it('uses word boundaries — "ui" must not match inside "build"', () => {
    const s = suggestAgent('build the release artifacts', BUILTIN_ROUTING);
    expect(s.agent).toBe(BUILTIN_ROUTING.default);
    expect(s.source).toBe('default');
  });

  it('most distinct keyword hits wins', () => {
    const config = {
      rules: [
        { match: ['alpha'], agent: 'cursor' },
        { match: ['beta', 'gamma'], agent: 'codex' },
      ],
      default: 'claude',
    };
    expect(suggestAgent('alpha beta gamma', config).agent).toBe('codex');
  });

  it('ties go to the first rule', () => {
    const config = {
      rules: [
        { match: ['alpha'], agent: 'cursor' },
        { match: ['beta'], agent: 'codex' },
      ],
      default: 'claude',
    };
    expect(suggestAgent('alpha beta', config).agent).toBe('cursor');
  });

  it('zero hits falls back to default', () => {
    const s = suggestAgent('completely unrelated text', BUILTIN_ROUTING);
    expect(s.agent).toBe('cursor');
    expect(s.rule).toBeNull();
  });

  it('matching is case-insensitive', () => {
    expect(suggestAgent('Fix the BUG', BUILTIN_ROUTING).agent).toBe('codex');
  });
});

describe('validateRoutingConfig', () => {
  it('accepts a valid config', () => {
    const { config, errors } = validateRoutingConfig({
      routing: { rules: [{ match: ['x'], agent: 'codex' }], default: 'claude' },
    });
    expect(errors).toEqual([]);
    expect(config?.rules).toHaveLength(1);
  });

  it('rejects missing routing key', () => {
    const { config, errors } = validateRoutingConfig({});
    expect(config).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('collects rule errors but keeps valid rules', () => {
    const { config, errors } = validateRoutingConfig({
      routing: {
        rules: [{ match: [], agent: 'codex' }, { match: ['ok'], agent: 'gemini' }],
        default: 'claude',
      },
    });
    expect(config?.rules).toHaveLength(1);
    expect(errors.some((e) => e.includes('rule 1'))).toBe(true);
  });

  it('warns on unknown agents without rejecting', () => {
    const { config, errors } = validateRoutingConfig({
      routing: { rules: [{ match: ['x'], agent: 'mystery-agent' }], default: 'claude' },
    });
    expect(config?.rules).toHaveLength(1);
    expect(errors.some((e) => e.includes('mystery-agent'))).toBe(true);
  });

  it('requires a default agent', () => {
    const { config } = validateRoutingConfig({ routing: { rules: [{ match: ['x'], agent: 'codex' }] } });
    expect(config).toBeNull();
  });

  it('lowercases keywords', () => {
    const { config } = validateRoutingConfig({
      routing: { rules: [{ match: ['UI'], agent: 'gemini' }], default: 'claude' },
    });
    expect(config?.rules[0].match).toEqual(['ui']);
  });
});
