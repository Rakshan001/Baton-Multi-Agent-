// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dashboard's SSE frame parser.
 *
 * This code only exists because EventSource cannot send an Authorization
 * header, so a browser reaching Baton over `--host` has to read the event
 * stream with fetch() and do the framing itself. Hand-rolled parsing of a wire
 * format is exactly the thing that works on the happy path and then loses an
 * event the first time a chunk boundary lands somewhere awkward — and a
 * dropped `claim.conflict` is a collision nobody is told about.
 *
 * The parser is pure, so it is tested here rather than through a browser.
 */
import { describe, it, expect } from 'vitest';
import { parseFrame } from '../web/src/lib/sse';

describe('parseFrame', () => {
  it('reads the shape the daemon actually writes (src/server.ts handleEvents)', () => {
    const frame = parseFrame('id: 42\nevent: claim.conflict\ndata: {"type":"claim.conflict","relPath":"src/a.ts"}');
    expect(frame).toEqual({
      id: '42',
      event: 'claim.conflict',
      data: '{"type":"claim.conflict","relPath":"src/a.ts"}',
    });
    expect(JSON.parse(frame!.data).relPath).toBe('src/a.ts');
  });

  /*
   * The keep-alive. The daemon sends `: ping` every 25 s to hold the connection
   * open through Cloudflare's ~100 s idle timeout. Treating it as an event would
   * fire a refetch of the whole dashboard every 25 seconds, forever.
   */
  it('returns null for a comment-only frame', () => {
    expect(parseFrame(': ping')).toBeNull();
    expect(parseFrame(': connected')).toBeNull();
    expect(parseFrame('')).toBeNull();
  });

  it('strips exactly one leading space after the colon, never more', () => {
    // A second space is DATA. Trimming it would corrupt any payload that starts
    // with whitespace and silently change what the daemon said.
    expect(parseFrame('data:  two spaces')!.data).toBe(' two spaces');
    expect(parseFrame('data:no space')!.data).toBe('no space');
  });

  it('joins multi-line data with newlines, as the spec requires', () => {
    expect(parseFrame('event: x\ndata: line one\ndata: line two')!.data).toBe('line one\nline two');
  });

  it('defaults the event name to "message" when the field is absent', () => {
    expect(parseFrame('data: hi')!.event).toBe('message');
  });

  it('handles CRLF line endings', () => {
    expect(parseFrame('id: 7\r\nevent: task.created\r\ndata: {}')).toEqual({
      id: '7', event: 'task.created', data: '{}',
    });
  });

  it('ignores fields it does not implement rather than choking', () => {
    // `retry` is deliberately unimplemented: the reconnect cadence is the
    // client's, so a server-suggested one must be ignored, not obeyed.
    const frame = parseFrame('retry: 5000\nevent: kb.rebuilt\ndata: {}');
    expect(frame).toEqual({ event: 'kb.rebuilt', data: '{}' });
  });

  it('does not invent an id when the daemon sent none', () => {
    // `id` drives Last-Event-ID on reconnect. A fabricated one would ask the
    // daemon to replay from a position that never existed.
    expect(parseFrame('event: x\ndata: {}')).not.toHaveProperty('id');
  });

  it('survives a field with no colon at all', () => {
    expect(parseFrame('data')).toEqual({ event: 'message', data: '' });
  });
});
