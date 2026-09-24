// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { codexSessions, parseCodexRollout } from '../src/usage/codex.js';
import type { Task } from '../src/store.js';

/**
 * Codex rollout parsing, against COMMITTED fixtures under
 * test/fixtures/usage/codex — never the developer's own ~/.codex, so the test
 * means the same thing on every machine.
 *
 * The bug these fixtures exist to catch: a rollout carries BOTH the per-call
 * `last_token_usage` and a running `total_token_usage`. Adding both double
 * counts every session. Fixture 1's two events are built so a double count is
 * visible — the honest answer is 3400 total tokens, the double-counted one is
 * 6800.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const dir = join(here, 'fixtures/usage/codex/sessions');

const root = '/fixture/repo';
const tasks = [
  { slug: 'fix-a', worktreePath: '/fixture/repo/.baton/worktrees/fix-a' },
  { slug: 'fix-b', worktreePath: '/fixture/repo/.baton/worktrees/fix-b' },
] as Task[];

const rollout = (rel: string) => join(dir, rel);

describe('parseCodexRollout', () => {
  it('reads the per-call figures and never adds the running total on top', async () => {
    const u = await parseCodexRollout(
      rollout('2026/07/03/rollout-2026-07-03T16-53-18-0aaaaaaa-0000-4000-8000-000000000001.jsonl'),
    );
    expect(u.agent).toBe('codex');
    expect(u.sessionId).toBe('0aaaaaaa-0000-4000-8000-000000000001');
    expect(u.cwd).toBe('/fixture/repo');
    expect(u.model).toBe('gpt-5.5');
    expect(u.turns).toBe(2);
    // input_tokens INCLUDES cached_input_tokens in this format; the split is
    // (1000-400)+(2000-1500) uncached and 400+1500 cached.
    expect(u.inputTokens).toBe(1100);
    expect(u.cacheReadTokens).toBe(1900);
    expect(u.outputTokens).toBe(400);
    expect(u.totalTokens).toBe(3400);
    expect(u.firstAt).toBe('2026-07-03T11:23:36.038Z');
    expect(u.lastAt).toBe('2026-07-03T11:24:13.000Z');
  });

  it('leaves cache writes absent when the format did not report them', async () => {
    const old = await parseCodexRollout(
      rollout('2026/07/03/rollout-2026-07-03T16-53-18-0aaaaaaa-0000-4000-8000-000000000001.jsonl'),
    );
    expect(old.cacheWriteTokens).toBeNull();
    const recent = await parseCodexRollout(
      rollout('2026/07/03/rollout-2026-07-03T18-00-00-0bbbbbbb-0000-4000-8000-000000000002.jsonl'),
    );
    expect(recent.cacheWriteTokens).toBe(64);
  });

  it('skips a truncated final line instead of throwing', async () => {
    const u = await parseCodexRollout(
      rollout('2026/07/03/rollout-2026-07-03T18-00-00-0bbbbbbb-0000-4000-8000-000000000002.jsonl'),
    );
    expect(u.turns).toBe(1);
    expect(u.inputTokens).toBe(400);
    expect(u.cacheReadTokens).toBe(100);
    expect(u.outputTokens).toBe(25);
    expect(u.totalTokens).toBe(525);
  });

  it('gives no cost for an OpenAI model rather than pricing it as Claude', async () => {
    const u = await parseCodexRollout(
      rollout('2026/07/03/rollout-2026-07-03T16-53-18-0aaaaaaa-0000-4000-8000-000000000001.jsonl'),
    );
    expect(u.estCostUsd).toBeNull();
  });
});

describe('codexSessions', () => {
  it('maps each session to its task worktree, or to the repo itself', async () => {
    const sessions = await codexSessions(root, tasks, dir);
    const bySlug = Object.fromEntries(sessions.map((s) => [s.sessionId.slice(0, 8), s.slug]));
    expect(bySlug['0aaaaaaa']).toBeNull();
    expect(bySlug['0bbbbbbb']).toBe('fix-a');
    expect(sessions.every((s) => s.agent === 'codex')).toBe(true);
  });

  /**
   * The rollout's own `session_meta.cwd` is where the session ran — a recorded
   * fact, not a deduction. Marking it keeps it apart from Antigravity's
   * inferred placement in the same table.
   */
  it('marks its attribution as measured — the rollout records the cwd', async () => {
    const sessions = await codexSessions(root, tasks, dir);
    expect(sessions.every((s) => s.attribution === 'measured')).toBe(true);
  });

  it('leaves another project’s sessions out of this repo’s spend', async () => {
    const sessions = await codexSessions(root, tasks, dir);
    const ids = sessions.map((s) => s.sessionId.slice(0, 8)).sort();
    // 0cccccccc ran in /other/project; 0ddddddd has no session_meta cwd at all.
    expect(ids).toEqual(['0aaaaaaa', '0bbbbbbb']);
  });

  it('ignores files that are not rollouts', async () => {
    const sessions = await codexSessions(root, tasks, dir);
    expect(sessions.length).toBe(2);
  });

  it('yields nothing and no error when the sessions directory is missing', async () => {
    await expect(codexSessions(root, tasks, join(here, 'fixtures/usage/codex/nope'))).resolves.toEqual([]);
  });

  it('yields nothing for an empty sessions directory', async () => {
    await expect(codexSessions(root, tasks, join(here, 'fixtures/usage/codex/empty/sessions'))).resolves.toEqual([]);
  });
});

describe('the parser streams', () => {
  it('parses a real transcript without ever reading one whole', async () => {
    // The guard below is file-wide, so EVERY fixture-driven test above is also
    // a proof of this. This one states the property outright so it is not
    // carried only by a side effect.
    const out = await codexSessions(root, tasks, dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => (s.totalTokens ?? 0) > 0 || s.turns > 0)).toBe(true);
  });
});

/**
 * A transcript must be STREAMED, never pulled into memory whole.
 *
 * This replaces an assertion that read this module's own source and looked for
 * the string `createReadStream`. That tested prose, not behaviour: an import
 * that is never called satisfied it, and a correct rewrite via `fs.open()`
 * would have failed it.
 *
 * The honest, deterministic proxy is WHICH fs API touches the transcript.
 * Measuring peak memory in-process is not viable — heap deltas are
 * GC-nondeterministic and the fixture would have to be tens of megabytes.
 *
 * Both whole-file reads are guarded, and ONLY for paths inside the fixture
 * tree: `readdir` (discovery) and `createReadStream` (parsing) stay real, and
 * every unrelated `readFileSync` a library makes during the run is passed
 * straight through. So this fails if — and only if — the parser starts reading
 * a transcript whole, by either API.
 */
/*
 * Function declarations, deliberately, not `const`. Vitest hoists `vi.mock`
 * above this file's imports, and a factory runs during the IMPORT phase — the
 * first time a module under test pulls in `node:fs` — which is before any
 * `const` here has been initialised. As arrow consts these were a latent TDZ
 * `ReferenceError` that would surface as an unrelated import failure. Hoisted
 * declarations are initialised before any of it runs.
 */
function wholeRead(): string { return 'a transcript must be streamed, never read whole'; }
function isTranscript(p: unknown): boolean { return String(p).includes(`fixtures${sep}usage${sep}`); }
const WHOLE_READ = wholeRead();

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (p: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (isTranscript(p)) throw new Error(wholeRead());
      return (actual.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (isTranscript(p)) throw new Error(wholeRead());
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});
