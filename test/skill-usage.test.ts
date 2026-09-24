// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The skill usage ledger: an append-only record of which skills actually get
 * used, so "which of these earns its place" stops being a guess.
 *
 * HOME is redirected per test — these write ~/.baton/skill-usage.jsonl, and a
 * suite that can write into the developer's own library is worse than no suite
 * (same convention as skill-origins.test.ts and skill-quarantine.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usePrivateHome } from './helpers/private-home.js';
import { existsSync } from 'node:fs';
import {
  MAX_ENTRY_BYTES, MAX_LEDGER_LINES, USAGE_VERSION,
  readUsage, recordUsage, usagePath,
} from '../src/skills/usage.js';
import {
  exportSkillFile, loadSkillRecordingUse, installSkill, listSkillStatus, uninstallSkill,
} from '../src/skills/install.js';
import { bundledSkills } from '../src/skills/catalog.js';

const home = usePrivateHome('baton-usage-home-');

/** Seed the ledger in ONE write — never by looping the writer. */
async function seed(lines: string[]): Promise<void> {
  await mkdir(join(home(), '.baton'), { recursive: true });
  await writeFile(usagePath(), lines.join('\n') + '\n', 'utf-8');
}

const entry = (id: string, at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: USAGE_VERSION, id, at, a: 'load', ...extra });

/** Where the catalog reads file-backed skills from, resolved the same way. */
const BUNDLED_DIR = fileURLToPath(new URL('../src/skills/bundled', import.meta.url));

const linesOf = async (): Promise<string[]> =>
  (await readFile(usagePath(), 'utf-8')).split('\n').filter((l) => l.trim());

describe('the usage ledger file', () => {
  it('reads a missing file as "no usage", not as an error', async () => {
    await expect(readUsage()).resolves.toEqual(new Map());
  });

  it('lives beside bookmarks at ~/.baton, machine-wide', async () => {
    expect(usagePath()).toBe(join(home(), '.baton', 'skill-usage.jsonl'));
  });

  it('appends one JSON object per line rather than rewriting the file', async () => {
    await recordUsage('bug-fix', 'install');
    const first = await readFile(usagePath(), 'utf-8');
    await recordUsage('bug-fix', 'load');

    const lines = await linesOf();
    expect(lines).toHaveLength(2);
    // The first write is still there, byte for byte: an append never rewrites.
    expect((await readFile(usagePath(), 'utf-8')).startsWith(first)).toBe(true);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('loses no entry when writers run concurrently', async () => {
    // The whole reason this is append-only: a read-modify-write of a counters
    // object drops entries here, because Baton is a multi-agent hub.
    const ids = Array.from({ length: 40 }, (_, i) => `skill-${i}`);
    await Promise.all(ids.map((id) => recordUsage(id, 'load')));

    const usage = await readUsage();
    expect(usage.size).toBe(ids.length);
    for (const id of ids) expect(usage.get(id)?.count, id).toBe(1);
  });
});

describe('readUsage aggregates', () => {
  it('counts uses per skill and keeps the latest timestamp', async () => {
    await seed([
      entry('bug-fix', '2026-01-01T00:00:00.000Z'),
      entry('bug-fix', '2026-03-02T00:00:00.000Z'),
      entry('lean-code', '2026-02-01T00:00:00.000Z'),
      // out of order on purpose: the ledger is appended by several writers
      entry('bug-fix', '2026-02-02T00:00:00.000Z'),
    ]);
    const usage = await readUsage();
    expect(usage.get('bug-fix')).toEqual({ count: 3, lastUsedAt: '2026-03-02T00:00:00.000Z' });
    expect(usage.get('lean-code')).toEqual({ count: 1, lastUsedAt: '2026-02-01T00:00:00.000Z' });
  });

  it('skips a truncated final line instead of throwing the whole file away', async () => {
    // Exactly what a crash mid-append leaves behind.
    await mkdir(join(home(), '.baton'), { recursive: true });
    await writeFile(
      usagePath(),
      entry('bug-fix', '2026-01-01T00:00:00.000Z') + '\n' + '{"v":1,"id":"lean-co',
      'utf-8',
    );
    const usage = await readUsage();
    expect(usage.get('bug-fix')?.count).toBe(1);
    expect(usage.has('lean-code')).toBe(false);
  });

  it('skips malformed lines anywhere in the file', async () => {
    await seed([
      entry('bug-fix', '2026-01-01T00:00:00.000Z'),
      'not json at all',
      '[1,2,3]',
      '{"id":"","at":"2026-01-01T00:00:00.000Z"}',   // no id
      '{"id":"x"}',                                   // no timestamp
      '{"id":"y","at":"whenever"}',                   // unusable timestamp
      '"a bare string"',
      'null',
      entry('lean-code', '2026-01-02T00:00:00.000Z'),
    ]);
    const usage = await readUsage();
    expect([...usage.keys()].sort()).toEqual(['bug-fix', 'lean-code']);
  });
});

describe('a skill id is hostile string input', () => {
  it('cannot pollute the aggregate through __proto__, constructor or toString', async () => {
    await seed([
      entry('__proto__', '2026-01-01T00:00:00.000Z', { n: 7 }),
      entry('constructor', '2026-01-01T00:00:00.000Z'),
      entry('toString', '2026-01-01T00:00:00.000Z'),
      '{"v":1,"id":"ok","at":"2026-01-01T00:00:00.000Z","__proto__":{"polluted":"yes"}}',
    ]);
    const usage = await readUsage();

    expect(usage.get('__proto__')).toEqual({ count: 7, lastUsedAt: '2026-01-01T00:00:00.000Z' });
    expect(usage.get('constructor')?.count).toBe(1);
    expect(usage.get('toString')?.count).toBe(1);
    // Nothing leaked onto Object.prototype, and the aggregate has no inherited
    // members masquerading as skills.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(usage.has('valueOf')).toBe(false);
  });

  it('never joins the id into a filesystem path', async () => {
    await recordUsage('../../../../etc/passwd', 'install');
    await recordUsage('a/b/c', 'load');

    // One file, whatever the ids were.
    expect(await readdir(join(home(), '.baton'))).toEqual(['skill-usage.jsonl']);
    expect((await readUsage()).has('../../../../etc/passwd')).toBe(true);
  });

  it('cannot forge extra entries with a newline in the id', async () => {
    await recordUsage('evil\n{"v":1,"id":"forged","at":"2026-01-01T00:00:00.000Z"}', 'load');
    expect(await linesOf()).toHaveLength(1);
    expect((await readUsage()).has('forged')).toBe(false);
  });

  it('refuses an entry over the documented cap rather than writing an unbounded line', async () => {
    await recordUsage('x'.repeat(MAX_ENTRY_BYTES * 2), 'load');
    await expect(readUsage()).resolves.toEqual(new Map());

    // and still records a normal one afterwards
    await recordUsage('bug-fix', 'load');
    expect((await readUsage()).get('bug-fix')?.count).toBe(1);
  });
});

describe('recording is best-effort, never a gate', () => {
  it('returns instead of throwing when ~/.baton cannot be written', async () => {
    // A regular file where the directory should be: every write below fails.
    await writeFile(join(home(), '.baton'), 'not a directory', 'utf-8');
    await expect(recordUsage('bug-fix', 'install')).resolves.toBeUndefined();
    await expect(readUsage()).resolves.toEqual(new Map());
  });

  it('ignores an empty or non-string id without writing a line', async () => {
    await recordUsage('', 'load');
    await recordUsage('   ', 'load');
    await recordUsage(undefined as unknown as string, 'load');
    await expect(readUsage()).resolves.toEqual(new Map());
  });
});

describe('compaction', () => {
  /** One write, not a loop — seeding through the writer is what timed a suite out. */
  const seedMany = async (n: number, id = (i: number) => `skill-${i % 5}`) =>
    seed(Array.from({ length: n }, (_, i) =>
      entry(id(i), new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1000).toISOString())));

  it('leaves a ledger under the line cap alone', async () => {
    await seedMany(50);
    await recordUsage('bug-fix', 'load');
    expect(await linesOf()).toHaveLength(51);
  });

  it('rolls the file up once it passes the documented line cap, losing no use', async () => {
    const seeded = MAX_LEDGER_LINES + 1;
    await seedMany(seeded);
    const before = await readUsage();
    const beforeTotal = [...before.values()].reduce((n, u) => n + u.count, 0);
    expect(beforeTotal).toBe(seeded);

    await recordUsage('bug-fix', 'load');

    const lines = await linesOf();
    expect(lines.length).toBeLessThan(seeded);
    const after = await readUsage();
    expect([...after.values()].reduce((n, u) => n + u.count, 0)).toBe(seeded + 1);
    for (const [id, u] of before) {
      expect(after.get(id)?.count, id).toBe(u.count);
      expect(after.get(id)?.lastUsedAt, id).toBe(u.lastUsedAt);
    }
  });

  it('does not take over another process\'s in-flight compaction temp file', async () => {
    await seedMany(MAX_LEDGER_LINES + 1);
    // A second agent process is mid-compaction: its rolled-up ledger is written
    // and not yet renamed. A fixed `.tmp` name means we overwrite that file and
    // then rename it away, so its rename hits ENOENT and the WHOLE ledger it was
    // installing is lost — not one append.
    const foreign = `${usagePath()}.tmp`;
    const foreignBody = entry('other-agent', '2026-01-01T00:00:00.000Z') + '\n';
    await writeFile(foreign, foreignBody, 'utf-8');

    await recordUsage('bug-fix', 'load');

    expect(existsSync(foreign), 'the other process\'s temp file was renamed away').toBe(true);
    expect(await readFile(foreign, 'utf-8'), 'the other process\'s temp file was overwritten')
      .toBe(foreignBody);
  });

  it('is crash-safe: writes through a temp file and leaves none behind', async () => {
    await seedMany(MAX_LEDGER_LINES + 1);
    await recordUsage('bug-fix', 'load');
    expect(await readdir(join(home(), '.baton'))).toEqual(['skill-usage.jsonl']);
    // and the file it left is complete, not half-written
    await expect(stat(usagePath())).resolves.toBeTruthy();
    for (const line of await linesOf()) expect(() => JSON.parse(line)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Wired into the skill paths that actually use a skill                */
/* ------------------------------------------------------------------ */

describe('what the catalog records', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'baton-usage-repo-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it('records one entry for an install', async () => {
    await installSkill(repo, 'bug-fix', 'claude');
    const usage = await readUsage();
    expect(usage.get('bug-fix')?.count).toBe(1);
    expect(await linesOf()).toHaveLength(1);
  });

  it('records one entry for an uninstall', async () => {
    await installSkill(repo, 'bug-fix', 'claude');
    await uninstallSkill(repo, 'bug-fix', 'claude');
    expect((await readUsage()).get('bug-fix')?.count).toBe(2);
  });

  it('records one entry when a skill body is loaded', async () => {
    await loadSkillRecordingUse(repo, 'bug-fix');
    expect((await readUsage()).get('bug-fix')?.count).toBe(1);
  });

  it('records nothing for a skill that does not exist', async () => {
    expect(await loadSkillRecordingUse(repo, 'no-such-skill')).toBeNull();
    await expect(readUsage()).resolves.toEqual(new Map());
  });

  it('records NOTHING for a listing — reading the catalog stays a pure read', async () => {
    const skills = await listSkillStatus(repo);
    expect(skills.length).toBeGreaterThan(5);
    await expect(readUsage()).resolves.toEqual(new Map());
  });

  it('still installs when the ledger cannot be written', async () => {
    // A regular file where ~/.baton should be: every ledger write fails.
    await writeFile(join(home(), '.baton'), 'not a directory', 'utf-8');
    const r = await installSkill(repo, 'bug-fix', 'claude');
    expect(r.wrote).toBe(true);
    expect(existsSync(r.path)).toBe(true);
  });
});

describe('listing a bundled skill does not read its reference files', () => {
  it('exposes reference paths eagerly and their contents only on demand', async () => {
    const skill = (await bundledSkills()).find((s) => s.references.length > 0);
    expect(skill, 'expected a bundled skill with references').toBeTruthy();
    for (const ref of skill!.references) {
      // The mechanism: `content` is a getter, so building a listing costs the
      // directory entry and none of the bytes.
      const d = Object.getOwnPropertyDescriptor(ref, 'content');
      expect(typeof d?.get, `${ref.rel} content is read eagerly`).toBe('function');
      // ...and it still hands back exactly what is on disk.
      const onDisk = await readFile(join(BUNDLED_DIR, skill!.id, ref.rel), 'utf-8');
      expect(ref.content).toBe(onDisk);
    }
  });
});

const ledgerLines = async (dir: string): Promise<number> => {
  try {
    const t = await readFile(join(dir, '.baton', 'skill-usage.jsonl'), 'utf-8');
    return t.split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
};

describe('a read path never records a use it did not make', () => {
  /**
   * `a list must never become a write` is the plan's principle, and the ledger
   * broke it twice on the same route. `exportSkillFile` recorded BEFORE its
   * refusal checks, so a 403 for a bundled skill counted as a use; and its HTTP
   * caller records before deciding whether to send a body, so every 304
   * conditional poll counted too. A dashboard polling every 30 seconds would
   * have written a "use" per poll, per skill, forever.
   */
  it('records nothing when the export is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-usage-read-repo-'));
    // `bug-fix` is bundled, so exporting it is refused.
    await expect(exportSkillFile(root, 'bug-fix')).rejects.toThrow();
    expect(await ledgerLines(home())).toBe(0);
  });

  it('records nothing when the skill does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-usage-read-repo-'));
    await expect(exportSkillFile(root, 'no-such-skill')).rejects.toThrow();
    expect(await ledgerLines(home())).toBe(0);
  });
});
