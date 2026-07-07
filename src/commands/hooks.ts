/**
 * `baton hooks install claude [--project]` — wire Claude Code's hooks to Baton:
 *
 *   Stop + PreCompact → `baton pass --auto`   (handoff brief when a session
 *     ends or is about to compact — no rate-limit event exists, these are the
 *     closest proxies; `baton pass` stays the explicit path)
 *   PreToolUse (Edit|Write|MultiEdit|NotebookEdit) → `baton guard`   (advisory
 *     collision note at the moment of editing — see commands/guard.ts)
 *
 * Both commands no-op outside a baton worktree, so installing user-wide is safe.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitRoot } from '../git.js';

const PASS_CMD = 'baton pass --auto';
const GUARD_CMD = 'baton guard';
const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

interface HookEntry { type: string; command: string }
interface HookMatcher { matcher?: string; hooks: HookEntry[] }
interface ClaudeSettings { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown }

function ensureHook(settings: ClaudeSettings, event: string, command: string, matcher?: string): boolean {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const present = settings.hooks[event].some((m) => m.hooks?.some((h) => h.command === command));
  if (present) return false;
  settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  return true;
}

/** Merge Baton's hook set into Claude settings; returns how many were newly added. */
export function withBatonHooks(settings: ClaudeSettings): number {
  return [
    ensureHook(settings, 'Stop', PASS_CMD),
    ensureHook(settings, 'PreCompact', PASS_CMD),
    ensureHook(settings, 'PreToolUse', GUARD_CMD, GUARD_MATCHER),
  ].filter(Boolean).length;
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

  const added = withBatonHooks(settings);
  if (!added) {
    console.log(`hooks already installed in ${file}`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`✓ added Stop + PreCompact (${PASS_CMD}) and PreToolUse (${GUARD_CMD}) hooks to ${file}`);
  console.log('  Session end/compact → a HANDOFF.md brief is generated automatically.');
  console.log('  Before each file edit → an advisory note if another session holds that file (never blocks).');
  console.log('  Note: there is no rate-limit hook event — Stop/PreCompact are the closest proxies; `baton pass` is always available manually.');
}
