#!/usr/bin/env node
/**
 * Baton — tiny personal worktree orchestration for running several AI agents
 * on one repo without hand-juggling `git worktree`.
 *
 *   baton new "<task>"   scaffold a branch + worktree, record the task
 *   baton ls             list tasks with status / ahead-behind / age
 *   baton merge <slug>   merge a task branch into the current branch
 *   baton rm <slug>      remove a task's worktree + branch
 *   baton path <slug>    print a task's worktree path
 */
import './util/quiet.js'; // FIRST: suppress node:sqlite experimental warning before any sqlite load
import { Command } from 'commander';
import { ensureBinPath } from './util/path-env.js';
import { setupCmd } from './commands/setup.js';
import { newCmd } from './commands/new.js';
import { lsCmd } from './commands/ls.js';
import { statusCmd } from './commands/status.js';
import { historyCmd } from './commands/history.js';
import { serveCmd } from './commands/serve.js';
import { mergeCmd } from './commands/merge.js';
import { rmCmd } from './commands/rm.js';
import { cleanCmd, doctorCmd } from './commands/doctor.js';
import { pathCmd } from './commands/path.js';
import { kbContextCmd, kbExportCmd, kbImportCmd, kbInitCmd, kbMcpCmd, kbRebuildCmd, kbShareCmd, kbStatusCmd } from './commands/kb.js';
import { mcpCmd } from './commands/mcp.js';
import { blameCmd, signalsCmd } from './commands/signals.js';
import { passCmd } from './commands/pass.js';
import { doneCmd, takeCmd } from './commands/take.js';
import { hooksInstallCmd } from './commands/hooks.js';
import { routeCmd } from './commands/route.js';
import { usageCmd } from './commands/usage.js';
import { startCmd, stopCmd } from './commands/start.js';
import { memoryAddCmd, memoryGcCmd, memoryListCmd, memoryLogCmd, memoryRmCmd } from './commands/memory.js';
import { connectCmd } from './commands/connect.js';
import { guardCmd } from './commands/guard.js';
import { orientCmd } from './commands/orient.js';
import { progressCmd } from './commands/progress.js';

// Make sure binaries we shell out to (tmux, graphify, agent CLIs) are findable
// even when launched from a GUI/non-login shell with a thin PATH.
ensureBinPath();

const program = new Command();

program
  .name('baton')
  .description('Tiny worktree orchestration for multiple AI coding agents')
  .version('0.0.1');

program
  .command('setup')
  .argument('[path]', 'folder to set up (default: current directory)')
  .option('--hub', 'multi-repo: one centralized hub (merged graph + one dashboard)')
  .option('--individual', 'multi-repo: set up each repo on its own')
  .option('--yes', 'accept the recommended defaults without prompting')
  .option('--no-mcp', 'skip writing graphify MCP servers to .mcp.json')
  .option('--no-docs', 'skip adding the coordination guide to AGENTS.md/CLAUDE.md')
  .option('--share', 'commit the KB to git so teammates skip re-indexing')
  .option('--local', 'keep the KB local-only (skip the share question)')
  .option('--serve', 'use the dashboard (skip the headless-vs-dashboard prompt)')
  .option('--headless', 'KB only — agents use it over MCP, no dashboard')
  .description('set up Baton for a repo — or a folder of several repos (hub vs individual)')
  .action((path: string | undefined, opts: { hub?: boolean; individual?: boolean; yes?: boolean; mcp?: boolean; docs?: boolean; share?: boolean; local?: boolean; serve?: boolean; headless?: boolean }) =>
    run(() => setupCmd(path, opts)));

program
  .command('connect')
  .option('--agents <list>', 'comma-separated: claude,cursor,codex,gemini (default: all four)')
  .option('--yes', 'also write global ($HOME) configs for codex/gemini')
  .description('wire the baton coordination MCP server into every agent, so they can see each other')
  .action((opts: { agents?: string; yes?: boolean }) => run(() => connectCmd(opts)));

program
  .command('new')
  .argument('<task...>', 'task description')
  .option('--project <id>', 'in a multi-repo hub: which sub-project the task targets')
  .option('--scope <globs>', 'comma-separated path globs this task owns (warns on overlap; steers the agent)')
  .description('scaffold a branch + worktree for a task')
  .action((task: string[], opts: { project?: string; scope?: string }) => run(() => newCmd(task.join(' '), opts)));

program
  .command('ls')
  .description('list tasks with git status, ahead/behind, and age')
  .action(() => run(lsCmd));

program
  .command('status')
  .option('-w, --watch', 'auto-refresh every 2s')
  .description('central view: live agent, status, ahead/behind, likely conflicts')
  .action((opts: { watch?: boolean }) => run(() => statusCmd(opts)));

program
  .command('merge')
  .argument('<slug>', 'task slug')
  .option('--no-squash', 'keep full branch history (default squashes to one commit)')
  .option('--no-archive', 'do not preserve branch history under refs/baton/archive')
  .description("merge a task's branch into the current branch (squash + archive)")
  .action((slug: string, opts: { squash?: boolean; archive?: boolean }) =>
    run(() => mergeCmd(slug, opts)),
  );

program
  .command('history')
  .argument('[file]', 'file path to trace (omit to list all tasks)')
  .description('trace which task/agent/commits touched a file (from the local index)')
  .action((file: string | undefined) => run(() => historyCmd(file)));

program
  .command('serve')
  .option('-p, --port <port>', 'port (default 7077)')
  .option('--write', 'enable write actions (merge / remove) from the dashboard')
  .description('start the local daemon: JSON API + the built web dashboard')
  .action((opts: { port?: string; write?: boolean }) => run(() => serveCmd(opts)));

program
  .command('rm')
  .argument('<slug>', 'task slug')
  .option('-f, --force', 'remove even with uncommitted changes')
  .description("remove a task's worktree + branch")
  .action((slug: string, opts: { force?: boolean }) => run(() => rmCmd(slug, opts)));

program
  .command('doctor')
  .description('audit junk: orphaned worktrees, branches, tmux sessions, leaked temp files')
  .action(() => run(doctorCmd));

program
  .command('clean')
  .option('--fix', 'actually delete the audited junk (default: dry-run / suggest)')
  .option('-f, --force', 'also remove worktrees with uncommitted changes')
  .description('reclaim junk found by `baton doctor` (dry-run unless --fix)')
  .action((opts: { fix?: boolean; force?: boolean }) => run(() => cleanCmd(opts)));

const memory = program
  .command('memory')
  .description('shared project memory: facts agents learned, evidence-anchored');

memory
  .command('list', { isDefault: true })
  .description('list all facts with freshness (● fresh · ◐ aging · ○ stale)')
  .action(() => run(memoryListCmd));

memory
  .command('add')
  .argument('<fact...>', 'the fact (1–3 sentences: why + how to apply)')
  .option('--type <type>', 'decision | gotcha | convention | reference | preference')
  .option('--files <paths>', 'comma-separated repo-relative files (evidence anchors)')
  .option('--task <slug>', 'task slug for attribution')
  .description('save a fact from the terminal')
  .action((fact: string[], opts: { type?: string; files?: string; task?: string }) =>
    run(() => memoryAddCmd(fact.join(' '), opts)));

memory
  .command('rm')
  .argument('<id>', 'memory id')
  .description('remove a fact')
  .action((id: string) => run(() => memoryRmCmd(id)));

memory
  .command('gc')
  .description('drop stale facts (anchored files changed since they were saved)')
  .action(() => run(memoryGcCmd));

memory
  .command('log')
  .description('KB change history: superseded/removed facts (archived, not destroyed)')
  .action(() => run(memoryLogCmd));

const kb = program
  .command('kb')
  .description('knowledge base: graphify code graphs per project + merged view');

kb.command('init')
  .argument('[path]', 'folder to index (default: repo root; sub-projects auto-detected)')
  .option('--no-mcp', 'skip writing graphify MCP servers to .mcp.json')
  .option('--no-docs', 'skip adding the coordination guide to AGENTS.md/CLAUDE.md')
  .option('--share', 'commit the KB to git (kb/ directory) so teammates skip re-indexing')
  .option('--local', 'keep the KB local-only (skip the share question)')
  .option('--port <port>', 'daemon port to embed in the generated MCP config URLs (default 7077)')
  .description('set up the knowledge base: graph per sub-project + merged graph + git hooks')
  .action((path: string | undefined, opts: { mcp?: boolean; docs?: boolean; share?: boolean; local?: boolean; port?: string }) => run(() => kbInitCmd(path, opts)));

kb.command('export')
  .option('--out <file>', 'output file (default: baton-kb-<repo>-<sha>.tar.gz)')
  .description('export the knowledge base as a shareable .tar.gz pack')
  .action((opts: { out?: string }) => run(() => kbExportCmd(opts)));

kb.command('import')
  .argument('<source>', 'a KB pack (.tar.gz) or a committed kb/ directory')
  .option('--no-rebuild', 'skip the automatic incremental refresh when the pack is behind HEAD')
  .description('adopt an exported knowledge base (re-anchored to this repo, staleness-checked)')
  .action((source: string, opts: { rebuild?: boolean }) => run(() => kbImportCmd(source, opts)));

kb.command('share')
  .argument('[mode]', 'on | off (omit to show current mode)')
  .description('toggle git-sharing of the KB via a committed kb/ directory')
  .action((mode: string | undefined) => run(() => kbShareCmd(mode)));

kb.command('status')
  .description('show projects, node/edge counts, last build')
  .action(() => run(kbStatusCmd));

kb.command('rebuild')
  .argument('[project]', 'project id (default: all)')
  .option('--full', 'full re-extract instead of incremental update')
  .description('rebuild graphs (incremental by default, no LLM needed)')
  .action((project: string | undefined, opts: { full?: boolean }) =>
    run(() => kbRebuildCmd(project, opts)));

kb.command('mcp')
  .option('--agent <agent>', 'claude | cursor | codex | gemini', 'claude')
  .option('--port <port>', 'daemon port to embed in the generated MCP config URLs (default 7077)')
  .description('print MCP config so an agent can query the knowledge graph')
  .action((opts: { agent?: string; port?: string }) => run(() => kbMcpCmd(opts)));

kb.command('context')
  .argument('[path]', 'project or hub root (default: nearest .baton, else git root)')
  .option('--project <id>', 'hub: render one sub-project instead of the combined pack')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('--tokens <n>', 'token budget (default 8000 — fits ChatGPT free tier)')
  .description('print a shareable markdown context pack for any external chatbot (pipe to pbcopy)')
  .action((path: string | undefined, opts: { project?: string; out?: string; tokens?: string }) =>
    run(() => kbContextCmd(path, opts)));

program
  .command('start')
  .argument('<slug>', 'task slug')
  .option('--agent <agent>', 'claude | codex | gemini (headless print modes)', 'claude')
  .option('--model <model>', "model override passed to the agent CLI (e.g. opus, sonnet, gemini-2.5-pro)")
  .option('--prompt <text>', 'override the prompt (default: HANDOFF.md brief, else the task text)')
  .description("run an agent headlessly in the task's worktree, streaming output")
  .action((slug: string, opts: { agent?: string; model?: string; prompt?: string }) => run(() => startCmd(slug, opts)));

program
  .command('stop')
  .argument('<slug>', 'task slug')
  .description('stop a baton-started headless agent')
  .action((slug: string) => run(() => stopCmd(slug)));

program
  .command('usage')
  .description('real token usage per Claude Code session (parsed from session files, costs estimated)')
  .action(() => run(usageCmd));

program
  .command('route')
  .argument('<task...>', 'task description to route')
  .description('which agent should take this task (rules from baton.config.json, no LLM)')
  .action((task: string[]) => run(() => routeCmd(task.join(' '))));

program
  .command('pass')
  .argument('[slug]', 'task slug (default: the worktree you are in)')
  .option('--to <agent>', 'receiving agent: cursor | codex | gemini | any (omit to auto-route by task type + severity)')
  .option('--model <model>', 'model for the receiving CLI (advisory, recorded in the brief)')
  .option('--note <text>', 'extra context for the receiving agent')
  .option('--from <agent>', 'handing-off agent (default claude)')
  .option('--no-commit-pending', 'skip the checkpoint commit of uncommitted changes')
  .option('--auto', 'quiet hook mode: no-op outside a worktree, skip if a fresh brief exists (briefs are routed by task type unless --to is given)')
  .description('package this session into a HANDOFF.md brief for another agent')
  .action((slug: string | undefined, opts: { to?: string; model?: string; note?: string; from?: string; commitPending?: boolean; auto?: boolean }) =>
    run(() => passCmd(slug, opts)));

program
  .command('take')
  .argument('[slug]', 'task slug (default: the worktree you are in)')
  .description('pick up a HANDOFF.md brief: prints the execution prompt, marks it in-progress')
  .action((slug: string | undefined) => run(() => takeCmd(slug)));

program
  .command('done')
  .argument('[slug]', 'task slug (default: the worktree you are in)')
  .description('mark a handoff brief as done')
  .action((slug: string | undefined) => run(() => doneCmd(slug)));

const hooks = program.command('hooks').description('agent-side hook installation');
hooks
  .command('install')
  .argument('<agent>', 'claude')
  .option('--project', 'install into .claude/settings.json in this repo instead of ~/.claude')
  .description('handoff brief on session end (Stop/PreCompact) + edit-collision guard (PreToolUse)')
  .action((agent: string, opts: { project?: boolean }) => run(() => hooksInstallCmd(agent, opts)));

program
  .command('guard', { hidden: true }) // invoked by the PreToolUse hook, not by humans
  .description('read a Claude Code PreToolUse payload on stdin; warn if the file is held by another session')
  .action(() => run(guardCmd));

program
  .command('orient')
  .option('--auto', 'SessionStart-hook mode: emit as additionalContext, skip if a HANDOFF already oriented the session')
  .description('print a budgeted project brief (memory, recent work, structure) so a fresh session onboards fast')
  .action((opts: { auto?: boolean }) => run(() => orientCmd(opts)));

program
  .command('progress')
  .argument('<note...>', 'one line: what you are working on right now')
  .description('tell other agents your current intent (shown on your files via check_files/list_signals)')
  .action((note: string[]) => run(() => progressCmd(note.join(' '))));

program
  .command('mcp')
  .description('run the Baton coordination MCP server over stdio (check_files, get_report, who_touched…)')
  .action(() => run(mcpCmd));

program
  .command('signals')
  .description('show live edit signals — which files are being edited by which session right now')
  .action(() => run(signalsCmd));

program
  .command('blame')
  .argument('<file>', 'repo-relative file path')
  .description('which task/agent touched a file: live editors + merged history')
  .action((file: string) => run(() => blameCmd(file)));

program
  .command('path')
  .argument('<slug>', 'task slug')
  .description("print a task's worktree path")
  .action((slug: string) => run(() => pathCmd(slug)));

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

program.parseAsync(process.argv);
