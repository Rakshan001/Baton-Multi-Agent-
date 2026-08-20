// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one wizard policy worth pinning in a test rather than a comment:
 *
 *   `--yes` accepts every default that touches THIS PROJECT, and never
 *   installs software.
 *
 * It is the rule most likely to be "simplified" later by someone reasoning that
 * --yes means yes to everything. It does not: --yes is what CI, Dockerfiles and
 * provisioning scripts run, and those are precisely the places where reaching
 * out to install a Python package or write a global npm prefix is least wanted
 * and least visible. The decision is a pure function so the guarantee cannot be
 * quietly lost inside the console output around it.
 */
import { describe, it, expect } from 'vitest';
import { graphifyStep, mayInstallSoftware } from '../src/commands/setup.js';

const MISSING = { ok: false as const, uv: true, pipx: true };

describe('mayInstallSoftware', () => {
  it('allows an install in an interactive run', () => {
    expect(mayInstallSoftware({})).toBe(true);
  });

  it('refuses under --yes', () => {
    expect(mayInstallSoftware({ yes: true })).toBe(false);
  });
});

describe('graphifyStep', () => {
  it('says nothing when graphify is already installed', () => {
    expect(graphifyStep({ ok: true, version: '0.8.40', uv: true, pipx: true }, {})).toEqual({ kind: 'already' });
  });

  it('offers to run the install in an interactive run', () => {
    expect(graphifyStep(MISSING, {})).toEqual({
      kind: 'offer',
      cmd: 'uv',
      args: ['tool', 'install', 'graphifyy'],
      line: 'uv tool install graphifyy',
    });
  });

  it('defers instead of installing under --yes', () => {
    // The whole point of this file.
    expect(graphifyStep(MISSING, { yes: true })).toEqual({
      kind: 'deferred',
      line: 'uv tool install graphifyy',
    });
  });

  it('falls back to pipx when uv is absent', () => {
    const step = graphifyStep({ ok: false, uv: false, pipx: true }, {});
    expect(step).toMatchObject({ kind: 'offer', cmd: 'pipx' });
  });

  it('hints rather than guessing when no installer exists', () => {
    // Bare `pip` would install into whichever Python leads PATH.
    const step = graphifyStep({ ok: false, uv: false, pipx: false }, {});
    expect(step.kind).toBe('no-installer');
  });

  it('hints rather than guessing even under --yes', () => {
    // --yes must not turn "we do not know how to install this" into an attempt.
    const step = graphifyStep({ ok: false, uv: false, pipx: false }, { yes: true });
    expect(step.kind).toBe('no-installer');
  });

  it('never reports an install when graphify is present, whatever the flags', () => {
    for (const opts of [{}, { yes: true }]) {
      expect(graphifyStep({ ok: true, uv: false, pipx: false }, opts).kind).toBe('already');
    }
  });
});
