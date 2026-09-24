// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The MCP wire budget — the fixed context tax every agent session pays on
 * connect, measured the only way that is honest: a real `initialize` +
 * `tools/list` handshake against the BUILT server, counting the bytes the
 * client actually receives.
 *
 * test/mcp-help.test.ts budgets the tool DESCRIPTIONS by reading the source
 * constant. That measurement missed 5,687 bytes of input-schema `.describe()`
 * text and JSON Schema scaffolding, because a source file is not the wire. This
 * test covers names, descriptions AND input schemas together, so a schema-only
 * regression fails it.
 *
 * A budget test that can pass while measuring nothing is worse than no test, so
 * every "no data" path here is a loud failure: no built CLI, a server that dies,
 * a handshake that times out, or zero tools all fail rather than scoring 0.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'cli.js');

/**
 * Recorded baseline, measured 2026-09-05 against the built `dist/`:
 * 19 tools, 10,708 UTF-8 bytes of `tools/list`. (`baton/plans/context-cost.md`
 * quotes 10,672 for the same handshake; that is the JSON string LENGTH in
 * UTF-16 code units. The 36-byte gap is em dashes and en dashes, which cost
 * 3 bytes each on the wire — so bytes, not chars, is what a session pays.)
 */
const WIRE_BASELINE_BYTES = 10_708;

/**
 * The cap. Set at the measured value, not a round number: a budget with slack
 * in it is a budget that has already been spent. Lowering it after a trim is
 * the point; raising it is a deliberate edit that says a tool earned its place.
 *
 * The history, because every move has to be explainable:
 *
 *   10,708 → 8,390  `mcp-schema-trim`: sentence-length field descriptions cut
 *                   to clauses (~570 B), plus two SDK-stamped fields per tool
 *                   (`execution.taskSupport:"forbidden"` and the
 *                   `inputSchema.$schema` dialect URI, ~1,748 B).
 *    8,390 → 8,710  `suggest_skills` (tool 20), 319 B.
 *    8,710 → 9,750  `$schema` PUT BACK, +1,040 B (52 B × 20 tools). The trim
 *                   plan's principle was "trim wording, never fields", and for
 *                   this one it was right: a dialect declaration is something a
 *                   strict client may validate against, and unlike taskSupport
 *                   nothing in the spec says its absence means the default.
 *                   `execution` stays stripped — the MCP schema defines its
 *                   absence to mean exactly what its presence means, so no
 *                   client can tell. See src/mcp.ts:stripWireFat.
 *    9,750 → 10,172  `list_worktrees` (tool 21), 421 B (description 204,
 *                    schema 162, name/scaffold ~55). It earned the raise: it
 *                    is the ONLY tool that tells an agent another worktree
 *                    exists. Every other thing Baton serves an agent is about
 *                    FILES (`check_files`, `list_signals`), so a sibling that
 *                    stopped mid-task is invisible until a human reads the
 *                    dashboard — and agents do not read the dashboard. That
 *                    blind spot is how a half-finished worktree gets
 *                    abandoned, reported as done, and lost with its directory.
 *                    Its schema is one optional filter on purpose; a schema is
 *                    paid for by every agent in every session whether or not
 *                    the tool is ever called.
 *
 * That leaves the real, measured saving against the baseline at 8.9% for the
 * 20 tools served today (12.4% comparing like with like, i.e. against the 19
 * tools the baseline counted). It is under the 20% the trim task aimed at, and
 * that is the honest number: the difference was a protocol field.
 *
 * The memory capture nudge (src/mcp-nudge.ts) rides existing tool ANSWERS and
 * registers no tool, so it is worth stating what it cost here: nothing. This
 * number did not move when it was wired in.
 */
const WIRE_BUDGET_BYTES = 10_172;

/** Hard stop well inside the 20s the whole file is allowed. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

type Tool = { name?: unknown; description?: unknown; inputSchema?: unknown };

/**
 * One real stdio MCP handshake against `node dist/cli.js mcp`.
 *
 * `BATON_SLUG` is set on purpose: with a task slug present the server skips
 * registering a hook session, so measuring the wire never writes a phantom
 * agent into the developer's real `.baton`. No network, nothing outside `dist/`.
 */
async function toolsList(): Promise<Tool[]> {
  if (!existsSync(CLI)) {
    throw new Error(`no built server at ${CLI} — run \`npm run build\` before this test (measuring nothing is not a pass)`);
  }
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BATON_SLUG: 'mcp-wire-budget' },
  });

  const stderr: string[] = [];
  child.stderr.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));

  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let buf = '';
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = msg.id;
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)!(msg);
        pending.delete(id);
      }
    }
  });

  const send = (obj: unknown): void => { child.stdin.write(`${JSON.stringify(obj)}\n`); };
  const call = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
    });

  // Any of these means we measured nothing, and must say so rather than score 0.
  const died = new Promise<never>((_, reject) => {
    child.once('error', (e) => reject(new Error(`could not start the MCP server: ${e.message}`)));
    child.once('exit', (code) => reject(new Error(`MCP server exited (code ${code}) before answering: ${stderr.join('') || '<no stderr>'}`)));
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`MCP handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms: ${stderr.join('') || '<no stderr>'}`)), HANDSHAKE_TIMEOUT_MS).unref();
  });

  try {
    await Promise.race([
      call(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-wire-budget', version: '0' },
      }),
      died,
      timeout,
    ]);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await Promise.race([call(2, 'tools/list', {}), died, timeout]);
    const tools = (listed.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools)) throw new Error(`tools/list returned no tool array: ${JSON.stringify(listed).slice(0, 400)}`);
    return tools as Tool[];
  } finally {
    child.kill();
  }
}

/** Exactly what the client is charged for: the serialized tool array. */
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Named per tool, largest first, so a failure points at the offender. */
function breakdown(tools: Tool[]): string {
  const rows = tools
    .map((t) => ({
      name: String(t.name ?? '<unnamed>'),
      bytes: wireBytes(t),
      description: wireBytes(t.description ?? ''),
      schema: wireBytes(t.inputSchema ?? {}),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return rows
    .map((r) => `  ${r.name.padEnd(18)} ${String(r.bytes).padStart(5)} B  (description ${r.description}, schema ${r.schema})`)
    .join('\n');
}

describe('MCP tools/list wire budget', () => {
  it('serves a real handshake inside its byte budget, schemas included', { timeout: 20_000 }, async () => {
    const tools = await toolsList();

    // Absence of data is a failure, never a pass. Everything below this line
    // would happily report "0 bytes, well under budget" on an empty list.
    expect(tools.length, 'tools/list returned zero tools — the budget below would be measuring nothing').toBeGreaterThan(0);

    const total = wireBytes(tools);
    expect(total, 'serialized tools/list is empty — measuring nothing is not a pass').toBeGreaterThan(0);

    const report = [
      `tools=${tools.length} wire_bytes=${total} budget=${WIRE_BUDGET_BYTES} baseline=${WIRE_BASELINE_BYTES}`,
      breakdown(tools),
    ].join('\n');

    // Names, descriptions and input schemas together — a schema-only regression
    // is invisible to the description budget in test/mcp-help.test.ts.
    expect(total, `MCP tools/list is over its context budget.\n${report}`).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);

    // Every tool must carry a description; an unnamed or undescribed tool is a
    // cheap way to pass a byte budget and an expensive way to lose an agent.
    for (const t of tools) {
      expect(typeof t.name === 'string' && t.name.length > 0, `a tool has no name:\n${report}`).toBe(true);
      expect(String(t.description ?? '').trim().length, `${String(t.name)} has no description:\n${report}`).toBeGreaterThan(20);
      // And its declared JSON Schema dialect. This is 52 bytes a tool that the
      // budget above deliberately pays for: buying the number down by deleting
      // a field a strict client may validate against is exactly the trade this
      // budget was reinstated to forbid. Deleting it is a protocol change, not
      // a trim, and it must fail here rather than quietly score better.
      expect(
        (t.inputSchema as { $schema?: unknown } | undefined)?.$schema,
        `${String(t.name)} lost its inputSchema.$schema — that is a protocol change, not a byte saving:\n${report}`,
      ).toEqual(expect.any(String));
    }
  });
});
