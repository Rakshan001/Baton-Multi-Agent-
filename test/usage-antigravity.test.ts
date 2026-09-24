// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { antigravitySessions, parseAntigravityTranscript } from '../src/usage/antigravity.js';
import { aggregate, estimateCostUsd } from '../src/usage.js';
import type { Task } from '../src/store.js';

/**
 * Antigravity transcripts, against COMMITTED fixtures under
 * test/fixtures/usage/antigravity.
 *
 * This format is the honest-gap case: it records steps, timestamps and the
 * paths the agent touched, but no input/output token split and no price. What
 * it cannot say must come back ABSENT — a null the UI can label "not
 * measured" — never a 0 that reads as "this agent cost nothing".
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const brain = join(here, 'fixtures/usage/antigravity/brain');
const transcript = (id: string) => join(brain, id, '.system_generated/logs/transcript.jsonl');

const A = '0aaa1111-0000-4000-8000-000000000001';
const B = '0bbb2222-0000-4000-8000-000000000002';

const root = '/fixture/repo';
const tasks = [{ slug: 'fix-a', worktreePath: '/fixture/repo/.baton/worktrees/fix-a' }] as Task[];

describe('parseAntigravityTranscript', () => {
  it('reports a session with NO numbers, not zeros, when nothing was measured', async () => {
    const u = await parseAntigravityTranscript(transcript(A));
    expect(u.agent).toBe('antigravity');
    expect(u.sessionId).toBe(A);
    expect(u.turns).toBe(2);
    expect(u.inputTokens).toBeNull();
    expect(u.outputTokens).toBeNull();
    expect(u.cacheReadTokens).toBeNull();
    expect(u.cacheWriteTokens).toBeNull();
    expect(u.totalTokens).toBeNull();
    expect(u.estCostUsd).toBeNull();
    expect(u.model).toBeNull();
    expect(u.firstAt).toBe('2026-08-09T09:00:00Z');
    expect(u.lastAt).toBe('2026-08-09T09:00:30Z');
  });

  it('reports a bare tokenCount as a total, with the split and the cost still absent', async () => {
    const u = await parseAntigravityTranscript(transcript(B));
    expect(u.totalTokens).toBe(2000);
    expect(u.inputTokens).toBeNull();
    expect(u.outputTokens).toBeNull();
    expect(u.estCostUsd).toBeNull();
  });

  it('skips a truncated final line instead of throwing', async () => {
    const u = await parseAntigravityTranscript(transcript(B));
    expect(u.turns).toBe(2);
  });

  it('records the paths the session worked in, since the format has no cwd', async () => {
    const u = await parseAntigravityTranscript(transcript(A));
    expect(u.paths).toContain('/fixture/repo/src');
    expect(u.paths).toContain('/fixture/repo/package.json');
  });
});

describe('antigravitySessions', () => {
  it('attributes a session to the repo or the worktree its own tool calls touched', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    const bySlug = Object.fromEntries(sessions.map((s) => [s.sessionId.slice(0, 8), s.slug]));
    expect(bySlug['0aaa1111']).toBeNull();
    expect(bySlug['0bbb2222']).toBe('fix-a');
  });

  it('leaves out sessions that never touched this repo, and ones with no path at all', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    expect(sessions.map((s) => s.sessionId.slice(0, 8)).sort()).toEqual(['0aaa1111', '0bbb2222']);
  });

  it('does not claim a session that merely glanced at one file here', async () => {
    // 0eee5555 worked in /other/project and read a single file in this repo.
    // Counting it as this repo's session would inflate the row count with
    // another project's work — the same lie as a wrong number.
    const sessions = await antigravitySessions(root, tasks, brain);
    expect(sessions.map((s) => s.sessionId.slice(0, 8))).not.toContain('0eee5555');
  });

  /**
   * This format records no session cwd, so placement is a plurality vote over
   * the paths the session's own tool calls touched. That is EVIDENCE, but it is
   * not the same kind of fact as a logged working directory, and the shape has
   * to say so — the dashboard labels these rows, and it can only label what the
   * daemon marks.
   */
  it('marks its attribution as inferred, because it is deduced from paths', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.attribution === 'inferred')).toBe(true);
  });

  it('carries the absent numbers through to the session rows', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    const a = sessions.find((s) => s.sessionId === A)!;
    expect(a.estCostUsd).toBeNull();
    expect(a.inputTokens).toBeNull();
    expect(a.turns).toBeGreaterThan(0);
    expect('paths' in a).toBe(false);
  });

  it('yields nothing and no error when the brain directory is missing', async () => {
    await expect(antigravitySessions(root, tasks, join(here, 'fixtures/usage/antigravity/nope'))).resolves.toEqual([]);
  });

  it('yields nothing when the directory holds no transcripts', async () => {
    await expect(antigravitySessions(root, tasks, join(here, 'fixtures/usage/antigravity'))).resolves.toEqual([]);
  });
});

/**
 * The header's central claim, asserted against the code instead of against the
 * header: this format carries no input/output token split and no price, so
 * those come back ABSENT — and stay absent through the rollup the dashboard
 * and `baton usage` actually read. A 0 surviving to that layer is the lie the
 * whole parser exists to avoid: a spend table showing $0.00 for an agent that
 * plainly did work.
 */
describe('what this format cannot report stays absent all the way to the totals', () => {
  it('rolls up to null input/output/cost, never zero, while the turns it DID record are real', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    const { totals, byAgent } = aggregate(sessions);

    // The format does record steps and timestamps, so this is a real number...
    expect(totals.sessions).toBe(2);
    expect(totals.turns).toBeGreaterThan(0);
    // ...and every number it does not record stays null, not 0.
    for (const t of [totals, byAgent.antigravity]) {
      expect(t.inputTokens).toBeNull();
      expect(t.outputTokens).toBeNull();
      expect(t.cacheReadTokens).toBeNull();
      expect(t.cacheWriteTokens).toBeNull();
      expect(t.estCostUsd).toBeNull();
    }
  });

  it('reports a bare tokenCount as a grand total only — it is never split into input/output', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    const { totals } = aggregate(sessions);
    // Fixture B carries tokenCount 1200 + 800 and nothing else. A total is the
    // only honest thing to say about it; apportioning it would be invention.
    expect(totals.totalTokens).toBe(2000);
    expect(totals.inputTokens).toBeNull();
    expect(totals.outputTokens).toBeNull();
  });

  it('prices nothing, because the format names no model', async () => {
    const sessions = await antigravitySessions(root, tasks, brain);
    expect(sessions.every((s) => s.model === null)).toBe(true);
    // Not "cheap" and not free: unknown. estimateCostUsd refuses a model it has
    // no price for, so a Gemini session can never be billed at Claude's rates.
    expect(sessions.every((s) => s.estCostUsd === null)).toBe(true);
    expect(estimateCostUsd(null, { totalTokens: 2000 })).toBeNull();
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
