/**
 * `baton kb <init|status|rebuild|mcp>` — set up and maintain the knowledge
 * base: one graphify graph per sub-project + a merged cross-project graph,
 * queryable by agents over MCP and rendered in the dashboard.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gitRoot } from '../git.js';
import { gitTry } from '../util/exec.js';
import {
  buildGraph, detectGraphify, hasLlmBackend, installGitHook, installHint, mergeGraphs, update,
} from '../kb/graphify.js';
import { detectProjects } from '../kb/projects.js';
import {
  graphPathFor, kbStatus, loadKb, mergedGraphFile, saveKb, type KbState,
} from '../kb/state.js';
import { jsonSnippet, snippetFor } from '../kb/mcp.js';
import { codebaseDocStatus, refreshCodebaseDocs } from '../kb/codebasemd.js';
import { exportKb, importKb, writeShareDir } from '../kb/transfer.js';

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
4. Read \`CODEBASE.md\` in the project root FIRST — it is the token-cheap map
   (structure, stack, key symbols). Don't re-scan the repo to orient yourself.
5. Use the \`graphify-*\` MCP tools (\`query_graph\`, \`get_node\`) to navigate
   the codebase instead of broad file scans.
<!-- /baton:coordination -->
`;

const GUIDE_RE = /<!-- baton:coordination -->[\s\S]*?<!-- \/baton:coordination -->\n?/;

/** Write/refresh the coordination guide in AGENTS.md / CLAUDE.md (replace-on-change, idempotent). */
async function appendAgentGuide(root: string): Promise<string | null> {
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  for (const name of candidates) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const current = await readFile(p, 'utf-8');
    if (GUIDE_RE.test(current)) {
      const next = current.replace(GUIDE_RE, AGENT_GUIDE.trimStart());
      if (next === current) return null; // up to date
      await writeFile(p, next, 'utf-8');
      return name;
    }
    await writeFile(p, current.trimEnd() + '\n' + AGENT_GUIDE, 'utf-8');
    return name;
  }
  await writeFile(join(root, 'AGENTS.md'), '# Agent instructions\n' + AGENT_GUIDE, 'utf-8');
  return 'AGENTS.md';
}

/**
 * Keep graphify away from our own generated files: with an LLM key set, it
 * would semantically re-extract CODEBASE.md/AGENTS.md/kb/ on every rebuild —
 * wasted tokens and self-referential graph nodes. Idempotent merge.
 */
async function ensureGraphifyIgnore(root: string): Promise<void> {
  const file = join(root, '.graphifyignore');
  const MARKER = '# baton: generated knowledge-base files (do not index)';
  const ENTRIES = ['CODEBASE.md', 'AGENTS.md', 'kb/'];
  let current = '';
  if (existsSync(file)) current = await readFile(file, 'utf-8');
  if (current.includes(MARKER)) return;
  const block = `${current.trimEnd()}\n\n${MARKER}\n${ENTRIES.join('\n')}\n`.replace(/^\n+/, '');
  await writeFile(file, block, 'utf-8');
}

/** Interactive share-or-local question (TTY only; non-TTY defaults to local). */
async function askShare(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Share the knowledge base via git (committed kb/ directory)? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function kbInitCmd(path: string | undefined, opts: { mcp?: boolean; docs?: boolean; share?: boolean; local?: boolean } = {}): Promise<void> {
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

  await ensureGraphifyIgnore(root);

  for (const p of projects) {
    console.log(`\n→ extracting ${p.id} ...`);
    await buildGraph(p.path, { onOutput: (l) => console.log(`    ${l}`) });
  }

  const share = opts.share === true ? true : opts.local === true ? false : await askShare();
  const state: KbState = {
    root,
    projects: projects.map((p) => ({ ...p, graphPath: graphPathFor(p.path) })),
    mergedGraphPath: null,
    lastBuiltAt: new Date().toISOString(),
    share,
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
  const docs = await refreshCodebaseDocs(root, state);
  console.log(`✓ CODEBASE.md ×${docs.length} (token-cheap structure maps)`);
  if (share) {
    const dir = await writeShareDir(root, state);
    console.log(`✓ share mode ON — committed KB at ${dir} (teammates: baton kb import kb/)`);
  }
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
    const doc = await codebaseDocStatus(p);
    const docNote = doc === 'fresh' ? '' : doc === 'stale' ? '  [CODEBASE.md stale — run: baton kb rebuild]' : '  [CODEBASE.md missing]';
    console.log(
      s
        ? `  ${p.id.padEnd(24)} ${String(s.nodes).padStart(6)} nodes  ${String(s.edges).padStart(6)} edges  ${String(s.communities).padStart(3)} communities${p.building ? '  [building]' : ''}${docNote}`
        : `  ${p.id.padEnd(24)} (no graph yet)${p.building ? '  [building]' : ''}${docNote}`,
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
  const docs = await refreshCodebaseDocs(root, state);
  if (state.share) await writeShareDir(root, state);
  console.log(`✓ rebuilt (+ CODEBASE.md ×${docs.length}${state.share ? ' + kb/ share dir' : ''})`);
}

export async function kbExportCmd(opts: { out?: string } = {}): Promise<void> {
  const root = await gitRoot();
  const state = await loadKb(root);
  if (!state) {
    console.error('knowledge base not initialized — run: baton kb init');
    process.exitCode = 1;
    return;
  }
  const head = await gitTry(['rev-parse', '--short', 'HEAD'], root);
  const defaultName = `baton-kb-${basename(root)}-${head.ok ? head.stdout : 'nohead'}.tar.gz`;
  const { file, bytes } = await exportKb(root, state, opts.out ?? defaultName);
  console.log(`✓ exported knowledge base → ${file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log('  share it; the receiver runs: baton kb import <file>');
}

export async function kbImportCmd(source: string, opts: { rebuild?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const result = await importKb(root, source);
  for (const p of result.projects) {
    const mark = p.status === 'ok' ? '✓' : '✗';
    console.log(`${mark} ${p.id}: ${p.status}`);
  }
  for (const w of result.warnings) console.log(`! ${w}`);
  if (result.commitsBehind !== null && result.commitsBehind > 0) {
    console.log(`KB is ${result.commitsBehind} commit${result.commitsBehind === 1 ? '' : 's'} behind your HEAD.`);
    const detection = await detectGraphify();
    if (opts.rebuild !== false && detection.ok) {
      console.log('→ refreshing (incremental)…');
      await kbRebuildCmd(undefined, {});
      return;
    }
    if (!detection.ok) console.log(`  install graphify to refresh: ${installHint(detection)}`);
    else console.log('  refresh with: baton kb rebuild');
  } else {
    console.log('✓ knowledge base imported and current');
  }
}

export async function kbShareCmd(mode?: string): Promise<void> {
  const root = await gitRoot();
  const state = await loadKb(root);
  if (!state) {
    console.error('knowledge base not initialized — run: baton kb init');
    process.exitCode = 1;
    return;
  }
  if (mode === 'on') state.share = true;
  else if (mode === 'off') state.share = false;
  else {
    console.log(`share mode is ${state.share ? 'ON (committed kb/ directory)' : 'OFF (local only)'}`);
    console.log('  toggle with: baton kb share on|off');
    return;
  }
  await saveKb(root, state);
  if (state.share) {
    const dir = await writeShareDir(root, state);
    console.log(`✓ share mode ON — ${dir} is committable (teammates: baton kb import kb/)`);
  } else {
    console.log('✓ share mode OFF — kb/ will no longer be refreshed (delete it if you no longer want it committed)');
  }
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
