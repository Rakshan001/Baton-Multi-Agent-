// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The done gate.
 *
 * Baton never runs project commands. A plan file is inert data, and that is
 * exactly what makes it safe to apply a plan that arrived over git — so this
 * gate cannot verify that the code works. It verifies that work HAPPENED, and it
 * is honest about the difference.
 *
 * What it catches cheaply and completely: "done" with nothing behind it. Zero
 * commits is a hard refusal, because an agent that hit its context limit and
 * reported success is the single most expensive failure in a five-agent
 * pipeline — every downstream phase then builds on nothing.
 *
 * What it cannot catch: three commits of confident, wrong code. That is what
 * review is for (§6.1), and review is why `requireReview` defaults on.
 *
 * The verdict is pure so every rule is a unit test; `collectEvidence` does the
 * git work and hands it in.
 */
import { scopesOverlap } from './plan.js';

export type CheckLevel = 'ok' | 'warn' | 'refuse' | 'attest';

export interface Check {
  level: CheckLevel;
  label: string;
  detail?: string;
}

export interface Evidence {
  /** Commits on the task branch since it was created. */
  commits: number;
  headSha: string | null;
  /** Every file the branch touched, repo-relative. */
  files: string[];
  /** Declared path globs, from the plan. Empty means "undeclared", not "none". */
  scope: string[];
  /** The worktree is recorded but not on disk, so the check below never ran. */
  worktreeMissing?: boolean;
  /** Uncommitted changes in the worktree. */
  dirtyFiles: string[];
  /** Files carrying conflict markers. */
  conflictFiles: string[];
  /** Evidence the plan asked for, which only an agent can attest to. */
  expects: string[];
  attested: boolean;
}

export interface Verdict {
  checks: Check[];
  /** Nothing may proceed while this is non-empty. */
  refusals: Check[];
  /** Files touched outside the declared scope — allowed, but recorded. */
  outOfScope: string[];
  pass: boolean;
}

/** Which touched files fall outside the declared scope. Empty scope declares
 *  nothing, so nothing is out of it — silence is not a claim about the diff. */
export function outOfScopeFiles(files: readonly string[], scope: readonly string[]): string[] {
  if (!scope.length) return [];
  return files.filter((f) => !scopesOverlap([f], scope as string[]));
}

export function verdictFor(e: Evidence): Verdict {
  const checks: Check[] = [];

  // The one hard refusal that costs nothing to check and catches the worst
  // failure: a task reported done with no work behind it at all.
  if (e.commits === 0) {
    checks.push({
      level: 'refuse',
      label: 'no commits on this branch',
      detail: 'Nothing was produced. Commit the work, or hand the task back with `baton pause`.',
    });
  } else {
    checks.push({ level: 'ok', label: `${e.commits} commit${e.commits === 1 ? '' : 's'}`, detail: e.headSha ? `head ${e.headSha.slice(0, 7)}` : undefined });
  }

  // Uncommitted work is not done work: a merge takes the branch, and anything
  // still in the worktree would be silently left behind.
  if (e.worktreeMissing) {
    // Not a refusal: the commits are the evidence, and the branch outlives the
    // directory. But it must not print "working tree clean" — that would be
    // claiming a check passed when it never ran, which is the exact confusion
    // that made a deleted worktree look pristine in the first place.
    checks.push({
      level: 'warn',
      label: 'worktree is gone — could not check for uncommitted work',
      detail: 'judging by the branch alone; anything left in that directory is already lost.',
    });
  } else if (e.dirtyFiles.length) {
    checks.push({
      level: 'refuse',
      label: `${e.dirtyFiles.length} uncommitted change${e.dirtyFiles.length === 1 ? '' : 's'}`,
      detail: `${e.dirtyFiles.slice(0, 5).join(', ')}${e.dirtyFiles.length > 5 ? ' …' : ''} — a merge takes the branch, not the worktree.`,
    });
  } else {
    checks.push({ level: 'ok', label: 'working tree clean' });
  }

  if (e.conflictFiles.length) {
    checks.push({
      level: 'refuse',
      label: `conflict markers in ${e.conflictFiles.length} file${e.conflictFiles.length === 1 ? '' : 's'}`,
      detail: e.conflictFiles.join(', '),
    });
  }

  const outOfScope = outOfScopeFiles(e.files, e.scope);
  if (e.scope.length) {
    const inScope = e.files.length - outOfScope.length;
    if (inScope > 0) checks.push({ level: 'ok', label: `diff touches ${e.scope.join(', ')} (declared scope)` });
    if (outOfScope.length) {
      // Recorded, not refused. Scope is a coordination signal, and a real fix
      // often needs one line somewhere it did not predict — refusing would
      // teach agents to declare `**` and defeat the whole mechanism.
      checks.push({
        level: 'warn',
        label: `also touches ${outOfScope.length} file${outOfScope.length === 1 ? '' : 's'} outside the declared scope`,
        detail: `${outOfScope.slice(0, 5).join(', ')}${outOfScope.length > 5 ? ' …' : ''} — recorded`,
      });
    }
  }

  for (const x of e.expects) {
    // An attestation is an agent's claim, not a verification. Labelled as such
    // so nobody downstream mistakes it for a passing test.
    checks.push(e.attested
      ? { level: 'ok', label: `attested: ${x}`, detail: 'agent attestation — not verified by baton' }
      : { level: 'attest', label: `expects: ${x}`, detail: 'confirm with --attest once you have actually run it' });
  }

  const refusals = checks.filter((c) => c.level === 'refuse');
  const unattested = checks.filter((c) => c.level === 'attest');
  return { checks, refusals, outOfScope, pass: refusals.length === 0 && unattested.length === 0 };
}

/** One line per check, for the terminal. */
export function renderChecks(checks: readonly Check[]): string[] {
  const mark: Record<CheckLevel, string> = { ok: 'ok ', warn: ' ! ', refuse: ' ✗ ', attest: ' ? ' };
  return checks.map((c) => `  ${mark[c.level]} ${c.label}${c.detail ? `\n        ${c.detail}` : ''}`);
}
