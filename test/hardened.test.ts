import { describe, it, expect } from 'vitest';
import { hardenedArgs, gitEnv } from '../src/util/exec.js';
import { parseConflicts, CONFLICT_LABELS } from '../src/git.js';

describe('hardenedArgs', () => {
  it('prepends -c config flags before the subcommand', () => {
    const out = hardenedArgs(['status', '--porcelain=v2']);
    // original args are preserved at the tail, in order
    expect(out.slice(-2)).toEqual(['status', '--porcelain=v2']);
    // pager and credential helper are neutralized
    expect(out).toContain('core.pager=cat');
    expect(out).toContain('credential.helper=');
    // every -c is paired with a value
    expect(out.filter((a) => a === '-c').length).toBeGreaterThan(0);
  });

  it('keeps an existing -C path valid (config flags come first)', () => {
    const out = hardenedArgs(['-C', '/some/path', 'status']);
    expect(out[out.length - 3]).toBe('-C');
    expect(out[out.length - 2]).toBe('/some/path');
    expect(out[out.length - 1]).toBe('status');
  });
});

describe('gitEnv', () => {
  it('strips interactive/redirecting env vars and numbered GIT_CONFIG_* keys', () => {
    const env = gitEnv(
      {
        GIT_ASKPASS: '/usr/bin/ssh-askpass',
        GIT_SSH_COMMAND: 'ssh -v',
        GIT_CONFIG_KEY_0: 'core.pager',
        GIT_CONFIG_VALUE_0: 'less',
        PATH: '/usr/bin',
      },
      'linux',
    );
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin'); // unrelated vars survive
  });

  it('forces non-interactive flags', () => {
    const env = gitEnv({}, 'linux');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_ASKPASS).toBe('true'); // POSIX fast-fail
  });

  it('does not set GIT_ASKPASS=true on win32 (not on PATH there)', () => {
    const env = gitEnv({}, 'win32');
    expect(env.GIT_ASKPASS).toBeUndefined();
  });
});

describe('parseConflicts', () => {
  it('parses porcelain v2 unmerged entries with labels', () => {
    // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const raw = [
      '1 .M N... 100644 100644 100644 abc abc README.md',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 src/Nav.tsx',
      'u AA N... 000000 100644 100644 100644 h1 h2 h3 src/New.ts',
    ].join('\n');
    const out = parseConflicts(raw);
    expect(out).toEqual([
      { path: 'src/Nav.tsx', xy: 'UU', label: 'both modified' },
      { path: 'src/New.ts', xy: 'AA', label: 'both added' },
    ]);
  });

  it('returns [] when there are no unmerged entries', () => {
    expect(parseConflicts('1 M. N... 100644 100644 100644 a a foo.ts')).toEqual([]);
    expect(parseConflicts('')).toEqual([]);
  });

  it('falls back to the raw xy code for unknown labels', () => {
    expect(CONFLICT_LABELS.UU).toBe('both modified');
    const out = parseConflicts('u ZZ N... 1 2 3 4 h1 h2 h3 weird.ts');
    expect(out[0]).toEqual({ path: 'weird.ts', xy: 'ZZ', label: 'ZZ' });
  });
});
