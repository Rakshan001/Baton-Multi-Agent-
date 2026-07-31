import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { addTask, getTask } from '../src/store.js';
import { saveReview } from '../src/reviews.js';
import { saveProgress } from '../src/handoff/progress-ledger.js';
import {
  BundleError, BUNDLE_VERSION, buildBundle, cleanBundle, importBundle, isSafeBundlePath,
  looksBinary, readBundle, restoreContext, scanBundleSecrets, writeBundle,
} from '../src/handoff/bundle.js';

/**
 * The bundle exists because `baton pass` carries the STORY of a task but not the
 * WORK — the uncommitted diff never left the worktree. What is pinned here is
 * mostly refusal: a patch is only meaningful against the sha it was cut from, it
 * cannot be redacted, and it must never half-apply.
 */
const git = (args: string[], cwd: string) => execa('git', args, { cwd });

let root: string;
let wt: string;

async function makeRepoWithTask(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'baton-bundle-'));
  await git(['init', '-q', '-b', 'main'], root);
  await git(['config', 'user.email', 't@t.dev'], root);
  await git(['config', 'user.name', 't'], root);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-qm', 'init'], root);
  wt = join(root, '.baton', 'wt', 'feat');
  await mkdir(join(root, '.baton', 'wt'), { recursive: true });
  await git(['worktree', 'add', '-q', '-b', 'baton/feat', wt, 'main'], root);
  await addTask(root, {
    slug: 'feat', task: 'add the thing', branch: 'baton/feat', baseBranch: 'main',
    worktreePath: wt, createdAt: new Date().toISOString(), agent: 'claude', status: 'in-progress',
  } as never);
}

beforeEach(makeRepoWithTask);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/* ---------------- pure helpers ---------------- */

describe('isSafeBundlePath', () => {
  it('accepts repo-relative paths and refuses anything that escapes', () => {
    expect(isSafeBundlePath('src/new.ts')).toBe(true);
    expect(isSafeBundlePath('../../.ssh/authorized_keys')).toBe(false);
    expect(isSafeBundlePath('/etc/passwd')).toBe(false);
    expect(isSafeBundlePath('C:\\evil')).toBe(false);
    expect(isSafeBundlePath('a/../../b')).toBe(false);
    expect(isSafeBundlePath('')).toBe(false);
  });
});

describe('looksBinary', () => {
  it('passes ordinary source and rejects control bytes', () => {
    expect(looksBinary('const a = 1;\n\tindented\r\n')).toBe(false);
    expect(looksBinary('PNG\u0000\u0001data')).toBe(true);
  });
});

describe('scanBundleSecrets', () => {
  it('finds a credential in the diff', () => {
    const patch = '+++ b/config.ts\n+const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n';
    expect(scanBundleSecrets(patch, [])).toMatch(/working-tree diff/);
  });

  it('finds one in an untracked file and names the file', () => {
    const found = scanBundleSecrets('', [
      { path: '.env.local', content: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' },
    ]);
    expect(found).toMatch(/\.env\.local/);
  });

  it('stays quiet on ordinary code', () => {
    expect(scanBundleSecrets('+const port = 7077;\n', [{ path: 'a.ts', content: 'export const a = 1;' }])).toBeNull();
  });
});

describe('cleanBundle', () => {
  const ok = (over: Record<string, unknown> = {}): unknown => ({
    version: BUNDLE_VERSION, slug: 'feat', task: 't', branch: 'b', baseBranch: 'main',
    head: 'a'.repeat(40), patch: '', untracked: [], findings: [], memory: [], ...over,
  });

  it('accepts a well-formed bundle', () => {
    expect(cleanBundle(ok()).slug).toBe('feat');
  });

  it('refuses an unknown version rather than guessing', () => {
    expect(() => cleanBundle(ok({ version: 99 }))).toThrow(BundleError);
  });

  it('refuses a bundled file that would be written outside the repo', () => {
    expect(() => cleanBundle(ok({ untracked: [{ path: '../../pwn', content: 'x' }] }))).toThrow(/unsafe file path/);
  });

  it('ignores a malformed head rather than passing it to git', () => {
    expect(cleanBundle(ok({ head: 'not-a-sha; rm -rf /' })).head).toBeNull();
  });
});

/* ---------------- export ---------------- */

describe('buildBundle', () => {
  it('captures the uncommitted diff and untracked files', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2; // changed\n', 'utf-8');
    await writeFile(join(wt, 'brand-new.ts'), 'export const n = 1;\n', 'utf-8');

    const task = (await getTask(root, 'feat'))!;
    const { bundle } = await buildBundle(root, task);

    expect(bundle.patch).toContain('changed');
    expect(bundle.untracked.map((f) => f.path)).toContain('brand-new.ts');
    expect(bundle.head).toMatch(/^[0-9a-f]{40}$/);
    expect(bundle.author.length).toBeGreaterThan(0);
  });

  it('carries the open findings and the progress ledger', async () => {
    await saveReview(root, 'feat', {
      fixedPoint: 'main', head: 'abc1234',
      findings: [{ axis: 'security', title: 'Unvalidated path', source: 'baseline: Path traversal' }],
    });
    await saveProgress(root, 'feat', { plan: [{ content: 'wire it up', status: 'in_progress' }], next: 'finish the test' });

    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);
    expect(bundle.findings).toHaveLength(1);
    expect(bundle.findings[0].title).toBe('Unvalidated path');
    expect(bundle.progress?.plan[0].content).toBe('wire it up');
  });

  /*
   * The central asymmetry. A memory fact keeps its meaning when a secret inside
   * it is replaced with a marker; a patch does not — it has to apply byte-exact.
   * So the only honest options are refuse or ship the secret, and a bundle is
   * built to be sent to someone else.
   */
  it('REFUSES to export a diff containing a credential', async () => {
    await writeFile(join(wt, 'a.ts'), 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n', 'utf-8');
    const task = (await getTask(root, 'feat'))!;
    await expect(buildBundle(root, task)).rejects.toThrow(/refusing to export/);
  });

  it('exports anyway under --allow-secrets, for a false positive', async () => {
    await writeFile(join(wt, 'a.ts'), 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n', 'utf-8');
    const task = (await getTask(root, 'feat'))!;
    const { bundle } = await buildBundle(root, task, { allowSecrets: true });
    expect(bundle.patch).toContain('sk-ant-api03');
  });

  // A file left out is work that will not arrive, so it is always reported.
  it('reports a binary untracked file as skipped instead of dropping it silently', async () => {
    await writeFile(join(wt, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const { bundle, skipped } = await buildBundle(root, (await getTask(root, 'feat'))!);
    expect(bundle.untracked.map((f) => f.path)).not.toContain('logo.bin');
    expect(skipped.join(' ')).toMatch(/logo\.bin.*binary/);
  });

  it('exports a clean tree as an empty patch rather than failing', async () => {
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);
    expect(bundle.patch).toBe('');
    expect(bundle.untracked).toHaveLength(0);
  });
});

/* ---------------- round trip + import ---------------- */

describe('export → import', () => {
  /** A second checkout of the same repo at the same commit — the receiving machine. */
  async function makeClone(): Promise<string> {
    const dst = await mkdtemp(join(tmpdir(), 'baton-bundle-dst-'));
    await execa('git', ['clone', '-q', root, join(dst, 'repo')]);
    return join(dst, 'repo');
  }

  it('reproduces the dirty working state in a fresh clone', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2; // changed\n', 'utf-8');
    await writeFile(join(wt, 'brand-new.ts'), 'export const n = 1;\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);

    const clone = await makeClone();
    const result = await importBundle(clone, bundle);

    expect(result.status).toBe('applied');
    expect(await readFile(join(clone, 'a.ts'), 'utf-8')).toContain('changed');
    expect(await readFile(join(clone, 'brand-new.ts'), 'utf-8')).toContain('export const n = 1');
    await rm(clone, { recursive: true, force: true });
  });

  /*
   * The rule that makes this safe. A diff has no meaning apart from its base
   * commit; applying one to a moved HEAD yields a rejected hunk at best and a
   * silently wrong merge at worst.
   */
  it('applies NOTHING when HEAD has moved, and says how far', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2;\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);

    const clone = await makeClone();
    await writeFile(join(clone, 'unrelated.ts'), 'export const u = 1;\n', 'utf-8');
    await git(['add', '.'], clone);
    await git(['-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'commit', '-qm', 'moved on'], clone);

    const result = await importBundle(clone, bundle);
    expect(result.status).toBe('head-mismatch');
    expect(result.detail).toMatch(/1 commit\(s\) ahead/);
    expect(result.drift?.baseKnown).toBe(true);
    // the tree was not touched
    expect(await readFile(join(clone, 'a.ts'), 'utf-8')).toBe('export const a = 1;\n');
    await rm(clone, { recursive: true, force: true });
  });

  it('--force applies over a moved HEAD when the patch still fits', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2;\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);

    const clone = await makeClone();
    await writeFile(join(clone, 'unrelated.ts'), 'export const u = 1;\n', 'utf-8');
    await git(['add', '.'], clone);
    await git(['-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'commit', '-qm', 'moved on'], clone);

    const result = await importBundle(clone, bundle, { force: true });
    expect(result.status).toBe('applied');
    expect(await readFile(join(clone, 'a.ts'), 'utf-8')).toContain('const a = 2');
    await rm(clone, { recursive: true, force: true });
  });

  // A half-applied patch is worse than a refused one, so --check runs first.
  it('refuses cleanly when the patch cannot apply, leaving the tree untouched', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2;\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);

    const clone = await makeClone();
    // same sha, but the file underneath the patch is different
    await writeFile(join(clone, 'a.ts'), 'totally different content\n', 'utf-8');

    const result = await importBundle(clone, bundle, { force: true });
    expect(result.status).toBe('would-conflict');
    expect(await readFile(join(clone, 'a.ts'), 'utf-8')).toBe('totally different content\n');
    await rm(clone, { recursive: true, force: true });
  });

  it('never overwrites an existing file, and says which it left alone', async () => {
    await writeFile(join(wt, 'brand-new.ts'), 'from the bundle\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);

    const clone = await makeClone();
    await writeFile(join(clone, 'brand-new.ts'), 'MY local work\n', 'utf-8');

    const result = await importBundle(clone, bundle);
    expect(await readFile(join(clone, 'brand-new.ts'), 'utf-8')).toBe('MY local work\n');
    expect(result.detail).toMatch(/brand-new\.ts/);
    await rm(clone, { recursive: true, force: true });
  });

  it('reports a clean bundle as nothing-to-apply rather than pretending it worked', async () => {
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);
    const clone = await makeClone();
    const result = await importBundle(clone, bundle);
    expect(result.status).toBe('nothing-to-apply');
    await rm(clone, { recursive: true, force: true });
  });

  it('restores the brief and ledger so `baton resume` can see them', async () => {
    await saveProgress(root, 'feat', { plan: [{ content: 'step one' }], next: 'do step two' });
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);
    bundle.brief = '---\nbaton: 1\n---\n\n# carry me\n';

    const clone = await makeClone();
    const written = await restoreContext(clone, clone, bundle);
    expect(written).toContain('HANDOFF.md');
    expect(existsSync(join(clone, 'HANDOFF.md'))).toBe(true);
    expect(existsSync(join(clone, '.baton', 'progress', 'feat.json'))).toBe(true);
    await rm(clone, { recursive: true, force: true });
  });

  it('survives a write/read round trip through disk', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 3;\n', 'utf-8');
    const { bundle } = await buildBundle(root, (await getTask(root, 'feat'))!);
    const file = join(root, 'out.bundle.json');
    await writeBundle(file, bundle);
    const back = await readBundle(file);
    expect(back.patch).toBe(bundle.patch);
    expect(back.slug).toBe('feat');
  });

  it('reports a missing or malformed bundle file clearly', async () => {
    await expect(readBundle(join(root, 'nope.json'))).rejects.toThrow(/cannot read bundle/);
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{not json', 'utf-8');
    await expect(readBundle(bad)).rejects.toThrow(/not valid JSON/);
  });
});
