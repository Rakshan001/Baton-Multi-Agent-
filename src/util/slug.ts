// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one id-slug rule.
 *
 * Member ids (src/members.ts) and team ids (src/teams.ts) are the same problem:
 * a display name a person typed, reduced to something safe in a URL path, a
 * JSON key and a CLI argument. Two copies of that rule would drift, and the
 * drift would surface as an id that looks identical in two places and does not
 * match in either.
 *
 * Idempotent on purpose — `slugify(slugify(x, n), n) === slugify(x, n)`. The
 * trailing separator is stripped AFTER the length cap, not before, because a
 * name long enough to be cut mid-word would otherwise end on a `-` that the
 * next pass through the same function would remove, giving one identity two
 * spellings depending on how many times it had been round-tripped.
 */
export function slugify(name: string, max: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}
