// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How long a spawned `node dist/cli.js serve` gets to answer `/api/meta`.
 *
 * Sixteen call sites across thirteen files each spawn a REAL daemon, and vitest
 * runs test files in parallel forks — so on a busy machine a cold node process
 * is competing with a couple of hundred others for CPU before it even reaches
 * `main()`. The old per-file budget of 20s was not a bug in the daemon (it
 * starts fine; it is starved), but it was tight enough that two consecutive
 * full-suite runs each lost a DIFFERENT daemon-spawning file to it.
 *
 * That failure mode is also unusually misleading: these waits live in
 * `beforeAll`, and a throwing `beforeAll` fails the whole FILE while reporting
 * zero failed tests — so the suite summary said "1 failed" with nothing under
 * it, which reads like a mystery rather than a timeout.
 *
 * 60s is a ceiling, not an expectation: the loop polls every 200ms and returns
 * the moment the daemon answers, so a healthy spawn still costs a few hundred
 * milliseconds. The larger number only buys patience for the pathological case.
 *
 * One constant rather than sixteen literals so the next person tuning this
 * changes it once — the same reason `freePort` was pulled into `./free-port.js`.
 */
export const DAEMON_START_MS = 60_000;
