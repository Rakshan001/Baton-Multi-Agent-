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
