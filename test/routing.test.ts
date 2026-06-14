import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROUTING, BUILTIN_TIERS, resolveChain, scoreSeverity, severityToTier,
  suggestAgent, suggestRoute, validateRoutingConfig, type RoutingConfig,
} from '../src/routing.js';

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

describe('scoreSeverity', () => {
  it('scores heavy work above the standard threshold', () => {
    const { score, signals } = scoreSeverity('refactor the authentication architecture for scalability');
    expect(score).toBeGreaterThanOrEqual(75);
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });

  it('scores trivial work low', () => {
    const { score } = scoreSeverity('fix typo');
    expect(score).toBeLessThan(45);
  });

  it('neutral text stays mid-range', () => {
    const { score } = scoreSeverity('add a created-at column to the export csv output');
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThan(75);
  });

  it('is clamped to 0..100', () => {
    expect(scoreSeverity('typo rename comment bump minor').score).toBeGreaterThanOrEqual(0);
    expect(scoreSeverity('architecture refactor migration security redesign rewrite '.repeat(10)).score).toBeLessThanOrEqual(100);
  });
});

describe('severityToTier', () => {
  it('maps thresholds onto tiers', () => {
    expect(severityToTier(90, BUILTIN_TIERS)).toBe('heavy');
    expect(severityToTier(60, BUILTIN_TIERS)).toBe('standard');
    expect(severityToTier(30, BUILTIN_TIERS)).toBe('light');
    expect(severityToTier(10, BUILTIN_TIERS)).toBe('local');
  });

  it('falls through to the nearest defined tier', () => {
    expect(severityToTier(10, { light: [{ agent: 'codex' }] })).toBe('light');
    expect(severityToTier(90, { light: [{ agent: 'codex' }] })).toBe('light');
  });
});

describe('suggestRoute', () => {
  it('rule hits still win over severity', () => {
    const s = suggestRoute('fix the crash on login', BUILTIN_ROUTING);
    expect(s.source).toBe('rule');
    expect(s.agent).toBe('codex');
    expect(s.severity).toBeGreaterThanOrEqual(0);
  });

  it('no rule hit → severity picks a tier with a fallback chain', () => {
    const s = suggestRoute('refactor the storage engine for concurrency and performance', BUILTIN_ROUTING);
    expect(s.source).toBe('severity');
    expect(s.tier).toBe('heavy');
    expect(s.agent).toBe('claude');
    expect(s.model).toBe('opus');
  });

  it('trivial text routes to the local tier', () => {
    const s = suggestRoute('typo rename', BUILTIN_ROUTING);
    expect(s.source).toBe('severity');
    expect(s.tier).toBe('local');
    expect(s.chain.length).toBeGreaterThan(1);
  });

  it('single mode sends everything to one agent', () => {
    const config: RoutingConfig = { ...BUILTIN_ROUTING, mode: 'single', single: { agent: 'claude', model: 'opus' } };
    const s = suggestRoute('fix typo', config);
    expect(s.source).toBe('single');
    expect(s.agent).toBe('claude');
    expect(s.model).toBe('opus');
    expect(s.confidence).toBe('high');
  });

  it('manual mode skips severity routing and uses the default', () => {
    const s = suggestRoute('completely unrelated text', { ...BUILTIN_ROUTING, mode: 'manual' });
    expect(s.mode).toBe('manual');
    expect(s.source).toBe('default');
  });

  it('tier-targeted rules return the tier chain', () => {
    const config: RoutingConfig = {
      rules: [{ match: ['deploy'], tier: 'light' }],
      default: 'standard',
      tiers: BUILTIN_TIERS,
    };
    const s = suggestRoute('deploy the service', config);
    expect(s.source).toBe('rule');
    expect(s.tier).toBe('light');
    expect(s.chain).toEqual(BUILTIN_TIERS.light);
  });

  it("a rule's explicit model applies to every fallback in the chain, not just the first", () => {
    const config: RoutingConfig = {
      rules: [{ match: ['deploy'], tier: 'local', model: 'ollama/qwen2.5-coder' }],
      default: 'standard',
      tiers: BUILTIN_TIERS,
    };
    const s = suggestRoute('deploy the service', config);
    expect(s.chain.length).toBeGreaterThan(1);
    expect(s.chain.every((e) => e.model === 'ollama/qwen2.5-coder')).toBe(true);
  });

  it('does not alias the config tier arrays (returns a fresh chain)', () => {
    const tiers = { light: [{ agent: 'codex' }, { agent: 'gemini' }] };
    const config: RoutingConfig = { rules: [], default: 'light', mode: 'manual', tiers };
    const s = suggestRoute('whatever', config);
    s.chain.reverse(); // mutating the suggestion must not corrupt the config
    expect(tiers.light[0].agent).toBe('codex');
  });

  it('one keyword hit is low confidence, two is high', () => {
    expect(suggestRoute('fix it', BUILTIN_ROUTING).confidence).toBe('low');
    expect(suggestRoute('fix the crash', BUILTIN_ROUTING).confidence).toBe('high');
  });

  it('default may name a tier', () => {
    const config: RoutingConfig = { rules: [], default: 'light', mode: 'manual', tiers: BUILTIN_TIERS };
    const s = suggestRoute('whatever', config);
    expect(s.tier).toBe('light');
    expect(s.agent).toBe('codex');
  });
});

describe('resolveChain', () => {
  const chain = [{ agent: 'aider', model: 'ollama/q' }, { agent: 'codex' }, { agent: 'gemini' }];

  it('returns the first available agent and lists skipped ones', async () => {
    const r = await resolveChain(chain, async (a) => a === 'codex');
    expect(r?.entry.agent).toBe('codex');
    expect(r?.index).toBe(1);
    expect(r?.skipped).toEqual(['aider']);
  });

  it('returns null when nothing is installed', async () => {
    expect(await resolveChain(chain, async () => false)).toBeNull();
  });

  it("'any' is always available", async () => {
    const r = await resolveChain([{ agent: 'any' }], async () => false);
    expect(r?.entry.agent).toBe('any');
  });
});

describe('validateRoutingConfig v2', () => {
  it('accepts mode, tiers and single', () => {
    const { config, errors } = validateRoutingConfig({
      routing: {
        mode: 'single',
        single: { agent: 'claude', model: 'opus' },
        rules: [{ match: ['x'], agent: 'codex' }],
        default: 'claude',
        tiers: { heavy: [{ agent: 'claude', model: 'opus' }] },
      },
    });
    expect(errors).toEqual([]);
    expect(config?.mode).toBe('single');
    expect(config?.single).toEqual({ agent: 'claude', model: 'opus' });
    expect(config?.tiers?.heavy).toHaveLength(1);
  });

  it('rules may target a tier instead of an agent', () => {
    const { config, errors } = validateRoutingConfig({
      routing: {
        rules: [{ match: ['x'], tier: 'fast' }],
        default: 'claude',
        tiers: { fast: [{ agent: 'codex' }] },
      },
    });
    expect(errors).toEqual([]);
    expect(config?.rules[0].tier).toBe('fast');
  });

  it('rejects a rule whose tier is undefined', () => {
    const { errors } = validateRoutingConfig({
      routing: { rules: [{ match: ['x'], tier: 'nope' }], default: 'claude' },
    });
    expect(errors.some((e) => e.includes('"nope"'))).toBe(true);
  });

  it('single mode without a single target falls back to auto with an error', () => {
    const { config, errors } = validateRoutingConfig({
      routing: { mode: 'single', rules: [{ match: ['x'], agent: 'codex' }], default: 'claude' },
    });
    expect(config?.mode).toBe('auto');
    expect(errors.some((e) => e.includes('routing.single'))).toBe(true);
  });

  it('single mode does NOT require a default — it falls back to the single agent', () => {
    const { config, errors } = validateRoutingConfig({
      routing: { mode: 'single', single: { agent: 'claude', model: 'opus' } },
    });
    expect(errors).toEqual([]);
    expect(config?.mode).toBe('single');
    expect(config?.default).toBe('claude'); // synthesized from single.agent
  });

  it('invalid mode falls back to auto with an error', () => {
    const { config, errors } = validateRoutingConfig({
      routing: { mode: 'turbo', rules: [{ match: ['x'], agent: 'codex' }], default: 'claude' },
    });
    expect(config?.mode).toBe('auto');
    expect(errors.some((e) => e.includes('routing.mode'))).toBe(true);
  });
});
