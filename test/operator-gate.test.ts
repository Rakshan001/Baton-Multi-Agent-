// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * §7.6's operator/member split, on the CLI.
 *
 * The daemon answers "who are you" from a token (`src/access.ts`). The CLI has
 * no token — the person running it is whoever is at the machine — so the only
 * question a command can ask is *whose plan is this*, and `.baton/host.json`
 * settles it.
 *
 * The failure this prevents is a silent fork, not an escalation. A member who
 * applies a plan locally rewrites their own tasks.json while the hub's stands;
 * from then on the two machines coordinate against different plans and nothing
 * reports an error. So the cases that matter are symmetric: refuse on a member
 * install, and — just as important — do NOT refuse anything a member is
 * supposed to be able to do, because a gate that catches ordinary work gets
 * turned off and then protects nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideOperator, requireOperator } from '../src/operator.js';
import { saveHostLink } from '../src/host-link.js';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { integrateCmd } from '../src/commands/integrate.js';
import { taskRmCmd } from '../src/commands/task.js';
import { planApplyCmd } from '../src/commands/plan.js';

let root: string;

/** Capture stderr and the exit code the way a user would experience them. */
async function attempt(action: string): Promise<{ ok: boolean; out: string; code: number | undefined }> {
  const lines: string[] = [];
  const realError = console.error;
  const realCode = process.exitCode;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  process.exitCode = undefined;
  try {
    const ok = await requireOperator(root, action);
    return { ok, out: lines.join('\n'), code: process.exitCode };
  } finally {
    console.error = realError;
    process.exitCode = realCode;
  }
}

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-operator-')));
  await mkdir(join(root, '.baton'), { recursive: true });
  await writeFile(join(root, '.baton', 'tasks.json'), '[]', 'utf-8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('decideOperator — the rule itself', () => {
  it('allows a machine with no host link', () => {
    // Solo, and the hub's own machine. Both are the operator of their plan.
    expect(decideOperator(null)).toEqual({ allowed: true });
    expect(decideOperator(undefined)).toEqual({ allowed: true });
  });

  it('refuses a machine linked to a hub, and says which one', () => {
    // Naming the hub is what makes the refusal actionable — "not allowed" alone
    // reads as a bug in Baton rather than a fact about this machine.
    expect(decideOperator({ url: 'https://hub.example.com' }))
      .toEqual({ allowed: false, hostUrl: 'https://hub.example.com' });
  });
});

describe('requireOperator — what a member is told', () => {
  it('lets an unlinked machine proceed silently', async () => {
    const r = await attempt('baton plan apply x');
    expect(r.ok).toBe(true);
    expect(r.out).toBe('');
    expect(r.code).toBeUndefined();   // nothing failed, so nothing is reported
  });

  it('refuses a member, names the hub, and fails the exit code', async () => {
    await saveHostLink(root, { url: 'https://hub.example.com', token: 'baton_x' });

    const r = await attempt('baton integrate 2');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);           // scripts and agents read this, not the prose
    expect(r.out).toContain('baton integrate 2');
    expect(r.out).toContain('https://hub.example.com');
    // The way out is part of the refusal. A gate with no stated exit gets worked
    // around by whatever means the user invents.
    expect(r.out).toContain('baton host clear');
  });
});

/*
 * The wiring, not the rule.
 *
 * The tests above would all pass with the gate defined and called from nowhere
 * — which is exactly the defect fixed one commit earlier, where `claim()` took
 * the barrier and every caller passed `{}`. A guard is only real at its call
 * sites, so these drive the commands themselves and assert on the repository
 * afterwards: refused has to mean nothing happened.
 */
describe('the operator-only commands, on a member machine', () => {
  let repo: string;
  let cwd: string;

  beforeEach(async () => {
    repo = realpathSync(await mkdtemp(join(tmpdir(), 'baton-op-cmd-')));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
    await writeFile(join(repo, '.gitignore'), '.baton/\n', 'utf-8');
    await writeFile(join(repo, 'a.ts'), 'base\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-qm', 'init'], repo);

    // A finished phase whose branch is still off the base: exactly the state
    // `baton integrate` exists to clear.
    await git(['checkout', '-q', '-b', 'baton/schema'], repo);
    await writeFile(join(repo, 'db.ts'), 'schema\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-qm', 'schema'], repo);
    const tip = (await git(['rev-parse', 'HEAD'], repo)).trim();
    await git(['checkout', '-q', 'main'], repo);

    await mkdir(join(repo, '.baton'), { recursive: true });
    await saveTasks(repo, [{
      slug: 'schema', task: 'phase 1', branch: 'baton/schema',
      worktreePath: join(repo, '.baton', 'wt', 'schema'),
      baseBranch: 'main', baseCommit: tip, createdAt: '2026-08-01T00:00:00.000Z',
      phase: 1, state: 'done',
    } as Task, {
      // Queued and never materialized — the ONE shape `task rm` actually
      // removes. Pointing that test at `schema` instead would pass with the
      // gate deleted, since a started task is refused on its own merits: the
      // test would be watching the wrong refusal.
      slug: 'draft', task: 'phase 2', branch: 'baton/draft',
      worktreePath: '', baseBranch: 'main', baseCommit: null,
      createdAt: '2026-08-01T00:00:00.000Z', phase: 2, state: 'queued',
    } as Task]);
    await saveHostLink(repo, { url: 'https://hub.example.com', token: 'baton_x' });

    cwd = process.cwd();
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(repo, { recursive: true, force: true });
  });

  /** Run a command with output swallowed, and report the exit code. */
  async function silently(fn: () => Promise<void>): Promise<number | undefined> {
    const log = console.log, err = console.error;
    const prev = process.exitCode;
    console.log = () => {}; console.error = () => {};
    process.exitCode = undefined;
    try {
      await fn();
      return process.exitCode;
    } finally {
      console.log = log; console.error = err;
      process.exitCode = prev;
    }
  }

  it('integrate refuses, and main does not move', async () => {
    const before = (await git(['rev-parse', 'main'], repo)).trim();
    expect(await silently(() => integrateCmd('1'))).toBe(1);
    // The assertion that matters. A refusal that still merged would be worse
    // than no gate, because the message would say it had not.
    expect((await git(['rev-parse', 'main'], repo)).trim()).toBe(before);
  });

  it('integrate --dry-run is still allowed — it writes nothing', async () => {
    // Gating the read too would cost a member the one way to find out their
    // phase conflicts, and tell them nothing `git merge-tree` would not.
    expect(await silently(() => integrateCmd('1', { dryRun: true }))).toBeUndefined();
  });

  it('task rm refuses, and the queued task is still there', async () => {
    expect(await silently(() => taskRmCmd('draft'))).toBe(1);
    expect((await loadTasks(repo)).map((t) => t.slug)).toContain('draft');
  });

  it('plan apply refuses before it even reads the file', async () => {
    // Named a plan that does not exist: if the gate fires first this is a
    // membership refusal, and if it does not, it is a file error. Only one of
    // those is exit code 1 with tasks.json untouched.
    expect(await silently(() => planApplyCmd('no-such-plan'))).toBe(1);
    expect((await loadTasks(repo)).map((t) => t.slug)).toEqual(['schema', 'draft']);
  });
});
