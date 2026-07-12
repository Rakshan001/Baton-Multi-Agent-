/* ============================================================
   BATON — routing mirror (demo mode)
   Mirrors src/routing.ts (BUILTIN_ROUTING, suggestAgent, scoreSeverity,
   severityToTier, suggestRoute) so demo mode shows real suggestions
   without a daemon. routing-parity.test.ts enforces lockstep — any
   change here must land in src/routing.ts too, and vice versa.
   ============================================================ */
import type { Downshift, RouteSuggestion, RoutingConfig, RoutingMode, RoutingRule, RoutingSuggestion, TierEntry } from "../types";

export const TIER_ORDER = ["heavy", "standard", "light", "local"] as const;

export const BUILTIN_TIERS: Record<string, TierEntry[]> = {
  heavy: [{ agent: "claude", model: "opus" }],
  standard: [{ agent: "cursor" }, { agent: "claude", model: "sonnet" }],
  light: [{ agent: "codex" }, { agent: "gemini" }],
  local: [{ agent: "aider", model: "ollama/qwen2.5-coder" }, { agent: "opencode" }],
};

export const BUILTIN_ROUTING: RoutingConfig = {
  rules: [
    { match: ["plan", "planning", "architecture", "design doc", "research", "investigate"], agent: "claude", model: "opus" },
    { match: ["ui", "frontend", "css", "design", "page", "component", "layout", "responsive"], agent: "gemini" },
    { match: ["bug", "fix", "error", "crash", "broken", "regression", "failing"], agent: "codex" },
  ],
  default: "cursor",
  mode: "auto",
  tiers: BUILTIN_TIERS,
};

const HEAVY_HINTS = [
  "architect", "refactor", "migrat", "redesign", "rewrite", "security",
  "concurren", "race", "deadlock", "performance", "scalab", "plan",
  "research", "investigat", "overhaul", "breaking", "protocol", "algorithm",
];

const LIGHT_HINTS = [
  "typo", "rename", "comment", "bump", "minor", "small", "quick", "tweak",
  "padding", "lint", "format", "docstring", "readme", "label", "wording",
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hintHit = (text: string, hint: string) => new RegExp(`\\b${escapeRegExp(hint)}`, "i").test(text);

export interface SeverityResult {
  score: number;
  signals: string[];
}

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
    signals.push("+ very detailed description");
  } else if (taskText.length > 200) {
    score += 10;
    signals.push("+ detailed description");
  } else if (taskText.length < 40) {
    score -= 10;
    signals.push("- short description");
  }
  return { score: Math.max(0, Math.min(100, score)), signals };
}

export function severityToTier(score: number, tiers: Record<string, TierEntry[]>): string | null {
  const want = score >= 75 ? "heavy" : score >= 45 ? "standard" : score >= 25 ? "light" : "local";
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

function bestRule(taskText: string, config: RoutingConfig): { rule: RoutingRule; matched: string[] } | null {
  let best: { rule: RoutingRule; matched: string[] } | null = null;
  for (const rule of config.rules) {
    const matched = rule.match.filter((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(taskText));
    if (matched.length && (!best || matched.length > best.matched.length)) best = { rule, matched };
  }
  return best;
}

export function suggestAgent(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RoutingSuggestion {
  const best = bestRule(taskText, config);
  if (best && best.rule.agent) {
    return { agent: best.rule.agent, model: best.rule.model, rule: best.rule, matched: best.matched, source: "rule" };
  }
  return { agent: config.default, rule: null, matched: [], source: "default" };
}

function chainFrom(entries: TierEntry[], model?: string): TierEntry[] {
  return entries.map((e) => (model ? { ...e, model } : { ...e }));
}

/** Which defined tier an agent belongs to (first match in capability order). */
function tierOfAgent(agent: string, tiers: Record<string, TierEntry[]>): string | null {
  for (const t of TIER_ORDER) {
    if (tiers[t]?.some((e) => e.agent === agent)) return t;
  }
  return null;
}

const CHEAP_TIERS = new Set<string>(["light", "local"]);

/** W5 mirror of src/routing.ts maybeDownshift — keep in lockstep (parity test). */
function maybeDownshift(
  score: number,
  ruleTier: string | null,
  agent: string,
  tiers: Record<string, TierEntry[]> | undefined,
  mode: RoutingMode,
): Downshift | null {
  if (!tiers || mode === "manual" || score >= 25) return null; // 25 = the 'local' severity band
  const current = ruleTier ?? tierOfAgent(agent, tiers);
  if (current && CHEAP_TIERS.has(current)) return null; // already cheap — don't churn
  const target = severityToTier(score, tiers);
  if (!target || !CHEAP_TIERS.has(target) || target === current) return null;
  return {
    tier: target,
    chain: chainFrom(tiers[target]),
    reason: `severity ${score}/100 says this is trivial — the '${target}' tier could handle it at lower cost`,
  };
}

export function suggestRoute(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RouteSuggestion {
  const mode: RoutingMode = config.mode ?? "auto";
  const { score, signals } = scoreSeverity(taskText);
  const tiers = config.tiers;

  if (mode === "single" && config.single) {
    return {
      mode, agent: config.single.agent, model: config.single.model,
      tier: null, chain: [config.single],
      severity: score, signals, matched: [], rule: null,
      source: "single", confidence: "high",
    };
  }

  const best = bestRule(taskText, config);
  if (best) {
    const { rule, matched } = best;
    const confidence = matched.length >= 2 ? "high" : "low";
    if (rule.tier && tiers?.[rule.tier]?.length) {
      const chain = chainFrom(tiers[rule.tier], rule.model);
      return {
        mode, agent: chain[0].agent, model: chain[0].model,
        tier: rule.tier, chain,
        severity: score, signals, matched, rule, source: "rule", confidence,
        downshift: maybeDownshift(score, rule.tier, chain[0].agent, tiers, mode),
      };
    }
    if (rule.agent) {
      return {
        mode, agent: rule.agent, model: rule.model,
        tier: null, chain: [{ agent: rule.agent, ...(rule.model ? { model: rule.model } : {}) }],
        severity: score, signals, matched, rule, source: "rule", confidence,
        downshift: maybeDownshift(score, null, rule.agent, tiers, mode),
      };
    }
  }

  if (mode !== "manual" && tiers) {
    const tier = severityToTier(score, tiers);
    if (tier) {
      const chain = chainFrom(tiers[tier]);
      return {
        mode, agent: chain[0].agent, model: chain[0].model,
        tier, chain,
        severity: score, signals, matched: [], rule: null,
        source: "severity", confidence: signals.length >= 2 ? "high" : "low",
      };
    }
  }

  const defEntries = tiers?.[config.default];
  if (defEntries?.length) {
    const chain = chainFrom(defEntries);
    return {
      mode, agent: chain[0].agent, model: chain[0].model,
      tier: config.default, chain,
      severity: score, signals, matched: [], rule: null,
      source: "default", confidence: "low",
    };
  }
  return {
    mode, agent: config.default, model: undefined,
    tier: null, chain: [{ agent: config.default }],
    severity: score, signals, matched: [], rule: null,
    source: "default", confidence: "low",
  };
}
