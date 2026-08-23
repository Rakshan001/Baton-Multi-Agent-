// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Node floor, decided before the real CLI is imported.
 *
 * IMPORTANT: this module must import NOTHING. It is the only static import of
 * the `baton` launcher (src/cli.ts), and the whole point of that arrangement
 * is that the runtime check runs against a module graph of two trivially
 * parseable files — so a stranger on Node 22 gets a sentence telling them what
 * to do, not a SyntaxError or a `node:sqlite` stack trace from 700 lines of
 * command wiring that were parsed before any of our code got to speak.
 */

/**
 * Node 24 is the floor because memory ranking uses `node:sqlite`'s FTS5:
 * Node 20 has no `node:sqlite` at all (src/history.ts), and builds before 24
 * ship it without FTS5, which silently demotes src/memory-rank.ts from BM25 to
 * a weaker word-scan scorer. Silent degradation is worse than refusing to run.
 *
 * Kept in lockstep with package.json `engines.node` by a test — npm warns at
 * the `engines` floor and the binary refuses at this one, so two numbers that
 * disagree would give one user two different answers.
 */
export const MIN_NODE_MAJOR = 24;

/**
 * `null` when this runtime may run Baton, else the message to print before
 * exiting.
 *
 * Unrecognised input returns `null` — deliberately. This function's failure
 * mode has to be "let it through": it runs under bundlers, shims, and future
 * runtimes where the version string is absent or shaped differently, and
 * wrongly blocking a working install is worse than not blocking a broken one,
 * which the real CLI would fail on anyway a moment later.
 */
export function nodeVersionError(version: string | undefined, min: number = MIN_NODE_MAJOR): string | null {
  const found = version?.trim();
  // `process.versions.node` is bare ("24.4.0"); `process.version` carries a
  // leading "v". Accept both, so a caller cannot pick the wrong one silently.
  const major = /^v?(\d+)/.exec(found ?? '')?.[1];
  if (major === undefined) return null;

  // Number(), not a string compare: lexically '9' > '24', numerically it is not.
  const n = Number(major);
  if (!Number.isFinite(n) || n >= min) return null;

  return [
    `Baton needs Node >= ${min} — this is Node ${found}.`,
    '',
    "Memory ranking uses node:sqlite's FTS5 full-text index, which older",
    'runtimes either do not ship at all or ship without FTS5.',
    '',
    '  Upgrade at https://nodejs.org',
    `  or, with nvm:  nvm install ${min} && nvm use ${min}`,
  ].join('\n');
}
