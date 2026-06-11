/* ============================================================
   BATON — routing mirror (demo mode)
   Mirrors src/routing.ts suggestAgent + BUILTIN_ROUTING so demo
   mode shows real suggestions without a daemon. Keep the scoring
   in sync with the backend (word-boundary, most hits, tie→first).
   ============================================================ */
import type { RoutingConfig, RoutingSuggestion } from "../types";

export const BUILTIN_ROUTING: RoutingConfig = {
  rules: [
    { match: ["plan", "planning", "architecture", "design doc", "research", "investigate"], agent: "claude", model: "opus" },
    { match: ["ui", "frontend", "css", "design", "page", "component", "layout", "responsive"], agent: "gemini" },
    { match: ["bug", "fix", "error", "crash", "broken", "regression", "failing"], agent: "codex" },
  ],
  default: "cursor",
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function suggestAgent(taskText: string, config: RoutingConfig = BUILTIN_ROUTING): RoutingSuggestion {
  let best: { rule: RoutingConfig["rules"][number]; matched: string[] } | null = null;
  for (const rule of config.rules) {
    const matched = rule.match.filter((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(taskText));
    if (matched.length && (!best || matched.length > best.matched.length)) best = { rule, matched };
  }
  if (best) return { agent: best.rule.agent, model: best.rule.model, rule: best.rule, matched: best.matched, source: "rule" };
  return { agent: config.default, rule: null, matched: [], source: "default" };
}
