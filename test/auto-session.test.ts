/**
 * The brief a root session gets automatically.
 *
 * `baton pass --auto` fires from Stop/PreCompact and, until this, returned null
 * for any session not inside a task worktree — which is how most sessions run.
 * Every hook fired, succeeded, and wrote nothing; the only autonomous handoff
 * writer never ran once.
 *
 * These tests pin the derivation and, more importantly, the conditions under
 * which it must stay SILENT. A hook that writes too eagerly is worse than one
 * that writes nothing: Stop fires at the end of every turn, so an undebounced
 * brief would churn the file (and the event bus) after every single reply.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { AUTO_DEBOUNCE_MS, readSessionState, runAutoSessionHandoff } from '../src/handoff/auto-session.js';

let root: string;

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q', dir]);
  await git(['-C', dir, 'config', 'user.email', 't@t.t']);
  await git(['-C', dir, 'config', 'user.name', 'Test']);
}

async function commit(dir: string, file: string, body: string, message: string): Promise<void> {
  await writeFile(join(dir, file), body, 'utf-8');
  await git(['-C', dir, 'add', '-A']);
  await git(['-C', dir, 'commit', '-qm', message]);
}

const briefsIn = async (r: string): Promise<string[]> => {
  try { return (await readdir(join(r, '.baton', 'handoffs'))).filter((f) => f.endsWith('.md')); }
  catch { return []; }
};

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-auto-')));
  await initRepo(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runAutoSessionHandoff — writes a brief where nothing was written before', () => {
  it('derives a brief from commits and the dirty tree', async () => {
    await commit(root, 'a.ts', 'export const a = 1;', 'feat: add the a module');
    await writeFile(join(root, 'b.ts'), 'wip', 'utf-8');

    const res = await runAutoSessionHandoff(root, { sessionId: 'sess-abc123' });
    expect(res).not.toBeNull();

    const md = await readFile(res!.path, 'utf-8');
    expect(md).toContain('feat: add the a module'); // done ← commits
    expect(md).toContain('b.ts');                   // pending ← dirty tree
    expect(md).toContain('## Next step');
    // It must say it was derived, so nobody mistakes it for agent narration.
    expect(md).toContain('no agent wrote it');
  });

  it('lands where resume and the dashboard already look', async () => {
    await commit(root, 'a.ts', 'x', 'feat: one');
    const res = await runAutoSessionHandoff(root, { sessionId: 'sess-abc123' });
    expect(res!.path).toContain(join('.baton', 'handoffs'));
    expect(await briefsIn(root)).toHaveLength(1);
  });

  it('never records decisions, and so never writes memory', async () => {
    // The "why" is the one thing a hook cannot observe. Deriving it would put
    // invented reasoning in the KB under the same badge as vouched knowledge.
    await commit(root, 'a.ts', 'x', 'feat: one');
    const res = await runAutoSessionHandoff(root, { sessionId: 'sess-abc123' });
    expect(await readFile(res!.path, 'utf-8')).not.toContain('## Decisions & gotchas');
    await expect(readdir(join(root, '.baton', 'memory', 'facts'))).rejects.toThrow();
  });
});

describe('when it must stay silent', () => {
  it('says nothing when the tree is clean and nothing was committed', async () => {
    // A brief that exists should always mean something happened.
    await rm(join(root, '.git'), { recursive: true, force: true });
    await initRepo(root);
    expect(await runAutoSessionHandoff(root, { sessionId: 's' })).toBeNull();
    expect(await briefsIn(root)).toHaveLength(0);
  });

  it('says nothing at a hub root, which is not a git repo at all', async () => {
    const hub = realpathSync(await mkdtemp(join(tmpdir(), 'baton-hub-')));
    try {
      expect(await runAutoSessionHandoff(hub, { sessionId: 's' })).toBeNull();
      expect(await briefsIn(hub)).toHaveLength(0);
    } finally {
      await rm(hub, { recursive: true, force: true });
    }
  });

  it('does not rewrite when nothing changed since the last brief', async () => {
    await commit(root, 'a.ts', 'x', 'feat: one');
    const first = await runAutoSessionHandoff(root, { sessionId: 's' });
    expect(first).not.toBeNull();
    // Same state, and far past the debounce window — still nothing to say.
    const again = await runAutoSessionHandoff(root, { sessionId: 's', now: Date.now() + AUTO_DEBOUNCE_MS * 10 });
    expect(again).toBeNull();
  });

  it('debounces, because Stop fires at the end of EVERY turn', async () => {
    await commit(root, 'a.ts', 'x', 'feat: one');
    expect(await runAutoSessionHandoff(root, { sessionId: 's' })).not.toBeNull();

    // New work, but seconds later — the hook fired again on the next reply.
    await commit(root, 'b.ts', 'y', 'feat: two');
    expect(await runAutoSessionHandoff(root, { sessionId: 's' })).toBeNull();

    // Past the window, the same new work is worth writing.
    const later = await runAutoSessionHandoff(root, { sessionId: 's', now: Date.now() + AUTO_DEBOUNCE_MS + 1 });
    expect(later).not.toBeNull();
    expect(await readFile(later!.path, 'utf-8')).toContain('feat: two');
  });
});

describe('edge cases that would otherwise corrupt or collide', () => {
  it('gives two sessions at one root their own briefs', async () => {
    // Without session identity both agents write the same filename and the
    // second silently destroys the first one's handoff.
    await commit(root, 'a.ts', 'x', 'feat: one');
    const a = await runAutoSessionHandoff(root, { sessionId: 'sess-aaaaaaaa' });
    await writeFile(join(root, 'b.ts'), 'wip', 'utf-8');
    const b = await runAutoSessionHandoff(root, { sessionId: 'sess-bbbbbbbb' });

    expect(a!.slug).not.toBe(b!.slug);
    expect(await briefsIn(root)).toHaveLength(2);
  });

  it('falls back to a branch-keyed brief with no hook payload', async () => {
    await git(['-C', root, 'checkout', '-qb', 'feat/my-branch']);
    await commit(root, 'a.ts', 'x', 'feat: one');
    const res = await runAutoSessionHandoff(root, {});
    expect(res!.slug).toBe('auto-feat-my-branch');
  });

  it('survives a detached HEAD', async () => {
    await commit(root, 'a.ts', 'x', 'feat: one');
    await commit(root, 'b.ts', 'y', 'feat: two');
    const head = await git(['-C', root, 'rev-parse', 'HEAD~1']);
    await git(['-C', root, 'checkout', '-q', head]);
    await writeFile(join(root, 'c.ts'), 'wip', 'utf-8');

    const state = await readSessionState(root);
    expect(state.branch).toBeNull(); // 'HEAD' is not a branch name — don't report a lie
    const res = await runAutoSessionHandoff(root, {});
    expect(res).not.toBeNull();
    expect(await readFile(res!.path, 'utf-8')).toContain('detached HEAD');
  });

  it('recovers when the last brief\'s commit no longer exists', async () => {
    // Rebase/amend/branch-switch all orphan the recorded sha. `<gone>..HEAD`
    // fails, and "I cannot diff" must not be reported as "no work happened".
    await commit(root, 'a.ts', 'x', 'feat: one');
    await runAutoSessionHandoff(root, { sessionId: 's' });
    await commit(root, 'b.ts', 'y', 'feat: two');
    await git(['-C', root, 'commit', '-q', '--amend', '-m', 'feat: two (amended)']);
    await git(['-C', root, 'reset', '-q', '--hard', 'HEAD']);

    const res = await runAutoSessionHandoff(root, { sessionId: 's', now: Date.now() + AUTO_DEBOUNCE_MS + 1 });
    expect(res).not.toBeNull();
    expect(res!.state.commits.length).toBeGreaterThan(0);
  });

  it('redacts a credential quoted in a commit subject', async () => {
    // Subjects are author-written prose that lands in a file every agent reads.
    await commit(root, 'a.ts', 'x', 'fix: rotate AKIAIOSFODNN7EXAMPLE after the leak');
    const res = await runAutoSessionHandoff(root, { sessionId: 's' });
    const md = await readFile(res!.path, 'utf-8');
    expect(md).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(md).toContain('[redacted:');
  });

  it('parses renamed paths from porcelain output', async () => {
    await commit(root, 'old.ts', 'x'.repeat(200), 'feat: one');
    await git(['-C', root, 'mv', 'old.ts', 'new.ts']);
    const state = await readSessionState(root);
    expect(state.dirty).toContain('new.ts');
    expect(state.dirty.some((p) => p.includes('->'))).toBe(false);
  });

  it('never reports its own artifacts as the session\'s pending work', async () => {
    // Writing a brief dirties `.baton/`. Counting that as pending work both
    // lies in the brief and makes the state hash change on every run, so the
    // hook would rewrite forever instead of converging.
    await commit(root, 'a.ts', 'x', 'feat: one');
    const res = await runAutoSessionHandoff(root, { sessionId: 's' });
    expect(await readFile(res!.path, 'utf-8')).not.toContain('.baton/');

    const after = await readSessionState(root);
    expect(after.dirty.some((p) => p.startsWith('.baton'))).toBe(false);
  });

  it('keeps .baton/handoffs from growing without bound', async () => {
    await commit(root, 'a.ts', 'x', 'feat: one');
    const dir = join(root, '.baton', 'handoffs');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      await writeFile(join(dir, `old-${i}.md`), '---\nbaton: 1\nderived: true\n---\n', 'utf-8');
    }

    await runAutoSessionHandoff(root, { sessionId: 's' });
    expect((await briefsIn(root)).length).toBeLessThanOrEqual(20);
  });

  it('never deletes an agent-authored brief to make room for a derived one', async () => {
    // `.baton/handoffs/` holds BOTH: briefs an agent wrote through
    // create_handoff — carrying decisions nothing else records — and these
    // derived ones. Pruning by mtime alone lets a hook silently destroy the
    // authored kind, which is the only kind that cannot be regenerated.
    await commit(root, 'a.ts', 'x', 'feat: one');
    const dir = join(root, '.baton', 'handoffs');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      await writeFile(join(dir, `authored-${i}.md`), '---\nbaton: 1\nkind: session\n---\n# real work\n', 'utf-8');
    }

    await runAutoSessionHandoff(root, { sessionId: 's' });
    const left = await briefsIn(root);
    expect(left.filter((f) => f.startsWith('authored-'))).toHaveLength(25);
  });

  it('does not claim commits it never saw as the session\'s own work', async () => {
    // Every session's FIRST brief has no previous marker to diff against, so
    // an unbounded `git log -n10` hands it credit for ten commits that may
    // predate it by months — and that path runs once per session, not once
    // per repo.
    await commit(root, 'a.ts', 'x', 'feat: landed long before this session');
    await writeFile(join(root, 'b.ts'), 'wip', 'utf-8');

    const later = Date.now() + 40 * 24 * 60 * 60_000; // the session starts weeks on
    const res = await runAutoSessionHandoff(root, { sessionId: 'fresh', now: later });
    expect(res).not.toBeNull(); // the dirty tree is still worth reporting
    expect(await readFile(res!.path, 'utf-8')).not.toContain('landed long before this session');
  });

  it('drops a marker whose brief is gone, so the brief comes back', async () => {
    // Markers would otherwise accumulate one per session forever while the
    // briefs beside them are capped — and a surviving marker makes a deleted
    // brief look up to date, so it is never rewritten.
    await commit(root, 'a.ts', 'x', 'feat: one');
    const res = await runAutoSessionHandoff(root, { sessionId: 's' });
    await rm(res!.path, { force: true });

    await runAutoSessionHandoff(root, { sessionId: 'other', now: Date.now() + AUTO_DEBOUNCE_MS + 1 });
    const markers = await readdir(join(root, '.baton', 'handoffs', '.auto')).catch(() => []);
    expect(markers).not.toContain('s.json');
    expect(markers.some((m) => m.includes('sess-s'))).toBe(false);
  });

  it('keeps its own coordination state out of the brief body too', async () => {
    // readSessionState filters `.baton/`, but the brief's own "Uncommitted
    // changes" section re-reads the tree — so in a repo whose .gitignore Baton
    // does not manage, the section contradicted the Pending list above it.
    await commit(root, 'a.ts', 'x', 'feat: one');
    await runAutoSessionHandoff(root, { sessionId: 's' });          // creates .baton/
    await writeFile(join(root, 'b.ts'), 'wip', 'utf-8');
    const res = await runAutoSessionHandoff(root, { sessionId: 's', now: Date.now() + AUTO_DEBOUNCE_MS + 1 });

    expect(await readFile(res!.path, 'utf-8')).not.toContain('.baton/');
  });
});
