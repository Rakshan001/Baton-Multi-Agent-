import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { addTask, getTask } from '../src/store.js';
import { buildBrief, fitBriefBody, graphSectionMd, HANDOFF_MAX_CHARS, type BriefSection } from '../src/handoff/brief.js';
import { saveProgress } from '../src/handoff/progress-ledger.js';

/**
 * ISS-08 — a brief that concatenates everything causes context rot. The body is
 * budgeted: lowest-value sections drop first, continuation essentials never do,
 * and a pointer tells the receiver to pull the rest just-in-time.
 */
describe('fitBriefBody (ISS-08 progressive disclosure)', () => {
  const S = (md: string, dropOrder: number): BriefSection => ({ md, dropOrder });

  it('keeps everything and drops nothing when under budget', () => {
    const secs = [S('a'.repeat(100), 0), S('b'.repeat(100), 5)];
    const { body, dropped } = fitBriefBody(secs, 1000);
    expect(dropped).toBe(0);
    expect(body).toContain('a'.repeat(100));
    expect(body).toContain('b'.repeat(100));
  });

  it('drops the highest-dropOrder (lowest-value) section first', () => {
    const keep = '## keep\n' + 'k'.repeat(200);
    const bloat = '## bloat\n' + 'x'.repeat(400);
    const { body, dropped } = fitBriefBody([S(keep, 0), S(bloat, 6)], 300);
    expect(dropped).toBe(1);
    expect(body).toContain('## keep');
    expect(body).not.toContain('## bloat');
  });

  it('never drops a dropOrder-0 section, even if that means overflowing', () => {
    const essential = 'e'.repeat(5000);
    const { body, dropped } = fitBriefBody([S(essential, 0)], 100);
    expect(dropped).toBe(0);
    expect(body).toBe(essential); // accepted overflow rather than losing the essential
  });

  it('drops in value order (commands→graph→files) until it fits', () => {
    const secs = [
      S('## objective\n' + 'o'.repeat(200), 0),
      S('## files\n' + 'f'.repeat(300), 4),
      S('## graph\n' + 'g'.repeat(300), 5),
      S('## commands\n' + 'c'.repeat(300), 6),
    ];
    const { body } = fitBriefBody(secs, 600);
    expect(body).toContain('## objective');
    expect(body).not.toContain('## commands'); // highest dropOrder → first out
    // graph/files drop next as needed; objective always survives
    expect(body.length).toBeLessThanOrEqual(600);
  });
});

describe('graphSectionMd (ISS-09/10 — graph as per-task hint + map/recall nudge)', () => {
  it('frames the map as a hint and nudges recall-first without mandating map-only', () => {
    const md = graphSectionMd('GRAPH: foo -> bar');
    expect(md).toContain('GRAPH: foo -> bar');       // the excerpt is still there
    expect(md).toContain('recall_memory');            // map/recall-first nudge (ISS-10)
    expect(md).toMatch(/read the full source/i);      // read source when the task needs it (ISS-09, not a mandate)
  });
});

describe('buildBrief budget integration (ISS-08)', () => {
  let root: string;
  let wt: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-briefbudget-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    wt = join(root, '.baton', 'wt', 'big');
    await mkdir(join(root, '.baton', 'wt'), { recursive: true });
    await git(['worktree', 'add', '-q', '-b', 'baton/big', wt, 'main'], root);
    await addTask(root, {
      slug: 'big', task: 'ship the big feature', branch: 'baton/big', baseBranch: 'main',
      worktreePath: wt, createdAt: new Date().toISOString(), agent: 'cursor', status: 'in-progress',
    } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('trims an oversized brief, keeps the essentials, and adds a JIT pointer', async () => {
    // A wall of notes (a low-value, high-volume section) blows past the budget.
    await saveProgress(root, 'big', {
      plan: [{ content: 'implement the core path', status: 'pending' }],
      notes: Array.from({ length: 30 }, (_, i) => `note ${i}: ` + 'detail '.repeat(60)),
    });
    const task = await getTask(root, 'big');
    const brief = await buildBrief(task!, { to: 'claude', root });

    // Essentials survive the budget.
    expect(brief.markdown).toContain('## Objective');
    expect(brief.markdown).toContain('ship the big feature');
    expect(brief.markdown).toContain('## Rules to hold');
    expect(brief.markdown).toContain('- [ ] implement the core path');
    // The low-value wall was trimmed, and the receiver is told to pull JIT.
    expect(brief.markdown).not.toContain('## Last notes from the previous agent');
    expect(brief.markdown).toContain('pull it just-in-time');
    // The fitted body (frontmatter aside) stays near the budget, not 12k of notes.
    const body = brief.markdown.split('\n---\n')[1] ?? brief.markdown;
    expect(body.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS + 300);
  });
});
