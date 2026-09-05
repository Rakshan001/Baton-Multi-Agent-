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
    'Short project brief for a fresh session: evidence-checked memory, recent work, structure, coordination. Call once at session start, before exploring.',
  check_files:
    'Are these files being edited by another session (live signals + unmerged branch changes)? Call BEFORE editing shared files; if busy, prefer other work and re-check. watcherActive:false means "not busy" is unproven.',
  list_signals:
    'Every file under live edit across sessions right now. level "warning" = 2+ sessions on the same path.',
  get_report:
    'Completion report of a merged task (summary, files, commits) — check whether your issue is already fixed before re-doing work. Omit slug for recent reports.',
  who_touched:
    'Which task/agent/commits touched a file: merged history + who is editing it live.',
  list_tasks:
    'All Baton sessions (worktrees) with status, agent, ahead/behind.',
  report_progress:
    'One line on what you are doing right now — siblings see it on your files and route around you. Expires in 30 min, clears on commit; refresh as you go.',
  save_progress:
    'Persist your live plan, notes, and next step for THIS task so a handoff or cutoff snapshot carries them — for agents with no transcript to mine (Cursor/Codex/Gemini). Full plan replaces; files add.',
  touch_files:
    'Declare files YOU are editing (live signals). Call when you start editing shared files — especially at the repo root where no watcher covers you. Self-cleans once committed.',
  save_memory:
    'Persist a LEARNED fact (decision, gotcha, convention): 1-3 sentences, why + how to apply. Pass the repo-relative files it is about — evidence anchors; if they change it is flagged stale. Never store secrets or code-derivable facts.',
  // The anti-capture gate (memory-durability.ts) is deliberately NOT described
  // here either: T1 leaves 4 chars of budget (2096/2100), and a rule that fires on a
  // minority of saves does not deserve a permanent tax on every session. The
  // rejection message names the class AND the rewrite, which teaches it at the
  // one moment the agent is able to act on it.
  // Progressive disclosure (M2) is deliberately NOT described here: the `ids`
  // schema field + the in-answer tip teach it exactly when a preview row
  // appears — cheaper than a permanent description tax in every session.
  recall_memory:
    'Recall project memory BEFORE exploring — facts earlier sessions learned, evidence-checked; stale facts are withheld, so results are safe to trust. Pass a topic to rank by relevance.',
  create_handoff:
    'Write a handoff brief (done / pending / next step / decisions) so another agent can resume this work. Call when near your usage or context limit, blocked, or asked to hand off. Returns the brief path + pickup command.',
  search_history:
    'Search merged commit history by keywords (messages + touched file paths). Cheaper and more precise than git-log spelunking: "when/where was X changed and by which task?" in one call.',
  // The four pipeline tools. Their bodies carry the next command in every
  // answer, so nothing situational is paid for here — only the trigger.
  my_tasks:
    'Do you have a pending task? What you hold now, what you may start, what awaits your verdict. Call at session start and after finishing anything.',
  take_task:
    'Claim a task and get the worktree to work in. Work ONLY inside the path it returns — that isolation is what lets other agents run at the same time.',
  complete_task:
    'Finish a task you hold. Commit everything first: uncommitted work is refused, and a task with no commits is never accepted as done. Stopping early is not finishing — use report_blocked or `baton pause`.',
  // The handoff relay's two ends. Baton had a writer (create_handoff) and no
  // closer at all, so briefs accumulated forever and the pickup list stopped
  // meaning anything. These are the pick-up and the hang-up.
  next_handoff:
    'Which handoff brief to pick up next: one ready brief with its resume prompt, what can run in parallel beside it, and what is blocked on what. Call at session start and after you close one.',
  resolve_handoff:
    'Close a handoff brief you finished, with a short report of what you did for whoever reviews it. Call the moment the work is done — nothing else marks a brief done, so an unclosed brief is offered to the next agent forever.',
  report_blocked:
    'You cannot proceed. Records the reason and keeps the task yours. Reach for this instead of guessing at the blocker, and instead of reporting work you did not do.',
} as const;

/** Hard total budget (chars) across all descriptions — the T1 regression lock.
 *  Raised 1900 → 2100 when save_progress (ISS-06) joined as the 13th tool: the
 *  agent-agnostic progress channel is always-on context, so it is budgeted like
 *  the rest. Raised 2100 → 2800 for the four pipeline tools, deliberately and
 *  once: "do you have a pending task?" is the product, and an agent that cannot
 *  see the pipeline from inside its own session has to be driven by hand. The
 *  situational detail still costs nothing — every answer carries its own next
 *  command. Keep new tools lean; a further raise needs a deliberate edit.
 *  Raised 2800 → 3200 for next_handoff + resolve_handoff: an agent that cannot
 *  ask what to pick up, or say that it finished, leaves the relay running on
 *  copy-paste — which is the manual step this whole feature exists to remove. */
export const TOOL_HELP_BUDGET = 3200;
