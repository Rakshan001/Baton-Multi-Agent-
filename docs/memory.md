# Project memory

Baton's shared memory lets agents persist what they learn — decisions, gotchas, conventions, references — so the next agent doesn't re-discover them by re-reading the repo. Every fact is **anchored to evidence**, so it can never silently rot into a hallucination. Memory always lives in the **main repository**, shared across all task worktrees.

Source: [`src/memory.ts`](../src/memory.ts), CLI in [`src/commands/memory.ts`](../src/commands/memory.ts).

## What gets stored

Each fact is one markdown file (with gray-matter frontmatter) under `.baton/memory/facts/` in the **main repo** — never per-worktree. Writes are atomic (tmp + rename) so multiple parallel sessions can write without clobbering each other.

A fact records:

| Field | Meaning |
| --- | --- |
| `fact` | The insight itself (1–3 sentences: why + how to apply). |
| `type` | One of `decision`, `gotcha`, `convention`, `reference`, `preference` (default `reference`). |
| `agent` | Who saved it (CLI saves as `cli`). |
| `task` | The task slug it came from, if any. |
| `created` | ISO timestamp. |
| `commit` | HEAD when the fact was learned (an evidence anchor). |
| `files` | Repo-relative paths the fact is about, each stored as `path@hash` (evidence anchors). |
| `supersedes` | The id of an older fact this one replaced. |

## The anti-hallucination model

A fact is only as trustworthy as the code it describes. Baton enforces this with **evidence anchors**:

- **Commit anchor** — the `HEAD` commit when the fact was saved.
- **File anchors** — a SHA-1 content hash of each referenced file at save time (up to 8 files).

On **every read**, Baton re-checks the anchors:

1. It re-hashes each anchored file and compares it to the stored hash.
2. If a file changed (or was deleted), the fact is marked **`stale`** with a reason like `src/server.ts changed since this was saved` or `src/server.ts no longer exists`.
3. If the files are unchanged but the repo has moved on (the anchored commit is behind `HEAD`), the fact is marked **`aging`** and annotated with how many commits old it is.
4. Otherwise the fact is **`fresh`**.

The freshness states are surfaced everywhere:

| State | Marker | Meaning |
| --- | --- | --- |
| `fresh` | `●` | Anchors unchanged, repo at the same commit. |
| `aging` | `◐` | Files unchanged, but the repo moved on. |
| `stale` | `○` | An anchored file changed or was deleted. |

**Stale facts are withheld from agents.** When an agent recalls memory, stale facts are excluded from the returned bodies — only counted and named in the summary. A stale "fact" presented as truth is exactly how a model hallucinates, so Baton refuses to serve it as fresh truth.

## Secret rejection

Memory files are plain text read by every agent, so a pasted credential would replicate into every session. `saveMemory` refuses anything that matches a secret pattern — private key blocks, AWS access key ids, `sk-…` API keys, GitHub tokens, Slack tokens, JWTs, and inline `password=`/`token=`/`api_key=` assignments. The save fails with a message telling you to describe *where* the credential lives instead of pasting it.

## Caps

| Limit | Value |
| --- | --- |
| Max characters per fact | **1200** |
| Max facts stored | **500** |

A fact under 10 characters is also rejected (write a real sentence). When the store hits 500 facts, saves fail until you reclaim space with `baton memory gc`.

Near-duplicates are handled automatically: when a new fact shares an opening fingerprint *and* its body is sufficiently similar to an existing one, the new fact **supersedes** the old one (the old file is archived after the new one lands).

## Nothing is hard-deleted: the journal & archive

Every removal — manual `rm`, `gc`, supersession, bulk delete, retention pruning — **moves** the fact file to `.baton/memory/archive/` and appends a line to a JSONL journal recording *what* was removed, *why*, and *when* (and, for supersession, *by which* fact). `baton memory log` prints it newest-first:

```bash
baton memory log
```

So a "deleted" fact is always recoverable, and you can audit why the store shrank — useful when several agents share one memory and one of them gc's.

## CLI

```bash
baton memory list              # show all facts with freshness + anchors
baton memory add "<fact>" [--type <t>] [--files a.ts,b.ts] [--task <slug>]
baton memory rm <id>           # archive one fact by id
baton memory gc                # archive all stale facts (changed/removed anchors)
baton memory log               # journal of removals/supersessions (newest first)
```

Example listing:

```text
● [convention] mem-daemon-stays-zero-dependency
    The daemon in src/server.ts is raw node:http — no express/fastify.
    by cli · anchors: src/server.ts
◐ [decision] mem-realtime-is-sse-not-socket-io · 4 commits old
    Realtime flows through the SSE bus in src/events.ts, not socket.io.
○ [gotcha] mem-git-calls-go-through-exec · STALE: src/util/exec.ts changed since this was saved
    All git calls go through src/util/exec.ts (shell-free, hardened).

3 facts · 1 stale (run: baton memory gc)
```

`baton memory add` records the agent as `cli`; pass `--type` to set the category, `--files` (comma-separated, repo-relative) to anchor it to evidence, and `--task` to attribute it to a task. `--files` and `--type` are what make a fact stale-checkable and relevant-rankable, so anchor your facts whenever you can.

## MCP tools

Agents save and recall memory through the Baton coordination MCP server (`baton mcp`):

- **`save_memory`** — store a new fact (same validation as the CLI: length cap, secret rejection, cap of 500).
- **`recall_memory`** — return the facts an agent should read: **fresh + aging only**, relevance-ranked when a topic is given. Stale facts are dropped from the bodies and reported as a withheld count.

Memory also appears in handoff briefs: `baton pass` embeds a compact "Project memory (evidence-checked)" section of the top fresh facts, with a note about how many stale memories were withheld.

## Retention policy

Beyond manual `gc`, you can set a persisted retention policy (stored at `.baton/memory/retention.json`) that prunes automatically. A policy can drop facts that are:

- **older than N days** (`maxAgeDays`),
- **stale** (`dropStale` — changed/removed anchors, same as `gc`), or
- **aging** (`dropAging` — the repo moved on, even if files are unchanged).

The policy is editable from the dashboard Memory page and applied via the daemon (`POST /api/memory/retention`, `POST /api/memory/prune`). See [HTTP API](./architecture.md) for the write endpoints.

## Dashboard Memory page

The daemon-served dashboard at `http://localhost:7077` includes a **Memory** page that lists every fact with its freshness marker, anchors, and attribution. With the daemon started in `--write` mode you can add, delete (single or bulk), prune, and edit the retention policy directly from the UI. Reads go through `GET /api/memory`; mutations require `--write` plus a loopback Origin (see [Security](./security.md)).

## Why memory lives in the main repo

Every memory function resolves the **main repository root** itself — via the git common dir — even when called from inside a task worktree. A `baton pass` triggered by a Claude Code Stop hook deep inside `.baton/wt/<slug>`, or a daemon started in the wrong directory, can never read or write a per-worktree shadow store. Shared memory is the whole point: what one agent learns, every agent sees.

## Next steps

- [CLI reference](./cli-reference.md) — every `baton` command and flag.
- [MCP tools](./mcp-tools.md) — `save_memory`, `recall_memory`, and the rest of the coordination toolkit.
- [Handoffs](./session-handoff.md) — how memory rides along in a `baton pass` brief.

Back to the [README](../README.md).
