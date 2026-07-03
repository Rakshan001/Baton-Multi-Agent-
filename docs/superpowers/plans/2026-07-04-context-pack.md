# Context Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `baton kb context` renders the project (or whole hub) into one paste-able markdown brief (≤ ~8k tokens) for external chatbots, exposed via CLI, a read-only daemon route, and a dashboard modal with Copy + Download.

**Architecture:** A new pure-ish module `src/kb/contextpack.ts` composes sections from artifacts Baton already maintains (README, `detectStack`/`scanDir`/`renderTree`/`extractGodNodes` from `codebasemd.ts`, `recallMemories`/`memoryBriefSection` from `memory.ts`). A staged-trim loop enforces a hard token budget; a regex pass redacts secrets. CLI, server route, and web modal are thin wrappers over `buildContextPack()`.

**Tech Stack:** Node ≥ 20, strict TypeScript, vitest, raw `node:http` daemon (zero new dependencies — no tokenizer libs), React dashboard (existing `CopyButton`, Blob download).

**Spec:** `docs/superpowers/specs/2026-07-04-context-pack-design.md` — read it before starting.

## Global Constraints

- **Zero-dependency daemon**: no new npm packages anywhere in root workspace. Token estimate is `Math.round(text.length / 4)`.
- **Deterministic output**: same inputs → byte-identical markdown. No `Date.now()`/random values in the body; `generatedAt` is injectable via options (tests pass a fixed value).
- **Demo mode must keep working**: web `getKbContext` returns a fixture when `BatonAPI.demo`; never gate the Share button off in demo.
- **Read-only surface**: the daemon route is GET, not write-gated (matches `GET /api/kb/export`).
- **Secret redaction always on** — no flag to disable it.
- **Strict TS in both workspaces**: `npm run build` and `npm run build --prefix web` must pass after every task.
- **Commit style**: plain messages, no AI co-author trailer, never push.
- Baseline before Task 1: `npx vitest run` → 271 passed.

## File Structure

- Create: `src/kb/contextpack.ts` — section extraction, redaction, fits, composer (Tasks 1–2)
- Create: `test/contextpack.test.ts` (Tasks 1–2)
- Modify: `src/commands/kb.ts`, `src/cli.ts` — CLI command (Task 3); Create: `test/context-cli.test.ts`
- Modify: `src/server.ts` — GET `/api/kb/context` (Task 4); Create: `test/context-route.test.ts`
- Modify: `web/src/types.ts`, `web/src/lib/api.ts`, `web/src/lib/demoKb.ts`; Create: `web/src/features/ContextPackModal.tsx`; Modify: `web/src/features/KnowledgeGraph.tsx` (Task 5)
- Modify: `docs/cli-reference.md`, `docs/knowledge-graph.md`, `STATUS.md` (Task 6)

---

### Task 1: Pure helpers — overview extraction, secret redaction, chatbot fits

**Files:**
- Create: `src/kb/contextpack.ts`
- Test: `test/contextpack.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 2 and 5 rely on these exact names):
  - `estTokens(text: string): number`
  - `extractOverview(readme: string, maxParagraphs?: number): string[]`
  - `extractConventionBullets(md: string, maxBullets?: number): string[]`
  - `redactSecrets(text: string): { text: string; redactions: number }`
  - `interface ChatbotFit { id: string; label: string; limit: number; ok: boolean }`
  - `chatbotFits(tokens: number): ChatbotFit[]`

- [ ] **Step 1: Write the failing tests**

Create `test/contextpack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  estTokens, extractOverview, extractConventionBullets, redactSecrets, chatbotFits,
} from '../src/kb/contextpack.js';

describe('estTokens', () => {
  it('is chars/4 rounded', () => {
    expect(estTokens('abcd')).toBe(1);
    expect(estTokens('abcdef')).toBe(2); // 6/4 = 1.5 → 2
    expect(estTokens('')).toBe(0);
  });
});

describe('extractOverview', () => {
  const README = [
    '<div align="center">',
    '',
    '# 🪄 Baton',
    '',
    '### Plan on your expensive agent.',
    '',
    '**Baton is a local coordination hub** for AI agents.',
    '',
    '![status](https://img.shields.io/badge/status-active-2ea043) ![license](https://img.shields.io/badge/license-MIT-blue)',
    '',
    '</div>',
    '',
    '---',
    '',
    'Developers increasingly run two or three AI coding tools at once.',
    '',
    '```bash',
    'npm install',
    '```',
    '',
    '> One file. No server lock-in.',
    '',
    'Third real paragraph here.',
  ].join('\n');

  it('keeps prose, skips headings/badges/HTML/fences/rules', () => {
    const paras = extractOverview(README, 4);
    expect(paras[0]).toBe('**Baton is a local coordination hub** for AI agents.');
    expect(paras[1]).toBe('Developers increasingly run two or three AI coding tools at once.');
    expect(paras[2]).toBe('One file. No server lock-in.'); // blockquote marker stripped
    expect(paras[3]).toBe('Third real paragraph here.');
    expect(paras.join(' ')).not.toContain('img.shields.io');
    expect(paras.join(' ')).not.toContain('npm install');
  });

  it('caps at maxParagraphs', () => {
    expect(extractOverview(README, 2)).toHaveLength(2);
  });

  it('joins wrapped lines within a paragraph and normalizes CRLF', () => {
    const md = 'First line\r\nsecond line of same paragraph.\r\n\r\nNext.';
    expect(extractOverview(md, 4)[0]).toBe('First line second line of same paragraph.');
  });

  it('returns [] for empty input', () => {
    expect(extractOverview('', 4)).toEqual([]);
  });
});

describe('extractConventionBullets', () => {
  it('takes list items only, capped', () => {
    const md = '# Rules\n\nProse here.\n- rule one\n* rule two\n- rule three\n';
    expect(extractConventionBullets(md, 2)).toEqual(['rule one', 'rule two']);
  });
});

describe('redactSecrets', () => {
  it('redacts AWS keys, PEM headers, assignments, and vendor tokens', () => {
    const input = [
      'key AKIAIOSFODNN7EXAMPLE here',
      '-----BEGIN RSA PRIVATE KEY-----',
      'api_key = "sk_live_abcdef123456789"',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n');
    const { text, redactions } = redactSecrets(input);
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('sk_live_abcdef123456789');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(text).toContain('[REDACTED]');
    expect(redactions).toBeGreaterThanOrEqual(4);
  });

  it('leaves normal pack prose alone', () => {
    const prose = '_~2,100 tokens (approximate, chars/4). Pastes into: ChatGPT free._\n- `npm run build` → `tsc`';
    const { text, redactions } = redactSecrets(prose);
    expect(text).toBe(prose);
    expect(redactions).toBe(0);
  });
});

describe('chatbotFits', () => {
  it('applies 8k/32k/128k thresholds inclusively', () => {
    const at8k = chatbotFits(8000);
    expect(at8k).toEqual([
      { id: 'chatgpt-free', label: 'ChatGPT free', limit: 8000, ok: true },
      { id: 'grok-free', label: 'Grok free', limit: 32000, ok: true },
      { id: 'deepseek', label: 'DeepSeek', limit: 128000, ok: true },
    ]);
    const over = chatbotFits(8001);
    expect(over[0].ok).toBe(false);
    expect(over[1].ok).toBe(true);
    expect(chatbotFits(200000).every((f) => !f.ok)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contextpack.test.ts`
Expected: FAIL — `Cannot find module '../src/kb/contextpack.js'`

- [ ] **Step 3: Implement the helpers**

Create `src/kb/contextpack.ts`:

```ts
/**
 * Context pack — one paste-able markdown brief of the project (or hub) for
 * EXTERNAL chatbots (ChatGPT, Grok, DeepSeek): overview, stack, annotated
 * tree, top graph symbols, fresh memory facts. No file bodies. Deterministic
 * (no LLM call), hard token budget, secrets redacted.
 * Spec: docs/superpowers/specs/2026-07-04-context-pack-design.md
 */

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/contextpack.test.ts`
Expected: PASS (all Task 1 describes)

- [ ] **Step 5: Build + full suite + commit**

Run: `npm run build && npx vitest run`
Expected: build clean; 271 + new tests all pass.

```bash
git add src/kb/contextpack.ts test/contextpack.test.ts
git commit -m "feat(kb): context-pack helpers — overview extraction, secret redaction, fit targets"
```

---

### Task 2: `buildContextPack()` — composer with hard budget, hub mode, degradation

**Files:**
- Modify: `src/kb/contextpack.ts` (append)
- Test: `test/contextpack.test.ts` (append)

**Interfaces:**
- Consumes (all already exported): Task 1 helpers; from `src/kb/codebasemd.ts`: `detectStack(path): Promise<StackInfo>`, `scanDir(path): Promise<DirNode>`, `renderTree(root: DirNode, maxLines?: number): string[]`, `extractGodNodes(graph: GraphJson, limit?: number): GodNode[]`, types `GraphJson`, `GodNode`, `DirNode`, `StackInfo`; from `src/kb/state.ts`: `type KbState`, `type KbProject`, `graphPathFor(projectPath)`; from `src/memory.ts`: `recallMemories(root, { limit })`, `memoryBriefSection(facts, staleDropped)`; from `src/util/exec.ts`: `gitTry(args, cwd)` → `{ ok, stdout, stderr }`.
- Produces (Tasks 3–4 rely on these exact names):
  - `interface ContextPackOptions { project?: string; maxTokens?: number; generatedAt?: string }`
  - `interface ContextPack { markdown: string; tokens: number; redactions: number; omitted: string[]; fits: ChatbotFit[] }`
  - `class UnknownProjectError extends Error { projects: string[] }`
  - `buildContextPack(root: string, state: KbState | null, opts?: ContextPackOptions): Promise<ContextPack>`

- [ ] **Step 1: Write the failing tests**

Append to `test/contextpack.test.ts` (add the new imports to the top of the file):

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { buildContextPack, UnknownProjectError } from '../src/kb/contextpack.js';
import type { KbState } from '../src/kb/state.js';
```

Then append:

```ts
describe('buildContextPack', () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true });
  });

  async function makeProject(name: string, opts: { readme?: string; graph?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `ctx-${name}-`));
    tmps.push(dir);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, scripts: { build: 'tsc' }, dependencies: { react: '^18' } }));
    if (opts.readme !== undefined) await writeFile(join(dir, 'README.md'), opts.readme);
    if (opts.graph) {
      await mkdir(join(dir, 'graphify-out'), { recursive: true });
      await writeFile(join(dir, 'graphify-out', 'graph.json'), JSON.stringify({
        nodes: [
          { id: 'a', label: 'createThing', file_type: 'function', source_file: 'src/index.ts', source_location: 'L1' },
          { id: 'b', label: 'helper', file_type: 'function', source_file: 'src/index.ts' },
        ],
        links: [{ source: 'a', target: 'b' }],
      }));
    }
    return dir;
  }

  const FIXED = { generatedAt: '2026-07-04' };

  it('renders a single project with no KB state (synthetic project)', async () => {
    const dir = await makeProject('solo', { readme: 'Solo is a test project that does things.\n' });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.markdown).toContain('Full source code is NOT included');
    expect(pack.markdown).toContain('Solo is a test project that does things.');
    expect(pack.markdown).toContain('## Folder structure');
    expect(pack.markdown).toContain('index.ts');
    expect(pack.markdown).toContain('**Stack:** node · react');
    expect(pack.markdown).toContain('knowledge graph not built'); // no graph fixture
    expect(pack.markdown).toContain('Pastes into:');
    expect(pack.tokens).toBeGreaterThan(0);
    expect(pack.fits).toHaveLength(3);
    expect(pack.redactions).toBe(0);
  });

  it('is byte-deterministic for fixed generatedAt', async () => {
    const dir = await makeProject('det', { readme: 'Deterministic project.\n' });
    const a = await buildContextPack(dir, null, FIXED);
    const b = await buildContextPack(dir, null, FIXED);
    expect(a.markdown).toBe(b.markdown);
  });

  it('includes key symbols when the graph exists', async () => {
    const dir = await makeProject('graphed', { readme: 'Has a graph.\n', graph: true });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('Key code symbols');
    expect(pack.markdown).toContain('`createThing` — src/index.ts:1');
  });

  it('falls back gracefully with no README', async () => {
    const dir = await makeProject('bare');
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.markdown).toContain('No README found');
  });

  it('throws UnknownProjectError listing valid ids', async () => {
    const dir = await makeProject('known', { readme: 'x\n' });
    const state: KbState = {
      root: dir, mergedGraphPath: null, lastBuiltAt: null,
      projects: [{ id: 'known', name: 'known', path: dir, graphPath: join(dir, 'graphify-out', 'graph.json') }],
    };
    await expect(buildContextPack(dir, state, { ...FIXED, project: 'nope' }))
      .rejects.toThrowError(UnknownProjectError);
    await expect(buildContextPack(dir, state, { ...FIXED, project: 'nope' }))
      .rejects.toThrowError(/known/);
  });

  it('renders hub mode: relate list + per-project sections; skips missing paths', async () => {
    const a = await makeProject('alpha', { readme: 'Alpha does A.\n' });
    const b = await makeProject('beta', { readme: 'Beta does B.\n' });
    const hub = await mkdtemp(join(tmpdir(), 'ctx-hub-'));
    tmps.push(hub);
    const state: KbState = {
      root: hub, mergedGraphPath: null, lastBuiltAt: null,
      projects: [
        { id: 'alpha', name: 'alpha', path: a, graphPath: join(a, 'graphify-out', 'graph.json') },
        { id: 'beta', name: 'beta', path: b, graphPath: join(b, 'graphify-out', 'graph.json') },
        { id: 'ghost', name: 'ghost', path: join(hub, 'gone'), graphPath: join(hub, 'gone', 'g.json') },
      ],
    };
    const pack = await buildContextPack(hub, state, FIXED);
    expect(pack.markdown).toContain('## How the repos relate');
    expect(pack.markdown).toContain('## alpha');
    expect(pack.markdown).toContain('## beta');
    expect(pack.markdown).toContain('Alpha does A.');
    expect(pack.markdown).toContain("skipped — path not found");
    expect(pack.omitted).toContain('ghost: path missing');
  });

  it('trims to the budget and records omissions', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with quite a few words in it to inflate the pack size for the trim test.`).join('\n\n');
    const dir = await makeProject('big', { readme: long, graph: true });
    const pack = await buildContextPack(dir, null, { ...FIXED, maxTokens: 400 });
    expect(pack.omitted.length).toBeGreaterThan(0);
    expect(pack.markdown).toContain('omitted to fit the token budget');
    // header + footer are never trimmed
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.markdown).toContain('Pastes into:');
  });

  it('redacts secrets found in the README and prepends a banner', async () => {
    const dir = await makeProject('leaky', { readme: 'Deploy with api_key = "sk_live_abcdef123456789" set.\n' });
    const pack = await buildContextPack(dir, null, FIXED);
    expect(pack.redactions).toBeGreaterThanOrEqual(1);
    expect(pack.markdown).not.toContain('sk_live_abcdef123456789');
    expect(pack.markdown.startsWith('> ⚠️')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/contextpack.test.ts`
Expected: FAIL — `buildContextPack` is not exported.

- [ ] **Step 3: Implement the composer**

Append to `src/kb/contextpack.ts` (and add these imports at the top of the file):

```ts
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
```

Then the composer:

```ts
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
    memorySection = memoryBriefSection(recalled.facts, recalled.staleDropped);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/contextpack.test.ts`
Expected: PASS. Note: the tmp fixtures are not git repos, so `commit` renders as `unknown` — that is what makes the determinism test stable.

- [ ] **Step 5: Build + full suite + commit**

Run: `npm run build && npx vitest run`
Expected: all green.

```bash
git add src/kb/contextpack.ts test/contextpack.test.ts
git commit -m "feat(kb): buildContextPack — budgeted, hub-aware shareable context pack"
```

---

### Task 3: CLI — `baton kb context [path]`

**Files:**
- Modify: `src/commands/kb.ts` (append command function + imports)
- Modify: `src/cli.ts` (register subcommand, extend the `./commands/kb.js` import)
- Test: `test/context-cli.test.ts`

**Interfaces:**
- Consumes: `buildContextPack`, `UnknownProjectError`, `ContextPack` from `../kb/contextpack.js`; `resolveBatonRoot(cwd?: string)` from `../store.js`; `loadKb` from `../kb/state.js` (already imported in kb.ts).
- Produces: `kbContextCmd(path: string | undefined, opts: { project?: string; out?: string; tokens?: string }): Promise<void>` exported from `src/commands/kb.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/context-cli.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kbContextCmd } from '../src/commands/kb.js';

describe('kbContextCmd', () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-cli-'));
    tmps.push(dir);
    await mkdir(join(dir, '.baton'), { recursive: true }); // resolveBatonRoot anchor
    await writeFile(join(dir, 'README.md'), 'CLI test project.\n');
    return dir;
  }

  it('--out writes the pack and reports on stderr', async () => {
    const dir = await makeRepo();
    const out = join(dir, 'pack.md');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kbContextCmd(dir, { out });
    expect(existsSync(out)).toBe(true);
    const md = await readFile(out, 'utf-8');
    expect(md).toContain('— project context pack');
    expect(md).toContain('CLI test project.');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('context pack →'));
  });

  it('prints to stdout without --out', async () => {
    const dir = await makeRepo();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    await kbContextCmd(dir, {});
    spy.mockRestore();
    expect(writes.join('')).toContain('— project context pack');
  });

  it('unknown --project reports valid ids and sets exitCode', async () => {
    const dir = await makeRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kbContextCmd(dir, { project: 'nope' });
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('valid:'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/context-cli.test.ts`
Expected: FAIL — `kbContextCmd` is not exported.

- [ ] **Step 3: Implement the command**

In `src/commands/kb.ts`, add to the imports:

```ts
import { buildContextPack, UnknownProjectError } from '../kb/contextpack.js';
import { resolveBatonRoot } from '../store.js';
```

Append the command (after `kbMcpCmd`):

```ts
/** `baton kb context` — print/write the shareable markdown pack for external chatbots. */
export async function kbContextCmd(
  path: string | undefined,
  opts: { project?: string; out?: string; tokens?: string } = {},
): Promise<void> {
  const root = await resolveBatonRoot(path ? resolve(path) : process.cwd());
  const state = await loadKb(root);
  const maxTokens = Math.max(1000, Math.min(200_000, Number(opts.tokens ?? 8000) || 8000));
  let pack;
  try {
    pack = await buildContextPack(root, state, { project: opts.project, maxTokens });
  } catch (e) {
    if (e instanceof UnknownProjectError) {
      console.error(`no project '${opts.project}' — valid: ${e.projects.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (opts.out) {
    const file = resolve(opts.out);
    await writeFile(file, pack.markdown, 'utf-8');
    const extras = [
      `~${pack.tokens.toLocaleString()} tokens`,
      ...(pack.redactions ? [`${pack.redactions} secret${pack.redactions === 1 ? '' : 's'} redacted`] : []),
    ].join(', ');
    console.error(`✓ context pack → ${file} (${extras})`);
  } else {
    process.stdout.write(pack.markdown);
  }
}
```

(`resolve`, `writeFile`, and `loadKb` are already imported at the top of kb.ts.)

In `src/cli.ts`, add `kbContextCmd` to the existing `./commands/kb.js` import list, and register after the `kb.command('mcp')` block:

```ts
kb.command('context')
  .argument('[path]', 'project or hub root (default: nearest .baton, else git root)')
  .option('--project <id>', 'hub: render one sub-project instead of the combined pack')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('--tokens <n>', 'token budget (default 8000 — fits ChatGPT free tier)')
  .description('print a shareable markdown context pack for any external chatbot (pipe to pbcopy)')
  .action((path: string | undefined, opts: { project?: string; out?: string; tokens?: string }) =>
    run(() => kbContextCmd(path, opts)));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/context-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke + build + full suite + commit**

Run: `npm run build && node dist/cli.js kb context | head -30`
Expected: this Baton repo's own pack prints (title, note, overview from README).

Run: `npx vitest run`
Expected: all green.

```bash
git add src/commands/kb.ts src/cli.ts test/context-cli.test.ts
git commit -m "feat(cli): baton kb context — shareable markdown pack (stdout or --out)"
```

---

### Task 4: Daemon route — `GET /api/kb/context`

**Files:**
- Modify: `src/server.ts` (new route after the `GET /api/kb/graph` block, before `POST /api/kb/rebuild`)
- Test: `test/context-route.test.ts`

**Interfaces:**
- Consumes: `buildContextPack`, `UnknownProjectError` from `./kb/contextpack.js`; existing `send`, `loadKb`, `url`, `origin` in server.ts scope.
- Produces: `GET /api/kb/context?project=<id|all>&tokens=<n>&format=<md|json>` — `200 text/markdown; charset=utf-8` by default; `format=json` → the `ContextPack` object as JSON; unknown project → `404 { error, projects }`. Read-only (not write-gated). Task 5 consumes the JSON form.

- [ ] **Step 1: Write the failing test**

Create `test/context-route.test.ts` (same daemon-spawn pattern as `test/graphify-proxy.test.ts`, but no uv/graph needed — gated on `dist/cli.js` only):

```ts
/**
 * E2E test for GET /api/kb/context. Spawns `node dist/cli.js serve` against a
 * temp root with a .baton dir (no KB, no git — exercises the degraded path).
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

async function waitForDaemon(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon on :${port} did not become ready within ${timeoutMs}ms`);
}

describe.runIf(hasDist)('GET /api/kb/context', () => {
  let child: ChildProcess | null = null;
  let dir = '';
  const port = 7300 + Math.floor(Math.random() * 500);

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = null;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves markdown, json, and 404 for unknown projects', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctx-route-'));
    await mkdir(join(dir, '.baton'), { recursive: true });
    await writeFile(join(dir, 'README.md'), 'Route test project.\n');
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port)], { cwd: dir, stdio: 'ignore' });
    await waitForDaemon(port);

    const md = await fetch(`http://127.0.0.1:${port}/api/kb/context`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    const body = await md.text();
    expect(body).toContain('— project context pack');
    expect(body).toContain('Route test project.');

    const json = await fetch(`http://127.0.0.1:${port}/api/kb/context?format=json`);
    expect(json.status).toBe(200);
    const pack = await json.json() as { markdown: string; tokens: number; fits: unknown[] };
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.tokens).toBeGreaterThan(0);
    expect(pack.fits).toHaveLength(3);

    const missing = await fetch(`http://127.0.0.1:${port}/api/kb/context?project=nope`);
    expect(missing.status).toBe(404);
    const err = await missing.json() as { projects: string[] };
    expect(Array.isArray(err.projects)).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/context-route.test.ts`
Expected: FAIL — the markdown fetch returns 404/does not match (route missing). (Build first so `hasDist` gates on.)

- [ ] **Step 3: Implement the route**

In `src/server.ts`, add to the imports from kb modules:

```ts
import { buildContextPack, UnknownProjectError } from './kb/contextpack.js';
```

Insert after the `GET /api/kb/graph` block (which ends around line 472) and before `POST /api/kb/rebuild`:

```ts
  // GET /api/kb/context?project=<id|all>&tokens=<n>&format=<md|json> —
  // the shareable markdown pack for external chatbots. Read-only; works
  // without an initialized KB (degrades to README + stack + tree).
  if (method === 'GET' && path === '/api/kb/context') {
    const state = await loadKb(root);
    const projectParam = url.searchParams.get('project');
    const project = projectParam && projectParam !== 'all' ? projectParam : undefined;
    const tokensRaw = Number(url.searchParams.get('tokens') ?? 8000);
    const maxTokens = Math.max(1000, Math.min(200_000, Number.isFinite(tokensRaw) ? tokensRaw : 8000));
    try {
      const pack = await buildContextPack(root, state, { project, maxTokens });
      if (url.searchParams.get('format') === 'json') return send(res, 200, pack, origin);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
      });
      res.end(pack.markdown);
      return;
    } catch (e) {
      if (e instanceof UnknownProjectError) {
        return send(res, 404, { error: `no project '${project}'`, projects: e.projects }, origin);
      }
      throw e;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run test/context-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run`
Expected: all green.

```bash
git add src/server.ts test/context-route.test.ts
git commit -m "feat(server): GET /api/kb/context — read-only context-pack route (md + json)"
```

---

### Task 5: Dashboard — Share-context modal with Copy + Download

**Files:**
- Modify: `web/src/types.ts` (append `ContextPackResponse`)
- Modify: `web/src/lib/demoKb.ts` (append `DEMO_CONTEXT_PACK`)
- Modify: `web/src/lib/api.ts` (append `getKbContext`)
- Create: `web/src/features/ContextPackModal.tsx`
- Modify: `web/src/features/KnowledgeGraph.tsx` (Share context button + modal mount)

**Interfaces:**
- Consumes: `GET /api/kb/context?format=json` from Task 4 (`ContextPack` shape); existing `CopyButton` (`web/src/components/primitives.tsx`), `Icon`, `showToast`, `BatonAPI.request`/`demoGate` patterns.
- Produces: `BatonAPI.getKbContext(project?: string): Promise<ContextPackResponse>`; `<ContextPackModal project={string|null} onClose={() => void} />`.

There is no web test runner — verification is `tsc` via `npm run build --prefix web` plus a manual demo-mode check.

- [ ] **Step 1: Add the type**

Append to `web/src/types.ts`:

```ts
/** GET /api/kb/context?format=json — the shareable context pack. */
export interface ContextPackResponse {
  markdown: string;
  tokens: number;
  redactions: number;
  omitted: string[];
  fits: { id: string; label: string; limit: number; ok: boolean }[];
}
```

- [ ] **Step 2: Add the demo fixture**

Append to `web/src/lib/demoKb.ts` (import `ContextPackResponse` from `../types` at the top):

```ts
const DEMO_PACK_MD = `# shop — project context pack

Generated 2026-07-04 · commit demo123 · by \`baton kb context\`

> **Note for the assistant reading this:** this is a generated context pack.
> Full source code is NOT included. If you need the contents of a specific
> file, ask the user to paste it.

## How the repos relate

- **api** — \`api/\` (node · express) — REST backend for the shop.
- **web** — \`web/\` (node · react · vite) — Customer-facing storefront.

## api

### Overview

REST backend for the shop: orders, payments, inventory.

### Stack & commands

**Stack:** node · express

- \`dev\` → \`nodemon src/index.ts\`
- \`test\` → \`vitest run\`

### Folder structure

\`\`\`
src/
  routes/
    orders.ts
    payments.ts
  db/
    schema.ts
\`\`\`

### Key code symbols (most connected in the code graph)

- \`createOrder\` — src/routes/orders.ts:12 (14 connections)
- \`chargeCard\` — src/routes/payments.ts:8 (9 connections)

## Project memory (evidence-checked)

- [decision] Payments retry at most twice, then park the order.

---

_~640 tokens (approximate, chars/4). Pastes into: ChatGPT free · Grok free · DeepSeek._
`;

export const DEMO_CONTEXT_PACK: ContextPackResponse = {
  markdown: DEMO_PACK_MD,
  tokens: 640,
  redactions: 0,
  omitted: [],
  fits: [
    { id: 'chatgpt-free', label: 'ChatGPT free', limit: 8000, ok: true },
    { id: 'grok-free', label: 'Grok free', limit: 32000, ok: true },
    { id: 'deepseek', label: 'DeepSeek', limit: 128000, ok: true },
  ],
};
```

- [ ] **Step 3: Add the API method**

In `web/src/lib/api.ts`: add `DEMO_CONTEXT_PACK` to the existing `./demoKb` import and `ContextPackResponse` to the `../types` type imports (both import statements already exist). Then append next to `getKb()`:

```ts
  /** The shareable context pack (markdown + metadata) for a project or the whole hub. */
  async getKbContext(project?: string): Promise<ContextPackResponse> {
    if (this.demo) {
      await this.demoGate(150);
      return DEMO_CONTEXT_PACK;
    }
    const q = project ? `?format=json&project=${encodeURIComponent(project)}` : '?format=json';
    return this.request<ContextPackResponse>(`/api/kb/context${q}`);
  }
```

- [ ] **Step 4: Create the modal**

Create `web/src/features/ContextPackModal.tsx`:

```tsx
/* ============================================================
   BATON — Context-pack modal ("Share context")
   Fetches /api/kb/context?format=json and offers Copy / Download —
   a paste-able project brief for external chatbots.
   ============================================================ */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { CopyButton } from "../components/primitives";
import { BatonAPI } from "../lib/api";
import type { ContextPackResponse } from "../types";

export function ContextPackModal({ project, onClose }: { project: string | null; onClose: () => void }) {
  const [pack, setPack] = useState<ContextPackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    BatonAPI.getKbContext(project ?? undefined)
      .then((p) => { if (!cancelled) setPack(p); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = () => {
    if (!pack) return;
    const blob = new Blob([pack.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project ?? "project"}-context.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Share context"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "color-mix(in srgb, var(--bg-base) 62%, transparent)", display: "grid", placeItems: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(760px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column", gap: 12, background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: 14, padding: 18, boxShadow: "0 24px 64px rgba(0,0,0,.35)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="share" size={16} />
          <div style={{ fontWeight: "var(--fw-semibold)" }}>Share context</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm fr" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
          A paste-able brief of this project for any chatbot (ChatGPT, Grok, DeepSeek…) — no source code included.
        </div>
        {error && <div style={{ color: "var(--conflict-text)", fontSize: "var(--fs-12)" }}>{error}</div>}
        {!pack && !error && <div className="skeleton" style={{ height: 220, borderRadius: 10 }} />}
        {pack && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                ~{pack.tokens.toLocaleString()} tokens
              </span>
              {pack.fits.map((f) => (
                <span key={f.id} style={{
                  display: "inline-flex", alignItems: "center", gap: 4, height: 20, padding: "0 8px",
                  borderRadius: "var(--r-full)", fontSize: "var(--fs-12)",
                  color: f.ok ? "var(--clean-text)" : "var(--text-tertiary)",
                  background: f.ok ? "var(--clean-soft)" : "var(--bg-active)",
                  border: `1px solid ${f.ok ? "var(--clean-border)" : "var(--border-subtle)"}`,
                }}>
                  <Icon name={f.ok ? "check" : "x"} size={11} /> {f.label}
                </span>
              ))}
            </div>
            {pack.redactions > 0 && (
              <div style={{ fontSize: "var(--fs-12)", color: "var(--conflict-text)" }}>
                ⚠️ {pack.redactions} secret-looking value{pack.redactions === 1 ? "" : "s"} redacted.
              </div>
            )}
            {pack.omitted.length > 0 && (
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                Trimmed to fit the budget: {pack.omitted.join(", ")}
              </div>
            )}
            <pre style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 0, padding: 12, borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--bg-base)", fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", userSelect: "text" }}>
              {pack.markdown}
            </pre>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn fr" onClick={download} style={{ height: 30 }}>
                <Icon name="arrowRight" size={14} style={{ transform: "rotate(90deg)" }} /> Download .md
              </button>
              <CopyButton value={pack.markdown} label="Copy markdown" className="btn btn-primary" title="Copy the whole pack" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

(If the `Icon` set has no `"x"` name, check `web/src/components/Icon.tsx` and use the existing close-icon name, e.g. `"close"` — keep whichever exists.)

- [ ] **Step 5: Wire the button into KnowledgeGraph**

In `web/src/features/KnowledgeGraph.tsx`:

1. Import: `import { ContextPackModal } from "./ContextPackModal";`
2. Add state next to the other `useState` calls: `const [shareOpen, setShareOpen] = useState(false);`
3. In the `<ScreenHeader>` children, add BEFORE the Export link:

```tsx
        <button className="btn fr" onClick={() => setShareOpen(true)}
          data-tip="Markdown brief of this project for any external chatbot"
          style={{ height: 30 }}>
          <Icon name="share" size={14} /> Share context
        </button>
```

4. At the end of the returned JSX (inside the root `<div>`, after everything else):

```tsx
      {shareOpen && (
        <ContextPackModal
          project={activeId === "merged" ? null : activeId}
          onClose={() => setShareOpen(false)} />
      )}
```

(`merged` maps to `null` → the combined hub pack.)

- [ ] **Step 6: Verify the web build**

Run: `npm run build --prefix web`
Expected: strict tsc + vite build pass with no errors.

- [ ] **Step 7: Manual demo-mode check**

Run: `npm run dev --prefix web` and open the printed URL (demo defaults ON on the Vite dev origin). Knowledge Graph screen → "Share context" → modal shows the demo pack, fit chips, Copy toasts "Copied to clipboard", Download saves a `.md`. Stop the dev server after.

- [ ] **Step 8: Commit**

```bash
git add web/src/types.ts web/src/lib/demoKb.ts web/src/lib/api.ts web/src/features/ContextPackModal.tsx web/src/features/KnowledgeGraph.tsx
git commit -m "feat(web): Share-context modal — copy/download the context pack from the dashboard"
```

---

### Task 6: Docs + STATUS

**Files:**
- Modify: `docs/cli-reference.md` (kb section — follow the file's existing per-command format exactly)
- Modify: `docs/knowledge-graph.md` (new section)
- Modify: `STATUS.md` (what-is-built entry)

**Interfaces:**
- Consumes: final CLI flags from Task 3, route shape from Task 4.
- Produces: docs only.

- [ ] **Step 1: cli-reference.md**

Add a `baton kb context` entry to the kb command section, matching the surrounding entries' format, with this content:

```markdown
### `baton kb context [path]`

Print a shareable markdown **context pack** — a ≤ ~8k-token brief of the
project (overview, stack, folder tree, key graph symbols, fresh memory facts,
**no source code**) that pastes into any external chatbot (ChatGPT, Grok,
DeepSeek). Secrets are redacted. Not the same as `kb export`, which produces a
machine pack for `kb import`.

| Flag | Meaning |
|---|---|
| `--project <id>` | hub: render one sub-project instead of the combined pack |
| `--out <file>` | write to a file instead of stdout |
| `--tokens <n>` | token budget (default 8000 — fits ChatGPT's free tier) |

```bash
baton kb context | pbcopy        # copy the whole-hub brief to the clipboard
baton kb context --project api --out api-context.md
```
```

- [ ] **Step 2: knowledge-graph.md**

Add a section (after the export/import section):

```markdown
## Share the project with any chatbot (context pack)

Hit a usage limit on your coding agent and want to continue in ChatGPT, Grok,
or DeepSeek? `baton kb context` renders everything Baton knows about the
project into one paste-able markdown brief — overview, stack, annotated folder
tree, the graph's most-connected symbols, and fresh (evidence-checked) memory
facts. No file contents are included, secret-looking strings are redacted, and
the output is capped at a token budget (default 8k, ChatGPT-free-tier sized —
the footer says which chatbots it fits).

In the dashboard: **Knowledge Graph → Share context** → Copy to clipboard or
Download `.md`. Over HTTP: `GET /api/kb/context?project=<id|all>&format=json`
(read-only). The pack works even before `baton kb init` — it just degrades to
README + structure until a graph exists.
```

- [ ] **Step 3: STATUS.md**

Add one entry to the "what is built" list, matching its existing style:

```markdown
- **Context pack** (`baton kb context`, `GET /api/kb/context`, dashboard
  "Share context" modal) — budgeted (≤ ~8k tokens), deterministic, secret-redacted
  markdown brief of the project/hub for pasting into external chatbots.
  Spec: docs/superpowers/specs/2026-07-04-context-pack-design.md.
```

- [ ] **Step 4: Build + full suite + commit**

Run: `npm run build && npx vitest run && npm run build --prefix web`
Expected: all green.

```bash
git add docs/cli-reference.md docs/knowledge-graph.md STATUS.md
git commit -m "docs(kb): document baton kb context + dashboard Share-context modal"
```

---

## Self-review notes

- Spec coverage: layout §→Task 2 render; budget §→TRIM_STAGES loop; secrets §→Task 1+2; CLI/API/dashboard §→Tasks 3/4/5; edge-case table→Tasks 2 (no-KB, no-README, missing path, unknown project, secrets), 4 (route 404, degraded root), 5 (demo mode); testing §→each task's tests. The spec's "per-repo budget = remaining/count" is implemented as uniform per-project trim stages — same hard-ceiling guarantee, simpler and deterministic.
- Fit-chip thresholds are tested server-side (`chatbotFits`, Task 1); web renders the server's verdicts, so no web test runner is needed.
- `scanDir` sorts with `localeCompare` (pre-existing) — determinism is per-machine, which is what the byte-identical test exercises.
