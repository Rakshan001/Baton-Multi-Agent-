/**
 * `baton kb <init|status|rebuild|mcp>` — set up and maintain the knowledge
 * base: one graphify graph per sub-project + a merged cross-project graph,
 * queryable by agents over MCP and rendered in the dashboard.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitRoot } from '../git.js';
import {
  buildGraph, detectGraphify, hasLlmBackend, installGitHook, installHint, mergeGraphs, update,
} from '../kb/graphify.js';
import { detectProjects } from '../kb/projects.js';
import {
  graphPathFor, kbStatus, loadKb, mergedGraphFile, saveKb, type KbState,
} from '../kb/state.js';
import { jsonSnippet, snippetFor } from '../kb/mcp.js';

const AGENT_GUIDE = `
<!-- baton:coordination -->
## Multi-agent coordination (Baton)

This repo is coordinated by Baton. Before editing files that other agents may
be working on:

1. Call the \`baton\` MCP tool \`check_files\` with the paths you plan to edit
   (or GET \`http://127.0.0.1:7077/api/signals/check?files=a,b\`).
2. If a file is busy (another session is editing it), prefer other work and
   re-check later instead of creating conflicting changes.
3. After waiting, call \`get_report\` for the finished task — the issue you
   were assigned may already be fixed; verify before re-doing work.
4. Use the \`graphify-*\` MCP tools (\`query_graph\`, \`get_node\`) to navigate
   the codebase instead of broad file scans.
<!-- /baton:coordination -->
`;

/** Append the coordination guide to AGENTS.md / CLAUDE.md (once, idempotent). */
async function appendAgentGuide(root: string): Promise<string | null> {
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  for (const name of candidates) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const current = await readFile(p, 'utf-8');
    if (current.includes('<!-- baton:coordination -->')) return null; // already there
    await writeFile(p, current.trimEnd() + '\n' + AGENT_GUIDE, 'utf-8');
    return name;
  }
  await writeFile(join(root, 'AGENTS.md'), '# Agent instructions\n' + AGENT_GUIDE, 'utf-8');
  return 'AGENTS.md';
}

export async function kbInitCmd(path: string | undefined, opts: { mcp?: boolean; docs?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const target = resolve(path ?? root);

  const det = await detectGraphify();
  if (!det.ok) {
    console.error('graphify is not installed (knowledge graphs need it).');
    console.error(`  install: ${installHint(det)}`);
    console.error('  then re-run: baton kb init');
    process.exitCode = 1;
    return;
  }
  console.log(`graphify ${det.version} ✓`);
  if (!hasLlmBackend()) {
    console.log('no LLM API key detected → AST-only extraction (fast, free; set ANTHROPIC_API_KEY etc. for semantic enrichment)');
  }

  const projects = await detectProjects(target);
  console.log(`detected ${projects.length} project${projects.length === 1 ? '' : 's'}:`);
  for (const p of projects) console.log(`  • ${p.id}  (${p.path})`);

  for (const p of projects) {
    console.log(`\n→ extracting ${p.id} ...`);
    await buildGraph(p.path, { onOutput: (l) => console.log(`    ${l}`) });
  }

  const state: KbState = {
    root,
    projects: projects.map((p) => ({ ...p, graphPath: graphPathFor(p.path) })),
    mergedGraphPath: null,
    lastBuiltAt: new Date().toISOString(),
  };

  if (state.projects.length > 1) {
    const out = mergedGraphFile(root);
    console.log('\n→ merging project graphs ...');
    await mergeGraphs(state.projects.map((p) => p.graphPath), out);
    state.mergedGraphPath = out;
  }

  const hooked = await installGitHook(root);
  console.log(hooked
    ? '✓ git hooks installed (graph auto-updates on commit)'
    : '! could not install git hooks — run `graphify hook install` manually');

  await saveKb(root, state);
  console.log(`✓ knowledge base ready (.baton/kb.json)`);

  // Project-scoped .mcp.json is picked up by Claude Code in every worktree.
  const mcpPath = join(root, '.mcp.json');
  if (opts.mcp !== false) {
    await writeMcpJson(mcpPath, state);
    console.log(`✓ wrote graphify + baton MCP servers to .mcp.json`);
  }
  if (opts.docs !== false) {
    const wrote = await appendAgentGuide(root);
    if (wrote) console.log(`✓ added coordination guide for agents to ${wrote}`);
  }
  console.log('\nnext: baton serve  → dashboard “Knowledge Graph” page');
  console.log('      baton kb mcp --agent codex|gemini|cursor  → config for other agents');
}

/** Merge graphify servers into an existing .mcp.json without clobbering other entries. */
async function writeMcpJson(mcpPath: string, state: KbState): Promise<void> {
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(await readFile(mcpPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }
  const ours = JSON.parse(jsonSnippet(state)) as { mcpServers: Record<string, unknown> };
  const merged = { ...existing, mcpServers: { ...existing.mcpServers, ...ours.mcpServers } };
  await writeFile(mcpPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

export async function kbStatusCmd(): Promise<void> {
  const root = await gitRoot();
  const { state, projects, merged } = await kbStatus(root);
  if (!state) {
    console.log('knowledge base not initialized — run: baton kb init');
    return;
  }
  console.log(`knowledge base @ ${state.root}  (built ${state.lastBuiltAt ?? 'never'})`);
  for (const p of projects) {
    const s = p.stats;
    console.log(
      s
        ? `  ${p.id.padEnd(24)} ${String(s.nodes).padStart(6)} nodes  ${String(s.edges).padStart(6)} edges  ${String(s.communities).padStart(3)} communities${p.building ? '  [building]' : ''}`
        : `  ${p.id.padEnd(24)} (no graph yet)${p.building ? '  [building]' : ''}`,
    );
  }
  if (merged?.stats) {
    console.log(`  ${'merged'.padEnd(24)} ${String(merged.stats.nodes).padStart(6)} nodes  ${String(merged.stats.edges).padStart(6)} edges`);
  }
}

export async function kbRebuildCmd(
  projectId: string | undefined,
  opts: { full?: boolean } = {},
): Promise<void> {
  const root = await gitRoot();
  const state = await loadKb(root);
  if (!state) {
    console.error('knowledge base not initialized — run: baton kb init');
    process.exitCode = 1;
    return;
  }
  const targets = projectId ? state.projects.filter((p) => p.id === projectId) : state.projects;
  if (projectId && targets.length === 0) {
    console.error(`no project '${projectId}' — see: baton kb status`);
    process.exitCode = 1;
    return;
  }
  for (const p of targets) {
    console.log(`→ ${opts.full ? 'full extract' : 'incremental update'}: ${p.id}`);
    if (opts.full) await buildGraph(p.path, { onOutput: (l) => console.log(`    ${l}`) });
    else await update(p.path, { onOutput: (l) => console.log(`    ${l}`) });
  }
  if (state.mergedGraphPath && state.projects.length > 1) {
    console.log('→ re-merging project graphs');
    await mergeGraphs(state.projects.map((p) => p.graphPath), state.mergedGraphPath);
  }
  state.lastBuiltAt = new Date().toISOString();
  await saveKb(root, state);
  console.log('✓ rebuilt');
}

export async function kbMcpCmd(opts: { agent?: string } = {}): Promise<void> {
  const root = await gitRoot();
  const state = await loadKb(root);
  if (!state) {
    console.error('knowledge base not initialized — run: baton kb init');
    process.exitCode = 1;
    return;
  }
  const agent = opts.agent ?? 'claude';
  const dest: Record<string, string> = {
    claude: '.mcp.json (repo root) or ~/.claude.json',
    cursor: '.cursor/mcp.json',
    codex: '~/.codex/config.toml',
    gemini: '~/.gemini/settings.json',
  };
  console.log(`# ${agent} → add to ${dest[agent] ?? dest.claude}`);
  console.log(snippetFor(agent, state));
}
