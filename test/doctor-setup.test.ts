// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton doctor` setup checks. Hermetic: HOME and the fleet dir are tmp dirs,
 * so nothing here reads this machine's real agent configs or daemons. The
 * tokens below are fixtures, and the assertions check that neither is ever
 * printed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupChecks, printSetup, type SetupItem } from '../src/commands/doctor-setup.js';
import { antigravitySnippet, codexSnippet, geminiSnippet, jsonSnippet } from '../src/kb/mcp.js';
import type { KbState } from '../src/kb/state.js';

const TOKEN_FILE = 'a'.repeat(32);
const TOKEN_CFG = 'b'.repeat(32);

let dir: string;
let root: string;
let home: string;
const saved = { HOME: process.env.HOME, BATON_DAEMONS_DIR: process.env.BATON_DAEMONS_DIR };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'baton-dsetup-'));
  root = join(dir, 'repo');
  home = join(dir, 'home');
  await mkdir(join(root, '.baton'), { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.BATON_DAEMONS_DIR = join(dir, 'daemons');
});
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((sv) => new Promise((r) => sv.close(r))));
  servers = [];
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const byId = (items: SetupItem[], id: string) => items.filter((i) => i.id === id);

async function writeMcpJson(token: string, port = 7077): Promise<void> {
  await writeFile(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      baton: { command: 'baton', args: ['mcp'] },
      'graphify-api': { type: 'http', url: `http://127.0.0.1:${port}/mcp/g/${token}/api` },
    },
  }));
}

/**
 * A daemon that verifies as live: this process's own pid, recorded in the
 * tmp fleet dir, answering /api/meta on loopback with the recorded root.
 */
async function fakeDaemon(recordRoot: string): Promise<number> {
  const sv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ repo: recordRoot, pid: process.pid }));
  });
  servers.push(sv);
  await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
  const port = (sv.address() as AddressInfo).port;
  const fleet = process.env.BATON_DAEMONS_DIR!;
  await mkdir(fleet, { recursive: true });
  await writeFile(join(fleet, `${process.pid}-${port}.json`), JSON.stringify({
    pid: process.pid, port, root: recordRoot, startedAt: new Date().toISOString(), version: 'test', writeEnabled: false, host: false,
  }));
  return port;
}

const kbState = (): KbState => ({
  root, projects: [{ id: 'api', name: 'api', path: join(root, 'api'), graphPath: join(root, 'api', 'g.json') }],
  mergedGraphPath: null, lastBuiltAt: null,
});
const opts = (port: number, token: string) => ({ baseUrl: `http://127.0.0.1:${port}`, token });

function captured(items: SetupItem[]): string {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  printSetup(items);
  return lines.join('\n');
}

describe('setupChecks', () => {
  it('fails an MCP config whose token does not match .baton/mcp-token, without printing either token', async () => {
    await writeFile(join(root, '.baton', 'mcp-token'), TOKEN_FILE + '\n');
    await writeMcpJson(TOKEN_CFG);
    const items = await setupChecks(root);
    const mcp = byId(items, 'mcp');
    expect(mcp.some((i) => i.level === 'fail' && /token/.test(i.detail))).toBe(true);
    const out = captured(items);
    expect(out).not.toContain(TOKEN_FILE);
    expect(out).not.toContain(TOKEN_CFG);
    expect(out).toContain('baton kb init');
    expect(process.exitCode).toBe(1);
  });

  it('never creates the mcp-token file, and fails a config that names a token when none exists', async () => {
    await writeMcpJson(TOKEN_CFG);
    const items = await setupChecks(root);
    expect(existsSync(join(root, '.baton', 'mcp-token'))).toBe(false);
    expect(byId(items, 'mcp').some((i) => i.level === 'fail')).toBe(true);
  });

  it('passes when no agent config names a graphify server', async () => {
    const items = await setupChecks(root);
    expect(byId(items, 'mcp').every((i) => i.level === 'ok')).toBe(true);
  });

  it('says nothing about Claude hooks when Claude is not in use here', async () => {
    expect(byId(await setupChecks(root), 'hooks')).toEqual([]);
  });

  it('warns when the Claude hooks are missing, and passes once either settings file holds them', async () => {
    await mkdir(join(home, '.claude'), { recursive: true }); // Claude is in use on this machine
    let hooks = byId(await setupChecks(root), 'hooks');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].level).toBe('warn');
    expect(hooks[0].fix).toBe('baton hooks install claude');

    const all = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'baton pass --auto' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'baton pass --auto' }] }],
        PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'baton guard' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'baton orient --auto' }] }],
      },
    };
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(all));
    hooks = byId(await setupChecks(root), 'hooks');
    expect(hooks[0].level).toBe('ok');
  });

  it('passes a config the real generator wrote for the live daemon', async () => {
    await writeFile(join(root, '.baton', 'mcp-token'), TOKEN_FILE + '\n');
    const port = await fakeDaemon(root);
    await writeFile(join(root, '.mcp.json'), jsonSnippet(kbState(), opts(port, TOKEN_FILE)));
    const items = await setupChecks(root);
    expect(byId(items, 'daemon')[0].level).toBe('ok');
    const mcp = byId(items, 'mcp');
    expect(mcp).toHaveLength(1);
    expect(mcp[0].level).toBe('ok');
    expect(mcp[0].detail).toContain('claude');
  });

  it('fails a config pointing at another port while this repo\'s daemon is live', async () => {
    await writeFile(join(root, '.baton', 'mcp-token'), TOKEN_FILE + '\n');
    const port = await fakeDaemon(root);
    await writeFile(join(root, '.mcp.json'), jsonSnippet(kbState(), opts(port === 65535 ? 1 : port + 1, TOKEN_FILE)));
    const mcp = byId(await setupChecks(root), 'mcp');
    expect(mcp.some((i) => i.level === 'fail' && /points at/.test(i.detail))).toBe(true);
  });

  it('reads the bridged `args` shape (Antigravity)', async () => {
    await writeFile(join(root, '.baton', 'mcp-token'), TOKEN_FILE + '\n');
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents', 'mcp_config.json'), antigravitySnippet(kbState(), opts(7077, TOKEN_CFG)));
    const mcp = byId(await setupChecks(root), 'mcp');
    expect(mcp.some((i) => i.level === 'fail' && i.detail.startsWith('antigravity'))).toBe(true);
  });

  it('judges only this repo\'s entries in a global config — httpUrl (Gemini) and TOML (Codex)', async () => {
    await writeFile(join(root, '.baton', 'mcp-token'), TOKEN_FILE + '\n');
    const port = await fakeDaemon(root);
    const wrong = port === 65535 ? 1 : port + 1;
    await mkdir(join(home, '.gemini'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    // Another repo's entry (other token) is ignored; this repo's wrong port is judged.
    await writeFile(join(home, '.gemini', 'settings.json'), geminiSnippet(kbState(), opts(wrong, TOKEN_FILE)));
    await writeFile(join(home, '.codex', 'config.toml'), codexSnippet(kbState(), opts(wrong, TOKEN_CFG)));
    let mcp = byId(await setupChecks(root), 'mcp');
    expect(mcp.some((i) => i.level === 'fail' && i.detail.startsWith('gemini'))).toBe(true);
    expect(mcp.some((i) => i.detail.startsWith('codex'))).toBe(false);

    // Both healthy → no warning left to clear.
    await writeFile(join(home, '.gemini', 'settings.json'), geminiSnippet(kbState(), opts(port, TOKEN_FILE)));
    await writeFile(join(home, '.codex', 'config.toml'), codexSnippet(kbState(), opts(port, TOKEN_FILE)));
    mcp = byId(await setupChecks(root), 'mcp');
    expect(mcp.every((i) => i.level === 'ok')).toBe(true);
    expect(mcp[0].detail).toMatch(/codex/);
    expect(mcp[0].detail).toMatch(/gemini/);
  });

  it('recognises a daemon whose record root is the realpath of this root (/tmp vs /private/tmp)', async () => {
    const port = await fakeDaemon(await realpath(root));
    const [d] = byId(await setupChecks(root), 'daemon');
    expect(d.level).toBe('ok');
    expect(d.detail).toContain(`:${port}`);
  });

  it.runIf(typeof process.getuid === 'function')('fails a world-writable .baton and names the chmod', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined); // trustedBatonDir's own notice
    await chmod(join(root, '.baton'), 0o777);
    const [b] = byId(await setupChecks(root), 'baton-dir');
    expect(b.level).toBe('fail');
    expect(b.fix).toMatch(/^chmod o-w /);
  });

  it('warns that no daemon serves this repo, pointing at baton serve', async () => {
    const [d] = byId(await setupChecks(root), 'daemon');
    expect(d.level).toBe('warn');
    expect(d.fix).toBe('baton serve');
  });
});
