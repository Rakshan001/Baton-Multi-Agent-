import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { addTask, getTask } from '../src/store.js';
import { buildBrief } from '../src/handoff/brief.js';
import { saveProgress, loadProgress } from '../src/handoff/progress-ledger.js';

/**
 * ISS-06 — buildBrief's Plan / Files / Notes used to come only from Claude's
 * JSONL transcript, so a Cursor/Codex/Gemini handoff collapsed to git-only.
 * The agent-agnostic progress ledger (save_progress) fills that gap and the
 * automated brief must merge it in.
 */
describe('progress ledger (ISS-06)', () => {
  let root: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-prog-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    wt = join(root, '.baton', 'wt', 'add-hourly');
    await mkdir(join(root, '.baton', 'wt'), { recursive: true });
    await git(['worktree', 'add', '-q', '-b', 'baton/add-hourly', wt, 'main'], root);
    await addTask(root, {
      slug: 'add-hourly', task: 'add hourly buckets to the chart', branch: 'baton/add-hourly',
      baseBranch: 'main', worktreePath: wt, createdAt: new Date().toISOString(),
      agent: 'cursor', status: 'in-progress',
    } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('round-trips a patch: plan/notes replace, files accumulate', async () => {
    await saveProgress(root, 'add-hourly', { plan: [{ content: 'wire the API', status: 'completed' }], filesEdited: ['a.ts'] });
    await saveProgress(root, 'add-hourly', { notes: ['chose UTC buckets to match the DB'], filesEdited: ['b.ts'] });
    const led = await loadProgress(root, 'add-hourly');
    expect(led!.plan).toEqual([{ content: 'wire the API', status: 'completed' }]); // kept from first patch
    expect(led!.notes).toContain('chose UTC buckets to match the DB');
    expect(led!.filesEdited.sort()).toEqual(['a.ts', 'b.ts']); // unioned
  });

  it('caps runaway lists so the ledger stays a brief', async () => {
    await saveProgress(root, 'add-hourly', { notes: Array.from({ length: 60 }, (_, i) => `note ${i}`) });
    expect((await loadProgress(root, 'add-hourly'))!.notes.length).toBeLessThanOrEqual(30);
  });

  it('buildBrief surfaces the ledger plan/notes for a non-Claude task (not the git-only fallback)', async () => {
    // No Claude transcript exists for this temp worktree → the OLD brief collapsed to git-only.
    await saveProgress(root, 'add-hourly', {
      plan: [
        { content: 'add the SQL hourly bucket query', status: 'completed' },
        { content: 'render the hourly series on the chart', status: 'pending' },
      ],
      notes: ['buckets are UTC to match the stored timestamps'],
      next: 'wire the chart component to the new endpoint',
    });
    const task = await getTask(root, 'add-hourly');
    const brief = await buildBrief(task!, { to: 'claude', root });

    expect(brief.markdown).toContain('## Plan');
    expect(brief.markdown).toContain('- [x] add the SQL hourly bucket query');
    expect(brief.markdown).toContain('- [ ] render the hourly series on the chart');
    expect(brief.markdown).toContain('buckets are UTC to match the stored timestamps');
    expect(brief.markdown).toContain('wire the chart component to the new endpoint');
    expect(brief.markdown).not.toContain('context above is from git alone');
  });

  it('still falls back to git-only when there is neither a transcript nor a ledger', async () => {
    const task = await getTask(root, 'add-hourly');
    const brief = await buildBrief(task!, { to: 'claude', root });
    expect(brief.markdown).toContain('git alone');
  });

  it('an empty patch does not fabricate a Plan — the brief still falls back to git-only', async () => {
    await saveProgress(root, 'add-hourly', {}); // a real call with nothing to say
    const task = await getTask(root, 'add-hourly');
    const brief = await buildBrief(task!, { to: 'claude', root });
    expect(brief.markdown).not.toContain('## Plan');
    expect(brief.markdown).toContain('git alone');
  });

  it('a plan item with no status defaults to pending (rendered as an open box)', async () => {
    await saveProgress(root, 'add-hourly', { plan: [{ content: 'ship the endpoint' }] });
    expect((await loadProgress(root, 'add-hourly'))!.plan[0].status).toBe('pending');
    const task = await getTask(root, 'add-hourly');
    const brief = await buildBrief(task!, { to: 'claude', root });
    expect(brief.markdown).toContain('- [ ] ship the endpoint');
  });
});
