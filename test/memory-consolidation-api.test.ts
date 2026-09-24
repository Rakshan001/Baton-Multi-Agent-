// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `GET/POST /api/memory/consolidation` — the route the Settings screen needs.
 *
 * The dashboard toggle for agent-assisted consolidation was built against a
 * route that did not exist, because the plan scoped `memory-settings` to three
 * files under `web/` and the server was not one of them. A switch that cannot
 * reach a daemon is not a setting, so the plan's own acceptance criterion —
 * "a setting enables agent-assisted consolidation" — was unmet until this.
 *
 * Two properties matter more than the shape:
 *
 *  - **It is a paid switch, so it is write-gated.** Turning it on authorises
 *    Baton to launch an agent on the user's account. A read-only daemon must
 *    refuse, the same way every other mutating route does.
 *  - **`enabled` is true only for boolean true.** `resolveDelegateConfig`
 *    already refuses a truthy `"yes"` or a leftover `1`; the route must not
 *    quietly widen that on the way in.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { usePrivateHome } from './helpers/private-home.js';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';
import {
  loadDelegateSetting, saveDelegateSetting, MACHINE_AUTHOR, MACHINE_FACT_PREFIX,
} from '../src/memory/delegate.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
// Port comes from the kernel at spawn time — see test/helpers/free-port.ts.
let API_PORT = 0;

usePrivateHome('baton-consolidation-home-');

describe('the delegate setting persists', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-consolidation-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('is off when nothing has ever been saved', async () => {
    expect((await loadDelegateSetting(root)).enabled).toBe(false);
  });

  it('round-trips an explicit enable', async () => {
    await saveDelegateSetting(root, true);
    expect((await loadDelegateSetting(root)).enabled).toBe(true);
  });

  it('turns back off, so the switch is reversible', async () => {
    await saveDelegateSetting(root, true);
    await saveDelegateSetting(root, false);
    expect((await loadDelegateSetting(root)).enabled).toBe(false);
  });

  it('carries the caps alongside, so the UI can price the decision', async () => {
    const cfg = await loadDelegateSetting(root);
    expect(cfg.maxRunsPerDay).toBeGreaterThan(0);
    expect(cfg.maxUsdPerDay).toBeGreaterThan(0);
  });

  it('reads a hand-edited truthy value as OFF', async () => {
    // The whole point of resolveDelegateConfig's strictness: a leftover `1` or
    // `"true"` in a hand-edited file must not start an agent on an account.
    await saveDelegateSetting(root, true);
    const file = join(root, '.baton', 'memory', 'delegate.json');
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    expect(raw.enabled).toBe(true);
    await rm(file);
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.baton', 'memory'), { recursive: true });
    await writeFile(file, JSON.stringify({ enabled: 'yes' }), 'utf-8');
    expect((await loadDelegateSetting(root)).enabled).toBe(false);
  });

  it('a corrupt file reads as OFF rather than throwing', async () => {
    // Fail closed: an unreadable setting must never be treated as consent.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.baton', 'memory'), { recursive: true });
    await writeFile(join(root, '.baton', 'memory', 'delegate.json'), '{ not json', 'utf-8');
    expect((await loadDelegateSetting(root)).enabled).toBe(false);
  });
});

/**
 * The route, against a REAL daemon started with `--write`.
 *
 * Two things this pins that the unit tests above structurally cannot:
 *
 *  - **Enabling the switch launches nothing.** Nothing in Baton calls
 *    `runDelegatePass`, and no caller applies a `ProposeOp`. The POST is a
 *    stored preference and a validation path, and the payload has to say so —
 *    a switch that reads "authorises Baton to launch a coding agent" while no
 *    such wiring exists is the documentation lying about behaviour, and the
 *    lie is on the one screen where someone decides to spend money.
 *  - **`generator` is provenance or it is nothing.** `parseFactFile` keeps no
 *    record of which agent produced a fact, so the field must be `null` rather
 *    than `author` — which is the constant `baton-machine` for every machine
 *    fact and therefore attributes nothing to anything.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
describe.runIf(existsSync(DIST_CLI))('GET/POST /api/memory/consolidation', () => {
  let base = '';
  let repo = '';
  const children: ResultPromise[] = [];
  // A getter, not a constant: API_PORT is not known until beforeAll runs.
  const url = () => `http://127.0.0.1:${API_PORT}/api/memory/consolidation`;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-consolidation-api-'));
    repo = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', repo]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

    // A machine-generated fact, written straight into the store: the only way
    // one could ever get there today is by hand, which is the finding.
    const facts = join(repo, 'baton', 'memory', 'facts');
    await mkdir(facts, { recursive: true });
    await writeFile(join(facts, 'mc-deadbeef0001.md'), [
      '---',
      'id: mc-deadbeef0001',
      'type: reference',
      'agent: null',
      `author: ${MACHINE_AUTHOR}`,
      'task: null',
      "created: '2026-09-01T00:00:00.000Z'",
      'commit: null',
      'files: []',
      'supersedes: null',
      'fingerprint: machine-consolidated-fixture',
      '---',
      '',
      `${MACHINE_FACT_PREFIX} the daemon binds to 127.0.0.1 by default`,
      '',
    ].join('\n'), 'utf-8');

    API_PORT = await freePort();
    const child = execa('node', [DIST_CLI, 'serve', '--port', String(API_PORT), '--write'], {
      cwd: repo,
      reject: false,
      env: { ...process.env, HOME: join(base, 'home'), BATON_DAEMONS_DIR: join(base, 'registry') },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${API_PORT}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c.catch(() => undefined)));
    await rm(base, { recursive: true, force: true });
  });

  const get = async (): Promise<any> => {
    const r = await fetch(url());
    expect(r.status).toBe(200);
    return r.json();
  };
  const post = async (enabled: unknown): Promise<any> => {
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    expect(r.status).toBe(200);
    return r.json();
  };

  it('says, in the payload, why no agent pass can have run', async () => {
    // The claim the dashboard renders has to come from the daemon, not from a
    // hopeful comment. `produced` can only ever be empty while nothing calls
    // runDelegatePass, and the payload must state that rather than leaving an
    // empty array to be read as "the pass ran and merged nothing".
    const body = await get();
    expect(typeof body.delegate.noPassReason).toBe('string');
    expect(body.delegate.noPassReason.length).toBeGreaterThan(0);
    expect(body.delegate.lastRun).toBe(null);
    expect(body.delegate.runsInWindow).toBe(0);
  });

  it('turning it ON stores consent and starts nothing', async () => {
    const body = await post(true);
    expect(body.delegate.config.enabled).toBe(true);
    // The reason does not go away when the switch goes on: consent is stored,
    // and there is still no wiring that would spend it.
    expect(typeof body.delegate.noPassReason).toBe('string');
    // The ledger is written by `runDelegatePass` and by nothing else, so its
    // absence is proof no agent was launched — the assertion that actually
    // guards the user's money.
    expect(existsSync(join(repo, '.baton', 'memory-delegate.jsonl'))).toBe(false);
    // Same claim from the other side: a run would be reported here.
    expect(body.delegate.lastRun).toBe(null);
    expect(body.delegate.runsInWindow).toBe(0);
  });

  it('honours a truthy-but-not-true `enabled` as OFF, over the wire too', async () => {
    expect((await post('yes')).delegate.config.enabled).toBe(false);
    expect((await post(1)).delegate.config.enabled).toBe(false);
  });

  it('reports a produced fact with NO generator, because none was recorded', async () => {
    // `author` is the constant `baton-machine` for every machine fact, so
    // reporting it as `generator` attributes the sentence to nothing while
    // looking like attribution. Provenance is absent, and must say so.
    const body = await post(false);
    const produced = body.delegate.produced.find((f: any) => f.id === 'mc-deadbeef0001');
    expect(produced, 'the seeded machine fact was not reported').toBeTruthy();
    expect(produced.generator).toBe(null);
    expect(produced.generator).not.toBe(MACHINE_AUTHOR);
  });
});
