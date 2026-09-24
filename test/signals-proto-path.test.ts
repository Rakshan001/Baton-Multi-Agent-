// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `checkFiles` must answer about every path it was asked about.
 *
 * The answer map is keyed by CALLER-SUPPLIED file paths, and it was built as a
 * plain `{}`. On a plain object `result['__proto__'] = …` does not create a
 * key — it invokes the prototype setter — so the entry vanished: measured, a
 * real `check_files({paths:['__proto__']})` over stdio answered
 * `{"watcherActive":false,"files":{}}`. `Object.values(result)` skipped it too,
 * so `enrichWithNotes` never saw it either.
 *
 * A path that silently disappears from the answer is worse here than almost
 * anywhere else in Baton: this tool exists so an agent can ask "is anyone else
 * on this file", and an absent entry is indistinguishable from a clear one. The
 * agent reads "nothing came back about it" as "nobody is editing it" and
 * overwrites another session's work — which is exactly the failure the whole
 * signal mechanism exists to prevent, and the same reason the over-cap paths in
 * `check_files` are named rather than dropped (src/mcp.ts, `notChecked`).
 *
 * `__proto__` is a legal filename. So is `constructor`. Neither is likely, and
 * neither has to be likely: the map has to be inert, exactly as the remote
 * claim map already is (src/remote-claims.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalTracker, checkFiles } from '../src/signals.js';
import { bus } from '../src/events.js';

/** Every name that means something to a plain object but nothing to a filesystem. */
const INHERITED = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

describe('checkFiles — a path named like an Object key is still a path', () => {
  let root: string;
  let tracker: SignalTracker;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-protopath-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    tracker = new SignalTracker(root);
    tracker.start();
  });
  afterEach(async () => {
    tracker.stop();
    await rm(root, { recursive: true, force: true });
  });

  const edit = (slug: string, path: string) =>
    bus.publish({ type: 'file.edited', slug, path, at: new Date().toISOString() });

  it('answers about every path it was asked about, whatever it is called', async () => {
    const res = await checkFiles(root, INHERITED);
    // Own keys only — this is what `JSON.stringify` will actually serve, and it
    // is where the entry went missing.
    expect(Object.keys(res).sort()).toEqual([...INHERITED].sort());
    for (const p of INHERITED) expect(res[p], `no answer for '${p}'`).toEqual({ busy: false, by: [] });
  });

  it('survives the round trip an agent actually reads — JSON, not the object', async () => {
    const wire = JSON.parse(JSON.stringify(await checkFiles(root, INHERITED))) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual([...INHERITED].sort());
  });

  /** The consequence, stated as the thing that matters: a real holder on a
   *  path named `__proto__` must not read back as an unheld file. */
  it('reports another session holding a path named __proto__ as busy', async () => {
    edit('other', '__proto__');
    const res = await checkFiles(root, ['__proto__'], 'me');
    expect(res['__proto__']?.busy, '__proto__ came back clear while another session held it').toBe(true);
    expect(res['__proto__']?.by.map((h) => h.slug)).toEqual(['other']);
  });

  it('does not let such a path corrupt the answers around it', async () => {
    edit('other', 'src/real.ts');
    const res = await checkFiles(root, ['__proto__', 'src/real.ts', 'constructor'], 'me');
    expect(res['src/real.ts']?.busy).toBe(true);
    expect(res['__proto__']?.busy).toBe(false);
    expect(res['constructor']?.busy).toBe(false);
  });

  /** Nothing here may reach the real Object.prototype — the map is the only
   *  thing being made inert, and a leak would be the actual pollution bug. */
  it('leaves Object.prototype alone', async () => {
    await checkFiles(root, ['__proto__', 'constructor', 'toString']);
    expect(Object.prototype).not.toHaveProperty('busy');
    expect(({} as Record<string, unknown>).busy).toBeUndefined();
  });
});
