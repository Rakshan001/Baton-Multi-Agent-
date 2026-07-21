/**
 * Unit tests for the Codex stdio↔HTTP graphify bridge.
 * Spawns no daemon — stubs fetch and drives the bridge over fake streams.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import {
  forwardJsonRpc,
  parseBridgeUrl,
  runMcpBridge,
  McpBridgeUrlError,
} from '../src/commands/mcp-bridge.js';

describe('parseBridgeUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(parseBridgeUrl('http://127.0.0.1:7077/mcp/g/abc/merged')).toBe(
      'http://127.0.0.1:7077/mcp/g/abc/merged',
    );
    expect(parseBridgeUrl('https://example.test/mcp')).toBe('https://example.test/mcp');
  });

  it('rejects non-http schemes and garbage', () => {
    expect(() => parseBridgeUrl('ftp://x')).toThrow(McpBridgeUrlError);
    expect(() => parseBridgeUrl('not a url')).toThrow(McpBridgeUrlError);
  });
});

describe('forwardJsonRpc', () => {
  it('POSTs the body with the Accept headers the daemon expects', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 }));
    const result = await forwardJsonRpc('http://127.0.0.1:9/mcp', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.body).toContain('"id":1');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init?.headers as Record<string, string>).Accept).toContain('application/json');
  });

  it('returns null body for empty upstream responses (notification acks)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const result = await forwardJsonRpc('http://127.0.0.1:9/mcp', '{"jsonrpc":"2.0","method":"notifications/initialized"}', fetchImpl as unknown as typeof fetch);
    expect(result.body).toBeNull();
    expect(result.ok).toBe(true);
  });
});

describe('runMcpBridge', () => {
  it('forwards a tools/list line and writes the response to stdout', async () => {
    const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n';
    const responseBody = '{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"query_graph"}]}}';
    const fetchImpl = vi.fn(async () => new Response(responseBody, { status: 200 }));

    const stdin = Readable.from([request]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (c) => chunks.push(Buffer.from(c)));

    await runMcpBridge('http://127.0.0.1:7077/mcp/g/tok/merged', {
      stdin,
      stdout,
      stderr,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = Buffer.concat(chunks).toString('utf8');
    expect(out).toBe(responseBody + '\n');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('synthesizes a JSON-RPC error when the daemon is unreachable', async () => {
    const request = '{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n';
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    const stdin = Readable.from([request]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    stdout.on('data', (c) => outChunks.push(Buffer.from(c)));
    stderr.on('data', (c) => errChunks.push(Buffer.from(c)));

    await runMcpBridge('http://127.0.0.1:9/mcp', {
      stdin,
      stdout,
      stderr,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = JSON.parse(Buffer.concat(outChunks).toString('utf8').trim());
    expect(out).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32000 } });
    expect(out.error.message).toContain('fetch failed');
    expect(Buffer.concat(errChunks).toString('utf8')).toContain('fetch failed');
  });

  it('writes nothing for an empty 202 notification ack', async () => {
    const request = '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));

    const stdin = Readable.from([request]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (c) => chunks.push(Buffer.from(c)));

    await runMcpBridge('http://127.0.0.1:7077/mcp/g/tok/merged', {
      stdin,
      stdout,
      stderr,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(Buffer.concat(chunks).toString('utf8')).toBe('');
  });
});
