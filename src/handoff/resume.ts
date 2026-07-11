/**
 * `baton resume` (H4) — the pickup side of the manual relay. Lists every open
 * handoff brief in one place (task briefs living in worktree HANDOFF.md files
 * + session briefs under .baton/handoffs/) and prints the paste-into-the-next-
 * agent prompt for one. The dashboard's copy buttons read the same list via
 * GET /api/handoffs.
 */
import matter from 'gray-matter';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { batonDir, loadTasks } from '../store.js';
import { handoffPath } from './brief.js';

export interface BriefEntry {
  slug: string;
  kind: 'task' | 'session';
  title: string;
  status: string;
  from: string;
  to: string;
  created: string;
  path: string;
  /** Where the resuming agent should work. */
  cwd: string;
  /** Full HANDOFF.md content (frontmatter + body) — what the copy button copies. */
  markdown: string;
  /** Body without frontmatter — the resume prompt. */
  body: string;
}

function toEntry(raw: string, path: string, fallback: { slug: string; kind: 'task' | 'session'; title?: string; cwd: string }): BriefEntry | null {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  if (data.baton !== 1) return null; // not a baton brief — ignore junk
  return {
    slug: fallback.slug,
    kind: fallback.kind,
    title: String(data.title ?? fallback.title ?? fallback.slug),
    status: String(data.status ?? 'ready'),
    from: String(data.from ?? 'unknown'),
    to: String(data.to ?? 'any'),
    created: String(data.created ?? ''),
    path,
    cwd: fallback.cwd,
    markdown: raw,
    body: parsed.content.trim(),
  };
}

/** Every baton handoff brief in the repo — task worktrees + session briefs. */
export async function listBriefs(root: string): Promise<BriefEntry[]> {
  const out: BriefEntry[] = [];

  // Task briefs: HANDOFF.md inside each task worktree.
  for (const task of await loadTasks(root)) {
    try {
      const p = handoffPath(task.worktreePath);
      const entry = toEntry(await readFile(p, 'utf-8'), p, { slug: task.slug, kind: 'task', title: task.task, cwd: task.worktreePath });
      if (entry) out.push(entry);
    } catch { /* no brief for this task */ }
  }

  // Session briefs: .baton/handoffs/<slug>.md.
  const dir = join(batonDir(root), 'handoffs');
  let files: string[] = [];
  try { files = await readdir(dir); } catch { files = []; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try {
      const p = join(dir, f);
      const entry = toEntry(await readFile(p, 'utf-8'), p, { slug: basename(f, '.md'), kind: 'session', cwd: root });
      if (entry) out.push(entry);
    } catch { /* unreadable — skip */ }
  }

  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** Flip a brief's status in place, wherever it lives. */
export async function setBriefStatusAt(path: string, status: 'ready' | 'in-progress' | 'done'): Promise<boolean> {
  try {
    const parsed = matter(await readFile(path, 'utf-8'));
    if ((parsed.data as Record<string, unknown>).baton !== 1) return false;
    parsed.data.status = status;
    await writeFile(path, matter.stringify(parsed.content, parsed.data), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
