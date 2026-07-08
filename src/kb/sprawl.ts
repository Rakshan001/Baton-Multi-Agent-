/**
 * `.md`-sprawl scan (P12, piece 1) — detect the scattered agent files Baton
 * exists to replace, and PROPOSE where they belong. Propose-only by design:
 * importing a `memory-bank/` into Baton memory can't be auto-applied (saveMemory
 * caps facts at 1,200 chars / 500 total, so bulk import would overflow or fail
 * validation), and moving docs is a human judgement call.
 *
 * The classifier is pure over a repo-relative POSIX path list, so it is fully
 * unit-tested; the git-backed file listing + printing live in the doctor command.
 */
import { gitTry } from '../util/exec.js';

export type SprawlKind = 'memory-bank' | 'stray-notes' | 'duplicate-rules';

export interface SprawlFinding {
  kind: SprawlKind;
  /** The offending file paths (repo-relative). */
  paths: string[];
  /** Propose-only guidance for the human. */
  suggestion: string;
}

/** Tooling footprint we never flag — Baton's own output and standard build dirs. */
const IGNORED_ROOTS = ['.git/', '.baton/', 'node_modules/', 'dist/', 'build/', 'graphify-out/', '.refs/'];

/** Per-agent rule files that drift from a single AGENTS.md — keyed by agent. */
function driftAgent(path: string): string | null {
  if (path === '.cursorrules' || path.startsWith('.cursor/rules/')) return 'cursor';
  if (path === 'GEMINI.md') return 'gemini';
  if (path === '.clinerules' || path.startsWith('.clinerules/')) return 'cline';
  if (path === '.windsurfrules') return 'windsurf';
  if (path === '.github/copilot-instructions.md') return 'copilot';
  return null;
}

const STRAY_NOTE = /^(notes|scratch|scratchpad|todo)\.md$/i;
const STRAY_NOTE_PREFIX = /^todo[-_].+\.md$/i;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Classify a repo's files into sprawl findings. Deterministic order
 * (memory-bank, stray-notes, duplicate-rules); each kind appears at most once.
 */
export function scanDocSprawl(files: string[]): SprawlFinding[] {
  const paths = files.filter((p) => !IGNORED_ROOTS.some((r) => p === r.slice(0, -1) || p.startsWith(r)));

  const memoryBank: string[] = [];
  const strayNotes: string[] = [];
  const ruleFiles: string[] = [];
  const agents = new Set<string>();

  for (const p of paths) {
    if (p.split('/').some((seg) => seg.toLowerCase() === 'memory-bank')) {
      memoryBank.push(p);
      continue;
    }
    const agent = driftAgent(p);
    if (agent) {
      ruleFiles.push(p);
      agents.add(agent);
      continue;
    }
    // stray notes: root/scattered, but anything already under docs/ is organized.
    if (!p.startsWith('docs/')) {
      const base = basename(p);
      if (STRAY_NOTE.test(base) || STRAY_NOTE_PREFIX.test(base)) strayNotes.push(p);
    }
  }

  const findings: SprawlFinding[] = [];
  if (memoryBank.length) {
    findings.push({
      kind: 'memory-bank',
      paths: memoryBank,
      suggestion:
        'Import the durable facts via `baton memory add` (propose-only — Baton caps facts at ' +
        '1,200 chars / 500 total, so there is no safe bulk auto-import), then delete the directory.',
    });
  }
  if (strayNotes.length) {
    findings.push({
      kind: 'stray-notes',
      paths: strayNotes,
      suggestion:
        'Move under docs/ (Diátaxis: explanation/ or how-to/) or fold the durable parts into ' +
        'Baton memory; drop the rest.',
    });
  }
  // 2+ DISTINCT agents' rule files → they should be one AGENTS.md. Multiple files
  // for a single agent (e.g. several .cursor/rules/*.mdc) is a legit pattern, not sprawl.
  if (agents.size >= 2) {
    findings.push({
      kind: 'duplicate-rules',
      paths: ruleFiles,
      suggestion:
        'Consolidate into a single AGENTS.md (Cursor and Gemini read it natively); ' +
        'per-agent rule files drift apart over time.',
    });
  }
  return findings;
}

/** Tracked + untracked-not-ignored files, repo-relative (git already drops .gitignore’d paths). */
export async function listRepoFiles(root: string): Promise<string[]> {
  const res = await gitTry(['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard']);
  if (!res.ok) return [];
  return res.stdout.split('\n').filter(Boolean);
}

/** Best-effort last-commit date (YYYY-MM-DD) for a path, '' when unknown. */
export async function lastCommitDate(root: string, path: string): Promise<string> {
  const res = await gitTry(['-C', root, 'log', '-1', '--format=%cs', '--', path]);
  return res.ok ? res.stdout.trim() : '';
}
