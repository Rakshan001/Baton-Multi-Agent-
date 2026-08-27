// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { isBenignInstallerExit, WINGET_NO_UPGRADE } from '../src/commands/setup.js';

/**
 * winget reports "already installed" as a failure.
 *
 * Observed on a real Windows machine, answering yes to the offer:
 *
 *   Found an existing package already installed. Trying to upgrade…
 *   No available upgrade found.
 *   ! install failed: Command failed with exit code 2316632107
 *
 * 2316632107 is 0x8A15002B — APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE.
 * uv was there the whole time. Baton read the non-zero exit as fatal, gave up,
 * and never ran the second half of the chain that installs graphify — so
 * answering yes could not possibly work on any machine that already had uv.
 *
 * The rule this encodes is the one `confirmGraphify` already followed for the
 * success path: trust the probe, not the exit code. An installer that says
 * "nothing to do" has left the machine in exactly the state we wanted.
 */
describe('winget exit codes', () => {
  it('treats "no applicable upgrade" as benign — it means already installed', () => {
    expect(WINGET_NO_UPGRADE).toBe(0x8A15002B);
    expect(WINGET_NO_UPGRADE).toBe(2316632107); // the number the user saw
    expect(isBenignInstallerExit(WINGET_NO_UPGRADE)).toBe(true);
  });

  it('still treats a real failure as a failure', () => {
    expect(isBenignInstallerExit(1)).toBe(false);
    expect(isBenignInstallerExit(127)).toBe(false); // command not found
    expect(isBenignInstallerExit(undefined)).toBe(false); // killed / never ran
  });

  it('treats success as success', () => {
    expect(isBenignInstallerExit(0)).toBe(true);
  });
});

describe('the exit code survives a signed round-trip', () => {
  it('accepts the signed form of the same code', () => {
    // 0x8A15002B is above 2^31; through a signed 32-bit int it reads negative.
    const signed = 0x8A15002B | 0;
    expect(signed).toBe(-1978335189);
    expect(isBenignInstallerExit(signed)).toBe(true);
  });

  it('does not make every negative code benign', () => {
    expect(isBenignInstallerExit(-1)).toBe(false);
  });
});
