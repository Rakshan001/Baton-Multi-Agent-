import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { firstAgentIn } from '../src/agents.js';
import { registerHookSession, recordHookEdit, getSignals, getProgress, setProgress } from '../src/signals.js';

/**
 * M1 — session identity for EVERY agent over MCP, zero config. Each agent
 * session spawns its own `baton mcp` process, so (a) the parent process chain
 * says WHICH agent this is, and (b) the pid gives a stable per-session slug.
 * That makes cursor/codex/gemini sessions at the repo root first-class:
 * registered, attributable, able to report progress and touch files.
 */
describe('firstAgentIn — classify the owning agent from an ancestor command chain', () => {
  it('finds the agent CLI in the chain (shell wrappers between are fine)', () => {
    expect(firstAgentIn(['/bin/zsh -c baton mcp', 'node /usr/local/bin/claude --resume'])).toBe('claude');
    expect(firstAgentIn(['sh -c "baton mcp"', '/Applications/Cursor.app/Contents/MacOS/cursor --type=utility'])).toBe('cursor');
  });
  it('returns null when nothing in the chain looks like a known agent', () => {
    expect(firstAgentIn(['/bin/zsh', '/sbin/launchd'])).toBeNull();
  });
});

describe('registerHookSession + MCP-written signals', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-mcpid-'));
    await git(['init', '-q'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'ui.tsx'), 'export const UI = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-q', '-m', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('a registered MCP session that touches a file is attributed with its agent', async () => {
    registerHookSession(root, 'sess-p4242', 'codex', root);
    await writeFile(join(root, 'ui.tsx'), 'export const UI = 2;\n', 'utf-8'); // the edit itself
    recordHookEdit(root, { slug: 'sess-p4242', path: 'ui.tsx' }); // touch_files path — no session payload needed

    const signals = await getSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0].holders[0]).toMatchObject({ slug: 'sess-p4242', agent: 'codex' });
  });

  it('progress notes work for MCP sessions too (no worktree required)', async () => {
    registerHookSession(root, 'sess-p7777', 'cursor', root);
    setProgress(root, 'sess-p7777', 'building the settings screen');
    expect(getProgress(root).get('sess-p7777')?.note).toBe('building the settings screen');
  });
});

describe('antigravity detection (M4)', () => {
  it('classifies the agy CLI and the Antigravity IDE host', () => {
    expect(firstAgentIn(['/bin/zsh', '/Users/me/.local/bin/agy'])).toBe('antigravity');
    expect(firstAgentIn(['/Applications/Antigravity.app/Contents/MacOS/Antigravity --type=utility'])).toBe('antigravity');
  });
});
