// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bookmarked skills — the handful you reach for, pinned to the top.
 *
 * Stored machine-wide at ~/.baton/skill-bookmarks.json, alongside the library
 * itself, for one reason: a skill uploaded once is present in every project, so
 * a bookmark that only applied to the project you happened to be in would
 * contradict the thing it is bookmarking. Browser storage was the other
 * candidate and loses on the same point — it would not survive a cleared cache,
 * and `baton skills list` could not show it.
 *
 * Deliberately just a list of ids, not a copy of the skills. An id whose skill
 * has since been deleted is ignored at render time rather than pruned on read:
 * pruning would mean a plain LIST turning into a WRITE, and a bookmark that
 * quietly disappeared because you opened the dashboard is worse than a stale
 * string nobody sees.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../util/lock.js';

export const BOOKMARKS_VERSION = 1;

/** A cap, so a scripted loop cannot grow an unbounded list that is then read
 *  into a browser. Far above any real user's count. */
export const MAX_BOOKMARKS = 500;

interface BookmarkFile {
  version: number;
  ids: string[];
}

export function bookmarksPath(): string {
  return join(homedir(), '.baton', 'skill-bookmarks.json');
}

/**
 * Read the set. Any failure — missing file, unreadable, malformed, written by a
 * version that means something else — reads as "nothing bookmarked" rather than
 * throwing: a bookmark is a convenience, and losing the skills screen over one
 * would be a bad trade.
 */
export async function loadBookmarks(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(bookmarksPath(), 'utf-8')) as Partial<BookmarkFile>;
    if (raw?.version !== BOOKMARKS_VERSION || !Array.isArray(raw.ids)) return new Set();
    return new Set(raw.ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_BOOKMARKS));
  } catch {
    return new Set();
  }
}

/**
 * Add or remove one bookmark, returning the new set.
 *
 * Written via a temp file and rename so an interrupted write cannot leave a
 * half-serialised file behind — cheap here, and the alternative is a corrupt
 * JSON that silently reads back as "nothing bookmarked".
 *
 * Two things make that temp file safe to share a directory with other writers,
 * and it had neither:
 *
 * - **The pid is in its name.** `~/.baton` is machine-wide, so every Baton
 *   process on the machine staged to the one path `skill-bookmarks.json.tmp`.
 *   One would overwrite another's staged file and then rename it away, so the
 *   other's rename hit ENOENT and the WHOLE list it was installing was lost —
 *   the same defect already fixed in the usage ledger (skills/usage.ts).
 * - **The read-modify-write is serialised.** The pid does not separate two
 *   pins inside ONE daemon, which both load the same list and write back their
 *   own copy of it: the second erases the first, and one of the two renames
 *   still throws ENOENT. See util/lock.ts.
 */
export async function setBookmark(id: string, on: boolean): Promise<Set<string>> {
  return withLock(bookmarksPath(), async () => {
    const ids = await loadBookmarks();
    if (on) {
      if (!ids.has(id) && ids.size >= MAX_BOOKMARKS) {
        throw new Error(`you have ${MAX_BOOKMARKS} bookmarks already — remove one first`);
      }
      ids.add(id);
    } else {
      ids.delete(id);
    }
    const path = bookmarksPath();
    const tmp = `${path}.${process.pid}.tmp`;
    const body: BookmarkFile = { version: BOOKMARKS_VERSION, ids: [...ids] };
    await mkdir(join(homedir(), '.baton'), { recursive: true });
    await writeFile(tmp, JSON.stringify(body, null, 2), 'utf-8');
    await rename(tmp, path);
    return ids;
  });
}
