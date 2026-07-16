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
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { recallMemories, memoryBriefSection } from '../memory.js';
import { listReports, type CompletionReport } from '../reports.js';
import { resolveMcpRoot } from '../store.js';
import { gitRoot } from '../git.js';
import { gitTry } from '../util/exec.js';
import { loadKb } from './state.js';
import { graphFreshness, renderGraphFreshnessNote, renderBranchDivergenceNote, worktreeGraphDivergence } from './freshness.js';

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
  /** One-line worktree nudge for main-checkout sessions (G2), or ''. */
  worktreeHint?: string;
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
  const hint = (parts.worktreeHint ?? '').trim(); // a nudge — first to go under budget

  const durable = [freshness, codebase, memory, reports, hint].filter(Boolean);
  if (durable.length === 0) {
    // Nothing learned yet — still orient the agent on how to proceed.
    return [header, 'No project memory or shipped tasks recorded yet — you are getting started fresh. As you learn decisions/gotchas, `save_memory` them so the next agent skips the rediscovery.', TOOLS_POINTER].join('\n\n');
  }

  // Fit within budget: drop trailing sections (reports first), then trim memory,
  // but the header and live-tools pointer are non-negotiable.
  const fixed = `${header}\n\n${TOOLS_POINTER}`.length + 4; // + section joins
  let sections = [freshness, codebase, memory, reports, hint].filter(Boolean);
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

/**
 * The kb project a session's cwd belongs to. Path-prefix first; for a LINKED
 * WORKTREE (whose path is outside every project) resolve the owning repo via
 * git-common-dir — `<project>/.git` — so worktree sessions still get graph
 * warnings (in a hub they previously matched nothing and got none).
 */
async function projectForCwd(state: NonNullable<Awaited<ReturnType<typeof loadKb>>>, at: string) {
  const byPath = state.projects.find((p) => at === p.path || at.startsWith(p.path + sep));
  if (byPath) return byPath;
  const common = await gitTry(['rev-parse', '--path-format=absolute', '--git-common-dir'], at);
  if (common.ok) {
    const owner = dirname(common.stdout.trim());
    const byRepo = state.projects.find((p) => resolvePath(p.path) === resolvePath(owner));
    if (byRepo) return byRepo;
  }
  return state.projects.length === 1 ? state.projects[0] : state.projects.find((p) => p.path === root0(state));
}
const root0 = (state: { root?: string }) => state.root ?? '';

/** Linked worktree (vs main checkout): its private git dir differs from the shared common dir. */
async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const r = await gitTry(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], cwd);
  if (!r.ok) return false;
  const [gitDir, commonDir] = r.stdout.trim().split('\n').map((l) => resolvePath(l.trim()));
  return !!gitDir && !!commonDir && gitDir !== commonDir;
}

async function freshnessNoteFor(root: string, cwd?: string): Promise<string> {
  try {
    const state = await loadKb(root);
    if (!state || state.projects.length === 0) return '';
    const at = cwd ?? root;
    const project = await projectForCwd(state, at);
    if (!project) return '';
    const fresh = await graphFreshness(project.path, project.graphPath);
    const notes = [renderGraphFreshnessNote(fresh)];
    // W2: a worktree session's branch can differ from the graph's build point —
    // the graph then describes code this branch does not have.
    if (fresh.builtAtCommit && resolvePath(at) !== resolvePath(project.path) && !at.startsWith(project.path + sep)) {
      const diverged = await worktreeGraphDivergence(at, fresh.builtAtCommit);
      notes.push(renderBranchDivergenceNote(diverged, fresh.builtAtCommit));
    }
    return notes.filter(Boolean).join('\n');
  } catch {
    return ''; // freshness is a warning, never a blocker
  }
}

/** Gather durable state for a repo and render the brief. */
export async function buildOrientation(root: string, opts: { topic?: string; cwd?: string } = {}): Promise<string> {
  let memorySection = '';
  try {
    const recalled = await recallMemories(root, { topic: opts.topic, limit: 6 });
    memorySection = memoryBriefSection(recalled.facts, recalled.staleDropped, recalled.staleGrounding);
  } catch { /* memory is an enhancement — never block orientation */ }

  let reports: CompletionReport[] = [];
  try {
    reports = listReports(root, 5);
  } catch { /* reports optional */ }

  const freshnessNote = await freshnessNoteFor(root, opts.cwd);
  const hasCodebaseMd = existsSync(join(root, 'CODEBASE.md'));
  // G2/W3: one-line placement nudge. Main checkout → suggest isolating via
  // `baton new`. An UNMANAGED worktree (created outside baton) → say so:
  // coordination still works, but nothing auto-cleans it after merge — a real
  // hub accumulated 60+ of these (~13GB of merged dead weight).
  let worktreeHint = '';
  if (opts.cwd && !/\.baton[\\/]wt[\\/]/.test(opts.cwd)) {
    worktreeHint = (await isLinkedWorktree(opts.cwd))
      ? '_This is an unmanaged worktree (created outside `baton new`). Coordination works here, but nothing auto-removes it after its branch merges — it stays on disk until someone runs `baton clean`. Prefer `baton new "<task>"` for the next task._'
      : '_Working in the main checkout — fine for solo work. For parallel sessions without merge conflicts, isolate the task first: `baton new "<task>"`, then start the agent inside the worktree it prints._';
  }
  return renderOrientation({ hasCodebaseMd, freshnessNote, memorySection, reports, worktreeHint });
}

/** Resolve the coordination root and build the brief (for the CLI / hook / MCP tool). */
export async function orientForCwd(cwd: string = process.cwd(), opts: { topic?: string } = {}): Promise<string> {
  // memory/reports resolve their own store from a git path; use the git root so
  // hub sub-repos and worktrees behave like the MCP tools do.
  const gitPath = await gitRoot(cwd).catch(() => cwd);
  const root = await resolveMcpRoot(cwd).catch(() => gitPath);
  return buildOrientation(root, { ...opts, cwd });
}
