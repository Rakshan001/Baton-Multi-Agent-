// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turning "graphify is missing" into a command Baton may actually run.
 *
 * `installHint` already produces a sentence for a human to copy. Running one on
 * someone's behalf needs something stricter: an argv array, never a string —
 * a string would have to be handed to a shell, and the hint's last variant
 * carries a parenthetical URL that a shell would try to execute.
 */
import { describe, it, expect } from 'vitest';
import { graphifyInstallCommand } from '../src/kb/graphify.js';

describe('graphifyInstallCommand', () => {
  it('prefers uv, the installer the docs recommend', () => {
    expect(graphifyInstallCommand({ ok: false, uv: true, pipx: true })).toEqual({
      cmd: 'uv',
      args: ['tool', 'install', 'graphifyy'],
    });
  });

  it('falls back to pipx when uv is absent', () => {
    expect(graphifyInstallCommand({ ok: false, uv: false, pipx: true })).toEqual({
      cmd: 'pipx',
      args: ['install', 'graphifyy'],
    });
  });

  it('declines to guess when neither installer exists', () => {
    // Reaching for bare `pip` here would install into whatever Python happens
    // to be first on PATH — frequently the system one, which is exactly where
    // a package should not go. The user gets the hint instead.
    expect(graphifyInstallCommand({ ok: false, uv: false, pipx: false })).toBeNull();
  });

  it('has nothing to do when graphify is already installed', () => {
    expect(graphifyInstallCommand({ ok: true, version: '0.4.0', uv: true, pipx: true })).toBeNull();
  });

  it('never returns a shell string, so no argument can be interpreted', () => {
    const cmd = graphifyInstallCommand({ ok: false, uv: true, pipx: false });
    expect(Array.isArray(cmd?.args)).toBe(true);
    expect(cmd?.cmd).not.toContain(' ');
  });
});
