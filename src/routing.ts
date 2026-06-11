/**
 * Task-type → agent routing: "plan on Claude/Opus, UI work to Gemini, bug
 * fixes to Codex" as a committable, team-shared config (baton.config.json at
 * the repo root). Pure keyword scoring — NO LLM call, deterministic, instant.
 *
 * Config shape adapted from claude-code-router (MIT) — task-type → model
 * routing — applied at the agent-handoff level instead of an API proxy.
 * See NOTICE.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RoutingRule {
  match: string[];
  agent: string;
  model?: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  default: string;
}

export interface RoutingSuggestion {
  agent: string;
  model?: string;
  rule: RoutingRule | null;
  matched: string[];
  source: 'rule' | 'default';
}

export const CONFIG_FILE = 'baton.config.json';

/** Known agent CLIs (web/src/types.ts AgentId mirrors this). Unknown agents warn, not reject. */
const KNOWN_AGENTS = new Set(['claude', 'cursor', 'codex', 'gemini', 'aider', 'opencode', 'any']);

export const BUILTIN_ROUTING: RoutingConfig = {
  rules: [
    { match: ['plan', 'planning', 'architecture', 'design doc', 'research', 'investigate'], agent: 'claude', model: 'opus' },
    { match: ['ui', 'frontend', 'css', 'design', 'page', 'component', 'layout', 'responsive'], agent: 'gemini' },
    { match: ['bug', 'fix', 'error', 'crash', 'broken', 'regression', 'failing'], agent: 'codex' },
  ],
  default: 'cursor',
};

export function validateRoutingConfig(raw: unknown): { config: RoutingConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { config: null, errors: ['config is not an object'] };
  const routing = (raw as { routing?: unknown }).routing;
  if (routing === undefined) return { config: null, errors: ['no "routing" key in baton.config.json'] };
  if (typeof routing !== 'object' || routing === null) return { config: null, errors: ['"routing" is not an object'] };

  const r = routing as { rules?: unknown; default?: unknown };
  const rules: RoutingRule[] = [];
  if (!Array.isArray(r.rules)) {
    errors.push('"routing.rules" must be an array');
  } else {
    r.rules.forEach((rule: unknown, i: number) => {
      if (typeof rule !== 'object' || rule === null) return void errors.push(`rule ${i + 1}: not an object`);
      const o = rule as { match?: unknown; agent?: unknown; model?: unknown };
      if (!Array.isArray(o.match) || !o.match.length || !o.match.every((m) => typeof m === 'string' && m.trim())) {
        return void errors.push(`rule ${i + 1}: "match" must be a non-empty array of keywords`);
      }
      if (typeof o.agent !== 'string' || !o.agent.trim()) {
        return void errors.push(`rule ${i + 1}: "agent" is required`);
      }
      if (!KNOWN_AGENTS.has(o.agent)) errors.push(`rule ${i + 1}: agent "${o.agent}" is not a known agent CLI (continuing anyway)`);
      if (o.model !== undefined && typeof o.model !== 'string') {
        return void errors.push(`rule ${i + 1}: "model" must be a string`);
      }
      rules.push({ match: (o.match as string[]).map((m) => m.trim().toLowerCase()), agent: o.agent, model: o.model as string | undefined });
    });
  }
  if (typeof r.default !== 'string' || !r.default.trim()) {
    errors.push('"routing.default" agent is required');
    return { config: null, errors };
  }
  if (!rules.length && Array.isArray(r.rules)) errors.push('no valid rules — using built-in routing');
  const fatal = !rules.length;
  return { config: fatal ? null : { rules, default: r.default }, errors };
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Suggest an agent for a task. Word-boundary keyword matching, case-insensitive;
 * the rule with the most distinct keyword hits wins; ties go to the first rule;
 * zero hits → the default agent. Pure — no LLM, no I/O.
 */
export function suggestAgent(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RoutingSuggestion {
  let best: { rule: RoutingRule; matched: string[] } | null = null;
  for (const rule of config.rules) {
    const matched = rule.match.filter((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(taskText));
    if (matched.length && (!best || matched.length > best.matched.length)) {
      best = { rule, matched };
    }
  }
  if (best) {
    return { agent: best.rule.agent, model: best.rule.model, rule: best.rule, matched: best.matched, source: 'rule' };
  }
  return { agent: config.default, rule: null, matched: [], source: 'default' };
}
