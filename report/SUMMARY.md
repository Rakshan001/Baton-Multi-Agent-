# Executive summary — Baton research & outcome

_2026-06. What was researched this session, and what came out of it._

## The journey
The idea evolved across the session: bug-fix skill improvements → multi-session coordination →
an enforced cross-agent locking tool (`agentlock`) → a smaller **agent handoff** tool (**Baton**)
with a cost-arbitrage angle → a session **export** feature → a final go/no-go market check.

## What was researched (6 passes + 1 deep-research workflow)
1. **Multi-agent orchestration best practices** (Anthropic patterns) — for the bug-fix skill.
2. **Code-graph blast-radius / change-impact analysis** — for the bug-fix skill.
3. **Systematic debugging & regression prevention** — for the bug-fix skill.
4. **Cross-agent coordination & enforcement hooks** → [docs/01](../docs/01-coordination-and-locking.md)
5. **Agent handoff market** → [docs/02](../docs/02-handoff-market.md)
6. **Session export / usage / dashboard OSS tools** → [docs/03](../docs/03-session-export-tools.md)
7. **Deep-research GO/NO-GO on Baton** (105 agents, adversarial) → [report/VERDICT.md](./VERDICT.md)

## The outcome
- **Baton (handoff + export): 🔴 NO-GO** as a standalone tool. Both functions are already shipped
  by maintained, adopted tools (CodeRabbit Agent Handoff; cli-continues; SpecStory; exporters).
  The only unmet slivers — a cost estimate on a brief, and condensed-by-default packs — are
  **features**, best contributed to `cli-continues`.
- **`agentlock` (enforced cross-agent lock-on-write): 🟢 the stronger opening.** Research found
  *no* tool does enforced (vs advisory) cross-vendor lock-on-write, and all three agents now have
  the blocking-hook primitive needed to build it. Design: `../../agentlock/DESIGN.md`.

## Recommended next move (priority order)
1. **Don't build Baton as-is.** Avoid duplicating cli-continues / CodeRabbit.
2. **Contribute** the cost-estimate + condensed-pack features to `cli-continues` (impact without
   building/marketing a whole tool).
3. **If you want to build something new → `agentlock`.** It's the genuine gap. Validate voiced
   demand first (the one dimension this research couldn't quantify).
4. Keep `docs/` + `PRIOR_ART.md` as a reusable research asset.

## What this repo now contains
```
baton/
├── README.md          # original pitch (kept for context)
├── BUILD.md           # original build plan (now superseded by VERDICT — see report/)
├── PRIOR_ART.md       # reusable OSS codebases catalog
├── docs/              # research findings (01 coordination · 02 handoff market · 03 export tools)
└── report/            # outcomes (VERDICT.md · SUMMARY.md)
```
> Note: `BUILD.md` reflects the original (pre-verdict) plan. Read `report/VERDICT.md` first — the
> recommendation is to pivot, not to execute BUILD.md as written.
