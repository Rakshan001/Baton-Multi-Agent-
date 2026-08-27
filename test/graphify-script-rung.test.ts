// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { uvScriptInstall, uvScriptHint, installHint, UV_INSTALLER_URL, UV_INSTALLER_URL_WINDOWS, type GraphifyDetection } from '../src/kb/graphify.js';
import { graphifyStep, looksLikeInstaller } from '../src/commands/setup.js';

/**
 * The last rung of the graphify ladder.
 *
 * A machine with no uv, no pipx and no package manager had no route to the
 * knowledge graph at all: `graphifyStep` returned 'no-installer' and
 * `offerGraphify` printed a hint and returned BEFORE asking anything. The graph
 * was unreachable on a stock machine, and the user was never even asked.
 *
 * The rung added here is a remote script, so the boundary that matters is not
 * whether it runs but WHO decided: interactively the URL is on screen and the
 * answer is the user's; under --yes there is nobody to ask and it must stay a
 * printed hint.
 */
const det = (over: Partial<GraphifyDetection> = {}): GraphifyDetection =>
  ({ ok: false, uv: false, pipx: false, brew: false, winget: false, ...over });

describe('uvScriptInstall — the last rung', () => {
  it('offers the installer on a stock POSIX machine', () => {
    expect(uvScriptInstall(det(), 'darwin')).toEqual({ url: UV_INSTALLER_URL, shell: 'sh' });
    expect(uvScriptInstall(det(), 'linux')).toEqual({ url: UV_INSTALLER_URL, shell: 'sh' });
  });

  it('never competes with a route that already works', () => {
    expect(uvScriptInstall(det({ ok: true }), 'darwin')).toBeNull();
    expect(uvScriptInstall(det({ uv: true }), 'darwin')).toBeNull();
    expect(uvScriptInstall(det({ pipx: true }), 'darwin')).toBeNull();
  });

  it('yields to a signed package manager', () => {
    expect(uvScriptInstall(det({ brew: true }), 'darwin')).toBeNull();
    expect(uvScriptInstall(det({ winget: true }), 'win32')).toBeNull();
  });

  // Windows used to return null here — see the Windows block below for why it
  // no longer does, and what it returns instead.

});

describe('graphifyStep — who gets asked', () => {
  it('reaches the script rung instead of dead-ending, when interactive', () => {
    const step = graphifyStep(det(), {}, true);
    expect(step.kind).toBe('script-uv');
    if (step.kind === 'script-uv') expect(step.url).toBe(UV_INSTALLER_URL);
  });

  it('refuses to reach for a remote script under --yes', () => {
    // The regression that matters: nobody is present to read the URL, so this
    // must stay a hint no matter how badly the graph is wanted.
    expect(graphifyStep(det(), { yes: true }, true).kind).toBe('no-installer');
  });

  it('refuses without a TTY, even interactively-invoked', () => {
    // askYesNo returns its fallback on EOF, and this rung's fallback is yes.
    // `baton setup < /dev/null` in CI or a cron wrapper must therefore never
    // reach it: a default taken against a closed stdin is not consent.
    expect(graphifyStep(det(), {}, false).kind).toBe('no-installer');
  });

  it('still prefers a package manager when one exists', () => {
    expect(graphifyStep(det({ brew: true }), {}, true).kind).toBe('bootstrap-uv');
    expect(graphifyStep(det({ uv: true }), {}, true).kind).toBe('offer');
    expect(graphifyStep(det({ ok: true }), {}, true).kind).toBe('already');
  });

  it('a package-manager route is unaffected by the TTY gate', () => {
    // Only the remote script needs a human. Signed argv installers keep the
    // behaviour they had before this rung existed.
    expect(graphifyStep(det({ brew: true }), {}, false).kind).toBe('bootstrap-uv');
    expect(graphifyStep(det({ uv: true }), {}, false).kind).toBe('offer');
  });
});

/**
 * Windows.
 *
 * winget ships with Windows 10 1709+ and Windows 11, so the rung above covers
 * almost every machine. It is genuinely absent on older builds, on LTSC images
 * and wherever an administrator disabled it — and those users got no route at
 * all, plus a `curl … | sh` hint that PowerShell cannot run.
 */
describe('the installer rung on Windows', () => {
  const bare = det();

  it('offers the PowerShell installer, not the shell script', () => {
    const s = uvScriptInstall(bare, 'win32');
    expect(s).toEqual({ url: UV_INSTALLER_URL_WINDOWS, shell: 'powershell' });
  });

  it('still offers the shell script on POSIX', () => {
    expect(uvScriptInstall(bare, 'darwin')).toEqual({ url: UV_INSTALLER_URL, shell: 'sh' });
  });

  it('yields to winget when it is there', () => {
    expect(uvScriptInstall(det({ winget: true }), 'win32')).toBeNull();
  });

  it('never hands a Windows user a POSIX command', () => {
    const hint = uvScriptHint({ url: UV_INSTALLER_URL_WINDOWS, shell: 'powershell' });
    expect(hint).toContain('powershell');
    expect(hint).not.toContain('| sh');
  });
});

describe('looksLikeInstaller', () => {
  it('rejects a captive portal or error page on both platforms', () => {
    const html = '<!DOCTYPE html><html><body>Sign in to continue</body></html>';
    expect(looksLikeInstaller(html, 'sh')).toBe(false);
    expect(looksLikeInstaller(html, 'powershell')).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(looksLikeInstaller('   ', 'sh')).toBe(false);
    expect(looksLikeInstaller('', 'powershell')).toBe(false);
  });

  it('accepts each platform its own installer shape', () => {
    expect(looksLikeInstaller('#!/bin/sh\necho hi\n', 'sh')).toBe(true);
    // PowerShell has no shebang; a leading comment or param block is normal.
    expect(looksLikeInstaller('# uv installer\nparam()\n', 'powershell')).toBe(true);
    expect(looksLikeInstaller('# not a shell script', 'sh')).toBe(false);
  });
});

describe('installHint never hands a user another platform\'s command', () => {
  it('gives Windows a PowerShell command when winget is missing', () => {
    const hint = installHint(det(), 'win32');
    expect(hint).toContain('powershell');
    expect(hint).not.toContain('| sh');
    expect(hint).toContain('install.ps1');
  });

  it('gives POSIX the shell command', () => {
    const hint = installHint(det(), 'darwin');
    expect(hint).toContain('| sh');
    expect(hint).not.toContain('powershell');
  });

  it('prefers winget on Windows over any script', () => {
    expect(installHint(det({ winget: true }), 'win32')).toContain('winget install');
  });
});
