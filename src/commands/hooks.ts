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
const ORIENT_CMD = 'baton orient --auto';

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
    ensureHook(settings, 'SessionStart', ORIENT_CMD),
  ].filter(Boolean).length;
}

const CURSOR_GUARD_CMD = 'baton guard --agent cursor';

interface CursorHooksConfig { version?: number; hooks?: Record<string, Array<{ command: string }>>; [k: string]: unknown }

/**
 * Merge Baton's hook into a Cursor hooks.json (M2). Cursor's dialect: a
 * `{version:1, hooks:{<event>:[{command}]}}` file; `afterFileEdit` fires per
 * edited file with `file_path`, `workspace_roots`, and a `conversation_id`
 * session identity — exactly what `baton guard` needs to record the edit
 * signal. Non-destructive and idempotent, like withBatonHooks.
 */
export function withCursorHooks(config: CursorHooksConfig): number {
  config.version ??= 1;
  config.hooks ??= {};
  config.hooks['afterFileEdit'] ??= [];
  if (config.hooks['afterFileEdit'].some((h) => h.command === CURSOR_GUARD_CMD)) return 0;
  config.hooks['afterFileEdit'].push({ command: CURSOR_GUARD_CMD });
  return 1;
}

export async function hooksInstallCmd(agent: string, opts: { project?: boolean }): Promise<void> {
  if (agent === 'cursor') return hooksInstallCursor(opts);
  if (agent !== 'claude') {
    console.error(`hooks are supported for 'claude' and 'cursor' (got '${agent}')`);
    console.error(`  codex/gemini/antigravity sessions coordinate via the baton MCP tools (touch_files/check_files) instead.`);
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
  console.log(`✓ installed Baton hooks in ${file}: Stop/PreCompact, PreToolUse (${GUARD_CMD}), SessionStart (${ORIENT_CMD}).`);
  console.log('  Session start → a budgeted project brief (memory, recent work, structure).');
  console.log('  Session end/compact → a HANDOFF.md brief is generated automatically.');
  console.log('  Before each file edit → an advisory note if another session holds that file (never blocks).');
  console.log('  Note: there is no rate-limit hook event — Stop/PreCompact are the closest proxies; `baton pass` is always available manually.');
}

/** `baton hooks install cursor [--project]` — wire Cursor's afterFileEdit to the guard (M2). */
async function hooksInstallCursor(opts: { project?: boolean }): Promise<void> {
  const file = opts.project
    ? join(await gitRoot(), '.cursor', 'hooks.json')
    : join(homedir(), '.cursor', 'hooks.json');

  let config: Parameters<typeof withCursorHooks>[0] = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(await readFile(file, 'utf-8')) as Parameters<typeof withCursorHooks>[0];
    } catch {
      console.error(`refusing to overwrite ${file} — it exists but is not valid JSON; fix it first`);
      process.exitCode = 1;
      return;
    }
  }

  const added = withCursorHooks(config);
  if (!added) {
    console.log(`hooks already installed in ${file}`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`✓ installed Baton hooks in ${file}: afterFileEdit → baton guard --agent cursor.`);
  console.log('  Every Cursor edit now records a live signal (works at the repo root, no daemon needed),');
  console.log('  so Claude/Codex/other sessions see what Cursor is touching — and vice versa.');
  console.log('  Restart Cursor (or reload the window) for hooks.json to take effect.');
}
