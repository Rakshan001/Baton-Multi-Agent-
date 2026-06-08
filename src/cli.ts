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
  .description('start the local JSON API for the web dashboard')
  .action((opts: { port?: string }) => run(() => serveCmd(opts)));

program
  .command('rm')
  .argument('<slug>', 'task slug')
  .option('-f, --force', 'remove even with uncommitted changes')
  .description("remove a task's worktree + branch")
  .action((slug: string, opts: { force?: boolean }) => run(() => rmCmd(slug, opts)));

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
