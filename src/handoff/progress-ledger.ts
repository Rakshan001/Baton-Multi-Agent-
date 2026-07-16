/**
 * Agent-agnostic progress ledger (ISS-06).
 *
 * `buildBrief`'s Plan / Files-edited / Last-notes sections used to come ONLY
 * from Claude Code's JSONL transcript (`claude-session.ts`), so a handoff from
 * Cursor / Codex / Gemini silently collapsed to "context above is from git
 * alone" — the very continuation state you most need (what's done, what's left)
 * disappeared for every non-Claude agent.
 *
 * This is the missing agent-agnostic channel: any MCP-connected agent calls the
 * `save_progress` tool with its current plan / notes, and it lands in a durable
 * per-task ledger that `buildBrief` merges in. The automated brief — and the
 * cutoff snapshot that rides on it — then carries the plan for EVERY agent.
 *
 * Stored as small, capped JSON at <root>/.baton/progress/<slug>.json. The agent
 * sends its full current plan/notes each time (like Claude's TodoWrite), so
 * those fields REPLACE; files accumulate (union) so nothing edited is forgotten.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from '../store.js';
import type { TodoItem } from './claude-session.js';

/** A ledger stays a brief — cap every list the same way session-brief.ts does. */
const LIST_CAP = 30;
const ITEM_MAX = 300;
const NOTE_MAX = 600;
const NEXT_MAX = 600;

export interface ProgressLedger {
  /** The plan/checklist — the closest thing to "what's done, what's left". */
  plan: TodoItem[];
  /** Free-form decisions/findings the agent wants the next one to see. */
  notes: string[];
  /** The single most useful next action for whoever resumes. */
  next?: string;
  /** Files the agent has touched (accumulated across patches). */
  filesEdited: string[];
  updatedAt: string;
}

/** Plan items as an agent supplies them — status is optional (defaults to
 *  'pending' on store), so callers don't have to fill it in. */
export type PlanItemInput = { content: string; status?: string };

export interface ProgressPatch {
  plan?: PlanItemInput[];
  notes?: string[];
  next?: string;
  filesEdited?: string[];
}

/** Filename-safe slug — never lets a hostile slug escape .baton/progress. */
function safeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

function progressDir(root: string): string {
  return join(batonDir(root), 'progress');
}
function ledgerPath(root: string, slug: string): string {
  return join(progressDir(root), `${safeSlug(slug)}.json`);
}

function cleanStrings(items: string[] | undefined, max: number): string[] {
  return (items ?? []).map((s) => String(s).trim().slice(0, max)).filter(Boolean).slice(0, LIST_CAP);
}
function cleanPlan(plan: PlanItemInput[] | undefined): TodoItem[] {
  return (plan ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .map((t) => ({ content: t.content.trim().slice(0, ITEM_MAX), status: String(t.status ?? 'pending') }))
    .slice(0, LIST_CAP);
}

const EMPTY = (): ProgressLedger => ({ plan: [], notes: [], filesEdited: [], updatedAt: new Date(0).toISOString() });

/** The persisted ledger for a task/session, or null when none was ever written. */
export async function loadProgress(root: string, slug: string): Promise<ProgressLedger | null> {
  try {
    const raw = await readFile(ledgerPath(root, slug), 'utf-8');
    const p = JSON.parse(raw) as Partial<ProgressLedger>;
    return {
      plan: cleanPlan(p.plan),
      notes: cleanStrings(p.notes, NOTE_MAX),
      next: typeof p.next === 'string' && p.next.trim() ? p.next.trim().slice(0, NEXT_MAX) : undefined,
      filesEdited: cleanStrings(p.filesEdited, ITEM_MAX),
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : EMPTY().updatedAt,
    };
  } catch {
    return null; // absent or corrupt — the brief falls back to git ground truth
  }
}

/**
 * Merge a patch into the existing ledger: plan/notes/next present in the patch
 * REPLACE (the agent sends its full current view); filesEdited UNION with prior
 * (accumulate). Written atomically (tmp + rename) so concurrent MCP calls can't
 * clobber. Callers treat this as best-effort — a handoff must never fail because
 * progress capture did.
 */
export async function saveProgress(root: string, slug: string, patch: ProgressPatch): Promise<ProgressLedger> {
  const prev = (await loadProgress(root, slug)) ?? EMPTY();
  const next: ProgressLedger = {
    plan: patch.plan !== undefined ? cleanPlan(patch.plan) : prev.plan,
    notes: patch.notes !== undefined ? cleanStrings(patch.notes, NOTE_MAX) : prev.notes,
    next: patch.next !== undefined ? (patch.next.trim().slice(0, NEXT_MAX) || undefined) : prev.next,
    filesEdited: patch.filesEdited !== undefined
      ? [...new Set([...prev.filesEdited, ...cleanStrings(patch.filesEdited, ITEM_MAX)])].slice(0, LIST_CAP)
      : prev.filesEdited,
    updatedAt: new Date().toISOString(),
  };
  const path = ledgerPath(root, slug);
  await mkdir(progressDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  await rename(tmp, path);
  return next;
}
