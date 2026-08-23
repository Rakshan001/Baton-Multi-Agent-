// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P4 — talking to the `orca` CLI, decided before anything is executed.
 *
 * Pure argv and pure parsing, because the alternative is finding out what this
 * layer does by launching an Electron app. Every envelope shape here was read
 * out of Orca's own source (`src/shared/runtime-rpc-envelope.ts`,
 * `src/cli/format.ts`), not guessed from documentation.
 */
import { describe, it, expect } from 'vitest';
import {
  STRIPPED_ORCA_ENV,
  orcaBinary,
  orcaEnv,
  parseOrcaEnvelope,
  terminalCreateArgs,
  terminalSendArgs,
  terminalWaitArgs,
  terminalReadArgs,
  terminalCloseArgs,
  repoListArgs,
} from '../src/executors/orca-cli.js';

describe('orcaBinary — P4-E3', () => {
  it('is `orca` on macOS and Windows', () => {
    expect(orcaBinary({}, 'darwin')).toBe('orca');
    expect(orcaBinary({}, 'win32')).toBe('orca');
  });

  it('is `orca-ide` on Linux, where bare `orca` is the GNOME screen reader', () => {
    // Running the wrong one starts speech on the user's machine.
    expect(orcaBinary({}, 'linux')).toBe('orca-ide');
  });

  it('honours ORCA_CLI_COMMAND above the platform default', () => {
    // Orca exports this for managed WSL sessions, where neither default is right.
    expect(orcaBinary({ ORCA_CLI_COMMAND: 'orca-dev' }, 'linux')).toBe('orca-dev');
  });

  it('ignores an empty override rather than execing the empty string', () => {
    expect(orcaBinary({ ORCA_CLI_COMMAND: '  ' }, 'linux')).toBe('orca-ide');
  });
});

describe('orcaEnv — the fence', () => {
  it('strips the attestation variables from every exec', () => {
    // A Baton daemon that happens to run inside an Orca terminal inherits these,
    // and every `orca` call it makes is then attested as THAT terminal — so the
    // dispatcher's own calls get fenced as if an agent had made them.
    const env = orcaEnv({ PATH: '/bin', ORCA_TERMINAL_HANDLE: 'h1', ORCA_PANE_KEY: 'p', ORCA_AGENT_LAUNCH_TOKEN: 't' });
    for (const key of STRIPPED_ORCA_ENV) expect(env[key], key).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('names all three, so adding one to the list is the only change needed', () => {
    expect([...STRIPPED_ORCA_ENV].sort()).toEqual(
      ['ORCA_AGENT_LAUNCH_TOKEN', 'ORCA_PANE_KEY', 'ORCA_TERMINAL_HANDLE']
    );
  });
});

describe('argv construction', () => {
  it('creates a terminal in a Baton worktree by absolute path', () => {
    // Baton owns the git checkout; Orca only runs a process inside it. `path:`
    // is the only selector that can name a worktree Orca did not create.
    expect(terminalCreateArgs({ cwd: '/repo/.baton/wt/add-auth', command: 'claude -p x', slug: 'add-auth' }))
      .toEqual([
        'terminal', 'create',
        '--worktree', 'path:/repo/.baton/wt/add-auth',
        '--command', 'claude -p x',
        '--title', 'baton:add-auth',
        '--json',
      ]);
  });

  it('waits for the TUI rather than assuming it is ready', () => {
    expect(terminalWaitArgs('h1', 60_000)).toEqual(
      ['terminal', 'wait', '--terminal', 'h1', '--for', 'tui-idle', '--timeout-ms', '60000', '--json']
    );
  });

  it('sends the pointer with --enter, or it sits in the buffer unsubmitted', () => {
    expect(terminalSendArgs('h1', 'read HANDOFF.md')).toEqual(
      ['terminal', 'send', '--terminal', 'h1', '--text', 'read HANDOFF.md', '--enter', '--json']
    );
  });

  it('reads incrementally from a cursor when one is known', () => {
    expect(terminalReadArgs('h1')).toEqual(['terminal', 'read', '--terminal', 'h1', '--json']);
    expect(terminalReadArgs('h1', 'c42')).toEqual(
      ['terminal', 'read', '--terminal', 'h1', '--cursor', 'c42', '--json']
    );
  });

  it('closes by handle', () => {
    expect(terminalCloseArgs('h1')).toEqual(['terminal', 'close', '--terminal', 'h1', '--json']);
  });

  it('lists repos, which is how registration is checked', () => {
    expect(repoListArgs()).toEqual(['repo', 'list', '--json']);
  });
});

describe('parseOrcaEnvelope — P4-E6', () => {
  it('reads a success envelope', () => {
    const out = parseOrcaEnvelope('{"id":"1","ok":true,"result":{"handle":"h1"},"_meta":{"runtimeId":"r"}}');
    expect(out).toEqual({ ok: true, result: { handle: 'h1' } });
  });

  it('reads a failure envelope and keeps the code', () => {
    const out = parseOrcaEnvelope('{"id":"local","ok":false,"error":{"code":"selector_not_found","message":"no worktree"},"_meta":{"runtimeId":null}}');
    expect(out).toEqual({ ok: false, code: 'selector_not_found', message: 'no worktree' });
  });

  it('treats output that is not an envelope as a failure, never as success', () => {
    // A CLI that printed a warning, or a different program on PATH named `orca`.
    for (const bad of ['', 'not json', '{"ok":"yes"}', 'null', '[]']) {
      expect(parseOrcaEnvelope(bad), bad).toMatchObject({ ok: false, code: 'orca_unparseable' });
    }
  });

  it('survives a leading line before the JSON', () => {
    // Node deprecation warnings and shim banners land on stdout in the wild.
    const out = parseOrcaEnvelope('(node:1) warning\n{"id":"1","ok":true,"result":1,"_meta":{"runtimeId":"r"}}');
    expect(out).toEqual({ ok: true, result: 1 });
  });

  it('gives a failure with no code a code rather than undefined', () => {
    const out = parseOrcaEnvelope('{"id":"1","ok":false,"error":{"message":"boom"},"_meta":{"runtimeId":null}}');
    expect(out).toMatchObject({ ok: false, code: 'orca_error', message: 'boom' });
  });
});
