import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import {
  clearHostLink, hostLinkPath, isValidHostUrl, loadHostLink, normalizeHostUrl,
  saveHostLink, sendHeartbeat, HostLinkError,
} from '../src/host-link.js';

/**
 * The member half of the live plane. The file holds a live token, so the
 * important properties are that it is written 0600, that a URL carrying
 * credentials is refused, and that an unreachable host degrades quietly instead
 * of disturbing anything running locally.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-hostlink-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('isValidHostUrl', () => {
  it('accepts plain http/https hosts', () => {
    expect(isValidHostUrl('http://mac-mini.local:7077')).toBe(true);
    expect(isValidHostUrl('https://hub.example.com')).toBe(true);
    expect(isValidHostUrl('http://192.168.1.4:7077')).toBe(true);
  });

  /*
   * A userinfo segment would put a live secret into every log line and error
   * message that echoes the URL. The token belongs in the Authorization header,
   * which is the one place it is not casually copied around.
   */
  it('refuses a URL carrying credentials', () => {
    expect(isValidHostUrl('http://user:tok@host:7077')).toBe(false);
    expect(isValidHostUrl('http://user@host:7077')).toBe(false);
  });

  it('refuses non-http schemes and nonsense', () => {
    expect(isValidHostUrl('file:///etc/passwd')).toBe(false);
    expect(isValidHostUrl('ftp://host')).toBe(false);
    expect(isValidHostUrl('not a url')).toBe(false);
    expect(isValidHostUrl('')).toBe(false);
  });

  it('normalizes away trailing slashes so URLs concatenate cleanly', () => {
    expect(normalizeHostUrl('http://h:7077///')).toBe('http://h:7077');
  });
});

describe('saveHostLink / loadHostLink', () => {
  it('round-trips and stores the file 0600', async () => {
    await saveHostLink(root, { url: 'http://h:7077/', token: 'baton_abc', device: 'laptop' });
    const mode = (await stat(hostLinkPath(root))).mode & 0o777;
    expect(mode).toBe(0o600);

    const link = await loadHostLink(root);
    expect(link).toMatchObject({ url: 'http://h:7077', token: 'baton_abc', device: 'laptop' });
  });

  it('refuses to save a bad URL or an empty token', async () => {
    await expect(saveHostLink(root, { url: 'nope', token: 't' })).rejects.toBeInstanceOf(HostLinkError);
    await expect(saveHostLink(root, { url: 'http://h', token: '  ' })).rejects.toBeInstanceOf(HostLinkError);
  });

  // Absent or corrupt must mean "not linked", never a half-configured state.
  it('reads absent, corrupt, or incomplete config as not linked', async () => {
    expect(await loadHostLink(root)).toBeNull();
    await writeFile(hostLinkPath(root), 'not json', 'utf-8');
    expect(await loadHostLink(root)).toBeNull();
    await writeFile(hostLinkPath(root), JSON.stringify({ url: 'http://h' }), 'utf-8');
    expect(await loadHostLink(root)).toBeNull();
    await writeFile(hostLinkPath(root), JSON.stringify({ url: 'http://u:p@h', token: 't' }), 'utf-8');
    expect(await loadHostLink(root)).toBeNull();
  });

  it('clearHostLink removes it and is safe to repeat', async () => {
    await saveHostLink(root, { url: 'http://h:7077', token: 'baton_abc' });
    expect(await clearHostLink(root)).toBe(true);
    expect(existsSync(hostLinkPath(root))).toBe(false);
    expect(await clearHostLink(root)).toBe(false);
  });
});

describe('sendHeartbeat', () => {
  let server: Server | null = null;
  let port = 0;
  let lastAuth = '';
  let lastBody = '';

  const listen = (handler: (body: string) => { status: number; json: unknown }): Promise<void> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        lastAuth = req.headers.authorization ?? '';
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          lastBody = raw;
          const { status, json } = handler(raw);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server!.address() as { port: number }).port;
        resolve();
      });
    });

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = null;
  });

  it('sends the token as a bearer header, never in the URL or body', async () => {
    await listen(() => ({ status: 200, json: { members: [], claims: [], overlaps: [] } }));
    const r = await sendHeartbeat(
      { url: `http://127.0.0.1:${port}`, token: 'baton_secret' },
      { claims: [{ projectId: null, relPath: 'a.ts', agent: 'claude', branch: 'main' }] },
    );
    expect(r.ok).toBe(true);
    expect(lastAuth).toBe('Bearer baton_secret');
    expect(lastBody).not.toContain('baton_secret');
    expect(JSON.parse(lastBody).claims[0].relPath).toBe('a.ts');
  });

  it('reports a revoked token distinctly, so the cause is obvious', async () => {
    await listen(() => ({ status: 401, json: { error: 'nope' } }));
    const r = await sendHeartbeat({ url: `http://127.0.0.1:${port}`, token: 'baton_x' }, { claims: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/revoked/);
  });

  /*
   * An unreachable host is routine — laptop asleep, tunnel down — so it must
   * never throw into whatever the daemon was doing.
   */
  it('never throws when the host is unreachable', async () => {
    const r = await sendHeartbeat({ url: 'http://127.0.0.1:1', token: 'baton_x' }, { claims: [] }, 500);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('never throws on a non-2xx or a garbage response', async () => {
    await listen(() => ({ status: 500, json: {} }));
    expect((await sendHeartbeat({ url: `http://127.0.0.1:${port}`, token: 't' }, { claims: [] })).ok).toBe(false);
  });
});
