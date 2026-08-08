// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The brief a ROOT session gets — derived, with no agent input at all.
 *
 * `baton pass --auto` fires from the Stop/PreCompact hooks, and until now it
 * returned null whenever the session was not inside a task worktree. That is
 * how most sessions run: an agent working at the repo root has no task, so
 * every hook fired, succeeded, and wrote nothing. The one autonomous handoff
 * writer never ran, which is also why the memory store stayed empty — its only
 * automatic feeder is a handoff.
 *
 * What makes this different from `create_handoff` (the MCP tool) is that there
 * is NO agent on the other end to ask. A hook gets git state and nothing else,
 * so every section here is derived from observable facts:
 *
 *   done     ← commits that landed since the previous brief
 *   pending  ← the dirty tree
 *   next     ← the obvious continuation, stated plainly
 *
 * Deliberately NOT derived: `decisions`. That field is the one thing no
 * heuristic can produce — it is the "why", which lives only in the agent's
 * head — and it is also the field that feeds memory. Inventing one would put
 * fabricated reasoning into the knowledge base under the same badge as
 * knowledge an agent actually vouched for. So an auto brief carries no
 * decisions and writes no memory facts; it says so in the note, and points at
 * the explicit path for recording them.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitTry } from '../util/exec.js';
import { batonDir } from '../store.js';
import { detectSecret } from '../memory.js';
import { sessionSlug } from '../signals.js';
import { createSessionHandoff, isBatonArtifact, porcelainPath } from './session-brief.js';

/** Stop fires at the END OF EVERY TURN, not at session end — without this the
 *  hook would rewrite a brief after every reply. Matches the task path's window. */
export const AUTO_DEBOUNCE_MS = 10 * 60_000;

/** Keep `.baton/handoffs/` from growing one file per branch forever. */
const MAX_AUTO_BRIEFS = 20;

/** Commits and dirty files are both capped — a brief is a summary, not a log. */
const MAX_COMMITS = 10;
const MAX_DIRTY = 20;
const TITLE_MAX = 120;

/**
 * How far back the FIRST brief for a session may look for commits.
 *
 * Every session starts with no marker, so there is no previous brief to diff
 * against — and that path runs once per session, not once per repo. An
 * unbounded `log -n10` therefore hands each new session credit for ten commits
 * that may predate it by months. A time floor is still a guess, but it is a
 * bounded one, and it errs toward saying nothing rather than claiming work.
 */
const FIRST_BRIEF_WINDOW_MS = 12 * 60 * 60_000;

/** One second of overlap when resuming from a marker's timestamp: a commit made
 *  in the same second as the last brief must be reported twice rather than
 *  lost, since `--since` compares at second granularity. */
const SINCE_GRACE_MS = 1000;

export interface AutoSessionOptions {
  /** Where the session works. Defaults to the baton root. */
  cwd?: string;
  /** The host agent's session id, from the hook payload. Distinguishes two
   *  agents at one root, which would otherwise share (and clobber) one brief. */
  sessionId?: string;
  agent?: string;
  /** Injected for tests — never passed in production. */
  now?: number;
  debounceMs?: number;
}

/** Observable git state. Every field degrades to null/[] outside a git repo. */
export interface SessionState {
  branch: string | null;
  head: string | null;
  /** Newest first, subjects only. */
  commits: string[];
  /** Repo-relative paths from `git status --porcelain`. */
  dirty: string[];
}

/**
 * A commit subject is author-written prose that lands in a file every agent
 * reads. Reviews already redact for exactly this reason; a subject that quotes
 * a token ("fix: rotate AKIA… after the leak") must not be copied verbatim.
 */
function redact(text: string): string {
  const what = detectSecret(text);
  return what ? `[redacted: ${what}]` : text;
}

/** Where the previous brief left off. `head` is exact; `time` is the floor used
 *  whenever no commit can serve as one (see FIRST_BRIEF_WINDOW_MS). */
export interface SessionSince {
  head?: string;
  /** ms since epoch. Defaults to `now - FIRST_BRIEF_WINDOW_MS`. */
  time?: number;
}

/**
 * Read git ground truth. `gitTry` never throws, so outside a git repo — a hub
 * root, most commonly — every probe simply fails and the state comes back
 * empty, which the caller reads as "nothing to write".
 */
export async function readSessionState(cwd: string, since: SessionSince = {}): Promise<SessionState> {
  const [branchRes, headRes, dirtyRes] = await Promise.all([
    gitTry(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
    gitTry(['-C', cwd, 'rev-parse', '--short', 'HEAD']),
    gitTry(['-C', cwd, 'status', '--porcelain']),
  ]);

  // A branch of 'HEAD' means detached — report no branch rather than a lie.
  const rawBranch = branchRes.ok ? branchRes.stdout.trim() : '';
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;
  const head = headRes.ok && headRes.stdout.trim() ? headRes.stdout.trim() : null;

  // Commits since the last brief. `<sha>..HEAD` fails if that sha is gone
  // (rebase, amend, branch switch), and there is no sha at all on a session's
  // first brief — fall back to a TIME floor, never to a plain `-n10`. "I cannot
  // diff" is not "no work happened", but neither is it licence to claim the
  // last ten commits in the repo, which is what the unbounded log did on the
  // path every new session takes.
  let commits: string[] = [];
  if (head) {
    const base = ['-C', cwd, 'log', '--format=%s', `-n${MAX_COMMITS}`];
    let log = since.head
      ? await gitTry([...base, `${since.head}..HEAD`])
      : { ok: false, stdout: '', stderr: '' };
    if (!log.ok) {
      const floor = since.time ?? Date.now() - FIRST_BRIEF_WINDOW_MS;
      log = await gitTry([...base, `--since=${new Date(floor).toISOString()}`]);
    }
    if (log.ok && log.stdout) commits = log.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  // Drop Baton's own artifacts. Writing a brief dirties `.baton/`, so without
  // this the brief reports ITSELF as pending work — and, worse, every run sees
  // a changed tree, so the dedupe below never converges and the hook rewrites
  // forever. In a repo whose .gitignore Baton manages this is invisible; in a
  // fresh one it is a self-feeding loop. Coordination state is never the
  // user's uncommitted work either way.
  const dirty = dirtyRes.ok && dirtyRes.stdout
    ? dirtyRes.stdout
      .split('\n').filter(Boolean)
      .map(porcelainPath)
      .filter((p) => p && !isBatonArtifact(p))
    : [];

  return { branch, head, commits, dirty };
}

/** Where the debounce//dedupe marker for one session lives. Under a dot-dir so
 *  the `.md`-only brief readers (resume.ts, /api/handoffs) never see it. */
function markerPath(root: string, slug: string): string {
  return join(batonDir(root), 'handoffs', '.auto', `${slug}.json`);
}

interface Marker { at: number; hash: string; head: string | null }

async function readMarker(root: string, slug: string): Promise<Marker | null> {
  try {
    return JSON.parse(await readFile(markerPath(root, slug), 'utf-8')) as Marker;
  } catch { return null; }
}

/** The identity of the current state: same hash → nothing happened → no rewrite. */
function stateHash(state: SessionState): string {
  return createHash('sha1')
    .update([state.branch ?? '', state.head ?? '', ...state.commits, ...state.dirty].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Was this brief derived by a hook, or written by an agent?
 *
 * `.baton/handoffs/` holds both, and only the DERIVED kind may be deleted
 * automatically: an authored brief carries decisions that exist nowhere else
 * and cannot be regenerated. Fail-closed — a brief we cannot read or parse is
 * treated as authored, because the cost of keeping one file is nothing and the
 * cost of deleting the wrong one is the work itself.
 */
async function isDerivedBrief(file: string): Promise<boolean> {
  try {
    const head = (await readFile(file, 'utf-8')).slice(0, 1024);
    if (!head.startsWith('---')) return false;
    const end = head.indexOf('\n---', 3);
    return /^derived: true\s*$/m.test(end > 0 ? head.slice(0, end) : head);
  } catch { return false; }
}

/**
 * Trim `.baton/handoffs/` to the newest MAX_AUTO_BRIEFS *derived* briefs, and
 * drop markers whose brief is gone. One brief per session per machine adds up
 * over months, and nothing else ever removes them.
 *
 * The marker sweep does double duty. It bounds `.auto/`, which would otherwise
 * grow one file per session forever while the briefs beside it stay capped —
 * and it self-heals the case where a brief was deleted but its marker survived,
 * which makes the state look unchanged so the brief is never written again.
 *
 * Best-effort throughout: a prune failure must never fail the handoff that
 * triggered it.
 */
async function pruneOldBriefs(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    const derived: string[] = [];
    for (const name of names) if (await isDerivedBrief(join(dir, name))) derived.push(name);

    if (derived.length > MAX_AUTO_BRIEFS) {
      const stamped = await Promise.all(
        derived.map(async (name) => ({ name, at: await stat(join(dir, name)).then((s) => s.mtimeMs).catch(() => 0) })),
      );
      stamped.sort((a, b) => b.at - a.at);
      for (const { name } of stamped.slice(MAX_AUTO_BRIEFS)) {
        await rm(join(dir, name), { force: true }).catch(() => undefined);
      }
    }

    const auto = join(dir, '.auto');
    const live = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')));
    for (const marker of await readdir(auto).catch(() => [])) {
      if (!marker.endsWith('.json')) continue;
      if (live.has(`${marker.slice(0, -'.json'.length)}.md`)) continue;
      await rm(join(auto, marker), { force: true }).catch(() => undefined);
    }
  } catch { /* pruning is housekeeping — never let it break a write */ }
}

/** Filename-safe, and never able to escape `.baton/handoffs/`. */
function autoSlug(sessionId: string | undefined, branch: string | null): string {
  if (sessionId?.trim()) return sessionSlug(sessionId.trim());
  const base = (branch ?? 'session').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `auto-${base.slice(0, 60) || 'session'}`;
}

function deriveTitle(state: SessionState): string {
  const where = state.branch ? `${state.branch}` : 'detached HEAD';
  const what = state.commits[0] ?? (state.dirty.length ? 'uncommitted work in progress' : 'session');
  return `${where} — ${redact(what)}`.slice(0, TITLE_MAX);
}

function deriveNext(state: SessionState): string {
  if (state.dirty.length) {
    const head = state.dirty.slice(0, 3).join(', ');
    return `${state.dirty.length} file${state.dirty.length === 1 ? '' : 's'} left uncommitted (${head}${state.dirty.length > 3 ? ', …' : ''}). Review them, then commit or discard before continuing.`;
  }
  return `Tree is clean at ${state.head ?? 'HEAD'}${state.branch ? ` on ${state.branch}` : ''}. Pick up the next piece of work.`;
}

/** Why this brief exists and what it deliberately does not contain. */
const DERIVED_NOTE =
  'Derived automatically from git state when the session stopped — no agent wrote it. '
  + 'It carries no decisions or gotchas, and recorded nothing to memory, because the "why" '
  + 'is the one thing a hook cannot observe. To record that, use the create_handoff tool.';

export interface AutoSessionResult {
  path: string;
  slug: string;
  state: SessionState;
}

/**
 * Write a derived brief for a session with no task, or return null when there
 * is nothing worth writing. Null is the common case and is not a failure:
 * within the debounce window, an unchanged tree, or a non-git root all end here.
 *
 * Never throws. This runs on a hook, and a hook must never fail the host agent.
 */
export async function runAutoSessionHandoff(
  root: string,
  opts: AutoSessionOptions = {},
): Promise<AutoSessionResult | null> {
  try {
    const cwd = opts.cwd ?? root;
    const now = opts.now ?? Date.now();
    const debounceMs = opts.debounceMs ?? AUTO_DEBOUNCE_MS;

    // Read the marker first so the commit range can start from the last brief.
    // Its timestamp is the floor when the recorded sha is unusable; with no
    // marker at all the floor is the first-brief window, so a brand-new session
    // cannot claim commits that predate it.
    const since = (m: Marker | null): SessionSince => ({
      head: m?.head ?? undefined,
      time: m ? m.at - SINCE_GRACE_MS : now - FIRST_BRIEF_WINDOW_MS,
    });
    const provisional = autoSlug(opts.sessionId, null);
    const early = await readMarker(root, provisional);
    let state = await readSessionState(cwd, since(early));

    // Not a git repo at all (a hub root is the usual case): nothing observable,
    // so there is nothing honest to say. Stay silent.
    if (!state.head && !state.branch && !state.dirty.length) return null;

    // Nothing happened: no commits to report and a clean tree. A brief that
    // exists should always mean something did.
    if (!state.commits.length && !state.dirty.length) return null;

    // The real slug may be branch-derived, in which case the marker read above
    // was for the wrong key — re-read against the right one.
    const slug = autoSlug(opts.sessionId, state.branch);
    const marker = slug === provisional ? early : await readMarker(root, slug);
    if (slug !== provisional && marker) state = await readSessionState(cwd, since(marker));

    const hash = stateHash(state);
    if (marker) {
      if (marker.hash === hash) return null;              // nothing changed
      if (now - marker.at < debounceMs) return null;      // too soon — Stop fires every turn
    }

    const handoff = await createSessionHandoff(root, {
      slug,
      agent: opts.agent ?? 'claude',
      title: deriveTitle(state),
      done: state.commits.map(redact),
      pending: state.dirty.slice(0, MAX_DIRTY),
      next: deriveNext(state),
      note: DERIVED_NOTE,
      cwd,
      derived: true, // the flag automatic pruning reads; an authored brief has none

      // decisions: deliberately absent — see the module header. An empty list
      // also means captureDecisions writes no memory, which is the intent.
    });

    const dir = join(batonDir(root), 'handoffs');
    await mkdir(join(dir, '.auto'), { recursive: true }).catch(() => undefined);
    await writeFile(markerPath(root, slug), JSON.stringify({ at: now, hash, head: state.head } satisfies Marker), 'utf-8')
      .catch(() => undefined); // no marker → we rewrite next time; harmless
    await pruneOldBriefs(dir);

    return { path: handoff.path, slug, state };
  } catch {
    return null; // hooks must never fail the host agent
  }
}
