import { describe, it, expect } from 'vitest';
import { withBatonHooks } from '../src/commands/hooks.js';

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
