# Agent routing

Baton decides which agent (and model) should take a task using a **deterministic, keyword-plus-severity scorer** — no LLM call, instant, and fully explainable. Routing rules live in a committable `baton.config.json` at the repo root, so the whole team shares the same "plan on Opus, UI to Gemini, bug fixes to Codex, trivial work on a local model" policy.

Routing is implemented in [`src/routing.ts`](../src/routing.ts). It is pure — same input always gives the same answer.

## `baton route`

Ask Baton who should take a task without committing to anything:

```bash
baton route "refactor the auth middleware to remove the race condition"
```

```text
→ claude (model: opus)   severity → heavy tier
  severity: 86/100   + heavy work: 'refactor' · + heavy work: 'race'
  heavy tier chain: [claude:opus]
  mode: auto
  config: built-in defaults (create baton.config.json to customize)
  hand off with: baton pass <slug> --to claude   (or omit --to to auto-route)
```

The output shows, top to bottom:

- the **picked agent/model** and the reason (matched rule, severity-to-tier, single mode, or default);
- the **severity score** (0–100) and the signals that produced it;
- the **fallback chain** — when more than one entry exists, the resolved choice is in `[brackets]` and any uninstalled agents that were skipped are listed;
- the active **mode** and which config file was used (built-in defaults if there's no `baton.config.json`).

If nothing in the chain is installed, `route` says so and suggests installing the first choice or routing elsewhere with `--to`.

## `baton.config.json`

Routing reads `baton.config.json` at the repo root. When the file is missing or invalid, Baton falls back to built-in defaults and prints the validation errors — it never throws.

```json
{
  "routing": {
    "mode": "auto",
    "rules": [
      { "match": ["plan", "architecture", "research"], "agent": "claude", "model": "opus" },
      { "match": ["ui", "frontend", "css", "component"], "agent": "gemini" },
      { "match": ["bug", "fix", "crash", "regression"], "tier": "light" }
    ],
    "default": "cursor",
    "tiers": {
      "heavy":    [{ "agent": "claude", "model": "opus" }],
      "standard": [{ "agent": "cursor" }, { "agent": "claude", "model": "sonnet" }],
      "light":    [{ "agent": "codex" }, { "agent": "gemini" }],
      "local":    [{ "agent": "aider", "model": "ollama/qwen2.5-coder" }, { "agent": "opencode" }]
    }
  }
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `mode` | `"auto"` \| `"manual"` \| `"single"` | How suggestions are applied (see below). Defaults to `auto`. |
| `rules` | array | Ordered keyword rules. Each needs a non-empty `match` array plus an `agent` **or** a `tier` (and optional `model`). |
| `default` | string | Tier name or agent id used when no rule matches. Required (except in `single` mode, where it falls back to the single target). |
| `tiers` | object | Named fallback chains: tier name → array of `{ agent, model? }`. |
| `single` | `{ agent, model? }` | The one target used in `single` mode. |

**Rule matching.** A rule fires when any of its `match` keywords appears as a whole word in the task text (word-boundary, case-insensitive). When several rules match, the one with the **most** matched keywords wins. A rule that matched two or more keywords is reported as `high` confidence; one keyword is `low`.

Agent ids are validated against the known CLIs — `claude`, `codex`, `cursor`, `gemini`, `aider`, `opencode` (plus `any`), defined in [`src/agents/registry.ts`](../src/agents/registry.ts). An unknown agent is a warning, not a hard error.

## The three modes

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Rules are tried first; if none match, the **severity score** maps to a tier. This is the only mode that auto-routes. |
| `manual` | Suggestions are advisory only. Rules still match, but when nothing matches Baton does **not** rank by severity — UIs don't preselect and the CLI tells you to pick with `--to`. |
| `single` | Everything goes to `routing.single`. For people who use one CLI and only want Baton's coordination. |

## Severity score (0–100)

When no rule matches in `auto` mode, Baton estimates how demanding the task is. The scorer starts at **50** and adjusts:

- **Heavy hints** (`architect`, `refactor`, `migrat`, `redesign`, `rewrite`, `security`, `concurren`, `race`, `deadlock`, `performance`, `scalab`, `plan`, `research`, `investigat`, `overhaul`, `breaking`, `protocol`, `algorithm`) — **+12 each**, capped at +36.
- **Trivial hints** (`typo`, `rename`, `comment`, `bump`, `minor`, `small`, `quick`, `tweak`, `padding`, `lint`, `format`, `docstring`, `readme`, `label`, `wording`) — **−12 each**, capped at −36.
- **Description length** — over 400 chars `+15`, over 200 chars `+10`, under 40 chars `−10`.

Hints are prefix-matched at a word start (so `refactor` also fires on `refactoring`). The final score is clamped to 0–100, and every adjustment is returned as a human-readable signal.

The score maps onto a tier by these thresholds:

| Score | Tier |
| --- | --- |
| ≥ 75 | `heavy` |
| 45–74 | `standard` |
| 25–44 | `light` |
| < 25 | `local` |

If the chosen tier isn't defined in your config, Baton falls through to the nearest defined tier (e.g. no `local` → use `light`).

## Tiers as fallback chains

A tier is an **ordered list of `{ agent, model? }` entries**. The first entry is the recommendation; the rest are fallbacks. At hand-off time Baton walks the chain and picks the **first installed** agent (`resolveChain` probes each CLI on `PATH`), so "Ollama down → next entry" is config, not code. The special agent `any` always resolves.

The built-in tiers (highest capability first — `heavy`, `standard`, `light`, `local`):

| Tier | Chain |
| --- | --- |
| `heavy` | `claude:opus` |
| `standard` | `cursor` → `claude:sonnet` |
| `light` | `codex` → `gemini` |
| `local` | `aider:ollama/qwen2.5-coder` → `opencode` |

A rule can target a `tier` instead of a single `agent`; the rule's `model` (if set) is forced onto every entry of the resolved chain.

## Auto-routing in `baton pass`

[`baton pass`](./02-handoff-market.md) packages a session into a `HANDOFF.md` brief for the next agent. When you give it `--to <agent>`, that target is used as-is. When you **omit** `--to` (or pass `--to auto`), `pass` routes deterministically the same way `route` does:

1. load `baton.config.json`,
2. run `suggestRoute` on the task text (rules → severity → default),
3. walk the resulting fallback chain and pick the first installed agent.

```bash
# explicit target
baton pass my-task --to codex

# auto-route by task type + severity (no LLM)
baton pass my-task
```

```text
✓ handoff brief ready → .baton/wt/my-task/HANDOFF.md
  routed → codex · matched 'bug', 'fix' · override with --to <agent>
```

If routing mode is `manual`, `pass` notes that the result is only a suggestion. If the picked agent came through low confidence, it tells you to double-check the target, and it lists any chain entries it skipped because the CLI wasn't installed.

## `/api/routing` endpoint

The daemon exposes routing over the local JSON API (read-only, no `--write` needed):

```bash
curl "http://localhost:7077/api/routing?task=fix%20the%20login%20crash"
```

```json
{
  "config": { "rules": [ ... ], "default": "cursor", "mode": "auto", "tiers": { ... } },
  "path": "/abs/path/baton.config.json",
  "errors": [],
  "suggestion": {
    "mode": "auto",
    "agent": "codex",
    "tier": null,
    "chain": [{ "agent": "codex" }],
    "severity": 50,
    "signals": [],
    "matched": ["fix", "crash"],
    "rule": { "match": ["bug", "fix", ...], "agent": "codex" },
    "source": "rule",
    "confidence": "high"
  }
}
```

Without `?task=`, `suggestion` is `null` and you get just the loaded config, its file path (`null` when using built-ins), and any validation errors.

## Settings & Handoff UI

The dashboard surfaces routing in two places:

- **Settings** shows the loaded routing config (mode, rules, tiers, default) and any validation errors.
- The **Handoff** flow uses the same `suggestRoute` logic to preselect a target. In `manual` mode it does not preselect — you choose the agent yourself, matching the CLI's advisory behavior.

> The web mirror in `web/src/lib/routing.ts` is kept in lockstep with `src/routing.ts` by `routing-parity.test.ts`, so UI and CLI always agree.

## Next steps

- [Handoff briefs](./02-handoff-market.md) — how `baton pass` / `take` / `done` package a session.
- [Coordination and locking](./01-coordination-and-locking.md) — edit signals and conflict avoidance across agents.
- [Baton README](../README.md) — install, `baton serve`, and the dashboard.
