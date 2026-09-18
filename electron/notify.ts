// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop notifications: the DECISION half. No Electron import lives in this
 * file, on purpose — main.ts is a thin adapter that turns `planNotifications`'s
 * answer into `new Notification(...)`, `app.dock.setBadge(...)` and a
 * `globalShortcut`, and `test/electron-notify.test.ts` exercises the judgement
 * without launching an app.
 *
 * Three rules hold this feature together, and all three are about restraint:
 *
 * 1. **Health is read, never re-derived.** `working|quiet|stalled|abandoned`
 *    comes from `deriveHealth` (`src/worktrees.ts:168`) and is served by
 *    `GET /api/worktrees` (`src/server.ts:2368`). This is the third consumer of
 *    that vocabulary — after the dashboard and `src/handoff/auto-brief.ts` — and
 *    a fourth definition of "stalled" would be a fourth thing to get wrong.
 *
 * 2. **`quiet` NEVER notifies.** `quiet` is the 10-minute period before the
 *    45-minute grace (`src/worktrees.ts:48`); it exists precisely so a worktree
 *    merely between commits is visible on the card without anything shouting.
 *    Notify on `quiet` and people switch the feature off — at which point the
 *    `stalled` notification that actually mattered is gone too. Every
 *    notification this module raises is one a human can act on.
 *
 * 3. **Edge, not level.** A stalled worktree stays stalled for hours, so firing
 *    on the level would mean one notification per poll forever. Same discipline
 *    as `enteredRisk` (`src/wip-snapshot.ts:326`) and `enteredStall`
 *    (`src/handoff/auto-brief.ts:102`): notify on the TRANSITION in. The badge
 *    is the level; the notification is the edge.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadBrand } from './brand.js';

/**
 * Why a human is being interrupted. Exactly three reasons exist, and each one
 * has an action behind it: take the work over, rescue the work, or answer the
 * question. Nothing else is allowed to reach the desktop.
 */
export type AttentionReason = 'abandoned' | 'stalled' | 'blocked';

/**
 * A row of `GET /api/worktrees`, narrowed to what the decision needs.
 *
 * `health` is typed as `string` rather than as a copy of `WorktreeHealth`:
 * `electron/tsconfig.json` has `rootDir: "."`, so this workspace cannot import
 * `src/worktrees.ts`, and a hand-copied union here would be a second (silently
 * drifting) statement of the vocabulary. Comparing against the words we act on
 * fails safe instead — an unrecognised health notifies nobody.
 */
export interface AttentionRow {
  /** Project root, from the fleet record — the notification says which repo. */
  root: string;
  projectName?: string;
  /** The daemon's port, so the hotkey can open the right dashboard. */
  port?: number | null;
  slug: string;
  health: string;
  /** `TaskState | null` as the route serves it; `blocked` is the needs-input one. */
  state: string | null;
  branch?: string | null;
  quietForMs?: number | null;
}

/** What was already in trouble last poll: key → reason. The edge is a diff of this. */
export type AttentionMap = Record<string, AttentionReason>;

/** One desktop notification, fully composed. The adapter only has to show it. */
export interface PendingNotification {
  key: string;
  root: string;
  port: number | null;
  slug: string;
  reason: AttentionReason;
  title: string;
  body: string;
}

/** One stop on the hotkey's tour of everything needing attention. */
export interface QueueEntry {
  key: string;
  slug: string;
  root: string;
  port: number | null;
  reason: AttentionReason;
}

export interface NotifyPlan {
  /** Carry this into the next call — it is the baseline the next edge is measured from. */
  next: AttentionMap;
  /** Edges only. Empty while nothing changed, and empty when notifications are off. */
  notifications: PendingNotification[];
  /** Level: how many worktrees need attention right now. 0 clears the dock badge. */
  badge: number;
  /** Level, ordered: what the hotkey walks. Answered even when notifications are off. */
  queue: QueueEntry[];
}

export interface NotifyPrefs {
  enabled: boolean;
}

/**
 * Worst first. This is the order the hotkey walks and it encodes the cost of
 * ignoring each state: `abandoned` means work that exists nowhere else has no
 * one looking after it (`src/worktrees.ts:185`), `stalled` means an agent is
 * nominally there but not moving, and `blocked` means somebody deliberately
 * asked a question and is waiting — bad, but not lossy.
 */
const SEVERITY: Record<AttentionReason, number> = { abandoned: 0, stalled: 1, blocked: 2 };

/** Root and slug together: the same slug in two repos is two different worktrees. */
export function attentionKey(row: AttentionRow): string {
  // NUL is the separator because it is the one byte that cannot occur in a
  // path or a slug, so no root/slug pair can forge another pair's key.
  // Written as an ESCAPE, not a raw byte: a literal NUL in the source makes
  // git treat this file as binary and show no diff for it at review time.
  return `${row.root}\u0000${row.slug}`;
}

/**
 * Does this row deserve a human? `null` for everything else — and `quiet` is
 * emphatically part of "everything else" (see rule 2 in the file header).
 *
 * `abandoned` outranks `blocked` deliberately: a worktree can be both, and the
 * one that loses work if ignored is the one to name.
 */
export function attentionReason(row: AttentionRow): AttentionReason | null {
  if (row.health === 'abandoned') return 'abandoned';
  if (row.health === 'stalled') return 'stalled';
  // The needs-input case. `blocked` is a TaskState the agent set by reporting it
  // cannot proceed (`src/pipeline.ts:32`) — a question aimed at a human, which is
  // the definition of actionable. It is read from `state`, not from `health`,
  // because a blocked agent's worktree is usually perfectly healthy on disk.
  if (row.state === 'blocked') return 'blocked';
  return null;
}

function titleFor(reason: AttentionReason, project: string): string {
  if (reason === 'abandoned') return `${project}: work left unattended`;
  if (reason === 'stalled') return `${project}: an agent stopped moving`;
  return `${project}: an agent needs you`;
}

function bodyFor(reason: AttentionReason, row: AttentionRow): string {
  const where = row.branch ? `${row.slug} (${row.branch})` : row.slug;
  if (reason === 'abandoned') {
    return `${where} holds work that exists nowhere else and nobody is running. Recover or take it over.`;
  }
  if (reason === 'stalled') {
    const mins = row.quietForMs != null ? Math.round(row.quietForMs / 60_000) : null;
    return mins != null
      ? `${where} has not made progress for ${mins} min. It can be taken over.`
      : `${where} has stopped making progress. It can be taken over.`;
  }
  return `${where} reported it cannot proceed and is waiting on an answer.`;
}

/**
 * Diff what needs attention against what needed it last time.
 *
 * `before === null` means "we have never looked" — the app just started, or the
 * daemon just appeared. That first sighting SEEDS the baseline and notifies
 * nobody. A desktop app that fires eight notifications the moment it launches,
 * for worktrees that died overnight, is one people quit; the badge and the
 * hotkey still say those worktrees are there, which is the honest way to
 * report history. (This is the opposite call to `enteredStall`
 * (`src/handoff/auto-brief.ts:94`) — but a brief is a file written quietly into
 * a worktree, and this interrupts a person.)
 *
 * With notifications OFF the diff still runs and `next` is still returned, so
 * turning them back on does not replay a backlog of things that went wrong
 * while the user asked for silence. The badge goes with the notifications —
 * "off" means the app stops asking for attention — but `queue` does not, because
 * the hotkey is a pull the user initiated, not a push.
 */
export function planNotifications(
  before: AttentionMap | null,
  rows: AttentionRow[],
  prefs: NotifyPrefs,
): NotifyPlan {
  const next: AttentionMap = {};
  const notifications: PendingNotification[] = [];
  const queue: Array<QueueEntry & { sortQuiet: number }> = [];

  for (const row of rows) {
    const reason = attentionReason(row);
    if (reason === null) continue; // includes `quiet`, and every git-truth modifier
    const key = attentionKey(row);
    next[key] = reason;
    queue.push({
      key,
      slug: row.slug,
      root: row.root,
      port: row.port ?? null,
      reason,
      sortQuiet: row.quietForMs ?? 0,
    });

    // The edge. An escalation (stalled → abandoned) is a different answer to
    // "why", so it counts as a new transition and notifies again; the reverse
    // (abandoned → stalled) cannot happen without passing through health that
    // clears the entry first.
    if (before !== null && before[key] !== reason && prefs.enabled) {
      notifications.push({
        key,
        root: row.root,
        port: row.port ?? null,
        slug: row.slug,
        reason,
        title: titleFor(reason, row.projectName ?? row.root),
        body: bodyFor(reason, row),
      });
    }
  }

  queue.sort((a, b) => (
    SEVERITY[a.reason] - SEVERITY[b.reason]
    // Longest-waiting first inside a severity band: the oldest silence is the
    // one closest to being lost, and a stable order is what makes the hotkey's
    // "next" mean something across polls.
    || b.sortQuiet - a.sortQuiet
    || a.key.localeCompare(b.key)
  ));

  return {
    next,
    notifications,
    badge: prefs.enabled ? queue.length : 0,
    queue: queue.map(({ sortQuiet: _q, ...entry }) => entry),
  };
}

/**
 * Where the hotkey goes next: the entry after `lastKey`, wrapping at the end.
 *
 * If `lastKey` is no longer in the queue — the usual case, because visiting a
 * worktree tends to be how it stops being in trouble — start again at the top,
 * which is the worst one.
 */
export function nextInQueue(queue: QueueEntry[], lastKey: string | null): QueueEntry | null {
  if (queue.length === 0) return null;
  const at = lastKey === null ? -1 : queue.findIndex((q) => q.key === lastKey);
  if (at < 0) return queue[0]!;
  return queue[(at + 1) % queue.length]!;
}

/* ------------------------------------------------------------------ */
/* The preference                                                      */
/* ------------------------------------------------------------------ */

/**
 * Persistence deliberately copies `electron/projects.ts:10-35` — same directory,
 * same `version`-stamped JSON, same write-temp-then-rename so a crash mid-write
 * cannot leave a half-file. That is the store this workspace already has; adding
 * `electron-store` for one boolean would put a dependency in the tree for a
 * fifteen-line function.
 *
 * `BATON_NOTIFY_FILE` exists for the tests, matching `BATON_PROJECTS_FILE`.
 */
interface NotifyFile { version: 1; enabled: boolean }

function prefsPath(): string {
  if (process.env.BATON_NOTIFY_FILE) return process.env.BATON_NOTIFY_FILE;
  return join(homedir(), `.${loadBrand().commandName}`, 'notify.json');
}

/**
 * Defaults to ON, and — importantly — falls back to ON when the file is
 * missing or unreadable. Silence must be something the user chose, never
 * something a corrupt file did to them: a feature that quietly stops warning
 * about lost work is worse than one that was never installed.
 */
export function readNotifyPrefs(): NotifyPrefs {
  const p = prefsPath();
  if (!existsSync(p)) return { enabled: true };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as NotifyFile;
    if (raw?.version !== 1 || typeof raw.enabled !== 'boolean') return { enabled: true };
    return { enabled: raw.enabled };
  } catch { return { enabled: true }; }
}

export function writeNotifyPrefs(prefs: NotifyPrefs): NotifyPrefs {
  const p = prefsPath();
  mkdirSync(dirname(p), { recursive: true });
  const body: NotifyFile = { version: 1, enabled: !!prefs.enabled };
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, p);
  return { enabled: body.enabled };
}
