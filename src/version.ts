// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Single source of the CLI version (package.json), shared by the daemon and KB packs. */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

type Pkg = { version?: string; repository?: string | { url?: string } };

const pkg: Pkg = (() => {
  try {
    return require_('../package.json') as Pkg;
  } catch {
    return {};
  }
})();

export const BATON_VERSION: string = pkg.version ?? '0.0.0';

/**
 * Where to get the source of the daemon that is running right now.
 *
 * AGPL-3.0 §13 makes this a licence obligation and not a nicety: the dashboard
 * is a network-interactive program, so whoever loads it is owed the source of
 * *this* build — modifications included. Reading it out of package.json rather
 * than hardcoding upstream is what keeps that honest for a fork: change the
 * `repository` field the way you already would, and the offer follows your
 * code instead of pointing strangers at someone else's.
 *
 * Normalised to something a browser can open — npm accepts `git+ssh://…` and
 * `user/repo`, neither of which is a URL a person can click.
 */
export const UPSTREAM_SOURCE = 'https://github.com/Rakshan001/Baton-Multi-Agent-';

/**
 * npm's `repository` field is a family of shorthands, and only one member of it
 * is a link a person can follow. `git+ssh://git@host/o/r.git` and the bare
 * `owner/repo` are both legal and neither opens in a browser — handing either
 * one to someone exercising their §13 right would satisfy the letter of the
 * obligation and none of its point.
 */
export function normalizeSourceUrl(raw: string | undefined): string {
  const s = raw?.trim();
  if (!s) return UPSTREAM_SOURCE;
  const url = s
    .replace(/^git\+/, '')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/^(git|ssh|git\+ssh):\/\/(?:git@)?/, 'https://')
    .replace(/\.git$/, '');
  if (/^https?:\/\//.test(url)) return url;
  // The shorthands npm resolves itself: `owner/repo`, `github:owner/repo`,
  // and the three hosts it special-cases.
  const m = url.match(/^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/);
  if (!m) return UPSTREAM_SOURCE;
  const host = { gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[m[1] ?? ''] ?? 'github.com';
  return `https://${host}/${m[2]}`;
}

export const SOURCE_URL: string = normalizeSourceUrl(
  typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
);
