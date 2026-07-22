import { describe, it, expect } from 'vitest';
import { isBatonOwned, unmergeJsonConfig, unmergeTomlConfig, McpConfigParseError } from '../src/agents/connect.js';

const TOKEN = 'a'.repeat(32);
const PROXY = `http://127.0.0.1:7077/mcp/g/${TOKEN}/merged`;

describe('isBatonOwned', () => {
  it('claims the stdio coordination server', () => {
    expect(isBatonOwned('baton', { command: 'baton', args: ['mcp'] })).toBe(true);
  });

  it('disowns a server named baton that runs something else', () => {
    expect(isBatonOwned('baton', { command: 'python', args: ['-m', 'mine'] })).toBe(false);
  });

  it('claims a graphify bridge and a graphify proxy url', () => {
    expect(isBatonOwned('graphify-api', { command: 'baton', args: ['mcp-bridge', PROXY] })).toBe(true);
    expect(isBatonOwned('graphify-api', { type: 'http', url: PROXY })).toBe(true);
    expect(isBatonOwned('graphify-api', { httpUrl: PROXY })).toBe(true);
    expect(isBatonOwned('graphify-api', { serverUrl: PROXY })).toBe(true);
  });

  it('disowns a graphify-* server the user wired at their own endpoint', () => {
    expect(isBatonOwned('graphify-mine', { type: 'http', url: 'http://127.0.0.1:9999/other' })).toBe(false);
    expect(isBatonOwned('graphify-mine', { command: 'uv', args: ['run', 'graphify'] })).toBe(false);
  });

  it('disowns a proxy-shaped url on a non-loopback host', () => {
    expect(isBatonOwned('graphify-api', { type: 'http', url: `http://evil.example.com/mcp/g/${TOKEN}/merged` })).toBe(false);
  });

  it('claims an absolute path to the baton binary', () => {
    // An install that wired a full path is exactly the stale entry disconnect
    // exists to clear; refusing it would defeat the command.
    expect(isBatonOwned('baton', { command: '/usr/local/bin/baton', args: ['mcp'] })).toBe(true);
    expect(isBatonOwned('graphify-api', { command: '/opt/homebrew/bin/baton', args: ['mcp-bridge', PROXY] })).toBe(true);
  });

  it('does not claim a command that merely ends in the letters baton', () => {
    expect(isBatonOwned('baton', { command: '/usr/bin/notbaton', args: ['mcp'] })).toBe(false);
    expect(isBatonOwned('baton', { command: 'baton-other', args: ['mcp'] })).toBe(false);
  });

  it('never claims an unrelated server name', () => {
    expect(isBatonOwned('postgres', { command: 'baton', args: ['mcp'] })).toBe(false);
  });

  it('tolerates junk defs without throwing', () => {
    for (const junk of [null, undefined, 'str', 42, []]) {
      expect(isBatonOwned('baton', junk)).toBe(false);
    }
  });
});

describe('unmergeJsonConfig', () => {
  it('is a no-op on an empty or whitespace-only file', () => {
    for (const src of ['', '   \n']) {
      const r = unmergeJsonConfig(src);
      expect(r.removed).toEqual([]);
      expect(r.text).toBe(src);
    }
  });

  it('refuses an unparseable file rather than clobbering it', () => {
    expect(() => unmergeJsonConfig('{ not json', '/tmp/x.json')).toThrow(McpConfigParseError);
  });

  it('refuses a JSON array or scalar', () => {
    expect(() => unmergeJsonConfig('[1,2]')).toThrow(McpConfigParseError);
    expect(() => unmergeJsonConfig('"hello"')).toThrow(McpConfigParseError);
  });

  it('is a no-op when there is no mcpServers key', () => {
    const r = unmergeJsonConfig('{"theme":"dark"}');
    expect(r.removed).toEqual([]);
    expect(JSON.parse(r.text).theme).toBe('dark');
  });

  it('removes only Baton servers and preserves everything else', () => {
    const src = JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash'] },
      mcpServers: {
        baton: { command: 'baton', args: ['mcp'] },
        'graphify-api': { type: 'http', url: PROXY },
        postgres: { command: 'pgmcp', args: [] },
      },
    });
    const r = unmergeJsonConfig(src);
    const out = JSON.parse(r.text);
    expect(r.removed.sort()).toEqual(['baton', 'graphify-api']);
    expect(Object.keys(out.mcpServers)).toEqual(['postgres']);
    expect(out.theme).toBe('dark');
    expect(out.permissions).toEqual({ allow: ['Bash'] });
  });

  it('leaves mcpServers as an empty object, never deleting the key or the file', () => {
    const r = unmergeJsonConfig(JSON.stringify({ mcpServers: { baton: { command: 'baton', args: ['mcp'] } } }));
    const out = JSON.parse(r.text);
    expect(out.mcpServers).toEqual({});
    expect('mcpServers' in out).toBe(true);
  });

  it('reports a look-alike it refused to remove instead of silently keeping it', () => {
    const r = unmergeJsonConfig(JSON.stringify({ mcpServers: { baton: { command: 'python', args: [] } } }));
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'baton', why: 'not written by Baton — left untouched' }]);
  });

  it('is idempotent', () => {
    const src = JSON.stringify({ mcpServers: { baton: { command: 'baton', args: ['mcp'] }, keep: { command: 'x', args: [] } } });
    const once = unmergeJsonConfig(src);
    const twice = unmergeJsonConfig(once.text);
    expect(twice.removed).toEqual([]);
    expect(twice.text).toBe(once.text);
  });
});

describe('unmergeTomlConfig', () => {
  it('removes a Baton block without eating the section that follows it', () => {
    const src = [
      'model = "gpt-5"',
      '',
      '[mcp_servers."baton"]',
      'command = "baton"',
      'args = ["mcp"]',
      '',
      '[mcp_servers."postgres"]',
      'command = "pgmcp"',
      'args = []',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const r = unmergeTomlConfig(src);
    expect(r.removed).toEqual(['baton']);
    expect(r.text).toContain('[mcp_servers."postgres"]');
    expect(r.text).toContain('command = "pgmcp"');
    expect(r.text).toContain('[history]');
    expect(r.text).toContain('persistence = "save-all"');
    expect(r.text).toContain('model = "gpt-5"');
    expect(r.text).not.toContain('[mcp_servers."baton"]');
    expect(r.text).not.toContain('args = ["mcp"]');
  });

  it('removes a bare-key table too', () => {
    const r = unmergeTomlConfig('[mcp_servers.baton]\ncommand = "baton"\nargs = ["mcp"]\n');
    expect(r.removed).toEqual(['baton']);
    expect(r.text.trim()).toBe('');
  });

  it('removes the graphify bridge block', () => {
    const src = `[mcp_servers."graphify-merged"]\ncommand = "baton"\nargs = ["mcp-bridge", "${PROXY}"]\n`;
    expect(unmergeTomlConfig(src).removed).toEqual(['graphify-merged']);
  });

  it('leaves a look-alike block that Baton did not write', () => {
    const src = '[mcp_servers."baton"]\ncommand = "python"\nargs = ["-m", "mine"]\n';
    const r = unmergeTomlConfig(src);
    expect(r.removed).toEqual([]);
    expect(r.skipped[0].name).toBe('baton');
    expect(r.text).toBe(src);
  });

  it('leaves a graphify block pointing at the user own backend', () => {
    const src = '[mcp_servers."graphify-mine"]\ncommand = "uv"\nargs = ["run", "graphify"]\n';
    expect(unmergeTomlConfig(src).removed).toEqual([]);
  });

  it('handles a block whose args array spans several lines', () => {
    const src = [
      '[mcp_servers."baton"]',
      'command = "baton"',
      'args = [',
      '  "mcp",',
      ']',
      '',
      '[history]',
      'persistence = "save-all"',
      '',
    ].join('\n');
    const r = unmergeTomlConfig(src);
    expect(r.removed).toEqual(['baton']);
    expect(r.text).toContain('[history]');
    expect(r.text).not.toContain('command = "baton"');
  });

  it('is a no-op on an empty file and on a file with no baton blocks', () => {
    expect(unmergeTomlConfig('').removed).toEqual([]);
    const other = '[mcp_servers."postgres"]\ncommand = "pgmcp"\n';
    const r = unmergeTomlConfig(other);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(other);
  });

  it('is idempotent', () => {
    const src = '[mcp_servers."baton"]\ncommand = "baton"\nargs = ["mcp"]\n\n[history]\nx = 1\n';
    const once = unmergeTomlConfig(src);
    const twice = unmergeTomlConfig(once.text);
    expect(twice.removed).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('removes a server sub-table with its parent, never orphaning it', () => {
    // Codex allows [mcp_servers."baton".env]. Dropping the parent alone would
    // leave config for a server that no longer exists.
    const src = [
      '[mcp_servers."baton"]',
      'command = "baton"',
      'args = ["mcp"]',
      '',
      '[mcp_servers."baton".env]',
      'BATON_ROOT = "/repo"',
      '',
      '[history]',
      'x = 1',
      '',
    ].join('\n');
    const r = unmergeTomlConfig(src);
    expect(r.removed).toEqual(['baton']);
    expect(r.text).not.toContain('mcp_servers');
    expect(r.text).not.toContain('BATON_ROOT');
    expect(r.text).toContain('[history]');
  });

  it('keeps a sub-table when the parent is not ours', () => {
    const src = '[mcp_servers."baton"]\ncommand = "python"\n\n[mcp_servers."baton".env]\nK = "v"\n';
    const r = unmergeTomlConfig(src);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(src);
  });

  it('leaves blank-line runs elsewhere in the file alone', () => {
    const src = 'a = 1\n\n\n\nb = 2\n\n[mcp_servers."baton"]\ncommand = "baton"\nargs = ["mcp"]\n';
    expect(unmergeTomlConfig(src).text).toBe('a = 1\n\n\n\nb = 2\n');
  });

  it('claims a block whose command is an absolute path to baton', () => {
    const src = '[mcp_servers."baton"]\ncommand = "/usr/local/bin/baton"\nargs = ["mcp"]\n';
    expect(unmergeTomlConfig(src).removed).toEqual(['baton']);
  });

  it('does not leave a run of blank lines behind', () => {
    const src = 'model = "gpt-5"\n\n[mcp_servers."baton"]\ncommand = "baton"\nargs = ["mcp"]\n\n[history]\nx = 1\n';
    expect(unmergeTomlConfig(src).text).not.toMatch(/\n{3,}/);
  });
});
