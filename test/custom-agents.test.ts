/**
 * The open agent registry (src/agents/registry.ts, phase 4 of the daemon-fleet
 * plan): OpenClaw as a built-in, and ~/.baton/agents.json for agent number
 * nine.
 *
 * The properties pinned hardest are the refusals: a built-in can never be
 * redefined by config, a malformed entry is skipped with its reason recorded
 * (never thrown — a typo in a config file must not take the daemon down), and
 * launcher args stay argv arrays end to end.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, type AgentDef, KNOWN_AGENT_IDS, loadCustomAgents } from '../src/agents/registry.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'baton-agents-'));
  file = join(dir, 'agents.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const load = async (content: unknown): Promise<{ into: Record<string, AgentDef>; issues: string[]; added: string[] }> => {
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  const into: Record<string, AgentDef> = { ...AGENTS };
  const issues: string[] = [];
  const added = loadCustomAgents(file, into, issues);
  return { into, issues, added };
};

describe('openclaw built-in', () => {
  it('is known, detection-only, and detects its process line', () => {
    expect(KNOWN_AGENT_IDS).toContain('openclaw');
    const a = AGENTS.openclaw;
    expect(a.headless).toBeUndefined();
    expect(a.interactive).toBeUndefined();
    expect(a.detect.test('/usr/local/bin/openclaw --serve')).toBe(true);
    expect(a.detect.test('node openclaw-helper.js')).toBe(false); // word boundary
  });
});

describe('loadCustomAgents', () => {
  it('an absent file is the normal case: no agents, no issues', () => {
    const into: Record<string, AgentDef> = {};
    const issues: string[] = [];
    expect(loadCustomAgents(join(dir, 'never-written.json'), into, issues)).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('loads a full entry and compiles its argv template', async () => {
    const { into, issues, added } = await load({
      agents: [{
        id: 'myagent', label: 'My Agent', binary: 'myagent',
        headless: { args: ['run', '--model={model}', '-p', '{prompt}'] },
        interactive: { args: ['--model={model}'] },
      }],
    });
    expect(issues).toEqual([]);
    expect(added).toEqual(['myagent']);
    const a = into.myagent;
    // With a model: the token substitutes. Without: it vanishes whole, no
    // dangling flag.
    expect(a.headless!.args('fix the bug', 'sonnet')).toEqual(['run', '--model=sonnet', '-p', 'fix the bug']);
    expect(a.headless!.args('fix the bug')).toEqual(['run', '-p', 'fix the bug']);
    expect(a.interactive!.args(undefined, undefined)).toEqual([]);
    // Detection defaults to the binary name in the same shape as built-ins.
    expect(a.detect.test('/opt/bin/myagent --tui')).toBe(true);
  });

  it('guards a positional prompt that starts with a dash, like the built-ins do', async () => {
    const { into } = await load({ agents: [{ id: 'p', binary: 'p', headless: { args: ['{prompt}'] } }] });
    const argv = into.p.headless!.args('--dangerously-skip-permissions');
    expect(argv).toEqual([' --dangerously-skip-permissions']); // leading space = plain text to every CLI parser
  });

  it('a built-in can NEVER be redefined by config', async () => {
    const { into, issues, added } = await load({
      agents: [{ id: 'claude', binary: 'evil-claude', headless: { args: ['{prompt}'] } }],
    });
    expect(added).toEqual([]);
    expect(into.claude.binary).toBe('claude');
    expect(issues.join(' ')).toMatch(/collides with a built-in/);
  });

  it('skips malformed entries one by one, keeps the valid ones, and never throws', async () => {
    const { into, issues, added } = await load({
      agents: [
        { id: 'UPPER', binary: 'x' },                          // bad id
        { id: 'nobin' },                                       // missing binary
        { id: 'badre', binary: 'b', detect: '([' },            // regex that cannot compile
        { id: 'sh', binary: 'sh; rm -rf /' },                  // shell metachars refused by the binary charset
        { id: 'good', binary: 'good-cli' },                    // fine, detection-only
      ],
    });
    expect(added).toEqual(['good']);
    expect(into.good.headless).toBeUndefined();
    expect(issues.length).toBe(4);
  });

  it('a file that is not JSON, or not the documented shape, loads nothing and says why', async () => {
    expect((await load('{ not json')).issues.join(' ')).toMatch(/not valid JSON/);
    expect((await load({ agents: 'nope' })).issues.join(' ')).toMatch(/must be \{ "agents"/);
    expect((await load([])).issues.join(' ')).toMatch(/must be \{ "agents"/);
  });

  it('drops a headless launcher whose template never uses {prompt}', async () => {
    // Zero-prompt headless argv would start a TUI under a pipe and hang
    // `baton start` forever.
    const { into, issues } = await load({ agents: [{ id: 'h', binary: 'h', headless: { args: ['--serve'] } }] });
    expect(into.h.headless).toBeUndefined();
    expect(issues.join(' ')).toMatch(/never use \{prompt\}/);
  });

  it('caps custom agents and says what was dropped', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `agent-${String.fromCharCode(97 + i)}`, binary: 'x' }));
    const { added, issues } = await load({ agents: many });
    expect(added.length).toBe(20);
    expect(issues.join(' ')).toMatch(/more than 20/);
  });
});
