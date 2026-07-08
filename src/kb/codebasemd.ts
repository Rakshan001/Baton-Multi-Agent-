/**
 * CODEBASE.md generation — the token-cheap structure layer under the graph.
 * One deterministic markdown map per project (< ~2k tokens): stack, annotated
 * folder tree, top graph symbols, and pointers to deeper queries — so an agent
 * orients itself for hundreds of tokens instead of re-reading the repo.
 *
 * Prior art (concepts adapted, no code vendored — see NOTICE): Aider's
 * repo-map (Apache-2.0; ranked symbols under a token budget), Repomix (MIT)
 * and the llms.txt convention (curated markdown index for LLMs).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { SKIP_DIRS } from './projects.js';
import { readStats } from './graphify.js';
import { loadKb, saveKb, type KbProject, type KbState } from './state.js';

/* ------------------------------ god nodes ------------------------------ */

interface GraphifyNode {
  id?: string;
  label?: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
}
interface GraphifyLink { source?: string; target?: string }
export interface GraphJson {
  built_at_commit?: string;
  nodes?: GraphifyNode[];
  links?: GraphifyLink[];
}

export interface GodNode {
  label: string;
  sourceFile: string | null;
  sourceLocation: string | null;
  degree: number;
}

/** Degree-rank graph nodes (code symbols only — documents excluded). Pure. */
export function extractGodNodes(graph: GraphJson, limit = 20): GodNode[] {
  const degree = new Map<string, number>();
  for (const l of graph.links ?? []) {
    if (typeof l.source === 'string') degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    if (typeof l.target === 'string') degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return (graph.nodes ?? [])
    .filter((n) => n.id && n.label && n.file_type !== 'document')
    .map((n) => ({
      label: n.label!,
      sourceFile: n.source_file ?? null,
      sourceLocation: n.source_location ?? null,
      degree: degree.get(n.id!) ?? 0,
    }))
    // codepoint compare, not localeCompare — output must be identical on every machine
    .sort((a, b) => b.degree - a.degree || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, limit);
}

/* ------------------------------ folder tree ----------------------------- */

export interface DirNode {
  name: string;
  dirs: DirNode[];
  files: string[];
  /** Set when the directory was collapsed (skip-listed or beyond depth): contained file count. */
  collapsedFiles?: number;
}

const MAX_DEPTH = 3;
/** Directories listed but never descended into. */
const COLLAPSE_DIRS = SKIP_DIRS;

async function countFiles(dir: string, budget = 2000): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < budget) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !COLLAPSE_DIRS.has(e.name)) stack.push(join(d, e.name));
      } else count++;
    }
  }
  return count;
}

/**
 * ≈ how many tokens reading the whole project would cost (bytes/4 over
 * everything an agent would actually read — skip-listed dirs excluded).
 * Budget-capped so a pathological tree can't stall a rebuild.
 */
export async function measureProjectTokens(dir: string, fileBudget = 20_000): Promise<number> {
  const { stat } = await import('node:fs/promises');
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < fileBudget) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!COLLAPSE_DIRS.has(e.name)) stack.push(join(d, e.name));
      } else {
        files++;
        try {
          bytes += (await stat(join(d, e.name))).size;
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  return Math.round(bytes / 4);
}

/** Scan a project directory into a DirNode (depth-limited, noise collapsed). */
export async function scanDir(path: string, depth = 1): Promise<DirNode> {
  const node: DirNode = { name: basename(path), dirs: [], files: [] };
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) {
      node.files.push(`${e.name} → (symlink)`); // never follow — cycles, escapes
      continue;
    }
    if (e.isDirectory()) {
      const child = join(path, e.name);
      if (COLLAPSE_DIRS.has(e.name) || depth >= MAX_DEPTH) {
        node.dirs.push({ name: e.name, dirs: [], files: [], collapsedFiles: await countFiles(child) });
      } else {
        node.dirs.push(await scanDir(child, depth + 1));
      }
    } else {
      node.files.push(e.name);
    }
  }
  return node;
}

const MAX_TREE_LINES = 120;
const MAX_FILES_PER_DIR = 12;

/** Render a DirNode as an indented tree, capped at ~120 lines. Pure. */
export function renderTree(root: DirNode, maxLines = MAX_TREE_LINES): string[] {
  const lines: string[] = [];
  const walk = (node: DirNode, indent: string): void => {
    for (const d of node.dirs) {
      if (lines.length >= maxLines) return;
      if (d.collapsedFiles !== undefined) {
        lines.push(`${indent}${d.name}/ (${d.collapsedFiles} file${d.collapsedFiles === 1 ? '' : 's'})`);
      } else {
        lines.push(`${indent}${d.name}/`);
        walk(d, indent + '  ');
      }
    }
    const shown = node.files.slice(0, MAX_FILES_PER_DIR);
    for (const f of shown) {
      if (lines.length >= maxLines) return;
      lines.push(`${indent}${f}`);
    }
    if (node.files.length > shown.length && lines.length < maxLines) {
      lines.push(`${indent}… +${node.files.length - shown.length} more files`);
    }
  };
  walk(root, '');
  if (lines.length >= maxLines) lines.push('… (tree truncated)');
  return lines;
}

/* ------------------------------ stack info ------------------------------ */

export interface StackInfo {
  stack: string[];
  scripts: Record<string, string>;
}

const KNOWN_FRAMEWORKS = [
  'react', 'next', 'vite', 'vue', 'svelte', 'angular', 'express', 'fastify',
  'nest', '@nestjs/core', 'koa', 'hono', 'electron', 'react-native', 'expo',
] as const;

export async function detectStack(projectPath: string): Promise<StackInfo> {
  const info: StackInfo = { stack: [], scripts: {} };
  try {
    if (existsSync(join(projectPath, 'package.json'))) {
      const pkg = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      info.stack.push('node');
      for (const fw of KNOWN_FRAMEWORKS) if (deps[fw]) info.stack.push(fw.replace('@nestjs/core', 'nestjs'));
      for (const [name, cmd] of Object.entries(pkg.scripts ?? {}).slice(0, 6)) info.scripts[name] = cmd;
    }
    if (existsSync(join(projectPath, 'pyproject.toml'))) info.stack.push('python');
    if (existsSync(join(projectPath, 'go.mod'))) info.stack.push('go');
    if (existsSync(join(projectPath, 'Cargo.toml'))) info.stack.push('rust');
    if (existsSync(join(projectPath, 'pom.xml'))) info.stack.push('java');
  } catch {
    /* stack detection is best-effort */
  }
  return info;
}

/* ------------------------------ rendering ------------------------------- */

export interface RenderMeta {
  generatedAt: string; // ISO — only appears in the footer comment
}

/** Render one project's CODEBASE.md. Body is deterministic; metadata lives in the footer comment. */
export async function renderCodebaseMd(project: KbProject, meta: RenderMeta): Promise<string> {
  const [stackInfo, tree] = await Promise.all([detectStack(project.path), scanDir(project.path)]);
  let graph: GraphJson | null = null;
  try {
    graph = JSON.parse(await readFile(project.graphPath, 'utf-8')) as GraphJson;
  } catch {
    /* graph not built yet — structure-only map */
  }
  const gods = graph ? extractGodNodes(graph) : [];
  const builtAtCommit = graph?.built_at_commit ?? null;

  const out: string[] = [
    `# CODEBASE — ${project.name}`,
    '',
    '> Auto-generated by `baton kb` — the token-cheap map of this project.',
    '> Read this BEFORE scanning files; query the knowledge graph for anything deeper.',
    '',
  ];
  if (stackInfo.stack.length) out.push(`**Stack:** ${stackInfo.stack.join(' · ')}`, '');
  if (Object.keys(stackInfo.scripts).length) {
    out.push('**Scripts:**', '');
    for (const [name, cmd] of Object.entries(stackInfo.scripts)) out.push(`- \`${name}\` → \`${cmd}\``);
    out.push('');
  }
  out.push('## Structure', '', '```', ...renderTree(tree), '```', '');
  if (gods.length) {
    out.push('## Key symbols (most connected in the code graph)', '');
    for (const g of gods) {
      const loc = g.sourceFile ? ` — ${g.sourceFile}${g.sourceLocation ? `:${g.sourceLocation.replace(/^L/, '')}` : ''}` : '';
      out.push(`- \`${g.label}\`${loc} (${g.degree} connection${g.degree === 1 ? '' : 's'})`);
    }
    out.push('');
  }
  out.push(
    '## Query more',
    '',
    `- Graph search: MCP tool \`query_graph\` on server \`graphify-${project.id}\`, or \`graphify query "<question>" --graph ${relative(project.path, project.graphPath) || 'graphify-out/graph.json'}\``,
    '- Who is editing what right now: `baton` MCP tool `check_files` / `baton signals`',
    '- File attribution: `baton blame <file>`',
    '',
    `<!-- baton:codebase generated=${meta.generatedAt} commit=${builtAtCommit ?? 'unknown'} -->`,
    '',
  );
  return out.join('\n');
}

/* ------------------------------ refresh hook ---------------------------- */

/**
 * THE single freshness hook: regenerates every project's CODEBASE.md (and the
 * root index for multi-project containers). Called by `kb init`, `kb rebuild`,
 * `kb import`, and the daemon's debounced kb.rebuilt subscriber.
 */
export async function refreshCodebaseDocs(root: string, state: KbState): Promise<string[]> {
  const written: string[] = [];
  const generatedAt = new Date().toISOString();
  for (const p of state.projects) {
    const md = await renderCodebaseMd(p, { generatedAt });
    const file = join(p.path, 'CODEBASE.md');
    await writeFile(file, md, 'utf-8');
    written.push(file);
    // Token-savings metric: what the map costs vs what reading the repo costs.
    p.mapTokens = Math.round(md.length / 4);
    p.repoTokens = await measureProjectTokens(p.path);
  }
  await saveKb(root, state);
  if (state.projects.length > 1) {
    const index: string[] = [
      '# CODEBASE — project index',
      '',
      '> Auto-generated by `baton kb`. One entry per server/project in this workspace.',
      '',
    ];
    for (const p of state.projects) {
      const rel = relative(root, p.path) || '.';
      const stack = (await detectStack(p.path)).stack.join(' · ') || 'unknown stack';
      index.push(`- **[${p.name}](${rel}/CODEBASE.md)** — \`${rel}/\` (${stack})`);
    }
    index.push('', `<!-- baton:codebase generated=${generatedAt} commit=unknown -->`, '');
    const file = join(root, 'CODEBASE.md');
    // Don't clobber a single-project CODEBASE.md when root IS a project.
    if (!state.projects.some((p) => p.path === root)) {
      await writeFile(file, index.join('\n'), 'utf-8');
      written.push(file);
    }
  }
  return written;
}

/**
 * G1: graphify's own post-commit hook rebuilds the graph OUTSIDE the daemon
 * (no kb.rebuilt event fires), leaving CODEBASE.md describing the previous
 * build. Regenerate the docs when any project's footer lags its graph;
 * no-op (and cheap — one footer/stats compare per project) when fresh.
 */
export async function refreshDocsIfStale(root: string): Promise<string[]> {
  const state = await loadKb(root);
  if (!state || state.projects.length === 0) return [];
  for (const p of state.projects) {
    if ((await codebaseDocStatus(p)) === 'stale') return refreshCodebaseDocs(root, state);
  }
  return [];
}

/** Staleness for `kb status`: footer commit vs the graph's built_at_commit. */
export async function codebaseDocStatus(p: KbProject): Promise<'missing' | 'fresh' | 'stale'> {
  try {
    const md = await readFile(join(p.path, 'CODEBASE.md'), 'utf-8');
    const m = md.match(/<!-- baton:codebase generated=\S+ commit=(\S+) -->/);
    if (!m) return 'missing';
    const graphCommit = (await readStats(p.graphPath))?.builtAtCommit ?? null;
    if (!graphCommit || m[1] === 'unknown') return 'fresh'; // nothing to compare against
    return m[1] === graphCommit ? 'fresh' : 'stale';
  } catch {
    return 'missing';
  }
}
