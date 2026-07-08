import { describe, it, expect } from 'vitest';
import { withBatonHooks, withCursorHooks } from '../src/commands/hooks.js';

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
