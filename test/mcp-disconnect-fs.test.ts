import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectAgentMcp,
  disconnectAgentMcp,
  disconnectAgents,
  McpUnsupportedError,
} from '../src/agents/connect.js';

let root: string;
let home: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'baton-disc-'));
  root = join(base, 'repo');
  home = join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('disconnectAgentMcp — project scope', () => {
  it('round-trips a connect: the file returns to just the user keys', async () => {
    const path = join(root, '.mcp.json');
    await writeFile(path, JSON.stringify({ theme: 'dark', mcpServers: { postgres: { command: 'pgmcp', args: [] } } }, null, 2));

    await connectAgentMcp('claude', root, null, {}, home);
    expect(JSON.parse(await readFile(path, 'utf-8')).mcpServers.baton).toBeTruthy();

    const r = await disconnectAgentMcp('claude', root, {}, home);
    expect(r.wrote).toBe(true);
    expect(r.removed).toEqual(['baton']);

    const after = JSON.parse(await readFile(path, 'utf-8'));
    expect(after.theme).toBe('dark');
    expect(Object.keys(after.mcpServers)).toEqual(['postgres']);
  });

  it('reports a missing config file without creating one', async () => {
    const r = await disconnectAgentMcp('cursor', root, {}, home);
    expect(r.exists).toBe(false);
    expect(r.wrote).toBe(false);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('leaves a file with nothing of ours byte-for-byte untouched', async () => {
    const path = join(root, '.mcp.json');
    const src = '{\n  "mcpServers": {\n    "postgres": { "command": "pgmcp" }\n  }\n}\n';
    await writeFile(path, src);
    const r = await disconnectAgentMcp('claude', root, {}, home);
    expect(r.wrote).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(src);
  });

  it('keeps the file and an empty mcpServers when the last server goes', async () => {
    const path = join(root, '.mcp.json');
    await connectAgentMcp('claude', root, null, {}, home);
    await disconnectAgentMcp('claude', root, {}, home);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf-8')).mcpServers).toEqual({});
  });

  it('is idempotent on disk', async () => {
    const path = join(root, '.mcp.json');
    await connectAgentMcp('claude', root, null, {}, home);
    await disconnectAgentMcp('claude', root, {}, home);
    const once = await readFile(path, 'utf-8');
    const second = await disconnectAgentMcp('claude', root, {}, home);
    expect(second.wrote).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(once);
  });

  it('leaves no temp file behind', async () => {
    await connectAgentMcp('claude', root, null, {}, home);
    await disconnectAgentMcp('claude', root, {}, home);
    expect((await readdir(root)).filter((f) => f.includes('baton-tmp'))).toEqual([]);
  });

  it('writes through a symlinked config instead of replacing the link', async () => {
    const realFile = join(root, 'real-mcp.json');
    await connectAgentMcp('claude', root, null, {}, home);
    await rename(join(root, '.mcp.json'), realFile);
    await symlink(realFile, join(root, '.mcp.json'));

    const r = await disconnectAgentMcp('claude', root, {}, home);
    expect(r.wrote).toBe(true);
    expect((await lstat(join(root, '.mcp.json'))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(realFile, 'utf-8')).mcpServers).toEqual({});
  });

  it('refuses an unparseable config and leaves it alone', async () => {
    const path = join(root, '.mcp.json');
    await writeFile(path, '{ this is not json');
    await expect(disconnectAgentMcp('claude', root, {}, home)).rejects.toThrow(/valid JSON/);
    expect(await readFile(path, 'utf-8')).toBe('{ this is not json');
  });

  it('throws for an agent with no MCP config', async () => {
    await expect(disconnectAgentMcp('opencode', root, {}, home)).rejects.toThrow(McpUnsupportedError);
  });
});

describe('disconnectAgentMcp — global scope needs a confirm', () => {
  it('previews without writing $HOME, then writes once confirmed', async () => {
    const path = join(home, '.gemini', 'settings.json');
    await connectAgentMcp('gemini', root, null, { confirmGlobal: true }, home);
    const before = await readFile(path, 'utf-8');

    const dry = await disconnectAgentMcp('gemini', root, {}, home);
    expect(dry.needsConfirm).toBe(true);
    expect(dry.wrote).toBe(false);
    expect(dry.preview).toBeTruthy();
    expect(await readFile(path, 'utf-8')).toBe(before);

    const done = await disconnectAgentMcp('gemini', root, { confirmGlobal: true }, home);
    expect(done.wrote).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf-8')).mcpServers).toEqual({});
  });

  it('removes a codex TOML block without disturbing the rest of the file', async () => {
    const path = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(path, 'model = "gpt-5"\n\n[history]\npersistence = "save-all"\n');

    await connectAgentMcp('codex', root, null, { confirmGlobal: true }, home);
    expect(await readFile(path, 'utf-8')).toContain('[mcp_servers."baton"]');

    const r = await disconnectAgentMcp('codex', root, { confirmGlobal: true }, home);
    expect(r.removed).toEqual(['baton']);
    const after = await readFile(path, 'utf-8');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[history]');
    expect(after).toContain('persistence = "save-all"');
    expect(after).not.toContain('mcp_servers');
  });
});

describe('disconnectAgents batch', () => {
  it('classifies every agent and never aborts the batch on a bad file', async () => {
    await writeFile(join(root, '.mcp.json'), '{ broken');
    await mkdir(join(root, '.cursor'), { recursive: true });
    await connectAgentMcp('cursor', root, null, {}, home);
    await connectAgentMcp('gemini', root, null, { confirmGlobal: true }, home);

    const out = await disconnectAgents(root, ['claude', 'cursor', 'codex', 'gemini', 'opencode'], {}, home);
    const by = Object.fromEntries(out.map((o) => [o.agent, o.status]));
    expect(by.claude).toBe('parse-error');
    expect(by.cursor).toBe('disconnected');
    expect(by.codex).toBe('nothing');
    expect(by.gemini).toBe('needs-confirm');
    expect(by.opencode).toBe('unsupported');
  });

  it('keeps going when one config cannot be read at all', async () => {
    // A directory where the config should be: readFile throws EISDIR, which is
    // not a parse error. The batch must still finish.
    await mkdir(join(root, '.mcp.json'), { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await connectAgentMcp('cursor', root, null, {}, home);

    const out = await disconnectAgents(root, ['claude', 'cursor'], {}, home);
    const by = Object.fromEntries(out.map((o) => [o.agent, o.status]));
    expect(by.claude).toBe('failed');
    expect(by.cursor).toBe('disconnected');
    expect(out.find((o) => o.agent === 'claude')?.error).toBeTruthy();
  });

  it('surfaces a look-alike server it refused to remove', async () => {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { baton: { command: 'python', args: [] } } }));
    const [claude] = await disconnectAgents(root, ['claude'], {}, home);
    expect(claude.status).toBe('nothing');
    expect(claude.skipped[0].name).toBe('baton');
  });
});
