/**
 * `orient` — a small, budgeted onboarding brief a fresh agent session gets so it
 * understands the project without re-exploring the repo. DURABLE content only
 * (CODEBASE.md pointer, evidence-checked memory facts, recently shipped work) +
 * a one-line pointer to the LIVE coordination tools — never a snapshot of live
 * signals, which would be stale within minutes (and Baton's own thesis is that
 * stale context is worse than none).
 *
 * Served two ways: the `orient` MCP tool (all agents) and a Claude SessionStart
 * hook (`baton orient --auto`).
 */
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { recallMemories, memoryBriefSection } from '../memory.js';
import { listReports, type CompletionReport } from '../reports.js';
import { resolveMcpRoot } from '../store.js';
import { gitRoot } from '../git.js';
import { loadKb } from './state.js';
import { graphFreshness, renderGraphFreshnessNote } from './freshness.js';

/** ~800 tokens. Focused context beats a big dump (Chroma "Context Rot"). */
export const ORIENT_MAX_CHARS = 3200;

const TOOLS_POINTER =
  '_Live coordination: call `check_files` before editing shared files, `list_signals` for who is editing right now, `get_report <slug>` to see what a finished task shipped._';

export interface OrientParts {
  hasCodebaseMd: boolean;
  /** Graph-freshness warning (G1 golden rule), or '' when the graph is current. */
  freshnessNote?: string;
  /** Pre-rendered memory block (from memoryBriefSection), or '' if none. */
  memorySection: string;
  reports: CompletionReport[];
}

function reportsSection(reports: CompletionReport[]): string {
  if (!reports.length) return '';
  const lines = reports.slice(0, 5).map((r) => `- ${r.task} (\`${r.slug}\`): ${(r.summary || '').split('\n')[0]}`);
  return `## Recently shipped\n\n${lines.join('\n')}`;
}

/**
 * Pure renderer: assemble the durable sections newest-value-first, always keep
 * the live-tools pointer, and drop the lowest-priority section ("recently
 * shipped") before the pointer when over budget.
 */
export function renderOrientation(parts: OrientParts, maxChars: number = ORIENT_MAX_CHARS): string {
  const header = '# Baton orientation';
  const codebase = parts.hasCodebaseMd
    ? 'Read **CODEBASE.md** for the repo structure, stack, and the biggest files.'
    : '';
  // A safety warning, not context — placed first so the budget never drops it.
  const freshness = (parts.freshnessNote ?? '').trim();
  const memory = parts.memorySection.trim();
  const reports = reportsSection(parts.reports);

  const durable = [freshness, codebase, memory, reports].filter(Boolean);
  if (durable.length === 0) {
    // Nothing learned yet — still orient the agent on how to proceed.
    return [header, 'No project memory or shipped tasks recorded yet — you are getting started fresh. As you learn decisions/gotchas, `save_memory` them so the next agent skips the rediscovery.', TOOLS_POINTER].join('\n\n');
  }

  // Fit within budget: drop trailing sections (reports first), then trim memory,
  // but the header and live-tools pointer are non-negotiable.
  const fixed = `${header}\n\n${TOOLS_POINTER}`.length + 4; // + section joins
  let sections = [freshness, codebase, memory, reports].filter(Boolean);
  while (sections.length && fixed + sections.join('\n\n').length > maxChars) {
    if (sections.length > 1) sections = sections.slice(0, -1); // drop the lowest-priority section
    else {
      // last remaining section still too big — hard-trim it
      const room = Math.max(0, maxChars - fixed - 1);
      sections = [sections[0].slice(0, room)];
      break;
    }
  }
  return [header, ...sections, TOOLS_POINTER].join('\n\n').slice(0, maxChars);
}

/** The kb project this session sits in: cwd match first, else the only/root project. */
async function freshnessNoteFor(root: string, cwd?: string): Promise<string> {
  try {
    const state = await loadKb(root);
    if (!state || state.projects.length === 0) return '';
    const at = cwd ?? root;
    const project =
      state.projects.find((p) => at === p.path || at.startsWith(p.path + sep)) ??
      (state.projects.length === 1 ? state.projects[0] : state.projects.find((p) => p.path === root));
    if (!project) return '';
    return renderGraphFreshnessNote(await graphFreshness(project.path, project.graphPath));
  } catch {
    return ''; // freshness is a warning, never a blocker
  }
}

/** Gather durable state for a repo and render the brief. */
export async function buildOrientation(root: string, opts: { topic?: string; cwd?: string } = {}): Promise<string> {
  let memorySection = '';
  try {
    const recalled = await recallMemories(root, { topic: opts.topic, limit: 6 });
    memorySection = memoryBriefSection(recalled.facts, recalled.staleDropped);
  } catch { /* memory is an enhancement — never block orientation */ }

  let reports: CompletionReport[] = [];
  try {
    reports = listReports(root, 5);
  } catch { /* reports optional */ }

  const freshnessNote = await freshnessNoteFor(root, opts.cwd);
  const hasCodebaseMd = existsSync(join(root, 'CODEBASE.md'));
  return renderOrientation({ hasCodebaseMd, freshnessNote, memorySection, reports });
}

/** Resolve the coordination root and build the brief (for the CLI / hook / MCP tool). */
export async function orientForCwd(cwd: string = process.cwd(), opts: { topic?: string } = {}): Promise<string> {
  // memory/reports resolve their own store from a git path; use the git root so
  // hub sub-repos and worktrees behave like the MCP tools do.
  const gitPath = await gitRoot(cwd).catch(() => cwd);
  const root = await resolveMcpRoot(cwd).catch(() => gitPath);
  return buildOrientation(root, { ...opts, cwd });
}
