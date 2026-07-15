/**
 * Context pack — one paste-able markdown brief of the project (or hub) for
 * EXTERNAL chatbots (ChatGPT, Grok, DeepSeek): overview, stack, annotated
 * tree, top graph symbols, fresh memory facts. No file bodies. Deterministic
 * (no LLM call), hard token budget, secrets redacted.
 * Spec: docs/superpowers/specs/2026-07-04-context-pack-design.md
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  detectStack, extractGodNodes, renderTree, scanDir,
  type DirNode, type GodNode, type GraphJson, type StackInfo,
} from './codebasemd.js';
import { graphPathFor, type KbProject, type KbState } from './state.js';
import { memoryBriefSection, recallMemories } from '../memory.js';
import { gitTry } from '../util/exec.js';

/** ≈ tokens via the repo-wide chars/4 heuristic (keeps the daemon dependency-free). */
export function estTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** Lines that are badges/HTML/anchors rather than prose. */
const NOISE_LINE_RE = /^(\[!\[|!\[|<)/;

/**
 * First prose paragraphs of a README: skip headings, badge rows, raw HTML,
 * code fences, and rules; join hard-wrapped lines; strip blockquote markers.
 */
export function extractOverview(readme: string, maxParagraphs = 4): string[] {
  const out: string[] = [];
  let inFence = false;
  const blocks = readme.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    // fences can span blank lines — track open/close across blocks
    const fenceTicks = (block.match(/```/g) ?? []).length;
    if (inFence) { if (fenceTicks % 2 === 1) inFence = false; continue; }
    if (block.startsWith('```')) { if (fenceTicks % 2 === 1) inFence = true; continue; }
    if (block.startsWith('#')) continue;
    if (/^-{3,}$/.test(block)) continue;
    const lines = block.split('\n').map((l) => l.trim().replace(/^>\s?/, ''));
    if (lines.every((l) => !l || NOISE_LINE_RE.test(l))) continue;
    out.push(lines.filter((l) => l && !NOISE_LINE_RE.test(l)).join(' '));
    if (out.length >= maxParagraphs) break;
  }
  return out;
}

/** First `-`/`*` list items of a conventions doc (CLAUDE.md / AGENTS.md). */
export function extractConventionBullets(md: string, maxBullets = 8): string[] {
  const out: string[] = [];
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (/^[-*] \S/.test(t)) {
      out.push(t.replace(/^[-*] /, ''));
      if (out.length >= maxBullets) break;
    }
  }
  return out;
}

/**
 * The pack goes to third-party chatbots — scrub anything secret-shaped.
 * Patterns: AWS access keys, PEM headers, key/secret/token assignments,
 * common vendor token prefixes (GitHub, Slack, OpenAI-style).
 */
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|apikey|secret|token|passwd|password)\b\s*[:=]\s*['"`]?[A-Za-z0-9_\-/+=.]{8,}['"`]?/gi,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk[_-][A-Za-z0-9_]{16,})\b/g,
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return '[REDACTED]';
    });
  }
  return { text: out, redactions };
}

/* ------------------------------ fit targets ----------------------------- */

export interface ChatbotFit {
  id: string;
  label: string;
  limit: number;
  ok: boolean;
}

/** Practical paste limits of common chatbot web UIs (planning figures, mid-2026). */
const FIT_TARGETS = [
  { id: 'chatgpt-free', label: 'ChatGPT free', limit: 8_000 },
  { id: 'grok-free', label: 'Grok free', limit: 32_000 },
  { id: 'deepseek', label: 'DeepSeek', limit: 128_000 },
] as const;

export function chatbotFits(tokens: number): ChatbotFit[] {
  return FIT_TARGETS.map((t) => ({ id: t.id, label: t.label, limit: t.limit, ok: tokens <= t.limit }));
}

/* ------------------------------ composer -------------------------------- */

export interface ContextPackOptions {
  /** Sub-project id (hub only); undefined = combined pack over all projects. */
  project?: string;
  /** Hard token ceiling for the rendered markdown. */
  maxTokens?: number;
  /** Injectable for deterministic tests; defaults to today's UTC date. */
  generatedAt?: string;
}

export interface ContextPack {
  markdown: string;
  tokens: number;
  redactions: number;
  omitted: string[];
  fits: ChatbotFit[];
}

export class UnknownProjectError extends Error {
  constructor(public readonly projects: string[]) {
    super(`unknown project — valid ids: ${projects.join(', ')}`);
    this.name = 'UnknownProjectError';
  }
}

interface RenderParams {
  treeLines: number;
  symbols: number;
  overviewParas: number;
  dropSymbols?: boolean;
  dropTrees?: boolean;
}

/** Applied in order until the pack fits — each stage strictly smaller. */
const TRIM_STAGES: RenderParams[] = [
  { treeLines: 120, symbols: 20, overviewParas: 4 },
  { treeLines: 60, symbols: 10, overviewParas: 4 },
  { treeLines: 30, symbols: 5, overviewParas: 2 },
  { treeLines: 20, symbols: 5, overviewParas: 1 },
  { treeLines: 20, symbols: 0, overviewParas: 1, dropSymbols: true },
  { treeLines: 0, symbols: 0, overviewParas: 1, dropSymbols: true, dropTrees: true },
];

interface ProjectInputs {
  p: KbProject;
  exists: boolean;
  stack: StackInfo;
  tree: DirNode | null;
  gods: GodNode[];
  graphBuilt: boolean;
  readme: string | null;
  conventions: string | null;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function gatherInputs(p: KbProject): Promise<ProjectInputs> {
  const exists = existsSync(p.path);
  const [stack, tree] = exists
    ? await Promise.all([detectStack(p.path), scanDir(p.path)])
    : [{ stack: [], scripts: {} } as StackInfo, null];
  let gods: GodNode[] = [];
  let graphBuilt = false;
  try {
    const graph = JSON.parse(await readFile(p.graphPath, 'utf-8')) as GraphJson;
    gods = extractGodNodes(graph, 20);
    graphBuilt = true;
  } catch {
    /* graph not built yet — structure-only pack */
  }
  const readme = exists ? await readFileOrNull(join(p.path, 'README.md')) : null;
  const conventions = exists
    ? (await readFileOrNull(join(p.path, 'CLAUDE.md')))
      ?? (await readFileOrNull(join(p.path, 'AGENTS.md')))
      ?? (await readFileOrNull(join(p.path, '.github', 'copilot-instructions.md')))
    : null;
  return { p, exists, stack, tree, gods, graphBuilt, readme, conventions };
}

interface RenderCtx {
  root: string;
  generatedAt: string;
  commit: string;
  params: RenderParams;
  hub: boolean;
  memorySection: string;
}

function renderPack(inputs: ProjectInputs[], ctx: RenderCtx, omitted: string[]): string {
  const { params } = ctx;
  const title = ctx.hub ? basename(ctx.root) : inputs[0]?.p.name ?? basename(ctx.root);
  const out: string[] = [
    `# ${title} — project context pack`,
    '',
    `Generated ${ctx.generatedAt} · commit ${ctx.commit} · by \`baton kb context\``,
    '',
    '> **Note for the assistant reading this:** this is a generated context pack.',
    '> Full source code is NOT included. If you need the contents of a specific',
    '> file, ask the user to paste it.',
    '',
  ];

  if (ctx.hub) {
    out.push('## How the repos relate', '');
    for (const i of inputs) {
      const rel = relative(ctx.root, i.p.path) || '.';
      const stack = i.stack.stack.join(' · ') || 'unknown stack';
      const oneLiner = i.readme ? (extractOverview(i.readme, 1)[0] ?? '').slice(0, 160) : '';
      out.push(`- **${i.p.name}** — \`${rel}/\` (${stack})${oneLiner ? ` — ${oneLiner}` : ''}`);
    }
    out.push('');
  }

  const h = ctx.hub ? '###' : '##';
  for (const i of inputs) {
    if (!i.exists) {
      out.push(`> ⚠️ project \`${i.p.id}\` skipped — path not found: \`${i.p.path}\``, '');
      omitted.push(`${i.p.id}: path missing`);
      continue;
    }
    if (ctx.hub) out.push(`## ${i.p.name}`, '');

    out.push(`${h} Overview`, '');
    if (i.readme) {
      const paras = extractOverview(i.readme, params.overviewParas);
      if (paras.length) out.push(...paras.flatMap((p2) => [p2, '']));
      else out.push('_README has no extractable prose._', '');
    } else {
      out.push('_No README found — overview derived from detected stack only._', '');
    }

    if (i.conventions) {
      const bullets = extractConventionBullets(i.conventions, 6);
      if (bullets.length) out.push(`${h} Conventions`, '', ...bullets.map((b) => `- ${b}`), '');
    }

    if (i.stack.stack.length || Object.keys(i.stack.scripts).length) {
      out.push(`${h} Stack & commands`, '');
      if (i.stack.stack.length) out.push(`**Stack:** ${i.stack.stack.join(' · ')}`, '');
      for (const [name, cmd] of Object.entries(i.stack.scripts)) out.push(`- \`${name}\` → \`${cmd}\``);
      out.push('');
    }

    if (params.dropTrees || !i.tree) {
      if (i.tree) {
        out.push('_(folder tree omitted to fit the token budget)_', '');
        omitted.push(`${i.p.id}: tree`);
      }
    } else {
      out.push(`${h} Folder structure`, '', '```', ...renderTree(i.tree, params.treeLines), '```', '');
    }

    if (params.dropSymbols) {
      if (i.gods.length) {
        out.push('_(key symbols omitted to fit the token budget)_', '');
        omitted.push(`${i.p.id}: symbols`);
      }
    } else if (i.graphBuilt && i.gods.length) {
      out.push(`${h} Key code symbols (most connected in the code graph)`, '');
      for (const g of i.gods.slice(0, params.symbols)) {
        const loc = g.sourceFile ? ` — ${g.sourceFile}${g.sourceLocation ? `:${g.sourceLocation.replace(/^L/, '')}` : ''}` : '';
        out.push(`- \`${g.label}\`${loc} (${g.degree} connection${g.degree === 1 ? '' : 's'})`);
      }
      out.push('');
    } else if (!i.graphBuilt) {
      out.push(`_(knowledge graph not built for ${i.p.name} — run \`baton kb init\` for a deeper symbol map)_`, '');
    }
  }

  if (ctx.memorySection) out.push(ctx.memorySection, '');

  const approx = estTokens(out.join('\n'));
  const fitsLine = chatbotFits(approx).filter((f) => f.ok).map((f) => f.label).join(' · ')
    || 'none of the common free tiers — use --tokens to shrink it';
  out.push('---', '', `_~${approx} tokens (approximate, chars/4). Pastes into: ${fitsLine}._`, '');
  return out.join('\n');
}

/**
 * Build the pack. `state` null (no `baton kb init` yet) still works — the
 * root becomes a synthetic single project and graph-derived sections degrade
 * to notes.
 */
export async function buildContextPack(
  root: string,
  state: KbState | null,
  opts: ContextPackOptions = {},
): Promise<ContextPack> {
  const maxTokens = opts.maxTokens ?? 8000;
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);

  let projects: KbProject[] = state?.projects?.length
    ? state.projects
    : [{ id: basename(root), name: basename(root), path: root, graphPath: graphPathFor(root) }];
  if (opts.project) {
    const match = projects.filter((p) => p.id === opts.project);
    if (!match.length) throw new UnknownProjectError(projects.map((p) => p.id));
    projects = match;
  }

  const inputs = await Promise.all(projects.map(gatherInputs));
  const head = await gitTry(['rev-parse', '--short', 'HEAD'], root);
  const commit = head.ok ? head.stdout.trim() : 'unknown';
  let memorySection = '';
  try {
    const recalled = await recallMemories(root, { limit: 6 });
    memorySection = memoryBriefSection(recalled.facts, recalled.staleDropped, recalled.staleGrounding);
  } catch {
    /* no memory store — section omitted */
  }

  const hub = !opts.project && inputs.length > 1;
  const omitted: string[] = [];
  let markdown = '';
  for (const params of TRIM_STAGES) {
    omitted.length = 0;
    markdown = renderPack(inputs, { root, generatedAt, commit, params, hub, memorySection }, omitted);
    if (estTokens(markdown) <= maxTokens) break;
  }

  const { text, redactions } = redactSecrets(markdown);
  const banner = redactions
    ? `> ⚠️ ${redactions} value${redactions === 1 ? '' : 's'} matching secret patterns ${redactions === 1 ? 'was' : 'were'} redacted from this pack.\n\n`
    : '';
  const final = banner + text;
  const tokens = estTokens(final);
  return { markdown: final, tokens, redactions, omitted: [...omitted], fits: chatbotFits(tokens) };
}
