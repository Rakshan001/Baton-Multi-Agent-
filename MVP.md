# Baton — refined MVP spec (session relay)

> Supersedes the original `BUILD.md` scope. Decision basis: `report/VERDICT-refined-scope.md`.
> **Verdict: GO** on Feature 1 (local auto-handoff). Feature 2 (sharing) later, redaction-first.

**What Baton is now:** a tool that turns a live AI-coding session into a portable **knowledge
pack**, and — when you're about to hit your usage limit — hands it off to another agent
(Cursor / Codex / ChatGPT) so work continues instead of being lost.

---

## The graphify-style pipeline (the core engine)

Same shape as graphify (walk → parse → incremental cache → enrich → output), applied to sessions:

```
1. SOURCE     ~/.claude/projects/<slug>/<uuid>.jsonl   (+ Cursor ~/.cursor/projects/*/agent-transcripts/*.jsonl)
2. PARSE      JSONL events → { messages, tool_calls, file_edits, branch, model, tokens, timestamps }
3. INCREMENTAL  track last-processed byte-offset/line per session (JSONL is append-only) → process only new events
4. CONDENSE   LLM pass → clean knowledge pack: objective, decisions, files touched, branch, what's done, open tasks, next steps  (strip tool spam)
5. OUTPUT     HANDOFF.md (portable artifact)
6. TRANSFER   to a target agent (clipboard / file / invoke) — manually OR auto on rate-limit
```

## Feature 1 — auto rate-limit handoff (THE MVP, local-only)

### Logic
1. **Watch usage** — read ccusage data / Claude Code session usage; estimate % of limit used
   (burn-rate like Claude-Code-Usage-Monitor).
2. **Trigger** at a threshold (default 80%) — via a Claude Code **hook** (`PreCompact`/`Stop`) or a
   background watcher; optionally emit a **webhook / socket.io** event.
3. **Package** the session → run the pipeline above → `HANDOFF.md` (+ metadata: agent, branch, model).
4. **Hand off** — present a target choice (Cursor / Codex / ChatGPT) and:
   - render a tight execution prompt, copy to clipboard, OR
   - write the file where the target agent will read it, OR
   - invoke the target CLI.
5. **Clean UI** (optional, M2) — a small local web UI: "You're at 82% — transfer to: [Cursor] [Codex] [ChatGPT] [Push code]". Shows history, branch, what was done.

### Build cost: LOW — pure local. Hooks + ccusage parsing + CLI. No backend, no secret risk.

### Commands
```
baton watch                 # background: monitor usage, fire at threshold
baton pack [--session <id>] # build the knowledge pack now
baton handoff --to cursor   # package + render/transfer to target
baton status                # current session + usage %
```

## Feature 2 — shareable continuation (LATER, redaction-first)

Genuinely novel (no tool lets someone open a *link* and continue your agent's work with
permissions). **But the moat is the hard part**, so phase it:
1. **`baton export --redacted`** → a shareable *file* with secrets/keys stripped (local, safe).
2. **Link sharing** → minimal backend stores the redacted pack, returns a URL.
3. **Permissions** → email invite / access control / expiry (Google-Docs-style).
4. **Continue-in-your-agent** → recipient runs `baton take <url>` to resume in their own tool.

**Risk to design around first:** session data contains source code + API keys. Secret redaction
(regex + entropy scan for keys, optional allowlist) is the prerequisite for ANY sharing. Do not
ship sharing without it.

## What's reused vs built
- **Reuse:** ccusage (usage/limit data), Claude JSONL + Cursor JSONL parsers (see PRIOR_ART.md),
  Claude Code hooks (trigger).
- **Build (original):** the condense-to-knowledge-pack step, the auto-trigger→handoff flow, the
  multi-target transfer, (later) redaction + shareable links.

## Differentiators (why this isn't duplicative)
- vs `cli-continues` (manual, local): **automatic on rate-limit** + **clean UI** + **multi-target**.
- vs `budget-rescue` (Codex-only, folder): **multi-agent targets** + condensed pack + UI.
- vs SpecStory (read-only share): **continue-the-work** sharing with permissions (Feature 2).

## Milestones
- **M0** — JSONL parser + `pack` (session → knowledge pack). The engine.
- **M1** — `watch` + threshold trigger + `handoff --to` (the auto-handoff MVP). ← ship this.
- **M2** — clean local web UI (transfer buttons, history, branch view).
- **M3** — `export --redacted` (secret-safe file sharing).
- **M4** — link sharing + permissions (the hosted Feature 2; only after traction).

## Validate before heavy investment
Demand is inferred, not counted. Post the M1 MVP to r/ClaudeAI / r/cursor / HN; if "you're about
to hit your limit → here's your session, continue in Cursor" resonates, push to M2+.
