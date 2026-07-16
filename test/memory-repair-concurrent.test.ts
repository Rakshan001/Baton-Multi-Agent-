import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { saveMemory, repairMemories } from '../src/memory.js';

/**
 * Repair runs from three places inside ONE daemon process: the periodic sweep,
 * the recall-time pass (maybeRepairOnRecall), and POST /api/memory/repair.
 * They can overlap, so the atomic write-then-rename must survive two passes
 * touching the same fact at once. Keying the temp file on process.pid alone
 * does not: same process = same name = the second rename hits ENOENT and the
 * endpoint 500s.
 */
describe('repairMemories (concurrent passes in one process)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-repair-race-'));
    await execa('git', ['init', '-q'], { cwd: root });
    await execa('git', ['config', 'user.email', 't@t.test'], { cwd: root });
    await execa('git', ['config', 'user.name', 'T'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = false;\n');
    await execa('git', ['add', '-A'], { cwd: root });
    await execa('git', ['commit', '-qm', 'init'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('never loses a rename race when two repairs overlap on the same fact', async () => {
    const fact = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention',
      files: ['src/server.ts'],
    });

    // Go stale: the anchored file changes but the verifiable term survives, so
    // both passes will decide this fact is mechanically re-anchorable.
    await writeFile(join(root, 'src', 'server.ts'), '// hardened\nexport const ORIGIN_GUARD = true;\n');

    // Two passes at once — exactly what the sweep + the endpoint do.
    const results = await Promise.allSettled([repairMemories(root), repairMemories(root)]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    // At least one pass must claim the re-anchor; neither may throw.
    const reanchored = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.reanchored : []));
    expect(reanchored).toContain(fact.id);
  });
});
