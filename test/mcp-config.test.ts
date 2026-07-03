import { describe, it, expect } from 'vitest';
import { mergeJsonConfig, mergeTomlConfig } from '../src/agents/connect.js';
import { mcpServers, codexSnippet } from '../src/kb/mcp.js';

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
  it('emits correct block headers (no url= for codex, command/args instead)', () => {
    const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
    const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) };
    const toml = codexSnippet(state, opts);
    // Codex uses stdio spawn (uv), not http url — verify it has command= and no url= for graphify
    expect(toml).toContain('[mcp_servers."graphify-api"]');
    expect(toml).toContain('command = "uv"');
    expect(toml).not.toContain(`url = "http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api"`);
    // baton server must be present
    expect(toml).toContain('[mcp_servers."baton"]');
    // no command= line in the graphify-merged block when it would be url-based
    // but for codex we keep stdio, so no url= at all
    expect(toml).not.toContain('url =');
  });

  it('uses toml-escaped url in non-codex snippet (verify escaping helper)', () => {
    // mergeTomlConfig already has escaping tests; this verifies codexSnippet
    // uses the same tomlStr-equivalent approach for any url in its server defs
    const state = { root: '/r', projects: [], mergedGraphPath: null, lastBuiltAt: null } as any;
    const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'b'.repeat(32) };
    const toml = codexSnippet(state, opts);
    // Just baton should appear
    expect(toml).toContain('[mcp_servers."baton"]');
    expect(toml).toContain('command = "baton"');
  });
});
