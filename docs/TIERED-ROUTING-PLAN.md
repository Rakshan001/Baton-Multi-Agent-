# Tiered model routing — implementation plan

> Decided 2026-06-12 with the user. Goal: route each task to the cheapest
> agent+model that can handle it — Opus/Claude for heavy reasoning, Gemini for
> UI, Codex/Cursor for small bug fixes, local models (Ollama via aider/opencode)
> for trivial fixes — without the system getting messy or opaque.
>
> **Settled decisions:**
> - Routing brain: keyword scoring + knowledge-graph heuristics (deterministic, no LLM call).
> - Failure escalation: suggest-only with one-click retry on the next tier (never auto-spend).
> - Local models: via aider/opencode wrappers speaking to Ollama (no new launcher framework yet).
> - Sequencing: land the code-review fixes first; the agent-registry consolidation is the feature's foundation.
>
> **Refined 2026-06-13 (user):** routing has three user-chosen **modes** — `single`
> (everything to one agent/model), `manual` (suggestions advisory only, you pick),
> `auto` (rules + severity rank). A 0–100 **severity** score ranks task demand
> (trivial→local model, high→Opus). Agents must be **onboarded one-by-one** from the
> UI: a roster shows installed/live/MCP-connected state and lets you wire each CLI's
> MCP config and dispatch (launch or hand off) work. Token-saving throughout; reuse
> project memory in launch prompts. No dummy content in the agent UI.
>
> **STATUS:** Stage A (review fixes + registry) ✅ · Phase 1 (model wiring) ✅ ·
> Phase 2 (tiers + modes + severity) ✅ · Agent roster + MCP connect ✅ · all verified
> in-browser. Pending: Phase 3 Ollama health check, Phase 4 graph-aware scoring,
> Phase 5 escalation-on-failure + per-tier cost rollup.

## Stage A — review fixes (prerequisite)

Backend:
1. **Consolidate SQLite access** into one `src/db.ts` — `getDb` is copy-pasted in
   `history.ts`, `signals.ts`, `reports.ts`, and `commands/pass.ts` (the last one
   leaks a connection per handoff in the daemon). Consider `PRAGMA journal_mode=WAL`.
2. **KB import hardening** (`src/kb/transfer.ts`): sanitize `project.id` from the
   manifest (reject `/`, `..`), restrict tar extraction member paths.
3. **tmux reattach backoff** (`src/terminals.ts` `onControlExit`): retry counter +
   backoff + give-up → `terminal.exited`, instead of the current zero-delay loop.
4. **Serialize tasks.json writes** (`src/store.ts`): write queue so concurrent
   `addTask`/`removeTask` can't last-writer-wins each other.
5. **Agent registry** — NEW `src/agents/registry.ts` as the single source of truth:
   id, display name, headless launcher, interactive launcher, ps detect pattern,
   model flag. Replaces the four independent lists in `spawn.ts` (LAUNCHERS),
   `terminals.ts` (INTERACTIVE_LAUNCHERS), `agents.ts` (AGENT_PATTERNS),
   `routing.ts` (KNOWN_AGENTS).

Frontend:
6. **`useCallback` on `subscribe`** in `web/src/hooks/useEvents.ts` — unstable
   identity currently wipes the Live event log every App render.
7. **Stop the refetch storm**: don't `BatonAPI.notify()` on `agent.output` /
   `terminal.*` events (or debounce notify).
8. **Connection switching**: request versioning in `usePoll`, re-key `useEvents`
   off the API connection, Settings save updates App state; clear `agentOverride`
   on `setConnection` and when real agent data arrives.
9. Small: reset Live elapsed clock per slug; Settings "Connected" badge from real
   poll state; surface `error` on Memory/Activity/Settings polls.

## Stage B — the feature

**Phase 1 — wire `model` through execution.** `RoutingRule.model` exists but never
reaches a process. Registry declares each CLI's model flag (`claude --model`,
`codex -m`, `gemini -m`, `cursor-agent --model`, `aider --model`); `baton start`,
interactive terminals, `/api` start endpoints, and the Launch dialog accept and
forward it.

**Phase 2 — tiers.** `baton.config.json` gains:
```json
{
  "routing": {
    "tiers": {
      "heavy":    [{ "agent": "claude", "model": "opus" }],
      "standard": [{ "agent": "cursor" }, { "agent": "claude", "model": "sonnet" }],
      "light":    [{ "agent": "codex" }, { "agent": "gemini" }],
      "local":    [{ "agent": "aider", "model": "ollama/qwen2.5-coder" }]
    },
    "rules": [{ "match": ["plan", "architecture"], "tier": "heavy" }],
    "default": "standard"
  }
}
```
Each tier is an ordered fallback chain — first installed/healthy entry wins.
Old-style `agent:` rules keep working (back-compat in `validateRoutingConfig`).

**Phase 3 — local tier health.** Ollama reachability check (ping `:11434`, model
pulled) folded into the existing capability reporting; unhealthy entry → fall
through the tier's chain; UI greys out uninstalled agents with an install hint
(same pattern as the tmux-missing hint).

**Phase 4 — graph-aware complexity scoring.** Still no LLM: keyword score as today
PLUS (a) graph lookup of likely files from task text — high-centrality god-nodes
escalate a tier, single leaf file de-escalates; (b) task-length signal. Suggestion
carries an explanation payload: matched keywords, graph evidence, confidence
(weak/tie ⇒ "low confidence" badge in UI, never silent).

**Phase 5 — escalation + cost visibility.** Failed run (nonzero exit / no commit)
⇒ completion report records tier + failure tail; dashboard offers one-click
"retry on next tier" whose handoff brief embeds the failure context. Activity
page: per-tier cost rollup from `src/usage.ts` ("light tier handled N tasks,
est. saved $X"); soft daily budget that warns (never blocks) when routing heavy.
Depends on extending `usage.ts` beyond Claude JSONLs (existing pending item).

## UX principles (anti-messiness)

- Routing is always a **suggestion with a visible why** ("→ codex: matched 'fix',
  'crash'") and a one-click override — never silent automation.
- Four tiers, not N×M agent/model pairs, is the user-facing mental model.
- Visual tier/rule editor in Settings (rules are still committed JSON underneath).
- Demo mode gets demo tier data; real behavior stays gated on `BatonAPI.demo`.

## Edge cases

| Case | Handling |
|---|---|
| Agent CLI not installed | tier fallback chain + greyed UI with install hint |
| Invalid model for a CLI | registry validates per-agent model names |
| Keyword tie / weak match | "low confidence" badge, default tier |
| Ollama down / model not pulled | health check ⇒ fall through chain |
| Invalid baton.config.json | existing fallback to built-ins with visible errors |
| Headless vs interactive conflict | existing tmux-locked 409s |
| Non-Claude token data | usage.ts parser per agent (pending item #3 in STATUS.md) |
| Escalation loop | suggest-only; each retry is an explicit user click |
