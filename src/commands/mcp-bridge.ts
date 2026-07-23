/**
 * `baton mcp-bridge <url>` — thin stdio↔HTTP bridge so Codex (TOML MCP config
 * only supports command+args, not url) can query the daemon's shared graphify
 * pool at `/mcp/g/<token>/<id>`.
 *
 * Framing matches the MCP SDK's StdioServerTransport: one JSON-RPC message per
 * newline. Each line is POSTed verbatim to `<url>`; the response body (if any)
 * is written back to stdout with a trailing newline. Empty bodies (HTTP 202
 * notification acks) produce no stdout line.
 *
 * Requires `baton serve` — same dependency Claude/Cursor/Gemini already have
 * for graph queries.
 */
import { Readable, Writable } from 'node:stream';

const POST_TIMEOUT_MS = 30_000;

export class McpBridgeUrlError extends Error {
  constructor(url: string) {
    super(`mcp-bridge: invalid url '${url}' — expected an http(s) URL to the daemon's /mcp/g/<token>/<id> proxy`);
    this.name = 'McpBridgeUrlError';
  }
}

/** Validate and normalize the daemon proxy URL (must be http/https). */
export function parseBridgeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpBridgeUrlError(raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpBridgeUrlError(raw);
  }
  return parsed.toString();
}

/**
 * POST one JSON-RPC line to the daemon proxy. Returns the response body
 * (without forcing a trailing newline), or null when the upstream returns an
 * empty body (notification ack / 202).
 */
export async function forwardJsonRpc(
  url: string,
  body: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; status: number; body: string | null }> {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, body: text.length > 0 ? text : null };
}

/** Extract a JSON-RPC `id` from a request line so we can synthesize an error. */
function requestId(line: string): string | number | null {
  try {
    const msg = JSON.parse(line) as { id?: unknown };
    if (typeof msg.id === 'string' || typeof msg.id === 'number') return msg.id;
  } catch { /* not JSON — leave id null */ }
  return null;
}

function synthesizeError(id: string | number | null, message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message },
  });
}

/**
 * Run the bridge loop until stdin closes. Exported for unit tests that pass
 * fake streams + a stub fetch.
 */
export async function runMcpBridge(
  url: string,
  opts: {
    stdin?: Readable;
    stdout?: Writable;
    stderr?: Writable;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  let buf = '';
  for await (const chunk of stdin) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;

      try {
        const result = await forwardJsonRpc(url, line, fetchImpl);
        if (result.ok && result.body !== null) {
          const out = result.body.endsWith('\n') ? result.body : result.body + '\n';
          if (!stdout.write(out)) {
            await new Promise<void>((resolve) => stdout.once('drain', resolve));
          }
        } else if (!result.ok) {
          // A FAILING response body is not JSON-RPC and must never reach the
          // client's framer: the daemon answers 403 {"error":"bad token"} on a
          // stale .baton/mcp-token, 502 with plain text for an unknown project,
          // 503, 405, 413. Forwarded verbatim, the framer sees a line that
          // carries no id, so the pending request never resolves — the agent
          // hangs to timeout with nothing on stderr. Synthesize a JSON-RPC
          // error carrying the request's own id, and keep the upstream text as
          // the message so the cause is visible rather than guessed.
          const id = requestId(line);
          const detail = result.body ? `: ${result.body.trim().slice(0, 200)}` : ' (empty body)';
          if (id !== null) {
            const errLine = synthesizeError(id, `daemon returned HTTP ${result.status}${detail}`) + '\n';
            if (!stdout.write(errLine)) {
              await new Promise<void>((resolve) => stdout.once('drain', resolve));
            }
          }
          stderr.write(`mcp-bridge: daemon returned HTTP ${result.status}${detail}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stderr.write(`mcp-bridge: ${message}\n`);
        const id = requestId(line);
        if (id !== null) {
          const errLine = synthesizeError(id, message) + '\n';
          if (!stdout.write(errLine)) {
            await new Promise<void>((resolve) => stdout.once('drain', resolve));
          }
        }
      }
    }
  }
}

/** CLI entry: `baton mcp-bridge <url>`. */
export async function mcpBridgeCmd(urlArg: string): Promise<void> {
  const url = parseBridgeUrl(urlArg);
  await runMcpBridge(url);
}
