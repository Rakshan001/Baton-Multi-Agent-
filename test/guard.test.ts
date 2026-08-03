import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { checkoutForEdit, guardTarget, formatGuardMessage, slugFromWorktreePath, selfIdentity, normalizeGuardPayload, maybeGuardrailReminder } from '../src/commands/guard.js';
import { GUARDRAIL_REINJECT_MS } from '../src/handoff/guardrails.js';
import type { FileCheck } from '../src/signals.js';

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 'test@baton.dev'], dir);
  await git(['config', 'user.name', 'Baton Test'], dir);
  await git(['config', 'core.hooksPath', '/dev/null'], dir);
  await git(['checkout', '-q', '-b', 'main'], dir);
  await writeFile(join(dir, 'README.md'), '# r\n', 'utf-8');
  await git(['add', '.'], dir);
  await git(['commit', '-q', '-m', 'initial'], dir);
}

describe('guardTarget — extract the repo-relative file a PreToolUse edit targets', () => {
  const wt = '/repo/.baton/wt/fix-auth';

  it('relativizes Edit/Write/MultiEdit file_path against the worktree root', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(guardTarget({ tool_name: tool, tool_input: { file_path: `${wt}/src/auth.ts` } }, wt)).toBe('src/auth.ts');
    }
  });

  it('ignores non-edit tools and payloads without a file_path', () => {
    expect(guardTarget({ tool_name: 'Read', tool_input: { file_path: `${wt}/src/auth.ts` } }, wt)).toBeNull();
    expect(guardTarget({ tool_name: 'Edit', tool_input: {} }, wt)).toBeNull();
    expect(guardTarget({ tool_name: 'Edit' }, wt)).toBeNull();
  });

  it('ignores files outside the worktree', () => {
    expect(guardTarget({ tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } }, wt)).toBeNull();
  });
});

/**
 * A session at the root of a multi-repo hub is not inside a git repo, so the
 * guard's `gitRoot(cwd)` threw and its fail-open swallowed the whole call:
 * every edit made from a hub root recorded NOTHING, leaving those sessions
 * invisible to each other and to every task. Verified before the fix — the
 * probe recorded a signal in a plain repo and none from a hub root.
 */
describe('checkoutForEdit — which checkout an edit is filed under', () => {
  let hub = '', projA = '', outside = '';

  beforeEach(async () => {
    hub = realpathSync(await mkdtemp(join(tmpdir(), 'baton-guardhub-')));
    projA = join(hub, 'proj-a');
    await mkdir(join(projA, 'src'), { recursive: true });
    await initRepo(projA);
    await mkdir(join(hub, '.baton'), { recursive: true });
    outside = realpathSync(await mkdtemp(join(tmpdir(), 'baton-guardout-')));
    await initRepo(outside);
  }, 60_000);
  afterEach(async () => {
    await rm(hub, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('uses the session cwd when that IS a git checkout', async () => {
    expect(await checkoutForEdit(projA, join(projA, 'src', 'x.ts'), hub)).toBe(projA);
  });

  it("falls back to the FILE's repo from a non-git hub root", async () => {
    // The path is then relative to proj-a — the same repo proj-a's own tasks
    // record against, which is what makes the two comparable at all.
    expect(await checkoutForEdit(hub, join(projA, 'src', 'x.ts'), hub)).toBe(projA);
  });

  it('refuses a file in an unrelated repo outside the baton root', async () => {
    expect(await checkoutForEdit(hub, join(outside, 'f.ts'), hub)).toBeNull();
  });

  it('refuses when there is no usable path at all', async () => {
    expect(await checkoutForEdit(hub, undefined, hub)).toBeNull();
    expect(await checkoutForEdit(hub, 'relative/f.ts', hub)).toBeNull();
  });
});

describe('formatGuardMessage — the advisory note injected into the agent context', () => {
  it('names the holders and their tasks when the file is busy', () => {
    const check: FileCheck = {
      busy: true,
      by: [
        { slug: 'refactor-auth', agent: 'cursor', lastEditAt: new Date(Date.now() - 40_000).toISOString() },
        { slug: 'fix-login', agent: null, lastEditAt: '' },
      ],
    };
    const msg = formatGuardMessage('src/auth.ts', check)!;
    expect(msg).toContain('src/auth.ts');
    expect(msg).toContain('refactor-auth');
    expect(msg).toContain('cursor');
    expect(msg).toContain('fix-login');
    expect(msg).toMatch(/check_files|get_report/); // points the agent at the coordination tools
  });

  it('includes the holder\'s progress note when they reported one', () => {
    const check: FileCheck = {
      busy: true,
      by: [{ slug: 'refactor-auth', agent: 'cursor', lastEditAt: new Date().toISOString(), note: 'rewriting the refresh flow' }],
    };
    expect(formatGuardMessage('src/auth.ts', check)).toContain('rewriting the refresh flow');
  });

  it('returns null when the file is free (zero happy-path tokens)', () => {
    expect(formatGuardMessage('src/auth.ts', { busy: false, by: [] })).toBeNull();
  });
});

describe('slugFromWorktreePath — self-identity fallback when BATON_SLUG is absent', () => {
  it('extracts the slug from a .baton/wt path', () => {
    expect(slugFromWorktreePath('/repo/.baton/wt/fix-auth')).toBe('fix-auth');
    expect(slugFromWorktreePath('/repo/.baton/wt/fix-auth/sub/dir')).toBe('fix-auth');
  });
  it('returns undefined outside a baton worktree', () => {
    expect(slugFromWorktreePath('/repo')).toBeUndefined();
  });
});

describe('selfIdentity — who is this session, worktree task or root session (G2)', () => {
  const payload = { tool_name: 'Edit', session_id: 'abc12345-6789-4def-a012-3456789abcde' };

  it('a worktree session is its task slug — no session registration needed', () => {
    const id = selfIdentity(payload, '/repo/.baton/wt/fix-auth', 'fix-auth');
    expect(id.slug).toBe('fix-auth');
    expect(id.session).toBeUndefined();
  });

  it('a root session gets a pseudo-slug from its session id + registers agent and checkout', () => {
    const id = selfIdentity(payload, '/repo');
    expect(id.slug).toBe('sess-abc12345');
    expect(id.session).toEqual({ agent: 'claude', sessionRoot: '/repo' });
  });

  it('no task and no session id → anonymous (nothing to record)', () => {
    expect(selfIdentity({ tool_name: 'Edit' }, '/repo').slug).toBeUndefined();
  });
});

describe('normalizeGuardPayload — one guard for every hook dialect (M2)', () => {
  it('maps a Cursor afterFileEdit payload onto the guard shape', () => {
    const p = normalizeGuardPayload({
      conversation_id: 'conv-42', generation_id: 'g1',
      file_path: '/repo/src/App.tsx', edits: [{}],
      workspace_roots: ['/repo'],
    });
    expect(p.tool_name).toBe('Edit');
    expect(p.tool_input?.file_path).toBe('/repo/src/App.tsx');
    expect(p.cwd).toBe('/repo');
    expect(p.session_id).toBe('conv-42');
  });

  it('passes a Claude payload through untouched', () => {
    const claude = { tool_name: 'Write', tool_input: { file_path: '/r/a.ts' }, cwd: '/r', session_id: 's1' };
    expect(normalizeGuardPayload(claude)).toEqual(claude);
  });
});

describe('selfIdentity — agent parameter (M2)', () => {
  it('registers a cursor root session under its own agent name', () => {
    const id = selfIdentity({ session_id: 'conv-42' }, '/repo', undefined, 'cursor');
    expect(id.slug).toBe('sess-conv-42');
    expect(id.session).toEqual({ agent: 'cursor', sessionRoot: '/repo' });
  });
});

describe('maybeGuardrailReminder — debounced mid-session re-injection (ISS-07)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-guardrail-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns the positive guardrail on the first edit and stamps the marker', async () => {
    const first = await maybeGuardrailReminder(root, 'fix-auth');
    expect(first).toContain('Stay inside this worktree');
    expect(first).toContain('baton done fix-auth');
    expect(first).not.toMatch(/do not/i);
  });

  it('stays quiet within the window, then fires again once it ages past it', async () => {
    await maybeGuardrailReminder(root, 'fix-auth'); // stamps the marker ~now
    expect(await maybeGuardrailReminder(root, 'fix-auth')).toBeNull(); // immediately after → debounced

    const marker = join(root, '.baton', 'guardrail', 'fix-auth');
    const old = (Date.now() - GUARDRAIL_REINJECT_MS - 60_000) / 1000;
    await utimes(marker, old, old);
    expect(await maybeGuardrailReminder(root, 'fix-auth')).toContain('Stay inside this worktree');
  });
});
