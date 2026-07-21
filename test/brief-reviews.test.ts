import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildBrief } from '../src/handoff/brief.js';
import { addTask, getTask } from '../src/store.js';
import { resolveFinding, saveReview } from '../src/reviews.js';

/**
 * A review that only reaches a chat window dies with the session. Persisting it
 * was step one; this is step two — the next agent must MEET the open findings
 * without knowing to go looking for them. Anything still open is inherited work,
 * so it belongs in the handoff brief alongside the plan.
 */
const git = (args: string[], cwd: string) => execa('git', args, { cwd });

describe('buildBrief — open review findings', () => {
  let root: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-briefrev-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    wt = join(root, '.baton', 'wt', 'rev');
    await mkdir(join(root, '.baton', 'wt'), { recursive: true });
    await git(['worktree', 'add', '-q', '-b', 'baton/rev', wt, 'main'], root);
    await addTask(root, {
      slug: 'rev', task: 'ship it', branch: 'baton/rev', baseBranch: 'main',
      worktreePath: wt, createdAt: new Date().toISOString(), agent: 'claude', status: 'in-progress',
    } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('carries open findings into the brief, grouped by axis, with id and route', async () => {
    await saveReview(root, 'rev', {
      fixedPoint: 'main',
      head: 'abc1234',
      findings: [
        { axis: 'standards', title: 'Duplicated parsing', file: 'src/a.ts', line: 4,
          source: 'baseline: Duplicated Code', route: 'fix-directly' },
        { axis: 'security', title: 'Unvalidated path', file: 'src/b.ts',
          source: 'baseline: Path traversal', route: 'bug-fix' },
      ],
    });

    const task = await getTask(root, 'rev');
    const brief = await buildBrief(task!, { to: 'claude', root });

    expect(brief.markdown).toContain('Open review findings');
    // grouped by axis — never merged into one ranked list
    expect(brief.markdown).toMatch(/Standards/);
    expect(brief.markdown).toMatch(/Security/);
    expect(brief.markdown).toContain('Duplicated parsing');
    expect(brief.markdown).toContain('Unvalidated path');
    expect(brief.markdown).toContain('src/a.ts:4');
    // the route tells the next agent what to actually do with it
    expect(brief.markdown).toContain('bug-fix');
    // and how to close it out
    expect(brief.markdown).toContain('baton review resolve rev');
  });

  it('omits the section entirely when every finding is resolved', async () => {
    const rec = await saveReview(root, 'rev', {
      fixedPoint: 'main', head: 'abc1234',
      findings: [{ axis: 'standards', title: 'Only one', source: 'baseline: Middle Man' }],
    });
    await resolveFinding(root, 'rev', rec.findings[0].id, 'fixed');

    const task = await getTask(root, 'rev');
    const brief = await buildBrief(task!, { to: 'claude', root });
    // no open findings → no noise in the brief
    expect(brief.markdown).not.toContain('Open review findings');
  });

  it('says nothing about reviews when none was ever recorded', async () => {
    const task = await getTask(root, 'rev');
    const brief = await buildBrief(task!, { to: 'claude', root });
    expect(brief.markdown).not.toContain('Open review findings');
  });
});
