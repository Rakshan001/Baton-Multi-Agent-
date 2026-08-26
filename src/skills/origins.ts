// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where each skill came from — the record that makes updating possible.
 *
 * A skill fetched from a repo is pinned at the moment it was fetched. Without a
 * note of its origin there is nothing to update FROM: not the URL, not the ref,
 * and no way to tell an untouched copy from one the user has since edited. That
 * record cannot be reconstructed later, which is why it is written from the
 * first release rather than added once people already have libraries.
 *
 * Stored machine-wide at ~/.baton/skill-origins.json, beside the library and
 * the bookmarks, for the same reason those are: a skill lives in every project,
 * so anything said about it has to as well.
 *
 * Deliberately NOT a file inside the skill's own directory. readSkillDir treats
 * every file beside SKILL.md as a companion, so a sidecar would be copied into
 * `.claude/skills/<id>/` on install — Baton's bookkeeping leaking into the
 * agent's context. It also would not work for flat <id>.md skills, which have
 * no directory to put it in.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORIGINS_VERSION = 1;

/** Far above any real library; a bound so a scripted loop cannot grow a file
 *  that is then read into a browser. Matches MAX_BOOKMARKS. */
export const MAX_ORIGINS = 500;

export interface SkillOrigin {
  /** The URL the user gave, normalised — what an update re-fetches. */
  url: string;
  /** Branch/tag the fetch resolved to, so an update follows the same line. */
  ref?: string;
  /** The skill named within a multi-skill repo. */
  skill?: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  /**
   * Hash of everything that was written, at write time.
   *
   * This is what separates "you have not touched it" from "you have edited it".
   * Update compares the current bytes to this: matching means replacing is
   * safe, differing means the user has local changes an update would destroy.
   */
  contentHash: string;
}

interface OriginsFile {
  version: number;
  skills: Record<string, SkillOrigin>;
}

export function originsPath(): string {
  return join(homedir(), '.baton', 'skill-origins.json');
}

/**
 * Hash a skill's full contents, order-independent.
 *
 * Sorted by path first, because two reads of the same directory may enumerate
 * in different orders and a hash that changed with directory order would report
 * every skill as locally edited.
 */
export function hashSkillFiles(files: { rel: string; content: string }[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    h.update(f.rel, 'utf-8');
    h.update('\0', 'utf-8');
    h.update(f.content, 'utf-8');
    h.update('\0', 'utf-8');
  }
  return h.digest('hex');
}

/**
 * Read the record. Any failure — missing, unreadable, malformed, or written by
 * a version that means something else — reads as "nothing recorded" rather than
 * throwing. A broken bookkeeping file must never cost the user their catalog;
 * the worst case is that a skill loses its update button.
 */
export async function loadOrigins(): Promise<Record<string, SkillOrigin>> {
  let raw: string;
  try {
    raw = await readFile(originsPath(), 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OriginsFile>;
    if (parsed?.version !== ORIGINS_VERSION || !parsed.skills || typeof parsed.skills !== 'object') return {};
    const out: Record<string, SkillOrigin> = {};
    for (const [id, o] of Object.entries(parsed.skills)) {
      if (typeof o?.url === 'string' && typeof o?.contentHash === 'string' && typeof o?.fetchedAt === 'string') {
        out[id] = {
          url: o.url, contentHash: o.contentHash, fetchedAt: o.fetchedAt,
          ...(typeof o.ref === 'string' ? { ref: o.ref } : {}),
          ...(typeof o.skill === 'string' ? { skill: o.skill } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function getOrigin(id: string): Promise<SkillOrigin | null> {
  return (await loadOrigins())[id] ?? null;
}

/** Write the whole map atomically: tmp file then rename, so a crash mid-write
 *  leaves the previous record rather than a truncated one. */
async function save(skills: Record<string, SkillOrigin>): Promise<void> {
  const path = originsPath();
  await mkdir(join(homedir(), '.baton'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: OriginsFile = { version: ORIGINS_VERSION, skills };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
}

/**
 * Record where a skill came from. Silently a no-op past the cap rather than an
 * error: failing an otherwise-successful import over bookkeeping would be the
 * tail wagging the dog.
 */
export async function setOrigin(id: string, origin: SkillOrigin): Promise<void> {
  const all = await loadOrigins();
  if (!(id in all) && Object.keys(all).length >= MAX_ORIGINS) return;
  all[id] = origin;
  await save(all);
}

/** Forget a skill's origin — called when the skill itself is deleted, so the
 *  file does not accumulate entries pointing at things that are gone. */
export async function clearOrigin(id: string): Promise<void> {
  const all = await loadOrigins();
  if (!(id in all)) return;
  delete all[id];
  await save(all);
}
