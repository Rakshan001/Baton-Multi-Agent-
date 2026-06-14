/**
 * Task → agent/model routing: "plan on Claude/Opus, UI work to Gemini, bug
 * fixes to Codex, trivial fixes on a local model" as a committable,
 * team-shared config (baton.config.json at the repo root). Pure keyword +
 * severity scoring — NO LLM call, deterministic, instant, explainable.
 *
 * Three modes (routing.mode):
 *  - "auto"   (default): rules first, then severity → tier when no rule hits.
 *  - "manual": suggestions are advisory only — UIs don't preselect, the CLI
 *              tells you it used the default because you didn't pick.
 *  - "single": everything goes to one agent/model (routing.single), for
 *              people who just use one CLI and want Baton's coordination.
 *
 * Tiers are ordered fallback chains: the first INSTALLED agent in the chain
 * wins (resolveChain), so "Ollama down → next entry" is config, not code.
 *
 * Config shape adapted from claude-code-router (MIT) — task-type → model
 * routing — applied at the agent-handoff level instead of an API proxy.
 * See NOTICE.
 *
 * Keep in lockstep with web/src/lib/routing.ts (routing-parity.test.ts).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_AGENT_IDS } from './agents/registry.js';

export type RoutingMode = 'auto' | 'manual' | 'single';

export interface TierEntry {
  agent: string;
  model?: string;
}

export interface RoutingRule {
  match: string[];
  /** Direct target (legacy style) — or use `tier` to route into a chain. */
  agent?: string;
  tier?: string;
  model?: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  /** Tier name (when tiers exist) or agent id — used when nothing matches. */
  default: string;
  mode?: RoutingMode;
  tiers?: Record<string, TierEntry[]>;
  /** "single" mode target. */
  single?: TierEntry;
}

/** Legacy suggestion shape (suggestAgent) — kept for back-compat. */
export interface RoutingSuggestion {
  agent: string;
  model?: string;
  rule: RoutingRule | null;
  matched: string[];
  source: 'rule' | 'default';
}

/** Rich suggestion (suggestRoute): severity-ranked, tier-aware, explainable. */
export interface RouteSuggestion {
  mode: RoutingMode;
  agent: string;
  model?: string;
  /** Tier the chain came from; null when a rule targeted an agent directly. */
  tier: string | null;
  /** Ordered fallback chain (always ≥ 1 entry; [0] is the recommendation). */
  chain: TierEntry[];
  /** 0–100 task severity estimate (higher = needs a more capable model). */
  severity: number;
  /** Human-readable severity evidence ("+heavy 'architecture'", "long task text"). */
  signals: string[];
  matched: string[];
  rule: RoutingRule | null;
  source: 'single' | 'rule' | 'severity' | 'default';
  confidence: 'high' | 'low';
}

export const CONFIG_FILE = 'baton.config.json';

/** Known agent CLIs (from the registry). Unknown agents warn, not reject. */
const KNOWN_AGENTS = new Set([...KNOWN_AGENT_IDS, 'any']);

/** Tier precedence, highest capability first. */
export const TIER_ORDER = ['heavy', 'standard', 'light', 'local'] as const;

export const BUILTIN_TIERS: Record<string, TierEntry[]> = {
  heavy: [{ agent: 'claude', model: 'opus' }],
  standard: [{ agent: 'cursor' }, { agent: 'claude', model: 'sonnet' }],
  light: [{ agent: 'codex' }, { agent: 'gemini' }],
  local: [{ agent: 'aider', model: 'ollama/qwen2.5-coder' }, { agent: 'opencode' }],
};

export const BUILTIN_ROUTING: RoutingConfig = {
  rules: [
    { match: ['plan', 'planning', 'architecture', 'design doc', 'research', 'investigate'], agent: 'claude', model: 'opus' },
    { match: ['ui', 'frontend', 'css', 'design', 'page', 'component', 'layout', 'responsive'], agent: 'gemini' },
    { match: ['bug', 'fix', 'error', 'crash', 'broken', 'regression', 'failing'], agent: 'codex' },
  ],
  default: 'cursor',
  mode: 'auto',
  tiers: BUILTIN_TIERS,
};

/* ------------------------------------------------------------------ */
/* Severity: 0–100, deterministic, every point traceable to a signal   */
/* ------------------------------------------------------------------ */

/** Prefix-matched (word-start) hints that a task needs a capable model. */
const HEAVY_HINTS = [
  'architect', 'refactor', 'migrat', 'redesign', 'rewrite', 'security',
  'concurren', 'race', 'deadlock', 'performance', 'scalab', 'plan',
  'research', 'investigat', 'overhaul', 'breaking', 'protocol', 'algorithm',
];

/** Hints that a task is trivial. */
const LIGHT_HINTS = [
  'typo', 'rename', 'comment', 'bump', 'minor', 'small', 'quick', 'tweak',
  'padding', 'lint', 'format', 'docstring', 'readme', 'label', 'wording',
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hintHit = (text: string, hint: string) => new RegExp(`\\b${escapeRegExp(hint)}`, 'i').test(text);

export interface SeverityResult {
  score: number;
  signals: string[];
}

/** Estimate how demanding a task is. Pure — same logic in the web mirror. */
export function scoreSeverity(taskText: string): SeverityResult {
  let score = 50;
  const signals: string[] = [];
  let up = 0;
  for (const h of HEAVY_HINTS) {
    if (hintHit(taskText, h) && up < 36) {
      up += 12;
      signals.push(`+ heavy work: '${h}'`);
    }
  }
  let down = 0;
  for (const h of LIGHT_HINTS) {
    if (hintHit(taskText, h) && down < 36) {
      down += 12;
      signals.push(`- trivial: '${h}'`);
    }
  }
  score += up - down;
  if (taskText.length > 400) {
    score += 15;
    signals.push('+ very detailed description');
  } else if (taskText.length > 200) {
    score += 10;
    signals.push('+ detailed description');
  } else if (taskText.length < 40) {
    score -= 10;
    signals.push('- short description');
  }
  return { score: Math.max(0, Math.min(100, score)), signals };
}

/** Map a severity score onto the highest-priority tier the config defines. */
export function severityToTier(score: number, tiers: Record<string, TierEntry[]>): string | null {
  const want = score >= 75 ? 'heavy' : score >= 45 ? 'standard' : score >= 25 ? 'light' : 'local';
  // Fall through to the nearest defined tier (e.g. no "local" → use "light").
  const start = TIER_ORDER.indexOf(want);
  for (let i = start; i < TIER_ORDER.length; i++) {
    if (tiers[TIER_ORDER[i]]?.length) return TIER_ORDER[i];
  }
  for (let i = start - 1; i >= 0; i--) {
    if (tiers[TIER_ORDER[i]]?.length) return TIER_ORDER[i];
  }
  const any = Object.keys(tiers).find((t) => tiers[t]?.length);
  return any ?? null;
}

/* ------------------------------------------------------------------ */
/* Config validation                                                   */
/* ------------------------------------------------------------------ */

export function validateRoutingConfig(raw: unknown): { config: RoutingConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { config: null, errors: ['config is not an object'] };
  const routing = (raw as { routing?: unknown }).routing;
  if (routing === undefined) return { config: null, errors: ['no "routing" key in baton.config.json'] };
  if (typeof routing !== 'object' || routing === null) return { config: null, errors: ['"routing" is not an object'] };

  const r = routing as { rules?: unknown; default?: unknown; mode?: unknown; tiers?: unknown; single?: unknown };

  // mode
  let mode: RoutingMode = 'auto';
  if (r.mode !== undefined) {
    if (r.mode === 'auto' || r.mode === 'manual' || r.mode === 'single') mode = r.mode;
    else errors.push(`"routing.mode" must be auto | manual | single (got ${JSON.stringify(r.mode)}) — using auto`);
  }

  // tiers
  let tiers: Record<string, TierEntry[]> | undefined;
  if (r.tiers !== undefined) {
    if (typeof r.tiers !== 'object' || r.tiers === null || Array.isArray(r.tiers)) {
      errors.push('"routing.tiers" must be an object of tier name → [{agent, model?}...]');
    } else {
      tiers = {};
      for (const [name, chain] of Object.entries(r.tiers as Record<string, unknown>)) {
        if (!Array.isArray(chain) || !chain.length) {
          errors.push(`tier "${name}": must be a non-empty array of {agent, model?}`);
          continue;
        }
        const entries: TierEntry[] = [];
        chain.forEach((e: unknown, i: number) => {
          if (typeof e !== 'object' || e === null) return void errors.push(`tier "${name}" entry ${i + 1}: not an object`);
          const o = e as { agent?: unknown; model?: unknown };
          if (typeof o.agent !== 'string' || !o.agent.trim()) return void errors.push(`tier "${name}" entry ${i + 1}: "agent" is required`);
          if (!KNOWN_AGENTS.has(o.agent)) errors.push(`tier "${name}": agent "${o.agent}" is not a known agent CLI (continuing anyway)`);
          if (o.model !== undefined && typeof o.model !== 'string') return void errors.push(`tier "${name}" entry ${i + 1}: "model" must be a string`);
          entries.push({ agent: o.agent, ...(o.model ? { model: o.model as string } : {}) });
        });
        if (entries.length) tiers[name] = entries;
      }
      if (!Object.keys(tiers).length) tiers = undefined;
    }
  }

  // single target
  let single: TierEntry | undefined;
  if (r.single !== undefined) {
    const o = r.single as { agent?: unknown; model?: unknown };
    if (typeof o !== 'object' || o === null || typeof o.agent !== 'string' || !o.agent.trim()) {
      errors.push('"routing.single" must be {agent, model?}');
    } else {
      if (!KNOWN_AGENTS.has(o.agent)) errors.push(`"routing.single": agent "${o.agent}" is not a known agent CLI (continuing anyway)`);
      single = { agent: o.agent, ...(typeof o.model === 'string' ? { model: o.model } : {}) };
    }
  }
  if (mode === 'single' && !single) {
    errors.push('"routing.mode" is "single" but "routing.single" {agent, model?} is missing — using auto');
    mode = 'auto';
  }

  // rules (agent- or tier-targeted)
  const rules: RoutingRule[] = [];
  if (r.rules !== undefined && !Array.isArray(r.rules)) {
    errors.push('"routing.rules" must be an array');
  } else if (Array.isArray(r.rules)) {
    r.rules.forEach((rule: unknown, i: number) => {
      if (typeof rule !== 'object' || rule === null) return void errors.push(`rule ${i + 1}: not an object`);
      const o = rule as { match?: unknown; agent?: unknown; tier?: unknown; model?: unknown };
      if (!Array.isArray(o.match) || !o.match.length || !o.match.every((m) => typeof m === 'string' && m.trim())) {
        return void errors.push(`rule ${i + 1}: "match" must be a non-empty array of keywords`);
      }
      const hasAgent = typeof o.agent === 'string' && o.agent.trim();
      const hasTier = typeof o.tier === 'string' && o.tier.trim();
      if (!hasAgent && !hasTier) {
        return void errors.push(`rule ${i + 1}: "agent" or "tier" is required`);
      }
      if (hasAgent && !KNOWN_AGENTS.has(o.agent as string)) errors.push(`rule ${i + 1}: agent "${o.agent}" is not a known agent CLI (continuing anyway)`);
      if (hasTier) {
        const known = tiers ?? BUILTIN_TIERS;
        if (!known[o.tier as string]) return void errors.push(`rule ${i + 1}: tier "${o.tier}" is not defined in routing.tiers`);
      }
      if (o.model !== undefined && typeof o.model !== 'string') {
        return void errors.push(`rule ${i + 1}: "model" must be a string`);
      }
      rules.push({
        match: (o.match as string[]).map((m) => m.trim().toLowerCase()),
        ...(hasAgent ? { agent: o.agent as string } : {}),
        ...(hasTier ? { tier: o.tier as string } : {}),
        ...(typeof o.model === 'string' ? { model: o.model } : {}),
      });
    });
  }
  // `default` is required EXCEPT in single mode, where it's unused — there we
  // fall back to the single target so a minimal single-mode config is valid.
  const hasDefault = typeof r.default === 'string' && !!r.default.trim();
  let defaultTarget: string;
  if (hasDefault) {
    defaultTarget = (r.default as string);
  } else if (mode === 'single' && single) {
    defaultTarget = single.agent;
  } else {
    errors.push('"routing.default" agent or tier is required');
    return { config: null, errors };
  }
  if (!rules.length && Array.isArray(r.rules)) errors.push('no valid rules — using built-in routing');
  const fatal = !rules.length && mode !== 'single';
  if (fatal) return { config: null, errors };
  return { config: { rules, default: defaultTarget, mode, ...(tiers ? { tiers } : {}), ...(single ? { single } : {}) }, errors };
}

/** Load <root>/baton.config.json. Never throws — invalid config falls back to built-ins with visible errors. */
export async function loadRouting(root: string): Promise<{ config: RoutingConfig; path: string | null; errors: string[] }> {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return { config: BUILTIN_ROUTING, path: null, errors: [] };
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    const { config, errors } = validateRoutingConfig(raw);
    return { config: config ?? BUILTIN_ROUTING, path: file, errors };
  } catch (e) {
    return { config: BUILTIN_ROUTING, path: file, errors: [`could not parse ${CONFIG_FILE}: ${(e as Error).message}`] };
  }
}

/* ------------------------------------------------------------------ */
/* Suggestion                                                          */
/* ------------------------------------------------------------------ */

function bestRule(taskText: string, config: RoutingConfig): { rule: RoutingRule; matched: string[] } | null {
  let best: { rule: RoutingRule; matched: string[] } | null = null;
  for (const rule of config.rules) {
    const matched = rule.match.filter((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(taskText));
    if (matched.length && (!best || matched.length > best.matched.length)) {
      best = { rule, matched };
    }
  }
  return best;
}

/**
 * Legacy suggestion — rule match or default agent, nothing else. Kept stable
 * for existing callers/tests; new code should prefer suggestRoute().
 */
export function suggestAgent(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RoutingSuggestion {
  const best = bestRule(taskText, config);
  if (best && best.rule.agent) {
    return { agent: best.rule.agent, model: best.rule.model, rule: best.rule, matched: best.matched, source: 'rule' };
  }
  return { agent: config.default, rule: null, matched: [], source: 'default' };
}

/**
 * A fresh copy of a tier chain (never alias the live config), optionally
 * forcing `model` onto EVERY entry — so a rule's explicit model still applies
 * after resolveChain falls through to an installed fallback agent.
 */
function chainFrom(entries: TierEntry[], model?: string): TierEntry[] {
  return entries.map((e) => (model ? { ...e, model } : { ...e }));
}

/**
 * Severity-ranked, tier-aware suggestion. Pure — no LLM, no I/O. The first
 * chain entry is the recommendation; the rest are fallbacks (resolveChain
 * picks the first installed one).
 */
export function suggestRoute(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RouteSuggestion {
  const mode: RoutingMode = config.mode ?? 'auto';
  const { score, signals } = scoreSeverity(taskText);
  const tiers = config.tiers;

  if (mode === 'single' && config.single) {
    return {
      mode, agent: config.single.agent, model: config.single.model,
      tier: null, chain: [config.single],
      severity: score, signals, matched: [], rule: null,
      source: 'single', confidence: 'high',
    };
  }

  const best = bestRule(taskText, config);
  if (best) {
    const { rule, matched } = best;
    const confidence = matched.length >= 2 ? 'high' : 'low';
    if (rule.tier && tiers?.[rule.tier]?.length) {
      const chain = chainFrom(tiers[rule.tier], rule.model);
      return {
        mode, agent: chain[0].agent, model: chain[0].model,
        tier: rule.tier, chain,
        severity: score, signals, matched, rule, source: 'rule', confidence,
      };
    }
    if (rule.agent) {
      return {
        mode, agent: rule.agent, model: rule.model,
        tier: null, chain: [{ agent: rule.agent, ...(rule.model ? { model: rule.model } : {}) }],
        severity: score, signals, matched, rule, source: 'rule', confidence,
      };
    }
  }

  // No rule hit: in auto mode, rank by severity into a tier.
  if (mode !== 'manual' && tiers) {
    const tier = severityToTier(score, tiers);
    if (tier) {
      const chain = chainFrom(tiers[tier]);
      return {
        mode, agent: chain[0].agent, model: chain[0].model,
        tier, chain,
        severity: score, signals, matched: [], rule: null,
        source: 'severity', confidence: signals.length >= 2 ? 'high' : 'low',
      };
    }
  }

  // Default: a tier name (when defined) or a plain agent id.
  const defEntries = tiers?.[config.default];
  if (defEntries?.length) {
    const chain = chainFrom(defEntries);
    return {
      mode, agent: chain[0].agent, model: chain[0].model,
      tier: config.default, chain,
      severity: score, signals, matched: [], rule: null,
      source: 'default', confidence: 'low',
    };
  }
  return {
    mode, agent: config.default, model: undefined,
    tier: null, chain: [{ agent: config.default }],
    severity: score, signals, matched: [], rule: null,
    source: 'default', confidence: 'low',
  };
}

/* ------------------------------------------------------------------ */
/* Chain resolution (the only I/O-adjacent piece — predicate injected) */
/* ------------------------------------------------------------------ */

export interface ResolvedRoute {
  entry: TierEntry;
  /** Index into the chain (0 = first choice). */
  index: number;
  /** Agents skipped because their CLI wasn't available. */
  skipped: string[];
}

/**
 * Walk a fallback chain and return the first entry whose agent is available
 * (per the injected predicate — probeBinary in real use, fixtures in demo).
 * Null when nothing in the chain is installed.
 */
export async function resolveChain(
  chain: TierEntry[],
  isAvailable: (agent: string) => Promise<boolean>,
): Promise<ResolvedRoute | null> {
  const skipped: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].agent === 'any' || (await isAvailable(chain[i].agent))) {
      return { entry: chain[i], index: i, skipped };
    }
    skipped.push(chain[i].agent);
  }
  return null;
}
