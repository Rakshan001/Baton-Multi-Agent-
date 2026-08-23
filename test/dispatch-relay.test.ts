// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * When Baton cannot start an agent, the human can.
 *
 * `@antigravity` refusing is correct — Baton has no spawn args for it and will
 * not guess. But "no launcher in the local backend" is a fact about Baton, not
 * an instruction to the person reading it, and the work is entirely doable:
 * open Antigravity yourself and point it at the task.
 *
 * So a refusal Baton cannot act on becomes an instruction a human can. The
 * distinction is which refusals those are — installing a missing CLI is a
 * different job from starting one that is already there.
 */
import { describe, it, expect } from 'vitest';
import { relayFor, type DispatchRefusal } from '../src/dispatch.js';

const refusal = (over: Partial<DispatchRefusal> = {}): DispatchRefusal => ({
  slug: 'auth-docs', code: 'no-mode', agentId: 'antigravity', reason: 'no launcher', ...over,
});

describe('relayFor', () => {
  it('turns "this backend has no launcher" into something to do', () => {
    const [r] = relayFor([refusal()]);
    expect(r).toMatchObject({ slug: 'auth-docs', agentId: 'antigravity' });
    expect(r!.command).toBe('baton take auth-docs');
  });

  it('relays an agent that would never be handed its brief', () => {
    // aider and opencode take a prompt argument and use only the model. A human
    // driving one can paste the brief; an unattended launch cannot.
    expect(relayFor([refusal({ code: 'no-prompt', agentId: 'aider' })])).toHaveLength(1);
  });

  it('does not relay an agent that is simply not installed', () => {
    // Nobody can start a CLI that is not there. Telling them to open it is
    // advice that fails at the first step.
    expect(relayFor([refusal({ code: 'not-installed', agentId: 'codex' })])).toEqual([]);
  });

  it('does not relay anything a human cannot fix by starting an agent', () => {
    for (const code of ['unknown-agent', 'no-model', 'no-route', 'needs-agent', 'at-capacity', 'per-agent-capacity', 'not-startable'] as const) {
      expect(relayFor([refusal({ code })]), code).toEqual([]);
    }
  });

  it('says to run it inside the agent, not in your own shell', () => {
    // `baton take` claims as whoever runs it, and the agent id comes from the
    // parent process. Run from the operator's shell it resolves to something
    // else and the claim is refused as "assigned to antigravity" -- the exact
    // confusion this instruction exists to prevent.
    expect(relayFor([refusal()])[0]!.where).toMatch(/antigravity/i);
    expect(relayFor([refusal()])[0]!.where.toLowerCase()).toContain('terminal');
  });

  it('keeps the daemon\'s own reason, so the refusal is still legible', () => {
    const [r] = relayFor([refusal({ reason: "'antigravity' has no launcher in the local backend" })]);
    expect(r!.why).toContain('no launcher');
  });

  it('drops the part of the reason that offers a different fix', () => {
    // The full refusal ends with "install Orca, register this repo…", which is
    // advice about automating this — beside an instruction for doing it by hand
    // it reads as two competing answers.
    const [r] = relayFor([refusal({
      reason: "'antigravity' has no launcher in the local backend — it can be detected but not started. The orca backend can launch it: install Orca.",
    })]);
    expect(r!.why).toBe("'antigravity' has no launcher in the local backend");
  });

  it('is empty when everything either started or is nobody\'s to start', () => {
    expect(relayFor([])).toEqual([]);
  });

  it('names an agent even when the refusal did not carry one', () => {
    // `agentId` is optional on a refusal. "open  in a terminal" is worse than
    // saying plainly that the assignee is unknown.
    const [r] = relayFor([refusal({ agentId: undefined })]);
    expect(r!.agentId).toBe('the assigned agent');
  });
});
