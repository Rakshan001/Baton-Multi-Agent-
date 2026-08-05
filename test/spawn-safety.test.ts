/**
 * What a headless agent run is allowed to do, and to publish.
 *
 * `baton start` / `POST /api/tasks/:slug/agent/start` runs a third-party CLI on
 * this machine with the user's own credentials. Two properties matter more than
 * anything the run produces:
 *
 *  - it is spawned as ARGV, never through a shell, so a prompt is data;
 *  - its output is redacted before it reaches the bus, because that output is
 *    the least controlled text in the system and lands in a 500-line ring
 *    buffer that `GET /api/agents/running` serves to every member.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let agentsFile: string;

/** A real child process, so this exercises the actual spawn path. */
const NODE_AGENT = {
  agents: [{ id: 'nodex9', binary: 'node', headless: { cmd: 'node', args: ['-e', '{prompt}'] } }],
};

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-spawn-')));
  agentsFile = join(root, 'agents.json');
  await writeFile(agentsFile, JSON.stringify(NODE_AGENT), 'utf-8');
  process.env.BATON_AGENTS_FILE = agentsFile; // read at module load, below
});

afterEach(async () => {
  delete process.env.BATON_AGENTS_FILE;
  await rm(root, { recursive: true, force: true });
});

/** Import AFTER the env var is set — the global registry loads once, at import. */
async function load() {
  const store = await import('../src/store.js');
  const spawn = await import('../src/spawn.js');
  const { bus } = await import('../src/events.js');
  return { ...store, ...spawn, bus };
}

/** Ask the OS directly, rather than trusting anything under test. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function taskAt(root: string, slug: string) {
  const wt = join(root, 'wt', slug);
  await mkdir(wt, { recursive: true });
  const { addTask } = await import('../src/store.js');
  await addTask(root, {
    slug, task: 'a task', agent: 'claude', branch: `baton/${slug}`,
    worktreePath: wt, status: 'todo', createdAt: new Date().toISOString(),
  } as never);
  return wt;
}

describe('agent output is redacted before it leaves the process', () => {
  it('never publishes a credential the agent printed', async () => {
    /*
     * Every other durable surface redacts — memory facts, review findings,
     * commit subjects in a derived brief. Agent stdout skipped it, and it is
     * the one text nobody reviewed: an agent echoing a .env, printing a failing
     * curl, or dumping its environment published straight onto the bus.
     */
    const { startAgent, waitForAgent, bus } = await load();
    await taskAt(root, 'redact');

    const seen: string[] = [];
    const unsub = bus.onType('agent.output', (e) => {
      if (e.event.type === 'agent.output') seen.push(e.event.line);
    });
    try {
      await startAgent('redact', {
        agent: 'nodex9',
        prompt: 'console.log("AKIAIOSFODNN7EXAMPLE")',
      }, root);
      await waitForAgent('redact');
    } finally {
      unsub();
    }

    expect(seen.join('\n')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(seen.some((l) => l.includes('[redacted:'))).toBe(true);
  }, 20_000);

  it('redacts a credential split across two stdout chunks', async () => {
    /*
     * `data` events arrive on arbitrary byte boundaries, so one printed line
     * routinely lands in two chunks. Treating each chunk as a set of lines let
     * a secret straddling the boundary walk past the redactor, which only ever
     * saw one half of it — redaction a chunk boundary can defeat is not
     * redaction. The writes below are deliberately split mid-token.
     */
    const { startAgent, waitForAgent, bus } = await load();
    await taskAt(root, 'chunks');

    const seen: string[] = [];
    const unsub = bus.onType('agent.output', (e) => {
      if (e.event.type === 'agent.output') seen.push(e.event.line);
    });
    try {
      await startAgent('chunks', {
        agent: 'nodex9',
        prompt: 'process.stdout.write("AKIAIOSF"); setTimeout(() => process.stdout.write("ODNN7EXAMPLE\\n"), 60)',
      }, root);
      await waitForAgent('chunks');
    } finally {
      unsub();
    }

    const all = seen.join('\n');
    expect(all).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(all).not.toContain('AKIAIOSF'); // nor the half, published as a whole line
    expect(seen.some((l) => l.includes('[redacted:'))).toBe(true);
  }, 20_000);

  it('still emits a final line that never got its newline', async () => {
    // Buffering must not swallow the last line — which is commonly the one
    // saying how the run ended.
    const { startAgent, waitForAgent, bus } = await load();
    await taskAt(root, 'tail');

    const seen: string[] = [];
    const unsub = bus.onType('agent.output', (e) => {
      if (e.event.type === 'agent.output') seen.push(e.event.line);
    });
    try {
      await startAgent('tail', { agent: 'nodex9', prompt: 'process.stdout.write("no trailing newline here")' }, root);
      await waitForAgent('tail');
      await new Promise((r) => setTimeout(r, 50)); // the flush rides the exit handler
    } finally {
      unsub();
    }
    expect(seen.join('\n')).toContain('no trailing newline here');
  }, 20_000);

  it('stopping a run also kills what the run spawned', async () => {
    /*
     * An agent CLI is a supervisor: it starts npm, tsc, pytest, its own MCP
     * servers. Killing only the direct child left those alive while the UI
     * said "stopped" — and a half-stopped agent still writing to the worktree
     * is worse than one that never stopped, because nobody is looking for it.
     *
     * The child below spawns a grandchild that would outlive it by minutes,
     * and the grandchild reports its own pid so we can ask the OS directly
     * whether it is still there.
     */
    const { startAgent, stopAgent, bus } = await load();
    await taskAt(root, 'tree');

    let grandchildPid = 0;
    const unsub = bus.onType('agent.output', (e) => {
      if (e.event.type !== 'agent.output') return;
      const m = /GRANDCHILD (\d+)/.exec(e.event.line);
      if (m) grandchildPid = Number(m[1]);
    });
    try {
      await startAgent('tree', {
        agent: 'nodex9',
        prompt: 'const c = require("child_process").spawn("node", ["-e", "setTimeout(()=>{}, 600000)"], {stdio: "ignore"});'
          + 'console.log("GRANDCHILD " + c.pid); setTimeout(() => {}, 600000);',
      }, root);

      for (let i = 0; i < 100 && !grandchildPid; i++) await new Promise((r) => setTimeout(r, 50));
      expect(grandchildPid).toBeGreaterThan(0);
      expect(alive(grandchildPid)).toBe(true);      // it really is running

      expect(stopAgent('tree')).toBe(true);
      for (let i = 0; i < 100 && alive(grandchildPid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchildPid)).toBe(false);     // ...and went down with its parent
    } finally {
      unsub();
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }, 30_000);

  it('passes the prompt as one argv element, so it can never become a command', async () => {
    // The prompt is attacker-adjacent by design (it is whatever the brief or
    // the caller supplied). execa with an argv array and no shell is what keeps
    // it data; this pins that a shell metacharacter stays literal.
    const { startAgent, waitForAgent, bus } = await load();
    await taskAt(root, 'argv');

    const seen: string[] = [];
    const unsub = bus.onType('agent.output', (e) => {
      if (e.event.type === 'agent.output') seen.push(e.event.line);
    });
    try {
      await startAgent('argv', {
        agent: 'nodex9',
        prompt: 'console.log("safe" + "; touch /tmp/baton-pwned-marker")',
      }, root);
      await waitForAgent('argv');
    } finally {
      unsub();
    }

    // The metacharacters arrived as part of the string, not as a second command.
    expect(seen.join('\n')).toContain('safe; touch /tmp/baton-pwned-marker');
  }, 20_000);
});
