// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gate between "a skill is on disk" and "the agent loads it as its own
 * instructions".
 *
 * An imported skill is written to `.claude/skills/<id>/SKILL.md`, where the
 * agent's harness reads it as directive text. Baton's untrusted-quoting defence
 * cannot apply — a skill *is* instructions — so the defence is a human release
 * instead, recorded here.
 *
 * **This file fails CLOSED, and that is the one way it differs from its
 * siblings.** `bookmarks.ts` and `origins.ts` degrade to "no opinion" when
 * their file is unreadable, because losing a bookmark is a nuisance. Losing
 * this file must not silently release every held skill, so an unreadable state
 * reads as *nothing is released*. Do not "fix" it for consistency.
 *
 * Approval binds to a **content hash**, not to a name. An approved name would
 * otherwise be a slot an attacker refills on the next update — release the
 * skill once, change its contents, and it would still read as reviewed.
 *
 * Shape adapted from hermes-agent's `tools/skills_guard.py` (MIT, Nous
 * Research): quarantine, release, audit. Concept only, no code vendored.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillSource } from './catalog.js';

export const QUARANTINE_VERSION = 1;

/** Far above any real library; stops a scripted loop growing the file forever. */
export const MAX_RELEASES = 500;

export interface ReleaseRecord {
  /** Hash of the content that was actually reviewed. */
  hash: string;
  /** Who took responsibility. */
  by: string;
  at: string;
}

/**
 * Does this skill need a human before an agent may load it?
 *
 * Bundled skills ship inside the package the user already chose to install, so
 * holding them would gate Baton on reviewing Baton. Everything the user brought
 * in from outside is reviewed, including a local path — a file on disk says
 * nothing about who wrote it.
 */
export function requiresReview(source: SkillSource): boolean {
  return source !== 'bundled';
}

export function quarantinePath(): string {
  return join(homedir(), '.baton', 'skill-quarantine.json');
}

/**
 * Every recorded release.
 *
 * The returned object has a **null prototype**: skill ids arrive from GitHub
 * imports and are attacker-controlled, and an id of `__proto__` written into a
 * normal object literal is prototype pollution — which here would mean an
 * unrelated skill inheriting a `hash` and reading as released.
 */
export async function listReleases(): Promise<Record<string, ReleaseRecord>> {
  const empty = Object.create(null) as Record<string, ReleaseRecord>;
  try {
    const raw = JSON.parse(await readFile(quarantinePath(), 'utf-8')) as {
      version?: number; released?: Record<string, unknown>;
    };
    // A file from a version that means something else is not evidence that
    // anything was released. Fail closed, like every other unreadable state.
    if (raw?.version !== QUARANTINE_VERSION || !raw.released || typeof raw.released !== 'object') return empty;

    const out = Object.create(null) as Record<string, ReleaseRecord>;
    // Own properties only, so an inherited key cannot be read back as a record.
    for (const id of Object.getOwnPropertyNames(raw.released)) {
      const r = (raw.released as Record<string, unknown>)[id];
      if (!r || typeof r !== 'object') continue;
      const { hash, by, at } = r as Partial<ReleaseRecord>;
      if (typeof hash !== 'string' || !hash) continue;
      out[id] = { hash, by: typeof by === 'string' ? by : 'unknown', at: typeof at === 'string' ? at : '' };
    }
    return out;
  } catch {
    return empty; // missing, unreadable, malformed — all mean "nothing released"
  }
}

/**
 * Has this exact content been released for this skill?
 *
 * Both arguments matter: the id says which skill, the hash says which version
 * of it. A mismatch is not an error — it is a skill that changed since someone
 * read it, and it goes back into quarantine.
 */
export async function isReleased(id: string, hash: string): Promise<boolean> {
  if (!id || !hash) return false;
  const rec = (await listReleases())[id];
  return rec?.hash === hash;
}

/**
 * Record that a person reviewed this exact content and accepted it.
 *
 * Written via temp file + rename so an interrupted write cannot leave a
 * half-serialised file — which, failing closed, would quarantine the user's
 * whole library rather than corrupting it open.
 */
export async function releaseSkill(id: string, hash: string, by: string): Promise<void> {
  if (!id || !hash) throw new Error('a release needs both a skill id and the hash being released');
  const all = await listReleases();
  if (!(id in all) && Object.getOwnPropertyNames(all).length >= MAX_RELEASES) return;
  all[id] = { hash, by: by || 'unknown', at: new Date().toISOString() };

  // Serialised from a null-prototype object, so no inherited key can be
  // written out and read back as a record.
  const released: Record<string, ReleaseRecord> = {};
  for (const key of Object.getOwnPropertyNames(all)) {
    Object.defineProperty(released, key, { value: all[key], enumerable: true, writable: true, configurable: true });
  }

  const path = quarantinePath();
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(join(homedir(), '.baton'), { recursive: true });
  await writeFile(tmp, JSON.stringify({ version: QUARANTINE_VERSION, released }, null, 2), 'utf-8');
  await rename(tmp, path);
}
