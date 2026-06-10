/**
 * `baton hooks install claude [--project]` — wire Claude Code's Stop and
 * PreCompact hooks to `baton pass --auto`, so a brief is (re)generated when a
 * session ends or is about to compact.
 *
 * Honest limitation: Claude Code exposes no "rate-limited" hook event, so
 * Stop + PreCompact are the closest proxies for "this session is winding
 * down". `baton pass` stays the explicit path. `--auto` no-ops outside a
 * baton worktree, so installing user-wide is safe.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitRoot } from '../git.js';

const HOOK_CMD = 'baton pass --auto';

interface HookEntry { type: string; command: string }
interface HookMatcher { matcher?: string; hooks: HookEntry[] }
interface ClaudeSettings { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown }

function ensureHook(settings: ClaudeSettings, event: string): boolean {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const present = settings.hooks[event].some((m) => m.hooks?.some((h) => h.command === HOOK_CMD));
  if (present) return false;
  settings.hooks[event].push({ hooks: [{ type: 'command', command: HOOK_CMD }] });
  return true;
}

export async function hooksInstallCmd(agent: string, opts: { project?: boolean }): Promise<void> {
  if (agent !== 'claude') {
    console.error(`only 'claude' hooks are supported for now (got '${agent}')`);
    process.exitCode = 1;
    return;
  }
  const file = opts.project
    ? join(await gitRoot(), '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

  let settings: ClaudeSettings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(await readFile(file, 'utf-8')) as ClaudeSettings;
    } catch {
      console.error(`refusing to overwrite ${file} — it exists but is not valid JSON; fix it first`);
      process.exitCode = 1;
      return;
    }
  }

  const added = [ensureHook(settings, 'Stop'), ensureHook(settings, 'PreCompact')].filter(Boolean).length;
  if (!added) {
    console.log(`hooks already installed in ${file}`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`✓ added Stop + PreCompact hooks (${HOOK_CMD}) to ${file}`);
  console.log('  When a Claude Code session ends in a baton worktree, a HANDOFF.md brief is generated automatically.');
  console.log('  Note: there is no rate-limit hook event — Stop/PreCompact are the closest proxies; `baton pass` is always available manually.');
}
