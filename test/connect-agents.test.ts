import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgents } from '../src/agents/connect.js';

describe('connectAgents — one-command "wire every agent to Baton coordination"', () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-connect-root-'));
    home = await mkdtemp(join(tmpdir(), 'baton-connect-home-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const byAgent = (rs: Awaited<ReturnType<typeof connectAgents>>) =>
    Object.fromEntries(rs.map((r) => [r.agent, r]));

  it('writes project-scoped configs immediately and defers global ones without --yes', async () => {
    const rs = byAgent(await connectAgents(root, ['claude', 'cursor', 'codex', 'gemini'], {}, home));

    // Project scope (inside the repo) → written now, wiring the `baton` stdio server.
    expect(rs.claude.status).toBe('connected');
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf-8')).mcpServers.baton).toEqual({ command: 'baton', args: ['mcp'] });
    expect(rs.cursor.status).toBe('connected');
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);

    // Global scope ($HOME) → never touched without an explicit confirm.
    expect(rs.codex.status).toBe('needs-confirm');
    expect(rs.gemini.status).toBe('needs-confirm');
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(false);
  });

  it('writes global configs when confirmGlobal is set', async () => {
    const rs = byAgent(await connectAgents(root, ['codex', 'gemini'], { confirmGlobal: true }, home));
    expect(rs.codex.status).toBe('connected');
    expect(rs.gemini.status).toBe('connected');
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(true);
  });

  it('reports an already-connected agent instead of rewriting', async () => {
    await connectAgents(root, ['claude'], {}, home);
    const rs = byAgent(await connectAgents(root, ['claude'], {}, home));
    expect(rs.claude.status).toBe('already');
  });

  it('marks agents with no standard MCP wiring as unsupported (never throws)', async () => {
    const rs = byAgent(await connectAgents(root, ['aider'], {}, home));
    expect(rs.aider.status).toBe('unsupported');
  });
});
