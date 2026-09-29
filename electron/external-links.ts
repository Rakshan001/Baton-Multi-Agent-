// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The only door from the desktop shell to the OS URL handler. `shell.openExternal`
 * hands the string to the OS, so `file:`, `smb:` or a custom scheme can run code
 * or leak NTLM hashes. Only `https:` and `mailto:` get through (Team Sync §12.3).
 * Kept free of `electron` imports so it is unit-testable.
 */

const ALLOWED_PROTOCOLS = new Set(['https:', 'mailto:']);
const MAX_URL_LENGTH = 2048;
/** The only `mailto:` query fields let through (Team Sync review, security #7). */
const MAILTO_PARAMS = new Set(['subject', 'body']);

/** Returns the normalized href when `url` may be opened externally, else null. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.protocol === 'https:') {
    if (!parsed.hostname) return null;
    // `https://github.com@evil.example` reads as GitHub but goes to evil.example.
    if (parsed.username || parsed.password) return null;
  }
  if (parsed.protocol === 'mailto:') {
    // Mail clients honour header fields in the query: `attach=` (or `Attach`,
    // or `%61ttach`) can silently attach a local file, and `cc`/`bcc`/`to`
    // add recipients the user never sees. Only a prefilled subject and body are
    // allowed; anything else refuses the whole link rather than guessing.
    for (const key of parsed.searchParams.keys()) {
      if (!MAILTO_PARAMS.has(key.toLowerCase())) return null;
    }
  }
  return parsed.href;
}

function schemeOf(url: unknown): string {
  if (typeof url !== 'string') return typeof url;
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? `${m[1]!.toLowerCase()}:` : 'malformed';
}

/**
 * Opens `url` with `open` (pass `shell.openExternal`) only if it is allowed.
 * Never throws; logs the scheme only, since URLs can carry tokens.
 */
export async function openExternalSafe(
  url: unknown,
  open: (href: string) => Promise<void>,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  const href = safeExternalUrl(url);
  if (!href) {
    warn('[external-links] blocked', schemeOf(url));
    return false;
  }
  try {
    await open(href);
    return true;
  } catch (err) {
    warn('[external-links] open failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}
