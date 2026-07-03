import { describe, expect, it } from 'vitest';
import {
  isConnected, McpConfigParseError, mcpTargetFor, mergeJsonConfig, mergeTomlConfig, serversForState,
} from '../src/agents/connect.js';

const SERVERS = { baton: { command: 'baton', args: ['mcp'] } };

describe('mcpTargetFor', () => {
  it('maps each supported agent to its config file + scope', () => {
    expect(mcpTargetFor('claude', '/repo', '/home')).toMatchObject({ scope: 'project', format: 'json', path: '/repo/.mcp.json' });
    expect(mcpTargetFor('cursor', '/repo', '/home')).toMatchObject({ scope: 'project', format: 'json', path: '/repo/.cursor/mcp.json' });
    expect(mcpTargetFor('gemini', '/repo', '/home')).toMatchObject({ scope: 'global', format: 'json', path: '/home/.gemini/settings.json' });
    expect(mcpTargetFor('codex', '/repo', '/home')).toMatchObject({ scope: 'global', format: 'toml', path: '/home/.codex/config.toml' });
  });

  it('returns null for agents with no MCP wiring', () => {
    expect(mcpTargetFor('aider', '/repo', '/home')).toBeNull();
    expect(mcpTargetFor('opencode', '/repo', '/home')).toBeNull();
  });
});

describe('serversForState', () => {
  it('wires just the coordination server when there is no KB', () => {
    expect(serversForState(null)).toEqual({ baton: { command: 'baton', args: ['mcp'] } });
  });

  it('throws when state exists but opts is undefined', () => {
    const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: null, lastBuiltAt: null } as any;
    expect(() => serversForState(state, undefined)).toThrow('mcpOpts required when a KB exists');
  });
});

describe('isConnected', () => {
  it('detects the baton server in JSON', () => {
    expect(isConnected('json', JSON.stringify({ mcpServers: { baton: {} } }))).toBe(true);
    expect(isConnected('json', JSON.stringify({ mcpServers: { other: {} } }))).toBe(false);
    expect(isConnected('json', '{ not valid')).toBe(false);
    expect(isConnected('json', '{}')).toBe(false);
  });

  it('detects the baton block in TOML — quoted OR bare key', () => {
    expect(isConnected('toml', '[mcp_servers."baton"]\ncommand = "baton"')).toBe(true);
    expect(isConnected('toml', '[mcp_servers.baton]\ncommand = "baton"')).toBe(true); // idiomatic bare key
    expect(isConnected('toml', '[mcp_servers."graphify-x"]\n')).toBe(false);
  });
});

describe('mergeJsonConfig', () => {
  it('adds mcpServers to an empty/absent config', () => {
    const out = JSON.parse(mergeJsonConfig('', SERVERS));
    expect(out.mcpServers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });

  it('preserves unrelated keys and existing servers', () => {
    const existing = JSON.stringify({ theme: 'dark', mcpServers: { keepme: { command: 'x', args: [] } } });
    const out = JSON.parse(mergeJsonConfig(existing, SERVERS));
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.keepme).toEqual({ command: 'x', args: [] });
    expect(out.mcpServers.baton).toBeDefined();
  });

  it('does not clobber a same-named server with a different one — ours wins, the rest stay', () => {
    const existing = JSON.stringify({ mcpServers: { baton: { command: 'old', args: [] }, keep: { command: 'k', args: [] } } });
    const out = JSON.parse(mergeJsonConfig(existing, SERVERS));
    expect(out.mcpServers.baton.command).toBe('baton');
    expect(out.mcpServers.keep).toBeDefined();
  });

  it('refuses to overwrite an unparseable config instead of silently dropping it', () => {
    expect(() => mergeJsonConfig('{ "mcpServers": { trailing, }', SERVERS, '/x/.mcp.json')).toThrow(McpConfigParseError);
    expect(() => mergeJsonConfig('not json at all', SERVERS)).toThrow(McpConfigParseError);
    // a JSON array/scalar is valid JSON but not a config object — also refuse
    expect(() => mergeJsonConfig('[1,2,3]', SERVERS)).toThrow(McpConfigParseError);
    expect(() => mergeJsonConfig('"hello"', SERVERS)).toThrow(McpConfigParseError);
  });
});

describe('mergeTomlConfig', () => {
  it('appends the baton block to an empty config', () => {
    const out = mergeTomlConfig('', SERVERS);
    expect(out).toContain('[mcp_servers."baton"]');
    expect(out).toContain('command = "baton"');
    expect(out).toContain('args = ["mcp"]');
  });

  it('is idempotent — does not duplicate an existing block', () => {
    const first = mergeTomlConfig('', SERVERS);
    const second = mergeTomlConfig(first, SERVERS);
    expect(second).toBe(first);
  });

  it('does not duplicate a server the user wired with a bare key', () => {
    const existing = '[mcp_servers.baton]\ncommand = "baton"\nargs = ["mcp"]\n';
    const out = mergeTomlConfig(existing, SERVERS);
    expect(out).toBe(existing.endsWith('\n') ? existing : existing + '\n'); // nothing appended
    expect((out.match(/\[mcp_servers\./g) || []).length).toBe(1);
  });

  it('escapes quotes and backslashes in values (no invalid TOML)', () => {
    const out = mergeTomlConfig('', { baton: { command: 'C:\\bin\\baton.exe', args: ['--say', 'he said "hi"'] } });
    expect(out).toContain('command = "C:\\\\bin\\\\baton.exe"');
    expect(out).toContain('"he said \\"hi\\""');
  });

  it('preserves unrelated TOML and appends below it', () => {
    const existing = '[profile]\nmodel = "gpt"\n';
    const out = mergeTomlConfig(existing, SERVERS);
    expect(out).toContain('[profile]');
    expect(out).toContain('model = "gpt"');
    expect(out).toContain('[mcp_servers."baton"]');
  });
});
