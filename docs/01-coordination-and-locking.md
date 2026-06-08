# Research 01 — Coordinating multiple different agents on one repo

**Questions:** Can Cursor + Claude Code + Gemini + local agents work on the same folder without
clobbering each other? What tools exist? Can edits be *enforced*-blocked, not just advised?

## Bottom line

- **No single turnkey product** does enforced cross-vendor lock-on-write on one shared folder.
- The mature pattern is **isolation (worktrees/containers) + a shared coordination service (MCP
  or git task board) + shared rules (AGENTS.md)** — assembled, not bought.
- It **is** buildable now, because all three agents shipped **synchronous pre-write blocking
  hooks** in the last ~12 months. That's the missing primitive that makes *enforced* locking
  (not advisory) possible. **This is a genuinely open niche** (the "agentlock" idea).

## The cross-agent connector: MCP
Cursor, Claude Code, and Gemini CLI are all MCP clients → one custom **coordination MCP server**
can expose `claim / lock / heartbeat / who` tools they all call. Transport: `stdio` (local,
no auth) or `streamable-http` (multi-machine, with an `Authorization` header).

## Enforcement: pre-write blocking hooks (the key finding)

| Agent | Hook | Deny mechanism |
|---|---|---|
| Claude Code | `PreToolUse` on `Edit\|Write\|MultiEdit` | `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` or exit 2. Fires **even under `--dangerously-skip-permissions`** |
| Cursor (v1.7+, Oct 2025) | generic `preToolUse` (no edit-specific hook) | `{"permission":"deny","agent_message":"…"}` or exit 2 |
| Gemini CLI | `BeforeTool` on `write_file`/`replace` | `{"decision":"deny","reason":"…"}` or exit 2 |

All release locks on `SessionEnd`/`Stop`; TTL backstops crashes.

## Worktree/container runners (isolation approach)
Conductor (Claude+Codex, Mac), **Sculptor** (Imbue — containers), Crystal→Nimbalyst (OSS),
**claude-squad** (agent-agnostic), uzi, Vibe Kanban, Superset, Backlog.md (git task board + MCP).

## Closest OSS to fork for a *locking* tool
| Project | Notes |
|---|---|
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (~1.9k) | Agent identities, inboxes, **advisory file leases + TTL**. Best fork base — add enforcement hooks. |
| [madebyaris/agent-orchestration](https://github.com/madebyaris/agent-orchestration) | MCP `lock_acquire/release`, shared memory, heartbeat |
| [Beads](https://github.com/steveyegge/beads) | Dolt issue/dependency graph, collision-free IDs |
| [GNAP](https://github.com/farol-team/gnap) / [GitAgent](https://github.com/open-gitagent/gitagent-protocol) | Git-native task protocols (RFC-stage) |

## Agent-to-agent protocols (NOT the right layer)
Google **A2A** (Linux Foundation, v1.0; absorbed IBM ACP) and Cisco **AGNTCY** are enterprise
agent *discovery/delegation* buses — they don't address repo-edit collisions. Don't use for this.

## Shared rules standard
**AGENTS.md** — read natively by Cursor/Gemini/Codex; **Claude Code needs a `CLAUDE.md`
symlink/import**. One AGENTS.md + a CLAUDE.md shim gives every agent the same "lock-first" rule.

## The hard problems (for whoever builds the locker)
Advisory-unless-hook-installed · forgotten release (need TTL + heartbeat) · single vs
multi-machine · granularity (file/folder easy, symbol-level hard) · deadlock · the real adoption
blocker = getting every vendor to install the hook (ship a one-command installer).

## Prototype produced this session
A working file-based prototype of the lock engine lives in the FAT_FOX workspace
(`scripts/ws-lock.sh`, `ws-heartbeat.sh`, `ws-worktree.sh`) — proves the lock/heartbeat/worktree
model. Full design for productizing it: `../../agentlock/DESIGN.md` (sibling folder).

**Sources:** Claude hooks (code.claude.com/docs/en/hooks) · Cursor hooks (cursor.com/docs/hooks,
InfoQ 2025-10) · Gemini hooks (geminicli.com/docs/hooks/reference) · MCP (code.claude.com/docs/en/mcp)
· mcp_agent_mail · agent-orchestration · Beads · GNAP · GitAgent · agents.md · a2a-protocol.org · agntcy
