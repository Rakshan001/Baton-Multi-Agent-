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
import { newCmd } from './commands/new.js';
import { lsCmd } from './commands/ls.js';
import { statusCmd } from './commands/status.js';
import { historyCmd } from './commands/history.js';
import { serveCmd } from './commands/serve.js';
import { mergeCmd } from './commands/merge.js';
import { rmCmd } from './commands/rm.js';
import { pathCmd } from './commands/path.js';
import { kbInitCmd, kbMcpCmd, kbRebuildCmd, kbStatusCmd } from './commands/kb.js';
import { mcpCmd } from './commands/mcp.js';
import { blameCmd, signalsCmd } from './commands/signals.js';
import { passCmd } from './commands/pass.js';
import { doneCmd, takeCmd } from './commands/take.js';
import { hooksInstallCmd } from './commands/hooks.js';

const program = new Command();

program
  .name('baton')
  .description('Tiny worktree orchestration for multiple AI coding agents')
  .version('0.0.1');

program
  .command('new')
  .argument('<task...>', 'task description')
  .description('scaffold a branch + worktree for a task')
  .action((task: string[]) => run(() => newCmd(task.join(' '))));

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
  .description('start the local JSON API for the web dashboard')
  .action((opts: { port?: string; write?: boolean }) => run(() => serveCmd(opts)));

program
  .command('rm')
  .argument('<slug>', 'task slug')
  .option('-f, --force', 'remove even with uncommitted changes')
  .description("remove a task's worktree + branch")
  .action((slug: string, opts: { force?: boolean }) => run(() => rmCmd(slug, opts)));

const kb = program
  .command('kb')
  .description('knowledge base: graphify code graphs per project + merged view');

kb.command('init')
  .argument('[path]', 'folder to index (default: repo root; sub-projects auto-detected)')
  .option('--no-mcp', 'skip writing graphify MCP servers to .mcp.json')
  .option('--no-docs', 'skip adding the coordination guide to AGENTS.md/CLAUDE.md')
  .description('set up the knowledge base: graph per sub-project + merged graph + git hooks')
  .action((path: string | undefined, opts: { mcp?: boolean; docs?: boolean }) => run(() => kbInitCmd(path, opts)));

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
  .description('print MCP config so an agent can query the knowledge graph')
  .action((opts: { agent?: string }) => run(() => kbMcpCmd(opts)));

program
  .command('pass')
  .argument('[slug]', 'task slug (default: the worktree you are in)')
  .option('--to <agent>', 'receiving agent: cursor | codex | gemini | any', 'any')
  .option('--note <text>', 'extra context for the receiving agent')
  .option('--from <agent>', 'handing-off agent (default claude)')
  .option('--no-commit-pending', 'skip the checkpoint commit of uncommitted changes')
  .option('--auto', 'quiet hook mode: no-op outside a worktree, skip if a fresh brief exists')
  .description('package this session into a HANDOFF.md brief for another agent')
  .action((slug: string | undefined, opts: { to?: string; note?: string; from?: string; commitPending?: boolean; auto?: boolean }) =>
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
  .description('auto-generate a handoff brief when a Claude Code session ends (Stop/PreCompact)')
  .action((agent: string, opts: { project?: boolean }) => run(() => hooksInstallCmd(agent, opts)));

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
