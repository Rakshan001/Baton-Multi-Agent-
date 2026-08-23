#!/usr/bin/env node
// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A scripted stand-in for the `orca` CLI.
 *
 * Real Orca is an Electron app: starting one per test would be slow, flaky, and
 * would not let a test ask for `selector_not_found` on demand. This prints the
 * same envelopes (`src/shared/runtime-rpc-envelope.ts`) and nothing else.
 *
 * FAKE_ORCA_SCRIPT points at a JSON file: { "<subcommand>": <envelope>, ... }
 * keyed by the first two argv words, e.g. "terminal create". A `_calls` path
 * records every invocation so a test can assert ORDER, which is most of what
 * this executor has to get right.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
// Key on the leading non-flag words: `terminal create --json` is "terminal
// create", and `status --json` is "status". Slicing a fixed two would key the
// single-word commands on their first flag.
const key = args.slice(0, args.findIndex((a) => a.startsWith('-')) === -1 ? args.length : args.findIndex((a) => a.startsWith('-'))).join(' ');
const script = JSON.parse(readFileSync(process.env.FAKE_ORCA_SCRIPT, 'utf8'));

if (script._calls) {
  appendFileSync(script._calls, JSON.stringify({
    key,
    args,
    // The fence is the point of recording env: a leaked ORCA_TERMINAL_HANDLE
    // is invisible in argv and changes how Orca attests the call.
    fenced: ['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_AGENT_LAUNCH_TOKEN']
      .filter((k) => process.env[k] !== undefined),
  }) + '\n');
}

const reply = script[key];
if (reply === undefined) {
  console.log(JSON.stringify({ id: 'local', ok: false, error: { code: 'unknown_command', message: `fake-orca has no script for '${key}'` }, _meta: { runtimeId: null } }));
  process.exit(1);
}
if (reply === 'HANG') { setTimeout(() => {}, 60_000); }
else {
  console.log(JSON.stringify(reply));
  process.exit(reply.ok ? 0 : 1);
}
