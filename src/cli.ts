#!/usr/bin/env node
// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `baton` bin entry — a launcher, and deliberately almost empty.
 *
 * Baton requires Node >= 24 (node:sqlite + FTS5). Someone who runs
 * `npx batonhq setup` on Node 20 or 22 should read one sentence telling them
 * so. What they would otherwise get is a stack trace from deep inside a module
 * they have never heard of, because ES imports are hoisted: the ENTIRE command
 * tree — 60-odd modules, commander, the MCP SDK — is resolved and parsed
 * before the first statement of the entry file executes. A version check
 * sitting at the top of that file has already lost.
 *
 * So the check happens here, where the module graph is two files, and the real
 * program is pulled in afterwards with a dynamic import that cannot run early.
 *
 * Keep this file free of static imports other than the preflight (a test
 * enforces it). Its emptiness IS the feature.
 *
 * This path is also an address: `src/commands/guard.ts` respawns
 * `process.argv[1]`, and `src/commands/new.ts` / `claim.ts` bake it into a git
 * commit hook. argv is passed through untouched, so those keep working.
 */
import { nodeVersionError } from './util/node-preflight.js';

const problem = nodeVersionError(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}

await import('./main.js');
