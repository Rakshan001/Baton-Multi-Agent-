# Verdict — should Baton be built?

> Output of a deep-research run (2026-06): 5 search angles → 23 sources fetched → 111 claims
> extracted → 25 adversarially verified (3-vote) → 22 confirmed, 3 killed. 105 agents.

## 🔴 NO-GO (as a standalone tool)

Both of Baton's functions are already shipped by maintained, adopted tools. Only a thin,
undefended sliver is genuinely unmet — not enough to justify a new project.

## Evidence

### 1. Cost-arbitrage handoff (function #1) — already shipped, with Baton's exact pitch
**CodeRabbit "Agent Handoff"** (GA, launched 2026-03-18) produces "context-rich prompts ready for
any coding agent (Claude Code, Copilot, Cursor)" and states: *"Because the plan already contains
precise instructions, you can often use faster or cheaper models for execution without losing
quality."* That is Baton's value prop, from a funded incumbent.
Also covered in framing by **GitHub Spec Kit** (spec→plan→tasks, 30 integrations, "switch agents,
no lock-in"). — `docs.coderabbit.ai/plan/agent-handoff`, `github.github.com/spec-kit/` *(3-0 overlap; 2-1 explicit cost framing)*

### 2. Condensed cross-tool session export (function #2) — already delivered
**`cli-continues`** (~1.2k★) produces a *summarized* pack (verbosity presets; *"Not every handoff
needs to be a novel"*), across 16 tools including **both Claude Code and Cursor**, reading Cursor's
`~/.cursor/projects/*/agent-transcripts/` JSONL. — `github.com/yigitkonur/cli-continues`
*(3-0 cross-tool; 2-1 condensation)*

### 3. Redundant export coverage
SpecStory (Claude+Cursor capture), claude-code-exporter (3 tools, "paste Claude export into
Cursor", May 2026), cc2md, claude-conversation-extractor. *(3-0)*

### 4. Substitutes for the framing
AGENTS.md (60k+ repos, Linux Foundation) and Spec Kit cover the handoff premise for most users —
though they are forward-authoring, NOT session export. *(3-0)*

### 5. Market is niche
JetBrains (Jan 2026, n>10,000): fragmented tool usage, ~70% use 2–4 tools. Baton's pain =
fragmentation ∩ budget ∩ export — a narrow slice already chased by 6+ tools. *(3-0)*

## The only genuinely unmet slivers
1. A **quantified token/cost estimate** attached to a handoff brief.
2. An **LLM-condensed-by-default** (not verbatim) cross-tool paste pack.

Both are single **features**, not a tool — and better contributed to `cli-continues`.

## Two assumed moats already obsolete
- Cursor sessions live in **JSONL agent-transcripts**, not only SQLite `state.vscdb` → no parsing moat.
- Cross-tool Claude↔Cursor handoff **already exists**.

## Honest caveats (where the verdict is soft)
- **Demand** was the weakest-evidenced dimension — no *volume* of direct forum quotes explicitly
  demanding this; inferred from tool existence + market data.
- **Fast-moving** — CodeRabbit Handoff ~3 months old, claude-code-exporter ~3 weeks; could shift.
- Several gap claims rest on *absence-in-docs*, not vendor denial.
- 3 claims were **killed** by adversarial verification (e.g. "cli-continues is explicitly
  motivated by rate-limit arbitrage" → 1-2 refuted; the condensation claims split 2-1).

## What would flip this to GO
Clear, voiced demand *at volume* specifically for the quantified-cost-estimate handoff, or
incumbents stalling/abandoning.

## Recommendation
1. **Contribute the 2 surviving features to `cli-continues`** instead of building a new tool.
2. If you want to build something *novel*, pursue **`agentlock`** (enforced cross-vendor
   lock-on-write) — research found that is **NOT** solved (all existing lockers are advisory).
3. Keep the research (`docs/`, `PRIOR_ART.md`) regardless — it's reusable.

## Open questions (worth answering before any reconsideration)
- How strong/recurring is the *voiced* demand for quantified cost-arbitrage handoff? (gather forum/HN/X quotes)
- Would the `cli-continues` maintainer accept the cost-estimate / condensation features?
- Do users actually want lossy LLM-condensed packs, or verbatim/foldable they can trust?
- Is there any willingness-to-pay, or is this an unmonetizable free CLI?

## Key sources
coderabbit.ai/plan/agent-handoff · github.com/yigitkonur/cli-continues ·
github.com/specstoryai/getspecstory · open-vsx.org/.../claude-code-exporter · github.com/magarcia/cc2md ·
agents.md · github.github.com/spec-kit · blog.jetbrains.com/research/2026/04 (tool-usage survey) ·
forum.cursor.com/t/...148298 (arbitrage quotes)
