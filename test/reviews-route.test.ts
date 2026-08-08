// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E tests for the /api/reviews routes.
 *
 * The point of these: a finding must be resolvable by its STABLE id, not only
 * by array position. `resolveFinding` already accepts `string | number`, and
 * findings carry an `id` precisely so triage survives a re-review that reorders
 * or rewords them — but the HTTP route rejected anything non-numeric, so the
 * dashboard could only address findings positionally. That is the exact bug the
 * store's own comment warns about, one layer up.
 *
 * Spawns `node dist/cli.js serve` against a temp git repo. Gated on dist/cli.js
 * being built (run `npm run build` first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { execa } from 'execa';
import { saveReview } from '../src/reviews.js';
import type { ReviewFinding } from '../src/reviews.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

async function waitForDaemon(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon on :${port} did not become ready within ${timeoutMs}ms`);
}

describe.runIf(hasDist)('/api/reviews routes', () => {
  let child: ChildProcess | null = null;
  let root = '';
  const port = 7400 + Math.floor(Math.random() * 400);

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = null;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setupRepo(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'baton-reviews-route-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const A = 1;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export const B = 2;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  }

  /** Two findings on different axes, so resolving one must not touch the other. */
  async function seedReview(): Promise<ReviewFinding[]> {
    const rec = await saveReview(root, 'my-task', {
      fixedPoint: 'HEAD~1',
      head: 'abc1234',
      findings: [
        { axis: 'standards', title: 'Duplicated guard clause', file: 'src/a.ts', line: 1, source: 'src/a.ts:1' },
        { axis: 'security', title: 'Unvalidated path join', file: 'src/b.ts', line: 2, source: 'src/b.ts:2' },
      ],
    });
    expect(rec.findings).toHaveLength(2);
    return rec.findings;
  }

  it('resolves a finding by its stable id, leaving the others open', async () => {
    await setupRepo();
    const findings = await seedReview();
    // Deliberately the SECOND finding: an id-addressed resolve must land on it
    // regardless of position, which is what a positional API cannot promise.
    const target = findings[1]!;
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const r = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, {
      method: 'POST',
      body: JSON.stringify({ id: target.id }),
    });
    expect(r.status).toBe(200);
    const rec = await r.json() as { findings: ReviewFinding[]; open: Record<string, number> };
    expect(rec.findings.find((f) => f.id === target.id)?.status).toBe('fixed');
    expect(rec.findings.find((f) => f.id === findings[0]!.id)?.status).toBe('open');
    // Per-axis counts only — the axes are never summed.
    expect(rec.open.security).toBe(0);
    expect(rec.open.standards).toBe(1);
  }, 40_000);

  it('dismisses by id when { dismiss: true }', async () => {
    await setupRepo();
    const findings = await seedReview();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const r = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, {
      method: 'POST',
      body: JSON.stringify({ id: findings[0]!.id, dismiss: true }),
    });
    expect(r.status).toBe(200);
    const rec = await r.json() as { findings: ReviewFinding[] };
    expect(rec.findings.find((f) => f.id === findings[0]!.id)?.status).toBe('dismissed');
  }, 40_000);

  it('404s an id that is not in the review', async () => {
    await setupRepo();
    await seedReview();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const r = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, {
      method: 'POST',
      body: JSON.stringify({ id: 'deadbeef00' }),
    });
    expect(r.status).toBe(404);
  }, 40_000);

  it('still accepts a positional index, and rejects a body with neither', async () => {
    await setupRepo();
    const findings = await seedReview();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const ok = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, {
      method: 'POST',
      body: JSON.stringify({ index: 0 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { findings: ReviewFinding[] })
      .findings.find((f) => f.id === findings[0]!.id)?.status).toBe('fixed');

    // A float or NaN index used to pass the store's bounds check and create a
    // NAMED array property, answering 200 with nothing resolved.
    for (const body of ['{}', JSON.stringify({ index: 1.5 }), JSON.stringify({ index: 'x' })]) {
      const bad = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, { method: 'POST', body });
      expect(bad.status, `body ${body} must be rejected`).toBe(400);
    }
  }, 40_000);

  it('lists reviews with per-axis open counts and a staleness flag', async () => {
    await setupRepo();
    await seedReview();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const r = await fetch(`http://127.0.0.1:${port}/api/reviews`);
    expect(r.status).toBe(200);
    const body = await r.json() as {
      reviews: { slug: string; open: Record<string, number>; stale: boolean }[];
      head: string;
    };
    const rec = body.reviews.find((x) => x.slug === 'my-task');
    expect(rec).toBeTruthy();
    expect(rec!.open.standards).toBe(1);
    expect(rec!.open.security).toBe(1);
    // Seeded head 'abc1234' is not this repo's HEAD, so the review is stale.
    expect(rec!.stale).toBe(true);
    expect(body.head).toMatch(/^[0-9a-f]{7,40}$/);
  }, 40_000);

  it('is write-gated like every other mutating endpoint', async () => {
    await setupRepo();
    const findings = await seedReview();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port)], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    const r = await fetch(`http://127.0.0.1:${port}/api/reviews/my-task/resolve`, {
      method: 'POST',
      body: JSON.stringify({ id: findings[0]!.id }),
    });
    expect(r.status).toBe(403);
  }, 40_000);
});
