/**
 * The dashboard hand-mirrors mcpTargetFor in web/src/lib/api.ts (two separate
 * tsconfigs, no monorepo tool, so it cannot import from src/). Adding an agent
 * to one side and not the other is silent: the daemon wires the agent while the
 * UI reports it as unsupported. This test makes that a red build instead.
 *
 * If it fails, fix the mirror — do not relax the test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpTargetFor } from '../src/agents/connect.js';

const REPO = join(import.meta.dirname, '..');
const MIRROR = join(REPO, 'web', 'src', 'lib', 'api.ts');

/** Pull `case "x": return { scope: "s", path: "p" }` lines out of demoMcpTarget. */
function readMirror(): Map<string, { scope: string; path: string }> {
  const src = readFileSync(MIRROR, 'utf-8');
  const body = /private demoMcpTarget\([\s\S]*?\n  \}/.exec(src)?.[0];
  expect(body, 'demoMcpTarget not found in web/src/lib/api.ts — did it get renamed?').toBeTruthy();
  const out = new Map<string, { scope: string; path: string }>();
  for (const m of body!.matchAll(/case "([\w-]+)":\s*return \{ scope: "(\w+)", path: "([^"]+)" \}/g)) {
    out.set(m[1], { scope: m[2], path: m[3] });
  }
  return out;
}

/** The same target from the real implementation, with root/home collapsed to the mirror's notation. */
function fromSource(agent: string): { scope: string; path: string } | null {
  const t = mcpTargetFor(agent, '/R', '/H');
  if (!t) return null;
  return { scope: t.scope, path: t.path.replace(/^\/R\//, '').replace(/^\/H\//, '~/') };
}

describe('web/src/lib/api.ts demoMcpTarget mirrors src mcpTargetFor', () => {
  const mirror = readMirror();

  it('found the mirrored cases at all', () => {
    expect(mirror.size).toBeGreaterThan(0);
  });

  it('covers exactly the agents the daemon can wire', () => {
    // Probed rather than hardcoded, so a new agent in either file is caught.
    const candidates = new Set([...mirror.keys(), 'claude', 'cursor', 'antigravity', 'gemini', 'codex', 'aider', 'opencode']);
    const wirable = [...candidates].filter((a) => fromSource(a)).sort();
    expect([...mirror.keys()].sort()).toEqual(wirable);
  });

  it('agrees on every scope and path', () => {
    for (const [agent, mirrored] of mirror) {
      expect(fromSource(agent), `${agent} is mirrored in the dashboard but unsupported in src`).toEqual(mirrored);
    }
  });

  it('never mirrors an agent that has no MCP config', () => {
    for (const agent of ['aider', 'opencode']) {
      expect(mirror.has(agent)).toBe(false);
      expect(fromSource(agent)).toBeNull();
    }
  });
});
