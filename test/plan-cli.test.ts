import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, tasksFile } from '../src/store.js';
import { planApplyCmd, planCheckCmd, PLANS_DIR } from '../src/commands/plan.js';

/**
 * End to end over a real repo: the dry run and the write are the SAME code
 * path, so what the human is shown is what happens. These tests exist to prove
 * the suppression, not the rendering.
 */
const PLAN = `---
plan: auth
---

## Phase 1 — Foundation

### auth-schema @claude
**scope:** \`src/db/**\`

Tables.

## Phase 2 — API

### auth-api
**after:** auth-schema
**scope:** \`src/auth/**\`

Tokens.
`;

describe('baton plan (cli)', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-plan-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    await mkdir(join(root, PLANS_DIR), { recursive: true });
    await writeFile(join(root, PLANS_DIR, 'auth.md'), PLAN, 'utf-8');

    cwd = process.cwd();
    process.chdir(root);
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('finds a plan by bare name under baton/plans/', async () => {
    await planCheckCmd('auth');
    expect(out.join('\n')).toContain('auth — 2 tasks across 2 phases');
    expect(process.exitCode).toBeUndefined();
  });

  it('a dry run writes nothing at all — not even the file', async () => {
    await planApplyCmd('auth', { dryRun: true });
    expect(out.join('\n')).toContain('+ auth-schema');
    expect(out.join('\n')).toContain('(dry run — nothing written)');
    await expect(loadTasks(root)).resolves.toEqual([]);
    expect(tasksFile(root)).toBeTruthy();
  });

  it('applies, then is idempotent', async () => {
    await planApplyCmd('auth', {});
    const tasks = await loadTasks(root);
    expect(tasks.map((t) => [t.slug, t.phase, t.state])).toEqual([
      ['auth-schema', 1, 'queued'], ['auth-api', 2, 'queued'],
    ]);
    expect(tasks[0].assignee).toBe('claude');
    expect(tasks[1].dependsOn).toEqual(['auth-schema']);

    out = [];
    await planApplyCmd('auth', {});
    expect(out.join('\n')).toContain('already applied');
    expect(await loadTasks(root)).toEqual(tasks);
  });

  it('refuses, and writes nothing, when the change lands under a working agent', async () => {
    await planApplyCmd('auth', {});
    const tasks = await loadTasks(root);
    tasks[0] = { ...tasks[0], state: 'active', baseCommit: 'abc', claimedBy: { agent: 'cursor', sessionSlug: 's', at: new Date().toISOString() } };
    await saveTasks(root, tasks);

    await writeFile(join(root, PLANS_DIR, 'auth.md'), PLAN.replace('`src/db/**`', '`src/db/**`, `src/models/**`'), 'utf-8');
    await planApplyCmd('auth', {});

    expect(err.join('\n')).toContain('1 in-flight task affected');
    expect(err.join('\n')).toContain('--force');
    expect(process.exitCode).toBe(1);
    expect((await loadTasks(root))[0].scope).toEqual(['src/db/**']);   // untouched

    process.exitCode = undefined;
    await planApplyCmd('auth', { force: true });
    expect((await loadTasks(root))[0].scope).toEqual(['src/db/**', 'src/models/**']);
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('reports every problem in an invalid plan and applies none of it', async () => {
    await writeFile(join(root, PLANS_DIR, 'bad.md'), '## Phase 1\n\n### a\n**after:** ghost\n\nw\n\n### a\n\nw\n', 'utf-8');
    await planApplyCmd('bad', {});
    const text = err.join('\n');
    expect(text).toContain('ghost');
    expect(text).toContain('duplicate task name');
    expect(process.exitCode).toBe(1);
    await expect(loadTasks(root)).resolves.toEqual([]);
  });

  it('exits non-zero when the plan file does not exist', async () => {
    await expect(planApplyCmd('nope', {})).rejects.toThrow('No plan file');
  });
});
