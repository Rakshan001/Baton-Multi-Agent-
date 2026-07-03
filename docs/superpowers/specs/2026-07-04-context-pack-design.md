# Context pack — shareable project brief for any chatbot

**Date:** 2026-07-04 · **Status:** approved · **Command:** `baton kb context`

## Problem

Users hit chat limits on their coding agents and want to continue the
conversation in an external chatbot (ChatGPT, Grok, DeepSeek). The chatbot
knows nothing about the project, and explaining a 150-file codebase by hand —
folder structure, what each part does, conventions — is impractical. Baton
already holds all of that knowledge (codebase map, knowledge graph, memory
facts) but has no way to hand it to something outside the MCP world.

Research context (2026-07): Repomix / gitingest / code2prompt all concatenate
file bodies — wrong for "understand my project" (and too big to paste).
Aider's repo map proves a whole repo's ranked structure fits in ~1–8k tokens.
ChatGPT free accepts only ~8k tokens of paste (Grok free ~32k, DeepSeek
~128k). Nobody ships a summary-first, multi-repo, one-click pack.

## Decision summary

One command / one click renders the project (or the whole hub) into a single
markdown document, **≤ ~8k tokens by default**, generated deterministically
from artifacts Baton already maintains — no LLM call, instant, free, and
nothing invented. Copy-to-clipboard and download-as-`.md` in the dashboard.

- Depth: **understand + discuss** — no source code, no code skeletons.
  (User decision 2026-07-03; a skeleton tier is future work.)
- Name: `kb context` — distinct from `kb export` (machine tarball for
  Baton-to-Baton transfer). Docs must state the difference.

## Document layout

Sections in order, each rendered by a pure function:

| # | Section | Source | ~Budget |
|---|---------|--------|---------|
| 1 | Header | kb.json, git HEAD, stats | 150 tok |
| 2 | Overview | README extract + CLAUDE.md/AGENTS.md conventions | 400–800 |
| 3 | Stack & commands | existing `detectStack()` + npm scripts | 150 |
| 4 | Folder tree | existing `scanDir()`/`renderTree()` | 500–1500 |
| 5 | Key code symbols | top ~20 god nodes from graph, `file:line` | 400–800 |
| 6 | Project memory | existing `memoryBriefSection()` — fresh facts only | 300–600 |
| 7 | Footer | token estimate + fit line | 100 |

**Header** includes an explicit instruction to the receiving model:

> This is a generated context pack. Full source code is NOT included. If you
> need the contents of a specific file, ask the user to paste it.

Telling the model what it cannot see is the anti-hallucination measure for
the paste-target side, mirroring stale-fact withholding on the agent side.

**Overview extraction (deterministic, no LLM):** README title + the first
meaningful paragraphs (skip badge lines, HTML blocks, license footers), capped
by budget. If CLAUDE.md / AGENTS.md / `.github/copilot-instructions.md`
exist, append a short **Conventions** subsection from their first bullets.
No README → fall back to detected stack + a "no README found" note.

**Hub mode (`project=all`, the default on a hub):** shared header, a
"How the repos relate" list (one line per sub-repo: name, relative path,
detected stack, README one-liner), then a mini-section per sub-repo
(overview + tree + symbols) with the per-repo budget = remaining budget /
project count. `--project <id>` renders a single sub-repo pack instead.

## Budget enforcement

`--tokens <n>` (default 8000) is a hard ceiling, not a hope:

1. Render all sections at natural size; estimate via the existing
   chars/4 heuristic (keeps the daemon zero-dependency; the footer states
   "~N tokens (approximate)").
2. If over budget, trim deterministically in this order until it fits:
   tree lines (renderTree max-lines parameter halves), then symbol count
   (20 → 10 → 5), then overview paragraph count (down to 1).
3. Never trim the header or footer. If still over after all trims (pathological
   hub), drop per-project symbol sections before per-project trees, and note
   each omission in the pack ("(section omitted to fit the token budget)").

No silent truncation: every trim that removes a whole section leaves a
one-line marker.

## Secret safety

The pack contains no file bodies, but README/config excerpts can leak. The
final markdown passes a regex scan (AWS access keys `AKIA[0-9A-Z]{16}`,
private-key PEM headers, `(api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}`,
long base64/hex literals ≥ 32 chars in assignment position). Matches are
replaced with `[REDACTED]` and a warning banner is prepended listing the
count. Scan runs in all surfaces (CLI, API, UI).

## Surfaces

**CLI:** `baton kb context [--project <id>] [--out <file.md>] [--tokens <n>]`
— writes markdown to stdout by default (`baton kb context | pbcopy` is the
one-liner); `--out` writes a file and prints a confirmation with the token
count to stderr. Works without a running daemon (direct library call).

**API:** `GET /api/kb/context?project=<id|all>&tokens=<n>` →
`200 text/markdown; charset=utf-8`. Read-only: no `--write` gate (consistent
with `GET /api/kb/export`); loopback-only daemon as always. Unknown project →
404 JSON. Content-Disposition left inline (download handled client-side).

**Dashboard:** a **Share context** button on the Knowledge Base screen opens
a modal: markdown preview (scrollable `<pre>`), token count + fit chips
("ChatGPT free ✓ / Grok ✓ / DeepSeek ✓" from thresholds 8k/32k/128k),
**Copy** (existing `CopyButton` / `copyText()` helper), **Download .md**
(client-side Blob + anchor download, named `<project>-context.md`). Demo mode
(`BatonAPI.demo`) returns a bundled fixture pack so the showcase keeps working.

## Architecture

New module `src/kb/contextpack.ts`:

```ts
export interface ContextPackOptions { project?: string; maxTokens?: number } // default 8000
export interface ContextPack { markdown: string; tokens: number; redactions: number; omitted: string[] }
export async function buildContextPack(root: string, state: KbState | null, opts?: ContextPackOptions): Promise<ContextPack>
```

- Composes the section renderers; every section renderer is a pure function
  `(inputs) => string[]` unit-testable without git or a graph.
- Reuses `scanDir`/`renderTree`/`detectStack` from `codebasemd.ts` (export
  them; do not duplicate). Reuses `memoryBriefSection()` from `memory.ts` and
  god-node extraction from the graph-loading path in `codebasemd.ts`.
- Degrades gracefully: `state === null` (no `baton kb init` yet) → header,
  overview, stack, tree only, plus a note that the deeper map needs
  `baton kb init`. Missing graph file for a project → symbols section skipped
  with a note. Missing sub-repo path in a hub → skipped with a warning line.
- CLI command in `src/commands/kb.ts` (+ `src/cli.ts` registration); route in
  `src/server.ts`; UI in `web/src/features/KnowledgeGraph.tsx` + `api.ts`.

## Edge cases

| Case | Behavior |
|------|----------|
| No `.baton/` / no KB | Works: README + stack + tree, note about `kb init` |
| No README | Stack-derived overview + explicit "no README" note |
| Empty/tiny repo | Small pack; no errors |
| Huge repo | Existing caps: scanDir depth 3 / 120 lines, 20k-file measure cap |
| Hub sub-repo path missing | Skipped + warning line in pack |
| Unknown `--project` | CLI error / 404 listing valid ids |
| Secrets in README | Redacted + warning banner |
| Stale graph | Symbols section notes graph `builtAt` |
| Symlinks / binaries | Existing renderTree handling (marked / listed only) |
| Non-UTF-8 / CRLF | Read as UTF-8, normalize line endings in extracts |
| Demo mode | Fixture pack, no daemon calls |

## Testing

Vitest, following existing patterns (fixture repos under `test/`):

- Composer: deterministic output (two runs byte-identical), budget trimming
  (each trim stage), no-README fallback, hub multi-project rendering,
  missing-graph degradation, secret redaction (each pattern), omission markers.
- CLI: `--out` writes file; unknown project errors.
- Server: route returns markdown + correct Content-Type; 404 unknown project;
  works read-only (no `--write`).
- UI: fit-chip thresholds (pure function test).

## Out of scope (parked)

- Code-skeleton tier (~30k tokens) and size tiers — future flag if asked for.
- LLM-written narrative summaries — deterministic-only by standing decision.
- Import direction ("paste a prompt to reconstruct memory") — `kb import`
  already covers Baton-to-Baton; chatbot→Baton import is a separate feature.
- Token-saving research follow-ups tracked elsewhere: cache-aligned context
  emission, session-delta handoff digest, signature tier + AST-aware chunking
  (fold into the unified-search build), lean AGENTS.md footprint.
