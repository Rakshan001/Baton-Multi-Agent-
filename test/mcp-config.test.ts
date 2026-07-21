import { describe, it, expect } from 'vitest';
import { mergeJsonConfig, mergeTomlConfig, serversForStateCodex } from '../src/agents/connect.js';
import { mcpServers, mcpServersCodex, codexSnippet, geminiSnippet } from '../src/kb/mcp.js';

describe('mergeJsonConfig with an http server def', () => {
  it('writes a { type, url } entry verbatim', () => {
    const out = JSON.parse(mergeJsonConfig('{}', {
      'graphify-merged': { type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' },
    }));
    expect(out.mcpServers['graphify-merged']).toEqual({ type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' });
  });
  it('still writes a stdio { command, args } entry', () => {
    const out = JSON.parse(mergeJsonConfig('{}', { baton: { command: 'baton', args: ['mcp'] } }));
    expect(out.mcpServers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });
});

describe('mergeTomlConfig with an http server def', () => {
  it('emits url for http servers and command/args for stdio', () => {
    const toml = mergeTomlConfig('', {
      'graphify-merged': { type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' },
      baton: { command: 'baton', args: ['mcp'] },
    });
    expect(toml).toContain('url = "http://127.0.0.1:7077/mcp/g/abc/merged"');
    expect(toml).toContain('command = "baton"');
  });
});

describe('mcpServers', () => {
  it('emits http urls for graphify and stdio for baton', () => {
    const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
    const servers = mcpServers(state, { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) });
    expect(servers['graphify-api']).toEqual({ type: 'http', url: `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api` });
    expect(servers['graphify-merged']).toEqual({ type: 'http', url: `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/merged` });
    expect(servers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });
});

describe('codexSnippet TOML block headers and escaping', () => {
  it('emits baton mcp-bridge + daemon URL (no url= key, no uv spawn)', () => {
    const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
    const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) };
    const proxyUrl = `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api`;
    const toml = codexSnippet(state, opts);
    // Codex uses command+args only — bridge wraps the same shared-pool URL
    expect(toml).toContain('[mcp_servers."graphify-api"]');
    expect(toml).toContain('command = "baton"');
    expect(toml).toContain(`args = ["mcp-bridge", "${proxyUrl}"]`);
    expect(toml).not.toContain('command = "uv"');
    expect(toml).not.toContain('url =');
    // baton coordination server must be present
    expect(toml).toContain('[mcp_servers."baton"]');
    expect(toml).toContain('args = ["mcp"]');
  });

  it('emits just the baton block when there are no projects', () => {
    const state = { root: '/r', projects: [], mergedGraphPath: null, lastBuiltAt: null } as any;
    const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'b'.repeat(32) };
    const toml = codexSnippet(state, opts);
    // Just baton should appear
    expect(toml).toContain('[mcp_servers."baton"]');
    expect(toml).toContain('command = "baton"');
  });
});

describe('mcpServersCodex / serversForStateCodex', () => {
  const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
  const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) };

  it('points graphify entries at baton mcp-bridge with the daemon URL', () => {
    const servers = mcpServersCodex(state, opts);
    expect(servers['graphify-api']).toEqual({
      command: 'baton',
      args: ['mcp-bridge', `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api`],
    });
    expect(servers['graphify-merged']).toEqual({
      command: 'baton',
      args: ['mcp-bridge', `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/merged`],
    });
    expect(servers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });

  it('serversForStateCodex matches mcpServersCodex (connect-from-dashboard path)', () => {
    expect(serversForStateCodex(state, opts)).toEqual(mcpServersCodex(state, opts));
    expect(serversForStateCodex(null)).toEqual({ baton: { command: 'baton', args: ['mcp'] } });
  });
});

describe('geminiSnippet uses httpUrl (not url) for graphify entries', () => {
  const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
  const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) };

  it('emits httpUrl for graphify entries', () => {
    const snippet = geminiSnippet(state, opts);
    expect(snippet).toContain('"httpUrl":');
    expect(snippet).not.toContain('"url":');
    expect(snippet).not.toContain('"type": "http"');
  });

  it('baton entry stays stdio (command/args)', () => {
    const parsed = JSON.parse(geminiSnippet(state, opts));
    expect(parsed.mcpServers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });

  it('claude/cursor still use type+url form (not httpUrl)', () => {
    // mcpServers is used by claude/cursor — verify it still uses { type:'http', url }
    const servers = mcpServers(state, opts);
    expect(servers['graphify-api']).toEqual({ type: 'http', url: `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api` });
    expect(servers['graphify-api']).not.toHaveProperty('httpUrl');
  });
});

describe('mcpServers port in URL', () => {
  it('uses the supplied port in all graphify URLs', () => {
    const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: null, lastBuiltAt: null } as any;
    const servers = mcpServers(state, { baseUrl: 'http://127.0.0.1:7079', token: 'c'.repeat(32) });
    const url = (servers['graphify-api'] as { type: 'http'; url: string }).url;
    expect(url).toContain(':7079');
  });
});
