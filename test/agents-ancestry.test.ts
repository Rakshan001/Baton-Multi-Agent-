// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I3-I6, I12 — one memoized `ps` walk, nearest agent first, IDE host
 * titles that never read as the workspace they have open. The ps runner is
 * injected; chains are the ones observed on a real machine (2026-09-24).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ancestryWalker, detectAncestry, nearestAgent, lenientAgent, firstAgentIn,
  agentDetectionUnavailable, resetAgentDetectionForTests, classify, type Ancestor,
} from '../src/agents.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const table = (rows: Array<[number, number, string]>) => rows.map(([p, pp, c]) => `${p} ${pp} ${c}`).join('\n');
const chainOf = (cmds: string[]): Ancestor[] => cmds.map((command, i) => ({ pid: 100 + i, command }));

const CLAUDE_BIN = '/Users/me/.cursor/extensions/anthropic.claude-code-2.1.280-darwin-arm64/resources/native-binary/claude --output-format stream-json --verbose';
const EXT_HOST = 'Cursor Helper (Plugin): extension-host (user) baton [1-1]';
const CURSOR_APP = '/Applications/Cursor.app/Contents/MacOS/Cursor .';

describe('ancestryWalker — one ps, memoized on success only', () => {
  const rows = table([[50, 40, 'node /opt/homebrew/bin/baton mcp'], [40, 30, '/bin/zsh'], [30, 1, '/sbin/launchd']]);

  it('walks nearest-first and memoizes a success', async () => {
    const run = vi.fn(async () => rows);
    const walk = ancestryWalker(run, 40);
    expect(await walk()).toEqual([{ pid: 40, command: '/bin/zsh' }, { pid: 30, command: '/sbin/launchd' }]);
    await walk();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a successful walk that finds no agent is memoized too', async () => {
    const run = vi.fn(async () => rows);
    const walk = ancestryWalker(run, 40);
    expect(await detectAncestry(undefined, walk)).toBeNull();
    expect(await detectAncestry(undefined, walk)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failure is not memoized: it retries, at most 3 attempts', async () => {
    const run = vi.fn(async (): Promise<string | null> => { throw new Error('timeout'); });
    const walk = ancestryWalker(run, 40);
    for (let i = 0; i < 5; i++) expect(await walk()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a timeout then a success → the identity updates', async () => {
    let n = 0;
    const run = vi.fn(async () => (n++ === 0 ? null : table([[40, 1, CLAUDE_BIN]])));
    const walk = ancestryWalker(run, 40);
    expect(await detectAncestry(undefined, walk)).toBeNull();
    expect(await detectAncestry(undefined, walk)).toMatchObject({ agent: 'claude', strict: true, pid: 40 });
  });

  it('an aborted walk hands the signal to the ps runner', async () => {
    let seen: AbortSignal | undefined;
    const walk = ancestryWalker(async (signal) => { seen = signal; return rows; }, 40);
    const ac = new AbortController();
    await detectAncestry(undefined, walk, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it('concurrent callers share one in-flight ps', async () => {
    const run = vi.fn(async () => rows);
    const walk = ancestryWalker(run, 40);
    await Promise.all([walk(), walk(), walk()]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops at maxDepth, at pid <= 1, and on a cycle', async () => {
    const deep = table([[9, 8, 'a'], [8, 7, 'b'], [7, 6, 'c'], [6, 5, 'd']]);
    expect((await ancestryWalker(async () => deep, 9, 2)()).map((a) => a.pid)).toEqual([9, 8]);
    expect((await ancestryWalker(async () => table([[5, 1, 'x'], [1, 0, 'launchd']]), 5)()).map((a) => a.pid)).toEqual([5]);
    const cyc = table([[3, 4, 'a'], [4, 3, 'b']]);
    expect((await ancestryWalker(async () => cyc, 3)()).map((a) => a.pid)).toEqual([3, 4]);
  });
});

describe('nearestAgent — observed chains', () => {
  it('Claude inside Cursor → claude, strict, the native-binary pid', () => {
    expect(nearestAgent(chainOf([CLAUDE_BIN, EXT_HOST, CURSOR_APP]))).toEqual({ agent: 'claude', strict: true, pid: 100 });
  });
  it('Cursor-native MCP → cursor, strict, the mcp-process pid', () => {
    expect(nearestAgent(chainOf(['Cursor Helper: mcp-process', CURSOR_APP]))).toEqual({ agent: 'cursor', strict: true, pid: 100 });
  });
  it('an extension-host whose workspace is named claude reads as cursor, not claude', () => {
    expect(nearestAgent(chainOf(['Cursor Helper (Plugin): extension-host (user) claude [1-1]', CURSOR_APP]))?.agent).toBe('cursor');
  });
  it('a VS Code extension-host title never reads as the workspace', () => {
    expect(nearestAgent(chainOf(['Code Helper (Plugin): extension-host (user) codex [1-1]']))).toBeNull();
  });
  it('Antigravity CLI chain → antigravity, strict', () => {
    expect(nearestAgent(chainOf(['agy', '-zsh']))).toMatchObject({ agent: 'antigravity', strict: true });
  });
  it('a shell wrapper between is fine', () => {
    expect(nearestAgent(chainOf(['/bin/zsh', 'node /x/claude --resume']))).toMatchObject({ agent: 'claude', strict: true, pid: 101 });
  });
  it('a `shell -c` wrapper is skipped: its text is the agent\'s own command, not an identity', () => {
    const wrapper = "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'baton review approve t-x && echo codex done' < /dev/null";
    expect(nearestAgent(chainOf([wrapper, CLAUDE_BIN]))).toEqual({ agent: 'claude', strict: true, pid: 101 });
    expect(nearestAgent(chainOf(['bash -lc "echo codex"', CLAUDE_BIN]))?.agent).toBe('claude');
    expect(nearestAgent(chainOf(['/bin/sh -c /usr/local/bin/cursor', CLAUDE_BIN]))?.agent).toBe('claude');
  });
  it('an interactive shell (no -c) is still classified by its text', () => {
    expect(nearestAgent(chainOf(['-zsh', CLAUDE_BIN]))?.pid).toBe(101);
    expect(nearestAgent(chainOf(['/bin/zsh /opt/bin/codex', CLAUDE_BIN]))?.agent).toBe('codex');
  });
  it('the nearest agent wins over a farther strict one', () => {
    expect(nearestAgent(chainOf(['/usr/bin/codex exec', 'node /x/claude --resume']))?.agent).toBe('codex');
  });
  it('built-ins beat a project pattern on one line (two-tier)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-anc-'));
    try {
      await mkdir(join(root, '.baton'), { recursive: true });
      await writeFile(join(root, '.baton', 'agents.json'), JSON.stringify({ agents: [{ id: 'acme', binary: 'acme', detect: 'acme' }] }));
      expect(nearestAgent(chainOf(['node /Users/acme-dev/.npm/bin/claude']), root)?.agent).toBe('claude');
      expect(nearestAgent(chainOf(['/opt/acme/run --x']), root)?.agent).toBe('acme');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('lenientAgent — executable basename or .app name only', () => {
  const ids = ['claude', 'codex', 'cursor'];
  it('does not read a directory in the path', () => {
    expect(lenientAgent('~/src/cursor/run.sh', ids)).toBeNull();
    expect(lenientAgent('bash ~/src/cursor/run.sh', ids)).toBeNull();
    expect(lenientAgent('/usr/local/bin/codex-wrapper', ids)).toBeNull();
    expect(firstAgentIn(['bash ~/src/cursor/run.sh'])).toBeNull();
  });
  it('matches the executable basename, case-insensitive', () => {
    expect(lenientAgent('/opt/x/Codex', ids)).toBe('codex');
    expect(nearestAgent(chainOf(['/opt/x/Codex']))).toMatchObject({ agent: 'codex', strict: false });
  });
  it('matches the .app bundle name', () => {
    expect(lenientAgent('/Applications/Cursor.app/Contents/MacOS/cursor --type=utility', ids)).toBe('cursor');
  });
});

describe('host patterns are ancestry-only, never in the board scan', () => {
  it('the board classify never marks an IDE host, so Claude-in-Cursor is not folded away', () => {
    // detectRootAgents drops a matched process whose parent is matched, and every
    // matched process costs an lsof — host titles must stay out of this table.
    expect(classify(EXT_HOST)).toBeNull();
    expect(classify('Cursor Helper: mcp-process')).toBeNull();
    expect(classify(CURSOR_APP)).toBeNull();
    expect(classify('/Applications/Antigravity.app/Contents/MacOS/Antigravity')).toBeNull();
    expect(classify(CLAUDE_BIN)).toBe('claude');
  });
});

describe('agentDetectionUnavailable (I12)', () => {
  afterEach(() => { resetAgentDetectionForTests(); vi.restoreAllMocks(); });
  it('win32 → no ancestry and the flag is set', async () => {
    const plat = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await detectAncestry()).toBeNull();
      expect(agentDetectionUnavailable()).toBe(true);
    } finally { Object.defineProperty(process, 'platform', plat); }
  });
  it('a timed-out walk returns null and leaves the flag clear', async () => {
    const walk = ancestryWalker(async () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); }, 40);
    expect(await detectAncestry(undefined, walk)).toBeNull();
    expect(agentDetectionUnavailable()).toBe(false);
  });
});
