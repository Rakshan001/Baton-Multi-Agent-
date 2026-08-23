// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Getting the knowledge graph onto a machine that has nothing.
 *
 * graphify is a Python CLI, and Baton already refuses to install it with bare
 * `pip` — pip lands in whichever Python leads PATH, often the system one, and
 * choosing that for someone silently is worse than showing them the command.
 * The consequence was that a laptop with no uv and no pipx got a hint and no
 * graph, which is where this starts.
 *
 * The fix is to install `uv` first, and the rule for *that* is the same rule,
 * one level down: Baton runs a package manager, and never a script it just
 * downloaded. `brew install uv` is an argv array against a signed formula.
 * `curl -LsSf https://astral.sh/uv/install.sh | sh` is a remote script piped
 * into a shell, and a tool that coordinates agents over your source code has
 * no business doing that on your behalf. So it gets printed, never run.
 */
import { describe, it, expect } from 'vitest';
import { uvInstallCommand, installHint, type GraphifyDetection } from '../src/kb/graphify.js';
import { graphifyStep } from '../src/commands/setup.js';

const missing = (over: Partial<GraphifyDetection> = {}): GraphifyDetection =>
  ({ ok: false, uv: false, pipx: false, brew: false, winget: false, ...over });

describe('uvInstallCommand', () => {
  it('uses brew when it is there', () => {
    expect(uvInstallCommand(missing({ brew: true }))).toEqual({ cmd: 'brew', args: ['install', 'uv'] });
  });

  it('uses winget on Windows', () => {
    const cmd = uvInstallCommand(missing({ winget: true }));
    expect(cmd?.cmd).toBe('winget');
    expect(cmd?.args.join(' ')).toContain('astral-sh.uv');
  });

  it('prefers brew when both are somehow present', () => {
    expect(uvInstallCommand(missing({ brew: true, winget: true }))?.cmd).toBe('brew');
  });

  // The whole point of the decision: no package manager means no automatic
  // install, because the only remaining route is a downloaded script.
  it('returns null with no package manager, rather than reaching for curl', () => {
    expect(uvInstallCommand(missing())).toBeNull();
  });

  it('never offers to install uv when uv is already here', () => {
    expect(uvInstallCommand(missing({ uv: true, brew: true }))).toBeNull();
  });

  // An argv array and never a string: a string implies a shell.
  it('returns argv, never a shell string', () => {
    const cmd = uvInstallCommand(missing({ brew: true }))!;
    expect(Array.isArray(cmd.args)).toBe(true);
    expect(cmd.cmd).not.toMatch(/[|;&><]/);
    for (const a of cmd.args) expect(a).not.toMatch(/[|;&><]/);
  });
});

describe('installHint when nothing is installed', () => {
  // It used to lead with `pip install graphifyy`, the one route Baton itself
  // refuses to take. Telling someone to run by hand the thing you declined to
  // run for them, for reasons that apply equally to them, is bad advice.
  it('leads with uv rather than bare pip', () => {
    const hint = installHint(missing());
    expect(hint).toContain('uv');
    expect(hint.indexOf('uv')).toBeLessThan(hint.indexOf('pip') === -1 ? Infinity : hint.indexOf('pip'));
  });

  it('gives the official installer for a machine with no package manager', () => {
    expect(installHint(missing())).toContain('astral.sh/uv/install.sh');
  });

  it('still prefers a package manager when one exists', () => {
    expect(installHint(missing({ brew: true }))).toContain('brew install uv');
  });

  it('is unchanged when uv or pipx is already available', () => {
    expect(installHint(missing({ uv: true }))).toBe('uv tool install graphifyy');
    expect(installHint(missing({ pipx: true }))).toBe('pipx install graphifyy');
  });
});

describe('graphifyStep — bootstrapping uv', () => {
  it('says nothing to do when graphify is already installed', () => {
    expect(graphifyStep({ ok: true, uv: true, pipx: true, brew: true, winget: false }, {}).kind).toBe('already');
  });

  it('installs graphify directly when uv is already present', () => {
    const step = graphifyStep(missing({ uv: true }), {});
    expect(step.kind).toBe('offer');
    if (step.kind === 'offer') expect(step.args).toContain('graphifyy');
  });

  // The new path: nothing installed, but brew can bootstrap the chain.
  it('offers to install uv first when brew is available', () => {
    const step = graphifyStep(missing({ brew: true }), {});
    expect(step.kind).toBe('bootstrap-uv');
    if (step.kind === 'bootstrap-uv') {
      expect(step.cmd).toBe('brew');
      expect(step.line).toBe('brew install uv');
      expect(step.then).toBe('uv tool install graphifyy');
    }
  });

  it('falls back to guidance when there is no package manager', () => {
    const step = graphifyStep(missing(), {});
    expect(step.kind).toBe('no-installer');
    if (step.kind === 'no-installer') expect(step.hint).toContain('astral.sh/uv/install.sh');
  });

  // --yes is what CI and Dockerfiles run, and is precisely where an unasked-for
  // `brew install` is least welcome. The rule survives the new path.
  it('never installs uv under --yes', () => {
    expect(graphifyStep(missing({ brew: true }), { yes: true }).kind).toBe('deferred');
  });

  it('tells a --yes run both commands it skipped', () => {
    const step = graphifyStep(missing({ brew: true }), { yes: true });
    if (step.kind === 'deferred') {
      expect(step.line).toContain('brew install uv');
      expect(step.then).toBe('uv tool install graphifyy');
    }
  });
});
