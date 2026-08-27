// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { uvScriptInstall, UV_INSTALLER_URL, type GraphifyDetection } from '../src/kb/graphify.js';
import { graphifyStep } from '../src/commands/setup.js';

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
    expect(uvScriptInstall(det(), 'darwin')).toEqual({ url: UV_INSTALLER_URL });
    expect(uvScriptInstall(det(), 'linux')).toEqual({ url: UV_INSTALLER_URL });
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

  it('is null on Windows — the script is POSIX-only', () => {
    expect(uvScriptInstall(det(), 'win32')).toBeNull();
  });
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
