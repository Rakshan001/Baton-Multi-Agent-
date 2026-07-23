import { describe, it, expect } from 'vitest';
import { mcpServers, mcpServersGemini, codexSnippet } from '../src/kb/mcp.js';

/**
 * P11 — cut hub graphify token duplication. In a true hub (a merged graph that
 * already spans 2+ projects), the per-project `graphify-<id>` servers are
 * redundant duplicated tool defs. Default to merged-only; per-project is opt-in.
 * A single project (even one that happens to carry a mergedGraphPath fixture)
 * must keep its per-project graph — there is nothing to collapse into.
 */
const opts = { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) };

const hubState = {
  root: '/r',
  projects: [
    { id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' },
    { id: 'web', name: 'web', path: '/r/web', graphPath: '/r/web/g.json' },
  ],
  mergedGraphPath: '/r/.baton/kb/m.json',
  lastBuiltAt: null,
} as any;

const singleState = {
  root: '/r',
  projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }],
  mergedGraphPath: '/r/.baton/kb/m.json',
  lastBuiltAt: null,
} as any;

describe('mcpServers hub collapse (P11)', () => {
  it('registers only graphify-merged by default in a 2+ project hub', () => {
    const servers = mcpServers(hubState, opts);
    expect(servers['graphify-merged']).toBeDefined();
    expect(servers['graphify-api']).toBeUndefined();
    expect(servers['graphify-web']).toBeUndefined();
    expect(servers.baton).toBeDefined();
  });

  it('restores per-project graphs when perProject is opted in', () => {
    const servers = mcpServers(hubState, { ...opts, perProject: true });
    expect(servers['graphify-merged']).toBeDefined();
    expect(servers['graphify-api']).toBeDefined();
    expect(servers['graphify-web']).toBeDefined();
  });

  it('keeps the per-project graph for a single project (nothing to collapse)', () => {
    const servers = mcpServers(singleState, opts);
    expect(servers['graphify-api']).toBeDefined();
    expect(servers['graphify-merged']).toBeDefined();
  });

  it('applies the same collapse to Gemini and Codex emitters (parity)', () => {
    const gem = mcpServersGemini(hubState, opts);
    expect(gem['graphify-merged']).toBeDefined();
    expect(gem['graphify-api']).toBeUndefined();

    const toml = codexSnippet(hubState, opts);
    expect(toml).toContain('[mcp_servers."graphify-merged"]');
    expect(toml).not.toContain('[mcp_servers."graphify-api"]');
    // Codex bridge still hits the shared pool URL (not a local uv spawn)
    expect(toml).toContain('mcp-bridge');
    expect(toml).not.toContain('command = "uv"');
  });
});
