// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, open, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { usePrivateHome } from './helpers/private-home.js';
import {
  consolidateOnce,
  lastConsolidationPass,
  listDaemonRecords,
  startIdleConsolidation,
  sweepDeadDaemonRecords,
  writeDaemonRecord,
} from '../src/daemons.js';
import { tasksFile } from '../src/store.js';
import { memoryConsolidateCmd } from '../src/commands/memory.js';
import {
  archiveDir, fingerprintOf, listMemories, localMemoryDir, readJournal, renderFactFile,
  type MemoryFact,
} from '../src/memory.js';

/**
 * Where the mechanical consolidation pass actually RUNS.
 *
 * The pass itself (src/memory/consolidate.ts) is pure and already tested. This
 * file is about the two things that decide whether it is a help or a tax:
 *
 *   - **Idle means idle.** It runs when nothing else is happening and never
 *     while a task is active; work starting mid-pass CANCELS it rather than
 *     queueing behind it. A background pass that competes with an agent for
 *     CPU makes the tool slower at exactly the moment it is being used.
 *   - **Every background capability has a manual equivalent.** `baton memory
 *     consolidate` runs the same pass, so someone who never leaves a daemon
 *     running does not silently get a lesser product.
 *
 * And the daemon must survive it: a failure is logged, never thrown into the
 * event loop that also serves the dashboard.
 */

// Machine-wide state lives in ~/.baton — file scope, so no describe leaks it.
usePrivateHome('baton-consolidate-idle-');

let root: string;
const g = (args: string[]) => execa('git', args, { cwd: root });

/** Seed a fact FILE directly. `saveMemory` de-dupes at write time, so it is
 *  physically unable to produce the duplicate pair this pass exists to clean
 *  up — those arrive by git pull, by two clones, or from before the gate. */
async function seed(id: string, text: string, createdAt: string): Promise<void> {
  const dir = localMemoryDir(root);
  await mkdir(dir, { recursive: true });
  const f: MemoryFact = {
    id, type: 'convention', fact: text, agent: 'claude', author: 'tester', task: null,
    createdAt, anchors: { commit: null, files: [] }, supersedes: null,
    fingerprint: fingerprintOf(text),
  };
  await writeFile(join(dir, `${id}.md`), renderFactFile(f), 'utf-8');
}

const DUP = 'Git calls go through src/util/exec.ts, never a raw shell.';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-consolidate-idle-'));
  await g(['init', '-q']);
  await g(['config', 'user.email', 't@t.t']);
  await g(['config', 'user.name', 'T']);
  await writeFile(join(root, 'README.md'), '# t\n');
  await g(['add', '.']);
  await g(['commit', '-qm', 'init']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('consolidateOnce — the pass, given somewhere to run', () => {
  it('applies the plan: the older duplicate is superseded, archived and journalled', async () => {
    await seed('older-dup', DUP, '2026-08-01T00:00:00.000Z');
    await seed('newer-dup', DUP, '2026-08-02T00:00:00.000Z');

    const r = await consolidateOnce(root);

    expect(r.status).toBe('ran');
    expect(r.superseded).toEqual(['older-dup']);
    const ids = (await listMemories(root)).map((f) => f.id);
    expect(ids).toContain('newer-dup');
    expect(ids).not.toContain('older-dup');
    // Supersede, never delete: the lineage is recorded, both ways.
    const j = await readJournal(root);
    expect(j.some((e) => e.op === 'supersede' && e.id === 'older-dup' && e.supersededBy === 'newer-dup')).toBe(true);
  });

  it('reports a contradiction for a person instead of resolving it', async () => {
    await seed('yes', 'The daemon must stay zero-dependency in src/server.ts.', '2026-08-01T00:00:00.000Z');
    await seed('no', 'The daemon must not stay zero-dependency in src/server.ts.', '2026-08-02T00:00:00.000Z');

    const r = await consolidateOnce(root);
    expect(r.status).toBe('ran');
    expect(r.superseded).toEqual([]);
    expect(r.contradictions.length).toBe(1);
    // Nothing was retired to "settle" the disagreement.
    expect((await listMemories(root)).map((f) => f.id).sort()).toEqual(['no', 'yes']);
  });

  it('never runs while a task is active — nothing is read, written or stamped', async () => {
    await seed('older-dup', DUP, '2026-08-01T00:00:00.000Z');
    await seed('newer-dup', DUP, '2026-08-02T00:00:00.000Z');

    const r = await consolidateOnce(root, { isBusy: () => true });

    expect(r.status).toBe('busy');
    expect(r.superseded).toEqual([]);
    expect((await listMemories(root)).length).toBe(2);
    // And it did not record a pass, so the NEXT idle window still does the work.
    expect((await consolidateOnce(root)).status).toBe('ran');
  });

  it('is CANCELLED, not queued, when work starts mid-pass', async () => {
    await seed('a-old', DUP, '2026-08-01T00:00:00.000Z');
    await seed('a-new', DUP, '2026-08-02T00:00:00.000Z');
    const other = 'Realtime is SSE and lives in src/events.ts, not socket.io.';
    await seed('b-old', other, '2026-08-01T00:00:00.000Z');
    await seed('b-new', other, '2026-08-02T00:00:00.000Z');

    // Idle when the pass starts; the machine gets busy the moment the first
    // fact has been retired (one archived file = one write landed).
    const busyOnceOneLanded = async () =>
      (await readdir(archiveDir(root)).catch(() => [] as string[])).length > 0;
    const r = await consolidateOnce(root, { isBusy: busyOnceOneLanded });

    expect(r.status).toBe('cancelled');
    expect(r.superseded.length).toBe(1);
    // Cancelled work is not recorded as a completed pass — the rest is picked
    // up next time the machine is quiet, not abandoned.
    const next = await consolidateOnce(root);
    expect(next.status).toBe('ran');
    expect(next.superseded.length).toBe(1);
    expect((await listMemories(root)).map((f) => f.id).sort()).toEqual(['a-new', 'b-new']);
  });

  it('is skipped entirely when the store has not changed since the last pass', async () => {
    await seed('older-dup', DUP, '2026-08-01T00:00:00.000Z');
    await seed('newer-dup', DUP, '2026-08-02T00:00:00.000Z');
    expect((await consolidateOnce(root)).status).toBe('ran');

    const before = (await readJournal(root)).length;
    const again = await consolidateOnce(root);
    expect(again.status).toBe('unchanged');
    expect(again.superseded).toEqual([]);
    expect((await readJournal(root)).length).toBe(before);

    // A new fact makes the store interesting again.
    await seed('fresh-one', 'Demo mode defaults ON only on the Vite dev origin.', '2026-08-03T00:00:00.000Z');
    expect((await consolidateOnce(root)).status).toBe('ran');
  });

  it('logs a failure and returns it, rather than throwing at the daemon', async () => {
    const logged: string[] = [];
    // A root that is not a directory: every read below it fails.
    const bogus = join(root, 'not-a-repo', 'nope');
    const r = await consolidateOnce(bogus, { log: (m) => logged.push(m) });

    expect(r.status).toBe('failed');
    expect(r.error).toBeTruthy();
    expect(logged.join('\n')).toMatch(/consolidat/i);
  });
});

describe('startIdleConsolidation — the daemon side', () => {
  it('runs the pass on a tick, with the daemon\'s own idea of "busy"', async () => {
    const calls: Array<{ root: string; busy: boolean }> = [];
    const idle = startIdleConsolidation({
      root,
      intervalMs: 3_600_000,
      isBusy: () => true,
      run: async (r, o) => {
        calls.push({ root: r, busy: Boolean(await o.isBusy?.()) });
        return { status: 'ran', superseded: [], contradictions: [] };
      },
    });
    try {
      expect((await idle.tick()).status).toBe('ran');
      expect(calls).toEqual([{ root, busy: true }]);
    } finally {
      idle.stop();
    }
  });

  it('logs a failing pass and keeps running — the daemon is never degraded', async () => {
    const logged: string[] = [];
    let n = 0;
    const idle = startIdleConsolidation({
      root,
      intervalMs: 3_600_000,
      log: (m) => logged.push(m),
      run: async () => {
        if (++n === 1) throw new Error('disk on fire');
        return { status: 'ran', superseded: [], contradictions: [] };
      },
    });
    try {
      const first = await idle.tick();
      expect(first.status).toBe('failed');
      expect(logged.join('\n')).toContain('disk on fire');
      // Still armed: the next tick does real work.
      expect((await idle.tick()).status).toBe('ran');
    } finally {
      idle.stop();
    }
  });

  it('never overlaps itself — a tick during a pass is skipped, not queued', async () => {
    let runs = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const idle = startIdleConsolidation({
      root,
      intervalMs: 3_600_000,
      run: async () => {
        runs++;
        await gate;
        return { status: 'ran', superseded: [], contradictions: [] };
      },
    });
    try {
      const inFlight = idle.tick();
      expect((await idle.tick()).status).toBe('busy');
      release();
      expect((await inFlight).status).toBe('ran');
      expect(runs).toBe(1);
    } finally {
      idle.stop();
    }
  });
});

describe('baton memory consolidate — the manual equivalent', () => {
  it('runs the same pass on demand, for someone with no long-lived daemon', async () => {
    await seed('older-dup', DUP, '2026-08-01T00:00:00.000Z');
    await seed('newer-dup', DUP, '2026-08-02T00:00:00.000Z');

    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await memoryConsolidateCmd();
    } finally {
      process.chdir(cwd);
      console.log = log;
    }

    expect((await listMemories(root)).map((f) => f.id)).toEqual(['newer-dup']);
    expect(lines.join('\n')).toContain('older-dup');
  });
});

describe('the fleet registry it shares a file with', () => {
  it('still records, lists and sweeps daemons (existing duties untouched)', async () => {
    const dir = join(root, 'fleet');
    const rec = {
      pid: process.pid, port: 7077, root, startedAt: new Date().toISOString(),
      version: 'test', writeEnabled: true, host: false,
    };
    await writeDaemonRecord(rec, dir);
    expect((await listDaemonRecords(dir)).map((r) => r.pid)).toEqual([process.pid]);
    // A live pid is never swept.
    expect(await sweepDeadDaemonRecords(dir)).toEqual([]);
    expect((await listDaemonRecords(dir)).length).toBe(1);
  });
});

describe('the idle gate treats an unreadable task store as busy', () => {
  /**
   * `tasksInFlight` documented itself as failing closed — "Unknown is treated
   * as BUSY ... running one over a repo whose state we cannot see is the risk
   * this whole gate exists to avoid" — and did the opposite.
   *
   * `loadTasks` catches its own errors and returns `[]`, so the catch here was
   * unreachable: a truncated or unparseable `tasks.json` read as "no tasks",
   * which reads as "nobody is working", and the pass rewrote the memory store
   * underneath a live agent. A comment claiming a safety property is worth
   * nothing until a test holds it to it.
   */
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-idle-busy-'));
    await execa('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Identical bodies, so both land in one fingerprint group and the pass has a
  // merge to plan. The group comes from the TEXT — the fingerprint is computed
  // at parse, never read from the file, so declaring one here would say nothing.
  const seedTwoMergeableFacts = async () => {
    const dir = join(root, '.baton', 'memory', 'facts');
    await mkdir(dir, { recursive: true });
    for (const [id, at] of [['a', '2020-01-01T00:00:00Z'], ['b', '2020-01-02T00:00:00Z']]) {
      await writeFile(join(dir, `${id}.md`), [
        '---', `id: ${id}`, 'author: t', 'agent: claude', `createdAt: ${at}`,
        '---', '', 'the same claim twice', '',
      ].join('\n'), 'utf-8');
    }
  };

  it('does not run when tasks.json is corrupt', async () => {
    await seedTwoMergeableFacts();
    await writeFile(join(root, '.baton', 'tasks.json'), '[{"slug":"x",', 'utf-8');
    const r = await consolidateOnce(root);
    expect(r.status).toBe('busy');
    expect(r.superseded).toEqual([]);
  });

  it('still runs when there is genuinely no task store', async () => {
    // Absent is knowable: no tasks means nobody is working. Only UNREADABLE is
    // unknown, and only unknown blocks.
    await seedTwoMergeableFacts();
    const r = await consolidateOnce(root);
    expect(r.status).not.toBe('busy');
  });

  /*
   * A zero-byte tasks.json is NOT the absent case.
   *
   * `saveTasks` writes tmp-then-rename, so no reader ever sees a half-written
   * store: an empty or whitespace-only file means something else truncated it —
   * a crash, an editor, a filesystem that lost the contents. That is a repo
   * whose state we cannot see, which is the exact condition the gate says it
   * treats as busy. `JSON.parse('')` throws, so the corrupt branch below would
   * have caught it; a `if (!raw.trim()) return false` short-circuit above it
   * turned the one unknown state that LOOKS empty back into "nobody is
   * working", and the pass rewrote memory under a live agent.
   */
  for (const [name, contents] of [['empty', ''], ['whitespace-only', '  \n\t\n']] as const) {
    it(`does not run when tasks.json is ${name}`, async () => {
      await seedTwoMergeableFacts();
      await writeFile(join(root, '.baton', 'tasks.json'), contents, 'utf-8');
      const r = await consolidateOnce(root);
      expect(r.status).toBe('busy');
      expect(r.superseded).toEqual([]);
    });
  }

  it('does not run when tasks.json parses but is not a list of tasks', async () => {
    await seedTwoMergeableFacts();
    await writeFile(join(root, '.baton', 'tasks.json'), '{"slug":"x"}', 'utf-8');
    const r = await consolidateOnce(root);
    expect(r.status).toBe('busy');
  });

  it('runs on a task store that is readable and idle', async () => {
    // The gate must still open: failing closed on everything is not a gate.
    await seedTwoMergeableFacts();
    await writeFile(join(root, '.baton', 'tasks.json'), '[]', 'utf-8');
    expect((await consolidateOnce(root)).status).toBe('ran');
  });
});

describe('the consolidation stamp is replaced, never rewritten in place', () => {
  /**
   * `stampPass` was the one writer in daemons.ts that called `writeFile`
   * straight at its destination. Every neighbour — `saveTasks`,
   * `setBriefStatusAt`, `saveProgress`, `releaseSkill` — stages to a
   * pid-scoped temp and renames, because `writeFile` opens the real path with
   * O_TRUNC: for the width of that call the stamp on disk is a zero-byte file.
   *
   * Two daemons on one repo hit that window, and so does an idle tick racing
   * `baton memory consolidate` (which deliberately passes `isBusy: () => false`
   * and so does not wait for anyone). It is recoverable — `lastSignature`
   * catches the parse error and redoes the pass — but "recoverable" is not the
   * same as "correct", and `GET /api/memory/consolidation` reports a torn stamp
   * as "no pass has ever run here".
   *
   * The property under test is atomic REPLACEMENT: a reader that opened the
   * stamp keeps reading the complete file it opened, because the new content
   * arrives as a different inode moved into place rather than as a truncation
   * of the one under its cursor. That is exactly what makes a partial read
   * impossible, and unlike a timing loop it is deterministic.
   */
  let root: string;
  const stampFile = (): string => join(root, '.baton', 'memory', 'consolidate.json');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-stamp-atomic-'));
    await execa('git', ['init', '-q'], { cwd: root });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const seedPair = async (id: string, claim: string, dir = join(root, '.baton', 'memory', 'facts')) => {
    await mkdir(dir, { recursive: true });
    for (const [n, at] of [['old', '2020-01-01T00:00:00Z'], ['new', '2020-01-02T00:00:00Z']]) {
      await writeFile(join(dir, `${id}-${n}.md`), [
        '---', `id: ${id}-${n}`, 'author: t', 'agent: claude', `createdAt: ${at}`,
        `fingerprint: ${claim}`, '---', '', claim, '',
      ].join('\n'), 'utf-8');
    }
  };

  it('does not rewrite the stamp under a reader that already opened it', async () => {
    await seedPair('a', 'the first claim, twice');
    expect((await consolidateOnce(root)).status).toBe('ran');
    const first = await lastConsolidationPass(root);
    expect(first?.superseded).toEqual(['a-old']);

    // A reader opens the stamp and holds it — the dashboard route, or the other
    // daemon, mid-read.
    const held = await open(stampFile(), 'r');
    try {
      // Meanwhile a second pass stamps again. New facts, so it genuinely runs.
      await seedPair('b', 'the second claim, twice');
      expect((await consolidateOnce(root)).status).toBe('ran');

      // The held handle still sees the whole file it opened. With an in-place
      // rewrite it would be reading the new pass's bytes through the same
      // inode — and, at the wrong instant, none of them.
      const snapshot = await held.readFile('utf-8');
      expect(() => JSON.parse(snapshot)).not.toThrow();
      expect(JSON.parse(snapshot).superseded).toEqual(['a-old']);
    } finally {
      await held.close();
    }

    // And the newest stamp is on disk, complete, for the next reader.
    expect((await lastConsolidationPass(root))?.superseded).toEqual(['b-old']);
  });

  it('leaves no staging file behind', async () => {
    await seedPair('a', 'the only claim, twice');
    expect((await consolidateOnce(root)).status).toBe('ran');

    const entries = await readdir(join(root, '.baton', 'memory'));
    expect(entries).toContain('consolidate.json');
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});

describe('the idle gate reads the store at the path the store defines', () => {
  /**
   * `tasksInFlight` rebuilt `<root>/.baton/tasks.json` by hand instead of
   * asking `tasksFile()`. The two agree today, which is the whole problem: if
   * the store ever moves its file, the gate silently reads a path nothing
   * writes, gets ENOENT, calls that "no tasks", and re-opens the fail-closed
   * gate the corrupt/empty cases above just shut — with nothing failing to say
   * so. This test writes through the store's own path function, so the two
   * cannot drift apart without going red.
   */
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-gate-path-'));
    await execa('git', ['init', '-q'], { cwd: root });
    const dir = join(root, '.baton', 'memory', 'facts');
    await mkdir(dir, { recursive: true });
    for (const [id, at] of [['a', '2020-01-01T00:00:00Z'], ['b', '2020-01-02T00:00:00Z']]) {
      await writeFile(join(dir, `${id}.md`), [
        '---', `id: ${id}`, 'author: t', 'agent: claude', `createdAt: ${at}`,
        'fingerprint: the same claim twice', '---', '', 'the same claim twice', '',
      ].join('\n'), 'utf-8');
    }
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const writeStore = async (tasks: unknown[]) => {
    const file = tasksFile(root);
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(file, JSON.stringify(tasks), 'utf-8');
  };

  it('sees an active task written at tasksFile() and refuses to run', async () => {
    await writeStore([{ slug: 'x', state: 'active' }]);
    expect((await consolidateOnce(root)).status).toBe('busy');
  });

  it('sees a claimed task written at tasksFile() and refuses to run', async () => {
    await writeStore([{ slug: 'x', state: 'claimed' }]);
    expect((await consolidateOnce(root)).status).toBe('busy');
  });

  it('runs when that same file says nobody is working', async () => {
    await writeStore([{ slug: 'x', state: 'done' }]);
    expect((await consolidateOnce(root)).status).toBe('ran');
  });
});

/**
 * What the pass REPORTS has to be what the pass DID.
 *
 * `superseded` is not a log line: it lands in `.baton/memory/consolidate.json`
 * and on the dashboard, and it is the only account anyone gets of knowledge the
 * machine retired while nobody was looking. A pass that names a fact it did not
 * retire teaches a reader to distrust the list — and a pass that retires one it
 * does not name is worse.
 *
 * The store can refuse a retire the plan asked for: the planner works from
 * frontmatter ids, the retire works from file names, and `archiveFact` now
 * refuses when the file at that name does not declare the fact being retired.
 * So the boolean it returns is the truth, and it is the only thing the report
 * may be built from.
 */
describe('the consolidation pass reports only what it actually retired', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-superseded-report-'));
    await execa('git', ['init', '-q'], { cwd: root });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('omits a fact whose file refused the retire, and leaves that fact live', async () => {
    const dir = localMemoryDir(root);
    await mkdir(dir, { recursive: true });
    const claim = 'the daemon binds to loopback and refuses a public bind';
    // Three identical claims — one fingerprint group, so the pass plans to
    // retire the two older ones in favour of the newest.
    //
    // `mem-x.md` is the trap: its NAME is the id the plan will name, its
    // CONTENTS are a different fact. Retiring `mem-x` used to archive this
    // file, destroying `mem-y` — a fact nobody named, with a journal line
    // naming `mem-x`.
    const plant = async (name: string, id: string, at: string) => {
      await writeFile(join(dir, `${name}.md`), [
        '---', `id: ${id}`, 'author: t', 'agent: claude', `created: '${at}'`,
        '---', '', claim, '',
      ].join('\n'), 'utf-8');
    };
    await plant('mem-x', 'mem-y', '2020-01-01T00:00:00.000Z');
    await plant('elsewhere', 'mem-x', '2020-01-02T00:00:00.000Z');
    await plant('mem-z', 'mem-z', '2020-01-03T00:00:00.000Z');

    const r = await consolidateOnce(root);

    expect(r.status).toBe('ran');
    // `mem-x` is resolvable to a file, but that file is not `mem-x`; `mem-y` is
    // servable but no file is named for it. Neither can be retired, so neither
    // may be reported.
    expect(r.superseded).toEqual([]);
    expect((await listMemories(root)).map((f) => f.id).sort()).toEqual(['mem-x', 'mem-y', 'mem-z']);
    expect(await readJournal(root)).toEqual([]);
    expect(await lastConsolidationPass(root)).toMatchObject({ superseded: [] });
  });
});
