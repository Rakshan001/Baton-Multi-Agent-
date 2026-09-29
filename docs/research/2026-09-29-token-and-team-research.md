# Research: prompt caching, token cost, and team collaboration (2026-09-29)

Status: research record. The token half is **deferred** (see the Team v2 overview for
priority). Keep this file so that work doesn't need to be re-researched. All claims were
web-verified on 2026-09-28/29; re-check prices before publishing any number.

## 1. Prompt caching: what is actually true

- LLM APIs are stateless. Every request carries the full context. Neither a client-side
  "hashmap of prompts already sent" nor an `id` in place of text can skip tokens the
  model needs. OpenAI's `previous_response_id` still bills all prior input.
  ([Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching),
  [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state))
- Provider caching matches an **exact prefix** in the order tools → system → messages.
  There is no per-block reuse: if block A changes, identical blocks after it still miss.
  ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))
- Anthropic pricing, as multiples of base input:
  - 5-minute cache write: 1.25×
  - 1-hour cache write: 2×
  - cache read: 0.05× on Opus 5.5 ($0.20 against $4/MTok)
  - Minimum cacheable length is 512–4096 tokens, depending on the model.
  - Breakpoints look back at most 20 blocks, with 4 explicit breakpoints per request.
- Claude Code caches in layers, most stable first: system prompt and tools, then
  CLAUDE.md, then the conversation. These break the cache:
  - a model switch
  - an effort switch
  - adding or removing MCP tools
  - `/compact`
  - an upgrade
  - a timestamp in the prefix
- The cache is per machine and directory, so separate worktrees don't share it.
- Subagents build their own cache.
  ([Claude Code costs](https://code.claude.com/docs/en/costs))
- OpenAI caches automatically from 1,024 tokens, reports `cached_tokens`, and routes by
  `prompt_cache_key`. Gemini has implicit caching from 2.5 on, plus explicit
  `caches.create`.

## 2. What a repeated `/bug-fix` really costs

- Claude Code injects the skill's text **once** as a user message. It stays in history and
  is re-read every turn at the cache-read price. Re-invoking it with identical content
  adds an "already loaded" note, not a second copy.
  ([Claude Code skills](https://code.claude.com/docs/en/skills))
- Worked example: a 5k-token skill in a 60-request session on Opus 5.5 costs about $0.08
  if cached and about $1.20 if not. In a long session that is roughly 2–3% of total cost.
- The real burn:
  - history re-sent every turn
  - cache misses (TTL expiry, model or effort switch, a new session or worktree)
  - subagents (78% of this user's usage on 2026-09-28)
  - context above 150k tokens (51%)
  - output tokens, which cost 5× input
- Levers, each with a source:
  - SKILL.md under 500 lines, with detail moved to `references/`
  - scripts instead of prose, since only their output enters context
  - `context: fork` (the skill runs in a subagent and only the result returns)
  - `disable-model-invocation: true` for slash-only skills
  - `/clear` between tasks
  - a cheaper model for subagents
  - hooks that filter tool output
- **Baton's own debt:** 10 of 35 bundled SKILL.md files are over 500 lines
  (imagegen-mobile 1469, image-to-code 1232, design-taste 1210, bug-fix 573). None uses
  `context: fork` or `disable-model-invocation`.

## 3. Claims we must not make

- **"graphify reduces 8M → 5k tokens."** The 8M figure is the size of the whole corpus
  (1,124 files, about 4.9M words), and no agent reads that. The fair baseline is grep plus
  a few files (about 20–100k), which puts the saving at roughly **5–20× on navigation
  only**. `graphify-out/graph.json` (11 MB) and `GRAPH_REPORT.md` (about 45k tokens) cost
  more than they save if an agent opens them.
- **"Tokens saved vs traditional coding."** There is no counterfactual to measure against.
  Only two numbers are honest:
  - measured cache savings: `cache_read × (input − cache_read price)`
  - within-team comparisons, with n and spread shown
- The north-star metric is **cost per merged task**.

## 4. What Baton has and what Orca has (usage)

- **Baton:**
  - parsers for Claude, Codex and Antigravity
  - cache read and write counts, with the 5-minute and 1-hour write split
  - per-agent and per-task attribution
  - null means unknown, not zero
- **Baton's gaps:**
  - no hit rate and no $-saved figure
  - no SSE updates (it polls every 30s)
  - no daily series
  - Codex and Gemini are unpriced
  - no quota view
- **Orca (MIT)** has:
  - `cacheReuseRate`
  - zero-cache-read turns
  - a 42-day heatmap, hand-rolled with no chart library
  - project and model breakdowns
  - a share card
  - Codex/OpenAI pricing
  - rate-limit fetchers
  - a mobile QR integration: `orca://pair` {ws endpoint, 24-byte device token,
    Curve25519 pubkey}, a direct WS on the LAN, NaCl box, an RPC allowlist and revocation
- **tokscale (MIT)** parses 50+ agents and draws heatmaps. Integrate it rather than
  hand-writing more parsers.

## 5. Team collaboration: market and technology

- **Market.** Nobody assigns work to a teammate's *local* agent across vendors with no
  account. The nearest products all use cloud agents or a cloud backend:
  - Conductor's multiplayer (cloud, $50/mo Pro)
  - GitHub Agent HQ and the Linear, Devin and Jules integrations (cloud agents)
  - Vibe Kanban, which shut down in April 2026 (its team features were cloud-only)

  Positioning: *your agents, your subscriptions, your machines*. LAN is one deployment of
  that, not the pitch.
- **What "offline" means.** Agents need the internet to reach their models, so offline
  means *coordination survives a WAN outage*. A true ad-hoc Wi-Fi mesh (Wi-Fi Direct or
  AWDL) is not cross-platform, so offline is realistically the same LAN or a hotspot with
  no WAN.
- **Recommended stack:**
  - hub-and-spoke on the existing daemon
  - a `node:dgram` beacon (Syncthing/LocalSend style) plus manual IP and QR
  - self-signed TLS with a fingerprint pinned by QR
  - a hub-owned append-only event log with SSE `Last-Event-ID` (no CRDT)
- **Rejected or deferred:**
  - Tailscale (can't add devices offline)
  - libp2p and Hyperswarm (too heavy)
  - git daemon (no auth)
  - Radicle (a separate stack)
- **Pitfalls:**
  - Corporate Wi-Fi client isolation breaks every LAN approach, so test with `curl` on
    day one.
  - On macOS 15, an app without `NSLocalNetworkUsageDescription` and `NSBonjourServices`
    is silently denied LAN access.
  - Electron notifications need codesigning on macOS and an AppUserModelID on Windows.

## 6. External items reviewed (read-only, nothing executed)

- **laya** (Apache-2.0): a Python typed-decision classifier, low relevance. Worth
  borrowing: shadow mode, then calibrated threshold, then canary. Red flags: 27k stars in
  10 days, a server bound to 0.0.0.0, and an article that contradicts the README.
- **Jev** (TypeSafe AI): a closed "System One" decision model, low relevance. Its
  benchmark claims are marketing.
- **Yao** (`how-it-works.png`): a central engine and task board, with per-machine agent
  cards and resource bars. The UI idea is borrowable. Its license is a modified Apache
  that requires a commercial license at 50+ employees or $1M+ revenue, so do not copy
  code.
- **YaoApp/designer** (MIT): dormant, 0 stars. Worth borrowing: an on-demand asset
  registry.
