// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — member credential for the browser

   A dashboard reached over `--host` is talking to a daemon that
   requires a member token on every /api call. This module is the ONLY
   place that token is stored, read, or attached, so there is exactly
   one answer to "where does the credential live" rather than one per
   screen.

   Deliberate choices:

   - **The token is never put in a URL.** Not as a query parameter, not
     for the SSE stream, not once. URLs are logged by proxies, kept in
     history, and leak through Referer — which is why the daemon offers
     no query-string fallback either (Phase 4). It travels only as an
     Authorization header, which is why the event stream is read with
     fetch() rather than EventSource (see lib/sse.ts).

   - **Two stores, and the user picks.** "Remember on this device" is
     localStorage: convenient, and survives until sign-out. Unchecked is
     sessionStorage: gone when the tab closes, which is the right default
     on a borrowed or shared machine. Offering only the convenient one
     would push people to keep the token in a text file, which is worse
     than either.

   - **Keyed per daemon.** The connection switcher can point the same UI
     at several hubs; a token for one is not a credential for another.
   ============================================================ */

const PREFIX = "baton:token:";

/** One key per daemon. "" (same-origin) is the common case and stays stable. */
function keyFor(baseUrl: string): string {
  return PREFIX + (baseUrl || "same-origin");
}

/**
 * Accept what people actually paste. The invite command shows
 * `--token baton_…`, so a copied fragment can arrive wrapped in quotes or
 * already carrying the `Bearer` word. Rejecting those would be pedantry
 * about a typo the user cannot see.
 */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Shape of a token the daemon could plausibly accept (`baton_` + 64 hex —
 * src/members.ts TOKEN_RE), used ONLY to give a better message than a
 * round-trip 401 when someone pastes a URL or half a command.
 *
 * Deliberately advisory: a false answer here must never be the reason a valid
 * credential is refused, so the gate offers to try it anyway. The daemon's own
 * verdict is the one that counts.
 */
export function looksLikeToken(raw: string): boolean {
  return /^baton_[0-9a-f]{64}$/i.test(normalizeToken(raw));
}

function read(store: Storage, k: string): string {
  try {
    return store.getItem(k) ?? "";
  } catch {
    return ""; // storage disabled (private mode, blocked cookies) — treat as signed out
  }
}

export const auth = {
  /** The token for a daemon, or "" when there is none. */
  get(baseUrl: string): string {
    const k = keyFor(baseUrl);
    return read(localStorage, k) || read(sessionStorage, k);
  },

  /** Store a token. `remember` picks the store; it is not a second copy —
   *  the other store is always cleared so sign-out cannot leave one behind. */
  set(baseUrl: string, token: string, remember: boolean): void {
    const k = keyFor(baseUrl);
    const value = normalizeToken(token);
    try {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
      (remember ? localStorage : sessionStorage).setItem(k, value);
    } catch {
      /* storage blocked — the token stays in memory for this page only */
    }
  },

  /** True when this token would survive closing the tab. */
  remembered(baseUrl: string): boolean {
    return !!read(localStorage, keyFor(baseUrl));
  },

  /** Sign out of one daemon. Clears BOTH stores — a sign-out that left a
   *  remembered copy behind would silently sign you back in on reload. */
  clear(baseUrl: string): void {
    const k = keyFor(baseUrl);
    try {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    } catch {
      /* nothing to clear */
    }
  },

  /** Sign out of every daemon this browser holds a token for. */
  clearAll(): void {
    for (const store of [localStorage, sessionStorage]) {
      try {
        const keys: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k?.startsWith(PREFIX)) keys.push(k);
        }
        for (const k of keys) store.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  },
};
