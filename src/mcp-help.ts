// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MCP tool descriptions — the fixed context tax every agent session pays (T1).
 * Before this round: 2,799 chars (~700 tokens); now budgeted and invariant-
 * locked (test/mcp-help.test.ts) so neither fat creep nor the loss of a
 * behavioral trigger phrase ("call BEFORE editing…") can land silently.
 * Every word here costs tokens in EVERY session — edit accordingly.
 */
export const TOOL_HELP = {
  orient:
    'Fresh-session brief: evidence-checked memory, recent work, structure, coordination. Call once at session start, before exploring.',
  check_files:
    'Is another session editing these files (live signals + unmerged branches)? Call BEFORE editing shared files; if busy, work elsewhere and re-check. watcherActive:false = "not busy" is unproven.',
  list_signals:
    'Every file under live edit across sessions right now. level "warning" = 2+ sessions on one path.',
  get_report:
    'What a merged task shipped (summary, files, commits): is your issue already fixed, before you re-do it? Omit slug for recent reports.',
  who_touched:
    'Which task/agent/commits touched a file: merged history + who is editing it live.',
  list_tasks:
    'All Baton sessions (worktrees) with status, agent, ahead/behind.',
  report_progress:
    'One line on what you are doing right now; siblings see it on your files and route around you. Expires in 30 min, clears on commit.',
  save_progress:
    'Persist your plan, notes and next step for THIS task so a handoff or cutoff snapshot carries them — for agents with no transcript (Cursor/Codex/Gemini). Plan replaces; files add.',
  touch_files:
    'Declare files YOU are editing (live signals). Call when you start editing shared files, especially at the repo root where no watcher covers you. Clears on commit.',
  save_memory:
    'Persist a LEARNED fact (decision, gotcha, convention): 1-3 sentences, why + how to apply. Pass the files it is about — evidence anchors; if they change it is flagged stale. Never secrets or code-derivable facts.',
  // The anti-capture gate (memory-durability.ts) is deliberately NOT described
  // here either: T1 leaves 4 chars of budget (2096/2100), and a rule that fires on a
  // minority of saves does not deserve a permanent tax on every session. The
  // rejection message names the class AND the rewrite, which teaches it at the
  // one moment the agent is able to act on it.
  // Progressive disclosure (M2) is deliberately NOT described here: the `ids`
  // schema field + the in-answer tip teach it exactly when a preview row
  // appears — cheaper than a permanent description tax in every session.
  recall_memory:
    'Recall project memory BEFORE exploring: what earlier sessions learned, evidence-checked; stale facts are withheld, so hits are safe to trust. Pass a topic to rank by relevance.',
  create_handoff:
    'Handoff brief (done / pending / next / decisions) so another agent can resume this work. Call near your usage or context limit, when blocked, or when asked. Returns the brief path + pickup command.',
  search_history:
    'Search merged commit history by keywords (messages + file paths): "when/where was X changed, and by which task?" in one call. Cheaper than git-log spelunking.',
  // The four pipeline tools. Their bodies carry the next command in every
  // answer, so nothing situational is paid for here — only the trigger.
  my_tasks:
    'Do you have a pending task? What you hold, what you may start, what awaits your verdict. Call at session start and after finishing anything.',
  take_task:
    'Claim a task and get its worktree. Work ONLY inside the path it returns — that isolation is what lets other agents run at the same time.',
  complete_task:
    'Finish a task you hold. Commit everything first: uncommitted work is refused, and a task with no commits is never accepted. Stopping early is not finishing — use report_blocked or `baton pause`.',
  // The handoff relay's two ends. Baton had a writer (create_handoff) and no
  // closer at all, so briefs accumulated forever and the pickup list stopped
  // meaning anything. These are the pick-up and the hang-up.
  next_handoff:
    'Which handoff brief to pick up next: one ready brief with its resume prompt, what can run in parallel, and what is blocked on what. Call at session start and after closing one.',
  resolve_handoff:
    'Close a handoff brief you finished, with a short report of what you did for whoever reviews it. Call the moment the work is done — nothing else closes a brief, and an unclosed one is offered forever.',
  // The skill graph's payoff. The trigger has to fire BEFORE the work, or the
  // agent has already improvised its way through a task a playbook covered.
  suggest_skills:
    'Which skills fit a task, ranked from what this project already has: five one-line summaries, never bodies. Call before starting unfamiliar work.',
  report_blocked:
    'You cannot proceed. Records the reason and keeps the task yours. Reach for this instead of guessing at the blocker, or reporting work you did not do.',
  // The only way an agent learns that another worktree EXISTS. Everything else
  // Baton tells an agent is about FILES (`check_files`, `list_signals`); a
  // sibling that stopped mid-task is invisible until someone reads the
  // dashboard, and agents do not read the dashboard.
  //
  // The four liveness names are spelled out on purpose. `health` is a
  // vocabulary the agent has to ACT on — `abandoned` means "take this over",
  // `quiet` means "leave it alone" — and a value it has to ask about costs more
  // than the twenty-odd bytes of naming it here.
  list_worktrees:
    'Every Baton worktree: branch, holder, state, health (working|quiet|stalled|abandoned) and quiet time; yours is marked mine. Call before assuming a sibling is still working, or before redoing their work.',
} as const;

/** Hard total budget (UTF-8 BYTES) across all descriptions — the T1 regression lock.
 *
 *  UNIT CHANGED 2026-09-07: chars → bytes, same text, no wording touched.
 *  `String.length` counts UTF-16 code units; every neighbouring budget in this
 *  repo counts bytes (test/mcp-wire-budget.test.ts, docs/mcp-tools.md), because
 *  bytes are what a session actually pays. The two had already diverged by 10:
 *  five descriptions carry an em dash at 3 bytes each, so the char total sat
 *  exactly on 3,045 while the real cost was 3,055. The number below therefore
 *  goes UP by 10 without admitting one extra word — it is the same descriptions
 *  measured honestly, and it still sits on the measured value with zero slack.
 *  What it no longer admits is a free em dash, curly quote or ellipsis: under
 *  the old count those cost nothing, which is how a byte budget drifts while
 *  its test stays green.
 *
 *  Raised 1900 → 2100 when save_progress (ISS-06) joined as the 13th tool: the
 *  agent-agnostic progress channel is always-on context, so it is budgeted like
 *  the rest. Raised 2100 → 2800 for the four pipeline tools, deliberately and
 *  once: "do you have a pending task?" is the product, and an agent that cannot
 *  see the pipeline from inside its own session has to be driven by hand. The
 *  situational detail still costs nothing — every answer carries its own next
 *  command. Keep new tools lean; a further raise needs a deliberate edit.
 *  Raised 2800 → 3200 for next_handoff + resolve_handoff: an agent that cannot
 *  ask what to pick up, or say that it finished, leaves the relay running on
 *  copy-paste — which is the manual step this whole feature exists to remove.
 *  LOWERED 3200 → 2901 by the wording trim that took the whole tools/list
 *  handshake from 10,708 to 8,390 bytes: no tool lost a trigger phrase, so the
 *  slack was never buying anything. It sits on the measured value on purpose —
 *  a budget with room left in it is a budget that has already been spent.
 *  Raised 2901 → 3045 for suggest_skills (the 20th tool, 144 chars): an agent
 *  that cannot ask which skill fits the work in front of it improvises through
 *  a task a playbook already covers, which is the failure the skill library
 *  exists to prevent. Sits on the measured value, like every value before it.
 *
 *  RESTATED 3045 -> 3055 as BYTES. Every prior value in this history was a
 *  UTF-16 code-unit count of the same text, which is not what a session pays:
 *  the em dashes and ellipsis in these descriptions cost 3 bytes each on the
 *  wire, so the budget silently meant something different from the byte budget
 *  next to it and was already 10 short of the payload it was policing. No tool
 *  gained a word here — the text is unchanged and the unit was corrected, which
 *  is why the number goes UP without anything having been added.
 *  Raised 3055 → 3257 for list_worktrees (the 21st tool, 202 bytes). The only
 *  tool that tells an agent another WORKTREE exists: everything else Baton
 *  serves an agent is about files, so a sibling that stopped mid-task is
 *  invisible until a human reads the dashboard — and agents do not read the
 *  dashboard. That blind spot is how a half-finished worktree gets abandoned,
 *  reported as done, and then lost with the directory. Sits on the measured
 *  value, like every value before it. */
export const TOOL_HELP_BUDGET = 3257;

/** The tool's ONE argument. A schema is paid for by every agent in every
 *  session whether or not the tool is ever called, so there is no pagination,
 *  no sort, no field selector and no verbosity flag — just this. */
export const WORKTREES_FILTER_HELP = 'Show only this health; default all';
