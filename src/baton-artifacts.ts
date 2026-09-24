// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Files Baton itself writes into a task worktree (each git-excluded by its
 * writer). A leaf module on purpose: liveness needs these names without the
 * memory/kb import chain their writers carry.
 */

/** Repo-root-relative name of the handoff brief — also the `.git/info/exclude` pattern. */
export const HANDOFF_REL = 'HANDOFF.md';

/** Worktree-relative path of the Cursor auto-load rule. */
export const CURSOR_RULE_REL = '.cursor/rules/baton-continuation.mdc';
