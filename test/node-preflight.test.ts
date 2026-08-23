// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Node floor is a licence to print a *friendly* message, not a stack
 * trace: on npm, the first thing a stranger runs is `npx batonhq setup`, and
 * on Node 22 every `node:sqlite` path in the codebase explodes in a way that
 * reads like a Baton bug rather than a runtime mismatch.
 *
 * The rule that shapes every case below: this check runs BEFORE the real CLI
 * is imported, so it must never be the thing that breaks. When it cannot tell
 * what runtime it is on, it lets the run proceed — a false block is worse than
 * a missing one, because the real CLI will still fail loudly on its own.
 */
import { describe, it, expect } from 'vitest';
import { MIN_NODE_MAJOR, nodeVersionError } from '../src/util/node-preflight.js';

describe('nodeVersionError', () => {
  it('allows the minimum supported major', () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR}.0.0`)).toBeNull();
  });

  it('allows a newer major', () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR + 2}.3.1`)).toBeNull();
  });

  it('rejects the major just below the floor', () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR - 1}.11.0`)).not.toBeNull();
  });

  it('rejects an old LTS', () => {
    expect(nodeVersionError('20.11.1')).not.toBeNull();
  });

  it('names the version found, the version required, and the reason', () => {
    const msg = nodeVersionError('22.14.0');
    // Without all three a user knows something is wrong but not what to do.
    expect(msg).toContain('22.14.0');
    expect(msg).toContain(String(MIN_NODE_MAJOR));
    expect(msg?.toLowerCase()).toContain('sqlite');
  });

  it('tells the user how to fix it rather than only what is wrong', () => {
    expect(nodeVersionError('20.0.0')?.toLowerCase()).toMatch(/nodejs\.org|nvm/);
  });

  // --- The "never be the thing that breaks" cases (spec E2) ---

  it('allows the run when the version is undefined', () => {
    // process.versions.node is always set on real Node, but this module also
    // runs under bundlers and shims where it is not.
    expect(nodeVersionError(undefined)).toBeNull();
  });

  it('allows the run when the version is empty', () => {
    expect(nodeVersionError('')).toBeNull();
  });

  it('allows the run when the version is unparseable', () => {
    expect(nodeVersionError('not-a-version')).toBeNull();
  });

  it('accepts a leading v, since process.version carries one and versions.node does not', () => {
    expect(nodeVersionError(`v${MIN_NODE_MAJOR}.1.0`)).toBeNull();
    expect(nodeVersionError('v20.1.0')).not.toBeNull();
  });

  it('reads a bare major with no minor or patch', () => {
    expect(nodeVersionError(String(MIN_NODE_MAJOR))).toBeNull();
    expect(nodeVersionError('20')).not.toBeNull();
  });

  it('reads a prerelease build of a supported major as supported', () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR}.0.0-nightly20260101abcdef`)).toBeNull();
  });

  it('does not mistake a leading zero or padding for a different major', () => {
    expect(nodeVersionError('024.0.0')).toBeNull();
  });

  it('never treats a two-digit major as smaller than a one-digit floor', () => {
    // Guards against string comparison: '9' > '24' lexically, but 9 < 24.
    expect(nodeVersionError('9.0.0', 24)).not.toBeNull();
    expect(nodeVersionError('100.0.0', 24)).toBeNull();
  });

  it('exports a floor that matches the engines field the package publishes', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    // A guard that disagrees with `engines` gives two different answers to the
    // same question — npm warns at one floor, the binary refuses at another.
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});
