// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One file, one signal row — whatever the caller spelled it.
 *
 * `edit_signals` is keyed `PRIMARY KEY (slug, path)` and `checkFiles` looks a
 * path up by exact string, so two spellings of one file were two rows and two
 * answers: a session that recorded `./src/a.ts` was invisible to a session
 * asking about `src/a.ts`. That is a miss in the one question Baton exists to
 * answer — "is anyone else on this file" — and a miss reads exactly like "no".
 *
 * The fold happens at the CHOKEPOINT (`canonicalSignalPath`, applied inside
 * `recordHookEdit`, `SignalTracker.record` and `checkFiles`), not at the two
 * MCP call sites, because `checkFiles` has five callers — MCP `check_files`,
 * MCP `who_touched`, `GET /api/signals/check`, `baton blame`, and the edit
 * guard — and normalising at two of them leaves the feature broken for three.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { canonicalSignalPath, checkFiles, foldSignalsByPath, recordHookEdit, SIGNAL_PATH_MAX } from '../src/signals.js';
import { guardTarget } from '../src/commands/guard.js';

const key = (p: string): string | null => canonicalSignalPath(p).key;

describe('canonicalSignalPath — fold what is safe to fold', () => {
  it('folds `.` and empty segments away: one file, one key', () => {
    expect(key('./src/a.ts')).toBe('src/a.ts');
    expect(key('src/./a.ts')).toBe('src/a.ts');
    expect(key('src//a.ts')).toBe('src/a.ts');
    expect(key('./src/././/a.ts')).toBe('src/a.ts');
    expect(key('src/a.ts/')).toBe('src/a.ts');
  });

  /**
   * A behaviour change, deliberately: a Windows agent and a POSIX agent editing
   * the same file must not hold two different rows. These strings are compared
   * BETWEEN machines, so the separator cannot be the local platform's business.
   */
  it('treats `\\` as a separator, so a Windows agent shares the POSIX agent\'s row', () => {
    expect(key('src\\a.ts')).toBe('src/a.ts');
    expect(key('src\\.\\a.ts')).toBe('src/a.ts');
    expect(key('.\\src\\deep\\a.ts')).toBe('src/deep/a.ts');
  });

  it('leaves an already-canonical path exactly as it is', () => {
    expect(key('src/mcp.ts')).toBe('src/mcp.ts');
    expect(key('  src/mcp.ts  ')).toBe('src/mcp.ts');
    expect(key('src/файл.ts')).toBe('src/файл.ts');
    expect(key('docs/🧨.md')).toBe('docs/🧨.md');
    expect(key('my file.ts')).toBe('my file.ts');
  });

  /**
   * `..` is the one thing folding cannot do: `a/link/../b` is `a/b` only if
   * `link` is not a symlink, and this module has no filesystem to ask.
   */
  it('rejects `..` as a SEGMENT, and only as a segment', () => {
    expect(key('../up.ts')).toBeNull();
    expect(key('src/../../up.ts')).toBeNull();
    expect(key('src\\..\\..\\up.ts')).toBeNull();
    expect(key('./../up.ts')).toBeNull();
    expect(key('..')).toBeNull();
    // Real filenames. Rejecting these hides the agent editing them.
    expect(key('test/fixtures/v1..v2.diff')).toBe('test/fixtures/v1..v2.diff');
    expect(key('src/a..b/c.ts')).toBe('src/a..b/c.ts');
    expect(key('..rc.json')).toBe('..rc.json');
  });

  it('rejects a path that names no file once folded', () => {
    for (const p of ['.', './', '/', '//', './/.', '', '   ']) expect(key(p), p).toBeNull();
  });

  it('rejects an absolute path in every spelling, on any platform', () => {
    for (const p of ['/etc/passwd', 'C:\\Windows\\system32', 'c:/Windows/system32', '\\\\server\\share\\x', '\\Windows\\x']) {
      expect(key(p), p).toBeNull();
    }
    // A colon is a legal POSIX filename character; only a DRIVE is absolute.
    expect(key('a:b/c.ts')).toBe('a:b/c.ts');
  });

  /**
   * The old class was `[\u0000-\u001f\u007f]` — C0 and DEL. It missed the C1
   * range entirely, and more importantly it missed the characters that are the
   * actual attack: `src/a\u200b.ts` renders in the who's-editing panel as
   * `src/a.ts`, collides with nothing, and lets a session hold a file it does
   * not appear to hold. A path is read by a human and compared by a machine
   * exactly like the prose in handoff/untrusted.ts, so it gets that standard.
   */
  it('rejects control characters, C1 included', () => {
    expect(key('a\u0000b')).toBeNull();          // NUL — measured, went in and came back out
    expect(key('src/\u0007bell.ts')).toBeNull(); // C0
    expect(key('two\nlines.ts')).toBeNull();     // a second row in a one-line panel
    expect(key('tab\tx.ts')).toBeNull();
    expect(key('del\u007fx.ts')).toBeNull();
    expect(key('src/a\u0085.ts')).toBeNull();    // C1 NEL — the old class let this through
    expect(key('src/a\u009b.ts')).toBeNull();    // C1 CSI
  });

  it('rejects characters that render as nothing — a spoofable path is worse than a rejected one', () => {
    expect(key('src/a\u200b.ts')).toBeNull();    // zero-width space
    expect(key('src/a\ufeff.ts')).toBeNull();    // BOM
    expect(key('src/a\u202e.ts')).toBeNull();    // RTL override
    expect(key('src/a\u00ad.ts')).toBeNull();    // soft hyphen
    expect(key('src/a\u2028.ts')).toBeNull();    // line separator (Zl — not Cc, not Cf)
    expect(key('src/a\u3164.ts')).toBeNull();    // hangul filler
    expect(key('src/a\ue000.ts')).toBeNull();    // private use
    expect(key('src/a\ud800.ts')).toBeNull();    // lone surrogate
    // …while a real astral character is a real filename.
    expect(key('src/\u{1f9e8}.ts')).toBe('src/\u{1f9e8}.ts');
  });

  it('rejects a path longer than any filesystem would accept', () => {
    expect(key(`src/${'x'.repeat(SIGNAL_PATH_MAX)}.ts`)).toBeNull();
    expect(key(`src/${'x'.repeat(SIGNAL_PATH_MAX - 8)}.ts`)).not.toBeNull();
  });

  /**
   * `checkFiles` builds its answer on a null-prototype object because
   * `result['__proto__'] = …` on a plain `{}` is a setter call, not an
   * assignment (test/signals-proto-path.test.ts). Folding must not quietly
   * make that guard unnecessary-looking by mangling the name: it doesn't.
   */
  it('leaves Object-key names intact, so the null-prototype guard still matters', () => {
    expect(key('__proto__')).toBe('__proto__');
    expect(key('./__proto__')).toBe('__proto__');
    expect(key('a/__proto__/constructor')).toBe('a/__proto__/constructor');
  });

  it('names the rule it refused on, and only when it refused', () => {
    expect(canonicalSignalPath('../up.ts').reason).toMatch(/\.\./);
    expect(canonicalSignalPath('/etc/passwd').reason).toMatch(/absolute/);
    expect(canonicalSignalPath('src/a\u200b.ts').reason).toMatch(/invisible/);
    expect(canonicalSignalPath('src/a.ts').reason).toBeNull();
  });
});

describe('two spellings of one path are one signal', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-sigpath-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const dirty = () => writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
  const session = { agent: 'claude', sessionRoot: '' };

  /**
   * The bug, end to end, in the shape that costs a user work: agent A declares
   * the file it is editing with a leading `./`, agent B asks for the same file
   * without one, and B is told the file is free.
   */
  it('a session editing ./src/a.ts is busy to a session asking about src/a.ts', async () => {
    await dirty();
    recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: './src/a.ts', session: { ...session, sessionRoot: root } });

    const check = await checkFiles(root, ['src/a.ts'], 'sess-bbbbbbbb');
    expect(check['src/a.ts'].busy).toBe(true);
    expect(check['src/a.ts'].by.map((h) => h.slug)).toEqual(['sess-aaaaaaaa']);
  });

  it('and the other way round, and through a backslash, and through a doubled slash', async () => {
    await dirty();
    recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: 'src/a.ts', session: { ...session, sessionRoot: root } });

    for (const spelling of ['./src/a.ts', 'src\\a.ts', 'src//a.ts', 'src/./a.ts']) {
      const check = await checkFiles(root, [spelling], 'sess-bbbbbbbb');
      expect(check[spelling]?.busy, spelling).toBe(true);
    }
  });

  /**
   * The write-side half of the fix, which the lookup alone would not give.
   * `reconcileSignals` asks git which paths are dirty and settles the rest —
   * and git's answer is always `src/a.ts`. An unfolded `./src/a.ts` row was
   * never in that set, so 15 seconds after it was written the holder's own
   * signal was settled away as "no longer being edited".
   */
  it('survives reconciliation, because the row now spells the path the way git does', async () => {
    await dirty();
    const old = new Date(Date.now() - 60_000).toISOString(); // past RECONCILE_GRACE_MS
    recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: './src/a.ts', at: old, session: { ...session, sessionRoot: root } });

    const check = await checkFiles(root, ['src/a.ts'], 'sess-bbbbbbbb');
    expect(check['src/a.ts'].busy).toBe(true);
  });

  it('reports the key it recorded, so a caller that can say so is able to', () => {
    expect(recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: './src/a.ts' })).toBe('src/a.ts');
    expect(recordHookEdit(root, { slug: 'sess-aaaaaaaa', path: '../escape.ts' })).toBeNull();
  });
});

describe('a path with no key is answered, never omitted', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-sigpath-null-'));
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /**
   * `repoRelative` returns null for these, and dropping them from the answer
   * would be the same defect as the `__proto__` disappearance: an absent row
   * reads exactly like a clear one, and "clear" is the conclusion this tool
   * exists to stop an agent reaching without evidence.
   */
  it('says WHY, in the row the caller asked for, instead of leaving it out', async () => {
    const asked = ['../up.ts', '/etc/passwd', '.', 'src/a\u200b.ts', 'src/real.ts'];
    const res = await checkFiles(root, asked);

    expect(Object.keys(res).sort()).toEqual([...asked].sort());
    for (const p of asked.slice(0, 4)) {
      expect(res[p].unchecked, p).toBeTruthy();
      expect(res[p].unchecked, p).toMatch(/NOT "nobody is editing it"/);
      expect(res[p].by, p).toEqual([]);
    }
    // A refusal is per-path: the legitimate path in the same call is answered.
    expect(res['src/real.ts']).toEqual({ busy: false, by: [] });
  });

  it('survives JSON — the field an agent reads is really on the wire', async () => {
    const wire = JSON.parse(JSON.stringify(await checkFiles(root, ['../up.ts']))) as Record<string, { unchecked?: string }>;
    expect(wire['../up.ts'].unchecked).toBeTruthy();
  });
});

describe('the answer is keyed by the caller\'s own spelling', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-sigpath-keys-'));
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /**
   * Every caller indexes the map with the string it passed in — `live[file]`
   * in who_touched and `baton blame`, `checked[p]` in GET /api/signals/check,
   * `files[p]` in check_files, `check[rel]` in the guard. Canonicalising the
   * KEYS would hand all five `undefined`, which is worse than the original bug:
   * who_touched would answer `live: undefined` for a file it just looked up.
   */
  it('answers under the exact strings it was given, folded or not', async () => {
    const asked = ['./src/a.ts', 'src\\b.ts', '  src/c.ts  ', 'src/d.ts'];
    const res = await checkFiles(root, asked);
    for (const p of asked) expect(res[p], p).toEqual({ busy: false, by: [] });
  });

  it('round-trips the guard: the target it derives is a key its own lookup resolves', async () => {
    const wt = '/repo/.baton/wt/fix-auth';
    const rel = guardTarget({ tool_name: 'Edit', tool_input: { file_path: `${wt}/src/auth.ts` } }, wt);
    expect(rel).toBe('src/auth.ts');
    expect((await checkFiles(root, [rel!]))[rel!]).toBeDefined();
    // Still not our business when the edit is outside the worktree.
    expect(guardTarget({ tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } }, wt)).toBeNull();
  });
});

/**
 * A rejected path registers NOTHING, and registering nothing is the failure
 * this whole module exists to prevent — "nobody is on this file" is exactly
 * what a miss looks like.
 *
 * `HIDDEN_CHARS` rejects `\p{Cf}` wholesale, and U+200D ZERO WIDTH JOINER is
 * `Cf`. It is also how every multi-part emoji is built, so a legal, ordinary
 * filename like `docs/<man technologist>.md` — routine in an asset or design
 * repo — stopped having a key at all. That silences far more than one row:
 * `SignalTracker.record` returns early, `recordHookEdit` writes nothing, and
 * `guardTarget` returns null, which drops the signal write, the collision
 * advisory, the HANDOFF snapshot and the guardrail reminder for that edit.
 *
 * The carve-out is deliberately narrow: a ZWJ is allowed ONLY between two
 * pictographs (optionally through a skin-tone modifier or VS16), which is the
 * one place it carries meaning. A ZWJ used as an invisibility trick — between
 * two letters, or merely NEAR an emoji — is still refused, as is every other
 * `Cf`, so the impersonation hole the class was closing stays closed.
 */
describe('a legal emoji filename still has a signal key', () => {
  const ZWJ = String.fromCodePoint(0x200d);
  const VS16 = String.fromCodePoint(0xfe0f);
  const MAN = String.fromCodePoint(0x1f468), LAPTOP = String.fromCodePoint(0x1f4bb);
  const WOMAN = String.fromCodePoint(0x1f469), GIRL = String.fromCodePoint(0x1f467);
  const TONE = String.fromCodePoint(0x1f3fb), FLAG = String.fromCodePoint(0x1f3f3);
  const RAINBOW = String.fromCodePoint(0x1f308);

  it.each([
    ['man technologist', `docs/${MAN}${ZWJ}${LAPTOP}.md`],
    ['skin-tone modifier before the joiner', `docs/${MAN}${TONE}${ZWJ}${LAPTOP}.md`],
    ['family, two joiners', `docs/${MAN}${ZWJ}${WOMAN}${ZWJ}${GIRL}.png`],
    ['variation selector before the joiner', `docs/${FLAG}${VS16}${ZWJ}${RAINBOW}.md`],
  ])('keys a %s filename', (_label, path) => {
    expect(canonicalSignalPath(path)).toEqual({ key: path, reason: null });
  });

  it.each([
    ['between two letters', `src/a${ZWJ}b.ts`],
    ['after a letter, with a pictograph further along', `src/a${ZWJ}b${LAPTOP}.ts`],
    ['after a pictograph but joining a letter', `src/a${LAPTOP}${ZWJ}b.ts`],
    ['a zero-width NON-joiner', `src/a${String.fromCodePoint(0x200c)}b.ts`],
    ['a bidi override', `src/a${String.fromCodePoint(0x202e)}b.ts`],
  ])('still refuses a joiner used %s', (_label, path) => {
    expect(canonicalSignalPath(path).key).toBeNull();
  });
});

/**
 * Two spellings of one file fold onto one key — and the holder that survives
 * has to be the FRESHEST, not merely the first one iterated.
 *
 * The fold's own comment justified keeping the first with "`liveRows` is
 * `ORDER BY at DESC`, so the first holder seen for a key is that slug's
 * freshest". That is true WITHIN a row, but the fold runs across rows, and
 * `getSignals` hands them back sorted by level then path — not by recency. So
 * whichever spelling happened to sort first won, and an agent could be told a
 * file was last touched minutes before it actually was.
 *
 * Only a legacy row reaches this: writes have been folded since
 * `recordHookEdit` started keying on `canonicalSignalPath`. But an older build
 * running against the same `history.db` keeps writing its old spelling until
 * those rows age out, which is the whole reason the read side folds at all.
 */
describe('folding two spellings keeps the freshest holder', () => {
  const holder = (slug: string, lastEditAt: string) =>
    ({ slug, agent: 'claude', lastEditAt, state: 'active' as const });

  it('prefers the newer lastEditAt when one slug holds both spellings', () => {
    const folded = foldSignalsByPath([
      // Sorted by path, which is what getSignals returns — NOT by recency, so
      // the stale spelling is seen first.
      { path: './src/a.ts', level: 'info', holders: [holder('auth-api', '2026-01-01T00:00:00.000Z')] },
      { path: 'src/a.ts', level: 'info', holders: [holder('auth-api', '2026-01-01T09:30:00.000Z')] },
    ]);

    const holders = folded.get('src/a.ts') ?? [];
    expect(holders, 'one slug on one file is one holder').toHaveLength(1);
    expect(holders[0].lastEditAt, 'the fresher edit must win').toBe('2026-01-01T09:30:00.000Z');
  });

  it('keeps two different slugs on the same folded path', () => {
    const folded = foldSignalsByPath([
      { path: './src/a.ts', level: 'info', holders: [holder('auth-api', '2026-01-01T00:00:00.000Z')] },
      { path: 'src/a.ts', level: 'info', holders: [holder('billing', '2026-01-01T09:30:00.000Z')] },
    ]);
    expect((folded.get('src/a.ts') ?? []).map((h) => h.slug).sort()).toEqual(['auth-api', 'billing']);
  });

  it('keeps an unkeyable path under its own raw spelling', () => {
    const folded = foldSignalsByPath([
      { path: '../outside.ts', level: 'info', holders: [holder('auth-api', '2026-01-01T00:00:00.000Z')] },
    ]);
    expect([...folded.keys()]).toEqual(['../outside.ts']);
  });
});

/**
 * The separator fold is a deliberate trade, and this records its cost so a
 * future reader meets it as a decision rather than a surprise: `\` and a
 * surrounding space are legal in POSIX filenames, and folding them means a
 * file honestly named that way is keyed as its neighbour.
 *
 * Kept because the case it serves — a Windows peer publishing `src\a.ts` to a
 * POSIX asker — is routine, and these two are not.
 */
describe('the separator fold has a known, accepted cost', () => {
  it('keys a POSIX file with a literal backslash as its neighbour', () => {
    expect(canonicalSignalPath('src/a\\b.ts').key).toBe('src/a/b.ts');
  });

  it('trims a name whose leading or trailing space is real', () => {
    expect(canonicalSignalPath('src/a.ts ').key).toBe('src/a.ts');
  });
});
