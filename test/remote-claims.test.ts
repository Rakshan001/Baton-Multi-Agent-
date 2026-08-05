/**
 * The bridge that carries federated claims to AGENTS (check_files), not just to
 * the dashboard.
 *
 * The property under test above all others: **"I could not ask the host" must
 * never be reported as "nobody else is there."** That is the same invariant the
 * memory plane rests on — a stale fact is withheld rather than served as fresh —
 * and it matters most here, because an unreachable host is exactly when a
 * confident "not busy" would be most wrong and most costly.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { saveHostLink } from '../src/host-link.js';
import {
  remoteClaims, remoteHoldersFor, remoteNote, resetRemoteClaimsCache,
} from '../src/remote-claims.js';

let root: string;
let server: Server | null = null;
let port = 0;
let hits = 0;
let lastAuth = '';

const listen = (handler: () => { status: number; json: unknown }): Promise<void> =>
  new Promise((resolve) => {
    server = createServer((req, res) => {
      hits++;
      lastAuth = req.headers.authorization ?? '';
      const { status, json } = handler();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port;
      resolve();
    });
  });

const claim = (over: Record<string, unknown> = {}) => ({
  projectId: null, relPath: 'src/a.ts', memberId: 'priya', memberName: 'Priya',
  agent: 'claude', branch: 'main', openedAt: '2026-07-30T12:00:00.000Z',
  refreshedAt: '2026-07-30T12:05:00.000Z', ...over,
});

beforeEach(async () => {
  resetRemoteClaimsCache();
  hits = 0;
  root = await mkdtemp(join(tmpdir(), 'baton-remote-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  await rm(root, { recursive: true, force: true });
});

describe('no host link', () => {
  /*
   * The overwhelmingly common case. A solo machine must behave exactly as it
   * always has — no network call, and nothing new in the answer.
   */
  it('makes no network call and reports itself unlinked', async () => {
    const view = await remoteClaims(root);
    expect(view).toEqual({ linked: false, reachable: false, byPath: {} });
    expect(remoteNote(view)).toBeNull();
  });
});

describe('reachable host', () => {
  it('maps claims by path and sends the token as a bearer header', async () => {
    await listen(() => ({ status: 200, json: { claims: [claim(), claim({ relPath: 'src/b.ts', memberId: 'sam', memberName: 'Sam' })] } }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_secret' });

    const view = await remoteClaims(root);
    expect(view.linked).toBe(true);
    expect(view.reachable).toBe(true);
    expect(lastAuth).toBe('Bearer baton_secret');
    expect(view.byPath['src/a.ts'][0]).toMatchObject({ memberId: 'priya', memberName: 'Priya', branch: 'main' });
    expect(remoteNote(view)).toBeNull();
  });

  it('drops malformed claims instead of inventing holders', async () => {
    await listen(() => ({ status: 200, json: { claims: [claim(), { relPath: '' }, { memberId: 'x' }, null] } }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    const view = await remoteClaims(root);
    expect(Object.keys(view.byPath)).toEqual(['src/a.ts']);
  });

  it('survives a teammate whose file is named __proto__ or constructor', async () => {
    /*
     * `{}` inherits from Object.prototype, so `byPath['__proto__'] ??= []`
     * found a truthy inherited object, skipped the assignment, and threw on
     * .push — and the catch reported the whole HOST unreachable, every 10s for
     * the claim's TTL. One teammate's file name silently blinded everyone
     * else's check_files. `constructor` needed no host at all: the read side
     * reached a function's .filter.
     *
     * Both are legal file names, so the fix is not to reject them: the map is
     * what must be inert.
     */
    await listen(() => ({
      status: 200,
      json: { claims: [claim({ relPath: '__proto__' }), claim({ relPath: 'constructor', memberId: 'sam' })] },
    }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });

    const view = await remoteClaims(root);
    expect(view.reachable).toBe(true); // NOT reported as an unreachable host
    expect(view.byPath['__proto__']).toHaveLength(1);

    // The read side must not reach an inherited member either.
    expect(remoteHoldersFor(view, ['constructor'])['constructor']).toHaveLength(1);
    expect(remoteHoldersFor(view, ['toString', 'hasOwnProperty'])).toEqual({});
  });
});

describe('unreachable host', () => {
  /*
   * THE test. An empty `byPath` alongside `reachable: false` must be readable
   * as "unknown", never as "clear" — so the flag is what callers branch on.
   */
  it('reports unknown, not empty — and says so in words', async () => {
    await saveHostLink(root, { url: 'http://127.0.0.1:1', token: 'baton_t' });
    const view = await remoteClaims(root);
    expect(view.linked).toBe(true);
    expect(view.reachable).toBe(false);
    expect(view.byPath).toEqual({});
    expect(remoteNote(view)).toMatch(/unavailable/);
  });

  it('names a revoked token as the cause rather than a generic failure', async () => {
    await listen(() => ({ status: 401, json: { error: 'nope' } }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    const view = await remoteClaims(root);
    expect(view.reachable).toBe(false);
    expect(remoteNote(view)).toMatch(/revoked/);
  });

  it('never throws on a server error or garbage body', async () => {
    await listen(() => ({ status: 500, json: {} }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    expect((await remoteClaims(root)).reachable).toBe(false);
  });
});

describe('caching', () => {
  it('reuses one answer across rapid calls', async () => {
    await listen(() => ({ status: 200, json: { claims: [claim()] } }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    const t = Date.now();
    await remoteClaims(root, t);
    await remoteClaims(root, t + 1000);
    await remoteClaims(root, t + 9000);
    expect(hits).toBe(1);
    await remoteClaims(root, t + 11_000);
    expect(hits).toBe(2);
  });

  /*
   * Failures are cached too, deliberately. Without this a dead host costs every
   * single check_files call a full timeout, and the tool agents are told to call
   * before every edit becomes the slowest thing they do — which is how a safety
   * check gets skipped.
   */
  it('caches failures too, so a dead host does not tax every call', async () => {
    await saveHostLink(root, { url: 'http://127.0.0.1:1', token: 'baton_t' });
    const t = Date.now();
    const a = await remoteClaims(root, t);
    const b = await remoteClaims(root, t + 500);
    expect(a).toBe(b); // same object — no second attempt
  });
});

describe('remoteHoldersFor', () => {
  const view = {
    linked: true, reachable: true,
    byPath: {
      'src/a.ts': [
        { memberId: 'priya', memberName: 'Priya', agent: 'claude', branch: 'main', projectId: null, since: 'x' },
        { memberId: 'me', memberName: 'Me', agent: 'cursor', branch: 'main', projectId: null, since: 'x' },
      ],
    },
  };

  it('returns only paths that are actually held', () => {
    expect(Object.keys(remoteHoldersFor(view, ['src/a.ts', 'src/unheld.ts']))).toEqual(['src/a.ts']);
  });

  it('excludes the asker — their own claim is not a reason to wait', () => {
    const out = remoteHoldersFor(view, ['src/a.ts'], 'me');
    expect(out['src/a.ts'].map((h) => h.memberId)).toEqual(['priya']);
  });

  it('drops the path entirely when the asker was the only holder', () => {
    const solo = { ...view, byPath: { 'src/a.ts': [view.byPath['src/a.ts'][1]] } };
    expect(remoteHoldersFor(solo, ['src/a.ts'], 'me')).toEqual({});
  });

  /*
   * A claim is (projectId, relPath) on the host — but the local side used to
   * key it on the path alone, so a teammate holding proj-b's `src/index.ts` was
   * reported to an agent working in proj-a as a hold on THEIR file.
   */
  describe('project scoping in a hub', () => {
    const hub = {
      linked: true, reachable: true,
      byPath: {
        'src/index.ts': [
          { memberId: 'priya', memberName: 'Priya', agent: 'claude', branch: 'main', projectId: 'proj-b', since: 'x' },
          { memberId: 'sam', memberName: 'Sam', agent: 'codex', branch: 'main', projectId: 'proj-a', since: 'x' },
        ],
      },
    };

    it('reports only holders in the asker\'s project', () => {
      expect(remoteHoldersFor(hub, ['src/index.ts'], undefined, 'proj-a')[
        'src/index.ts'
      ].map((h) => h.memberId)).toEqual(['sam']);
    });

    it('drops the path when every holder is in another project', () => {
      const onlyB = { ...hub, byPath: { 'src/index.ts': [hub.byPath['src/index.ts'][0]] } };
      expect(remoteHoldersFor(onlyB, ['src/index.ts'], undefined, 'proj-a')).toEqual({});
    });

    it('an asker with no project sees everyone — unknown must not silently hide a holder', () => {
      expect(remoteHoldersFor(hub, ['src/index.ts'], undefined, null)['src/index.ts']).toHaveLength(2);
    });

    it('keeps a holder whose project is unknown, whoever asks', () => {
      expect(remoteHoldersFor(view, ['src/a.ts'], 'me', 'proj-a')['src/a.ts'].map((h) => h.memberId))
        .toEqual(['priya']);
    });
  });
});

describe('self-exclusion', () => {
  /*
   * We publish our claims to the host every 30 s and read the pooled picture
   * straight back. Without dropping our own, every file OUR agents are editing
   * would be reported to them as "a teammate is on this" — the tool would
   * manufacture the exact conflict it exists to prevent.
   */
  it("drops this machine's own claims, identified by the host from our token", async () => {
    await listen(() => ({
      status: 200,
      json: {
        you: { memberId: 'sam' },
        claims: [
          claim({ relPath: 'mine.ts', memberId: 'sam', memberName: 'Sam' }),
          claim({ relPath: 'theirs.ts', memberId: 'priya', memberName: 'Priya' }),
        ],
      },
    }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    const view = await remoteClaims(root);
    expect(Object.keys(view.byPath)).toEqual(['theirs.ts']);
  });

  /*
   * A host that does not say who we are (older daemon) must not cause us to
   * silently drop a real teammate's claim — so with no `you`, nothing is
   * filtered. Over-reporting is recoverable; under-reporting is a collision.
   */
  it('filters nothing when the host does not identify us', async () => {
    await listen(() => ({ status: 200, json: { claims: [claim({ relPath: 'x.ts', memberId: 'sam' })] } }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    expect(Object.keys((await remoteClaims(root)).byPath)).toEqual(['x.ts']);
  });
});

describe('loopback host link', () => {
  /*
   * A daemon linked to a host on the SAME machine never gets its token checked
   * (loopback needs no credential), so the host files it under `local` and
   * answers `you.memberId: null`. Treating that as "unknown identity" would
   * make it read every one of its own claims back as a teammate's — the exact
   * failure this feature exists to prevent, inverted.
   */
  it('recognises itself as `local` when the host answers with a null id', async () => {
    await listen(() => ({
      status: 200,
      json: {
        you: { memberId: null },
        claims: [
          claim({ relPath: 'mine.ts', memberId: 'local', memberName: 'this machine' }),
          claim({ relPath: 'theirs.ts', memberId: 'priya', memberName: 'Priya' }),
        ],
      },
    }));
    await saveHostLink(root, { url: `http://127.0.0.1:${port}`, token: 'baton_t' });
    expect(Object.keys((await remoteClaims(root)).byPath)).toEqual(['theirs.ts']);
  });
});
