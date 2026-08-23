// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A spawned agent has to know WHICH agent it is.
 *
 * `resolveAgentId()` reads BATON_AGENT first and only then falls back to
 * sniffing the parent process. `terminals.ts` sets it; `spawn.ts` did not — so a
 * headless run launched as `codex` introduced itself by whatever
 * `detectParentAgent()` guessed, or as `unknown`.
 *
 * That string is what `assignee` is matched against, so a dispatcher that
 * launches Cursor on a task assigned to Cursor would watch the agent get
 * refused from its own task. Identity has to come from the launch, not a guess.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;

/** A real child process, so this exercises the actual spawn path. */
const NODE_AGENT = {
  agents: [{ id: 'nodex9', binary: 'node', headless: { cmd: 'node', args: ['-e', '{prompt}'] } }],
};

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-spawn-id-')));
  const agentsFile = join(root, 'agents.json');
  await writeFile(agentsFile, JSON.stringify(NODE_AGENT), 'utf-8');
  process.env.BATON_AGENTS_FILE = agentsFile; // read at module load, below
});

afterEach(async () => {
  delete process.env.BATON_AGENTS_FILE;
  await rm(root, { recursive: true, force: true });
});

async function load() {
  const spawn = await import('../src/spawn.js');
  const { bus } = await import('../src/events.js');
  return { ...spawn, bus };
}

async function taskAt(root: string, slug: string): Promise<string> {
  const wt = join(root, 'wt', slug);
  await mkdir(wt, { recursive: true });
  const { addTask } = await import('../src/store.js');
  await addTask(root, {
    slug, task: 'a task', agent: 'claude', branch: `baton/${slug}`,
    worktreePath: wt, status: 'todo', createdAt: new Date().toISOString(),
    baseCommit: 'abc',
  } as never);
  return wt;
}

/** Run the fake agent with a prompt that prints one env var, and return what it printed. */
async function envSeenByAgent(slug: string, varName: string, agent: string): Promise<string> {
  const { startAgent, waitForAgent, bus } = await load();
  await taskAt(root, slug);

  const seen: string[] = [];
  const unsub = bus.onType('agent.output', (e) => {
    if (e.event.type === 'agent.output') seen.push(e.event.line);
  });
  try {
    await startAgent(slug, {
      agent,
      prompt: `console.log("SAW=" + process.env.${varName})`,
    }, root);
    await waitForAgent(slug);
  } finally {
    unsub();
  }
  return seen.join('\n');
}

describe('a headless run tells the agent who it is', () => {
  it('sets BATON_AGENT to the agent it launched', async () => {
    const out = await envSeenByAgent('whoami', 'BATON_AGENT', 'nodex9');

    expect(out).toContain('SAW=nodex9');
  }, 20_000);

  it('still sets BATON_SLUG, which is the session identity', async () => {
    const out = await envSeenByAgent('mysession', 'BATON_SLUG', 'nodex9');

    expect(out).toContain('SAW=mysession');
  }, 20_000);
});
