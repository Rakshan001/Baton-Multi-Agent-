import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  saveMemory, removeMemory, listMemories, readJournal, archiveDir,
} from '../src/memory.js';

/**
 * P10 — append-only KB journal. Knowledge must never silently disappear:
 * supersession and removal ARCHIVE the old fact (so its lineage survives for a
 * future repair queue) and append one JSONL journal line per op. Recall is
 * unchanged — listMemoryFacts reads the flat facts/ dir and never sees the
 * sibling archive/ subdir.
 */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-journal-'));
  const g = (args: string[]) => execa('git', args, { cwd: root });
  await g(['init', '-q']);
  await g(['config', 'user.email', 't@t.t']);
  await g(['config', 'user.name', 'T']);
  await g(['commit', '-qm', 'init', '--allow-empty']);
  return root;
}

describe('memory journal — archive instead of hard-delete (P10)', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('supersession archives the old fact and journals a supersede op', async () => {
    const first = await saveMemory(root, { fact: 'Deploys happen from main every friday afternoon.' });
    const second = await saveMemory(root, { fact: 'Deploys happen from main every friday at 15:00 UTC, never on holidays.' });
    expect(second.supersedes).toBe(first.id);

    // recall unchanged — the old fact is gone from the active view
    const all = await listMemories(root);
    expect(all.find((f) => f.id === first.id)).toBeUndefined();

    // ...but its content is preserved in the archive, not destroyed
    expect(existsSync(join(archiveDir(root), `${first.id}.md`))).toBe(true);

    const journal = await readJournal(root);
    const entry = journal.find((e) => e.id === first.id);
    expect(entry).toBeDefined();
    expect(entry!.op).toBe('supersede');
    expect(entry!.supersededBy).toBe(second.id);
  });

  it('removeMemory archives the fact and journals a remove op', async () => {
    const saved = await saveMemory(root, { fact: 'The staging database resets every night at midnight UTC.' });
    expect(await removeMemory(root, saved.id, 'manual removal')).toBe(true);

    expect(await listMemories(root)).toHaveLength(0);
    expect(existsSync(join(archiveDir(root), `${saved.id}.md`))).toBe(true);

    const journal = await readJournal(root);
    expect(journal).toHaveLength(1);
    expect(journal[0].op).toBe('remove');
    expect(journal[0].id).toBe(saved.id);
    expect(journal[0].reason).toBe('manual removal');
  });

  it('readJournal returns entries newest-first', async () => {
    const a = await saveMemory(root, { fact: 'First fact about the build pipeline caching layer.' });
    const b = await saveMemory(root, { fact: 'Second fact about the deployment rollback procedure.' });
    await removeMemory(root, a.id, 'reason a');
    await removeMemory(root, b.id, 'reason b');

    const journal = await readJournal(root);
    expect(journal.map((e) => e.id)).toEqual([b.id, a.id]);
  });
});
