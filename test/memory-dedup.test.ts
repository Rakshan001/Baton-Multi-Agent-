import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { saveMemory } from '../src/memory.js';

/**
 * M8 — write-time reconciliation, the Mem0 pattern with the agent as the
 * judge: `save_memory` retrieves the most similar existing facts and returns
 * them as `similarExisting` hints. Auto-supersede stays reserved for the
 * high-confidence case (same fingerprint + high similarity); everything else
 * is the saving agent's call — Baton never guesses with knowledge.
 */
describe('saveMemory — near-duplicate hints', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memdedup-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await g(['commit', '-qm', 'init', '--allow-empty']);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('flags a same-knowledge fact phrased differently (fingerprint dedup misses it)', async () => {
    const first = await saveMemory(root, {
      fact: 'The CSRF origin guard gates every mutating endpoint centrally.',
      type: 'convention',
    });
    const second = await saveMemory(root, {
      fact: 'Every mutating endpoint is gated centrally by the CSRF origin guard.',
      type: 'convention',
    });
    // Different opening words → no auto-supersede — but the hint must fire.
    expect(second.supersedes).toBeNull();
    expect(second.similarExisting?.some((s) => s.id === first.id)).toBe(true);
  });

  it('stays quiet for genuinely distinct knowledge', async () => {
    const r = await saveMemory(root, {
      fact: 'Worktree cleanup runs only after the branch is fully merged upstream.',
      type: 'decision',
    });
    expect(r.similarExisting ?? []).toEqual([]);
  });

  it('does not hint the fact it just auto-superseded (that is already handled)', async () => {
    await saveMemory(root, {
      fact: 'The dashboard polling interval for board updates was thirty seconds.',
      type: 'reference',
    });
    const updated = await saveMemory(root, {
      fact: 'The dashboard polling interval for board updates is now sixty seconds.',
      type: 'reference',
    });
    expect(updated.supersedes).not.toBeNull();
    expect(updated.similarExisting?.some((s) => s.id === updated.supersedes)).toBeFalsy();
  });
});
