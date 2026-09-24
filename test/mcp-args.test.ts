// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The MCP tool INPUT boundary.
 *
 * Every argument that reaches these tools was written by a language model, so
 * "the caller would not do that" is not an argument available here: a
 * hallucinated absolute path, a 50,000-character slug and a fractional `limit`
 * are all one bad token away. The tools below each own a boundary that a zod
 * type does not cover — `z.number()` admits 2.7, `z.array(z.string())` admits
 * two thousand of them — and this file is where those boundaries are pinned.
 *
 * The measured facts these tests were written against (2026-09-07, built
 * `dist/`, real stdio handshake):
 *
 *   - `search_history({ query: 'a', limit: 2.7 })` answered
 *     `isError: true, "datatype mismatch"` — a raw SQLite driver string, from
 *     `LIMIT ?` bound to a non-integer.
 *   - `touch_files({ paths: ['a\0b', 'C:\\win\\x'] })` recorded BOTH as live
 *     signals, which every other agent then reads back out of `list_signals`.
 *   - `check_files` with 2,000 paths answered 79,002 bytes — eight times the
 *     entire 9,750-byte `tools/list` handshake this repo budgets to the byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/util/exec.js';
import { searchHistory } from '../src/history.js';
import { PATHS_CAP, capPaths, historyLimit, repoRelative } from '../src/mcp.js';
import { usePrivateHome } from './helpers/private-home.js';

// src/mcp.ts reaches the skill catalogue, which reads the machine-wide library
// under ~/.baton. Importing it must not touch a developer's real one.
usePrivateHome();

describe('historyLimit — search_history must not hand SQLite a fraction', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-mcpargs-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /**
   * The bug, at the seam where it actually bites. `history.ts` clamps with
   * `Math.max(1, Math.min(limit, 25))`, which keeps 2.7 as 2.7 and binds it to
   * `LIMIT ?`; the driver refuses a non-integer and the tool answers with the
   * driver's own words. An agent reading "datatype mismatch" learns nothing
   * about what it did wrong, and search is simply unavailable to it.
   */
  it('proves the raw failure: an unrounded limit reaches SQLite and throws', () => {
    expect(() => searchHistory(root, 'init', 2.7)).toThrow(/datatype mismatch/i);
  });

  it('rounds a fractional limit to an integer the driver accepts', () => {
    expect(Number.isInteger(historyLimit(2.7))).toBe(true);
    expect(() => searchHistory(root, 'init', historyLimit(2.7))).not.toThrow();
  });

  it('honours the documented default and ceiling ("default 10, max 25")', () => {
    expect(historyLimit(undefined)).toBe(10);
    expect(historyLimit(5)).toBe(5);
    expect(historyLimit(1_000_000)).toBe(25);
  });

  it('turns a nonsense count into the smallest sane one, never a negative LIMIT', () => {
    expect(historyLimit(0)).toBe(1);
    expect(historyLimit(-5)).toBe(1);
    expect(historyLimit(Number.NaN)).toBe(10);
    expect(historyLimit(Number.POSITIVE_INFINITY)).toBe(25);
    expect(historyLimit(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe('repoRelative — what touch_files may write into shared state', () => {
  it('keeps an ordinary repo-relative path unchanged', () => {
    expect(repoRelative('src/mcp.ts')).toBe('src/mcp.ts');
    expect(repoRelative('  src/mcp.ts  ')).toBe('src/mcp.ts');
  });

  it('keeps a unicode path — a filename is not ASCII-only', () => {
    expect(repoRelative('src/файл.ts')).toBe('src/файл.ts');
    expect(repoRelative('docs/🧨.md')).toBe('docs/🧨.md');
  });

  it('refuses a NUL byte, which is never part of a real path', () => {
    // Reproduced end to end: this string was accepted and then served back to
    // every other agent by list_signals.
    expect(repoRelative('a\u0000b')).toBeNull();
    expect(repoRelative('src/\u0007bell.ts')).toBeNull();
    expect(repoRelative('two\nlines.ts')).toBeNull();
  });

  /**
   * The C1 range and the invisibles the old `[\u0000-\u001f\u007f]` never saw.
   * `src/a\u200b.ts` is the interesting one: it is not a control character, it
   * renders in the who's-editing panel as `src/a.ts`, and it collides with
   * nothing — so it is a way to hold a file while appearing not to, or to
   * appear to hold one nobody holds. A path is read by a human and compared by
   * a machine exactly like the prose in src/handoff/untrusted.ts, so it gets
   * that module's standard rather than a weaker one.
   */
  it('refuses the C1 range and characters that render as nothing', () => {
    expect(repoRelative('src/a\u0085.ts')).toBeNull();  // C1 NEL
    expect(repoRelative('src/a\u009b.ts')).toBeNull();  // C1 CSI
    expect(repoRelative('src/a\u200b.ts')).toBeNull();  // zero-width space
    expect(repoRelative('src/a\ufeff.ts')).toBeNull();  // BOM
    expect(repoRelative('src/a\u2028.ts')).toBeNull();  // line separator (Zl)
  });

  /**
   * The key `touch_files` writes and the key `check_files` looks up are now one
   * function, so two spellings of a file can no longer be two rows that cannot
   * see each other. Folded rather than refused: a refused path registers
   * nothing, and registering nothing reads to the next agent exactly like
   * "nobody is on this file".
   */
  it('folds `.`, empty segments and `\\` onto one spelling instead of refusing them', () => {
    expect(repoRelative('./src/mcp.ts')).toBe('src/mcp.ts');
    expect(repoRelative('src/./mcp.ts')).toBe('src/mcp.ts');
    expect(repoRelative('src//mcp.ts')).toBe('src/mcp.ts');
    expect(repoRelative('src\\mcp.ts')).toBe('src/mcp.ts');   // a Windows agent shares the row
    expect(repoRelative('src/mcp.ts/')).toBe('src/mcp.ts');
  });

  it('refuses a path that names no file once folded', () => {
    expect(repoRelative('.')).toBeNull();
    expect(repoRelative('./')).toBeNull();
    expect(repoRelative('//')).toBeNull();
  });

  it('refuses an absolute path in every spelling, not just the POSIX one', () => {
    expect(repoRelative('/etc/passwd')).toBeNull();
    expect(repoRelative('C:\\Windows\\system32')).toBeNull();
    expect(repoRelative('c:/Windows/system32')).toBeNull();
    expect(repoRelative('\\\\server\\share\\x')).toBeNull();
  });

  it('refuses traversal on either separator', () => {
    expect(repoRelative('../up.ts')).toBeNull();
    expect(repoRelative('src/../../up.ts')).toBeNull();
    expect(repoRelative('src\\..\\..\\up.ts')).toBeNull();
    expect(repoRelative('..')).toBeNull();
  });

  /**
   * The old guard was `!p.includes('..')`, which is a substring test. These are
   * real filenames — a version-diff fixture, a Word lock file — and rejecting
   * them means the agent editing them is invisible to everyone else.
   */
  it('does NOT refuse a legitimate name that merely contains two dots', () => {
    expect(repoRelative('test/fixtures/v1..v2.diff')).toBe('test/fixtures/v1..v2.diff');
    expect(repoRelative('src/a..b/c.ts')).toBe('src/a..b/c.ts');
  });

  it('refuses the empty and whitespace-only path', () => {
    expect(repoRelative('')).toBeNull();
    expect(repoRelative('   ')).toBeNull();
  });

  it('refuses a path longer than any filesystem would accept', () => {
    expect(repoRelative(`src/${'x'.repeat(4_096)}.ts`)).toBeNull();
  });
});

describe('capPaths — one call may not be unbounded', () => {
  it('passes an ordinary list through whole, with nothing skipped', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    expect(capPaths(paths)).toEqual({ within: paths, skipped: [] });
  });

  it('caps a list of thousands and says exactly what it did not do', () => {
    const paths = Array.from({ length: 2_000 }, (_, i) => `f${i}.ts`);
    const { within, skipped } = capPaths(paths);
    expect(within).toHaveLength(PATHS_CAP);
    expect(skipped).toHaveLength(2_000 - PATHS_CAP);
    // Nothing is invented and nothing is lost — the two halves are the input.
    expect([...within, ...skipped]).toEqual(paths);
  });

  it('has a cap small enough to keep one answer under the handshake budget', () => {
    // The whole tools/list handshake is 9,750 bytes and budgeted to the byte;
    // a single check_files answer that dwarfs it is the same defect one layer on.
    expect(PATHS_CAP).toBeLessThanOrEqual(500);
    expect(PATHS_CAP).toBeGreaterThan(0);
  });

  it('handles the empty list without inventing a cap violation', () => {
    expect(capPaths([])).toEqual({ within: [], skipped: [] });
  });
});

/**
 * The helpers above, through the tools that are supposed to use them.
 *
 * A guard that exists and is wired to nothing is this repo's known failure
 * shape (see test/mcp-answer-notices.test.ts, written after a complete, tested
 * notice shipped attached to no tool), so the three fixes are re-checked here
 * on the real wire: one stdio session against the BUILT server, no mocks.
 */
describe('the fixed boundaries, on the real wire', () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  let root: string;
  let home: string;
  let child: ReturnType<typeof spawn>;
  let nextId = 0;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();

  const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const id = ++nextId;
      const timer = setTimeout(() => rej(new Error(`${method} timed out — nothing was measured`)), 15_000);
      pending.set(id, (m) => { clearTimeout(timer); res(m); });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  /** Call a tool and return its text payload. */
  const tool = async (name: string, args: unknown): Promise<string> => {
    const r = await rpc('tools/call', { name, arguments: args });
    const content = (r.result as { content?: { text?: string }[] } | undefined)?.content;
    if (!content?.[0]?.text) throw new Error(`no content from ${name}: ${JSON.stringify(r).slice(0, 300)}`);
    return content[0].text;
  };

  beforeEach(async () => {
    if (!existsSync(CLI)) throw new Error(`no built server at ${CLI} — run \`npm run build\` first (measuring nothing is not a pass)`);
    home = await mkdtemp(join(tmpdir(), 'baton-mcpargs-home-'));
    root = await mkdtemp(join(tmpdir(), 'baton-mcpargs-wire-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'initial'], root);
    await mkdir(join(root, '.baton'), { recursive: true });

    child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, BATON_ROOT: root },
    });
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const id = msg.id;
        if (typeof id === 'number' && pending.has(id)) { pending.get(id)!(msg); pending.delete(id); }
      }
    });
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-args', version: '0' } });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }, 30_000);

  afterEach(async () => {
    child?.kill();
    pending.clear();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('answers a fractional limit with results, not with SQLite\'s own words', async () => {
    // Before: {"content":[{"text":"datatype mismatch"}],"isError":true}
    const text = await tool('search_history', { query: 'initial', limit: 2.7 });
    expect(text).not.toMatch(/datatype mismatch/i);
    expect(JSON.parse(text)).toHaveProperty('hits');
  }, 30_000);

  it('refuses to record a NUL byte or a Windows-absolute path as a live signal', async () => {
    const declared = JSON.parse(await tool('touch_files', {
      paths: ['/etc/passwd', '../up.ts', 'a\u0000b', 'C:\\win\\x', '\\\\srv\\share', 'test/fixtures/v1..v2.diff', 'ok.ts'],
    })) as { touched: string[]; ignored?: string[] };

    expect(declared.touched).toEqual(['test/fixtures/v1..v2.diff', 'ok.ts']);
    expect(declared.ignored).toBeDefined();      // named, never dropped in silence

    // And nothing hostile reached the state other agents read back.
    const signals = await tool('list_signals', {});
    expect(signals).not.toContain('\\u0000');
    expect(signals).not.toContain('etc/passwd');
    expect(signals).toContain('v1..v2.diff');     // the legitimate name still lands
  }, 30_000);

  it('keeps one check_files answer under the whole tools/list handshake', async () => {
    const text = await tool('check_files', { paths: Array.from({ length: 2_000 }, (_, i) => `f${i}.ts`) });
    // Measured at 79,002 bytes before the cap; the handshake itself is 9,750.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(9_750);
    const answer = JSON.parse(text) as { files: Record<string, unknown>; notChecked?: { count: number } };
    expect(Object.keys(answer.files)).toHaveLength(PATHS_CAP);
    // The half it did not look at is stated, so "not busy" is never inferred
    // from a path that was never asked about.
    expect(answer.notChecked?.count).toBe(2_000 - PATHS_CAP);
  }, 30_000);

  it('does not echo a 50,000-character slug back at the session that sent it', async () => {
    const text = await tool('get_report', { slug: 'z'.repeat(50_000) });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(500);
    expect(text).toContain('no report for');
  }, 30_000);
});
