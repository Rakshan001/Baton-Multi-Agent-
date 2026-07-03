import { describe, it, expect } from 'vitest';
import { mergeJsonConfig, mergeTomlConfig } from '../src/agents/connect.js';

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
