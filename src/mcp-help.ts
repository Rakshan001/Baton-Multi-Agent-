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
  // Progressive disclosure (M2) is deliberately NOT described here: the `ids`
  // schema field + the in-answer tip teach it exactly when a preview row
  // appears — cheaper than a permanent description tax in every session.
  recall_memory:
    'Recall project memory BEFORE exploring — facts earlier sessions learned, evidence-checked; stale facts are withheld, so results are safe to trust. Pass a topic to rank by relevance.',
  create_handoff:
    'Write a handoff brief (done / pending / next step / decisions) so another agent can resume this work. Call when near your usage or context limit, blocked, or asked to hand off. Returns the brief path + pickup command.',
  search_history:
    'Search merged commit history by keywords (messages + touched file paths). Cheaper and more precise than git-log spelunking: "when/where was X changed and by which task?" in one call.',
} as const;

/** Hard total budget (chars) across all descriptions — the T1 regression lock.
 *  Raised 1900 → 2100 when save_progress (ISS-06) joined as the 13th tool: the
 *  agent-agnostic progress channel is always-on context, so it is budgeted like
 *  the rest. Keep new tools lean; a further raise needs a deliberate edit. */
export const TOOL_HELP_BUDGET = 2100;
