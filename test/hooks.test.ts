import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { hooksFile, withBatonHooks, withCursorHooks } from '../src/commands/hooks.js';

type Settings = Parameters<typeof withBatonHooks>[0];

describe('withBatonHooks — the hook set `baton hooks install claude` writes', () => {
  it('adds Stop + PreCompact (handoff), PreToolUse (guard), and SessionStart (orient)', () => {
    const settings: Settings = {};
    const added = withBatonHooks(settings);
    expect(added).toBe(4);
    expect(settings.hooks!.Stop[0].hooks[0].command).toBe('baton pass --auto');
    expect(settings.hooks!.PreCompact[0].hooks[0].command).toBe('baton pass --auto');
    const guard = settings.hooks!.PreToolUse[0];
    expect(guard.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(guard.hooks[0].command).toBe('baton guard');
    expect(settings.hooks!.SessionStart[0].hooks[0].command).toBe('baton orient --auto');
  });

  it('is idempotent — a second run adds nothing', () => {
    const settings: Settings = {};
    withBatonHooks(settings);
    expect(withBatonHooks(settings)).toBe(0);
  });

  it('preserves unrelated existing hooks', () => {
    const settings: Settings = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }] },
    };
    withBatonHooks(settings);
    expect(settings.hooks!.PreToolUse).toHaveLength(2);
    expect(settings.hooks!.PreToolUse[0].hooks[0].command).toBe('my-linter');
  });
});

describe('hooksFile — where `hooks install --project` writes', () => {
  let hub = '', projA = '', worktree = '';

  beforeAll(async () => {
    hub = realpathSync(await mkdtemp(join(tmpdir(), 'baton-hooksfile-')));
    projA = join(hub, 'proj-a');
    await mkdir(projA, { recursive: true });
    await git(['init', '-q'], projA);
    await git(['config', 'user.email', 'test@baton.dev'], projA);
    await git(['config', 'user.name', 'Baton Test'], projA);
    await git(['config', 'core.hooksPath', '/dev/null'], projA);
    await git(['checkout', '-q', '-b', 'main'], projA);
    await writeFile(join(projA, 'README.md'), '# r\n', 'utf-8');
    await git(['add', '.'], projA);
    await git(['commit', '-q', '-m', 'initial'], projA);
    await mkdir(join(hub, '.baton'), { recursive: true });
    await writeFile(join(hub, '.baton', 'kb.json'), JSON.stringify({
      root: hub,
      projects: [{ id: 'proj-a', name: 'proj-a', path: projA, graphPath: join(projA, 'g.json') }],
      mergedGraphPath: join(hub, '.baton', 'kb', 'm.json'),
      lastBuiltAt: null,
    }), 'utf-8');
    worktree = (await createTask('Hooks probe', hub, 'proj-a')).worktreePath;
  }, 60_000);
  afterAll(async () => { if (hub) await rm(hub, { recursive: true, force: true }); });

  it('writes to the hub root, which is not a git repo — the install used to die there', async () => {
    expect(await hooksFile('claude', { project: true }, hub, {})).toBe(join(hub, '.claude', 'settings.json'));
    expect(await hooksFile('cursor', { project: true }, hub, {})).toBe(join(hub, '.cursor', 'hooks.json'));
  });

  it('writes to the OWNING root from inside a task worktree, not the worktree', async () => {
    // The worktree is deleted on merge, so hooks installed into it are hooks
    // that silently disappear — after a command that printed "✓ installed".
    const file = await hooksFile('claude', { project: true }, worktree, {});
    expect(file).toBe(join(hub, '.claude', 'settings.json'));
    expect(file.startsWith(worktree)).toBe(false);
  });

  it('honours BATON_ROOT, so a baton-spawned agent installs where it was launched from', async () => {
    expect(await hooksFile('claude', { project: true }, worktree, { BATON_ROOT: hub }))
      .toBe(join(hub, '.claude', 'settings.json'));
  });

  it('without --project stays user-wide, wherever it is run from', async () => {
    expect(await hooksFile('claude', {}, worktree, {})).toBe(join(homedir(), '.claude', 'settings.json'));
    expect(await hooksFile('cursor', {}, hub, {})).toBe(join(homedir(), '.cursor', 'hooks.json'));
  });
});

describe('withCursorHooks — the hook set `baton hooks install cursor` writes (M2)', () => {
  it('adds afterFileEdit → baton guard --agent cursor to an empty config', () => {
    const config: Record<string, unknown> = {};
    const added = withCursorHooks(config);
    expect(added).toBeGreaterThan(0);
    const hooks = (config as { hooks: Record<string, Array<{ command: string }>> }).hooks;
    expect(hooks.afterFileEdit.some((h) => h.command.includes('baton guard --agent cursor'))).toBe(true);
    expect((config as { version: number }).version).toBe(1);
  });

  it('is idempotent and preserves a user\'s own hooks', () => {
    const config: Record<string, unknown> = {
      version: 1,
      hooks: { afterFileEdit: [{ command: './my-formatter.sh' }] },
    };
    withCursorHooks(config);
    expect(withCursorHooks(config)).toBe(0); // second run adds nothing
    const after = (config as { hooks: Record<string, Array<{ command: string }>> }).hooks.afterFileEdit;
    expect(after.some((h) => h.command === './my-formatter.sh')).toBe(true);
    expect(after.filter((h) => h.command.includes('baton guard'))).toHaveLength(1);
  });
});
