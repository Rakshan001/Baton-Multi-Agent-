// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The browser's member-credential store.
 *
 * Small surface, but it is the only place a live token sits in a browser, so
 * the properties that matter are the negative ones: a sign-out must not leave a
 * copy behind, and "this tab only" must not quietly mean "forever".
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/** Minimal Web Storage stand-in — jsdom is not a dependency and is not needed
 *  for a key/value map with a `length`/`key()` pair. */
class MemStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const g = globalThis as unknown as { localStorage: MemStorage; sessionStorage: MemStorage };
g.localStorage = new MemStorage();
g.sessionStorage = new MemStorage();
afterAll(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

const { auth, normalizeToken, looksLikeToken } = await import('../web/src/lib/auth');

const TOKEN = `baton_${'a'.repeat(64)}`;
const OTHER = `baton_${'b'.repeat(64)}`;

beforeEach(() => { g.localStorage.clear(); g.sessionStorage.clear(); });

describe('normalizeToken', () => {
  it('accepts what people actually paste', () => {
    expect(normalizeToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(normalizeToken(`bearer  ${TOKEN}`)).toBe(TOKEN);
    expect(normalizeToken(`"${TOKEN}"`)).toBe(TOKEN);
  });
});

describe('looksLikeToken', () => {
  it('matches the daemon\'s own format (src/members.ts TOKEN_RE)', () => {
    expect(looksLikeToken(TOKEN)).toBe(true);
    expect(looksLikeToken(`Bearer ${TOKEN}`)).toBe(true);
  });
  it('rejects the common wrong pastes', () => {
    expect(looksLikeToken('http://mac-mini.local:7077')).toBe(false);
    expect(looksLikeToken('npx baton join')).toBe(false);
    expect(looksLikeToken('baton_short')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('auth store', () => {
  it('remembers across tabs only when asked', () => {
    auth.set('', TOKEN, true);
    expect(auth.get('')).toBe(TOKEN);
    expect(auth.remembered('')).toBe(true);
    expect(g.sessionStorage.length).toBe(0);

    auth.set('', TOKEN, false);
    expect(auth.get('')).toBe(TOKEN);
    expect(auth.remembered('')).toBe(false);
    // The point of the unchecked box: nothing survives the tab.
    expect(g.localStorage.length).toBe(0);
  });

  /*
   * The bug this prevents: switching from "remember" to "this tab only" leaves
   * the old copy in localStorage, so the box says one thing and the browser
   * does another — and a sign-out would silently sign you back in on reload.
   */
  it('never leaves a copy in the other store', () => {
    auth.set('', TOKEN, true);
    auth.set('', OTHER, false);
    expect(g.localStorage.getItem('baton:token:same-origin')).toBeNull();
    expect(auth.get('')).toBe(OTHER);

    auth.clear('');
    expect(auth.get('')).toBe('');
    expect(g.localStorage.length + g.sessionStorage.length).toBe(0);
  });

  it('normalizes on the way in, so a pasted `Bearer ` prefix is never stored', () => {
    auth.set('', `Bearer ${TOKEN}`, true);
    expect(auth.get('')).toBe(TOKEN);
  });

  it('keys per daemon — one hub\'s token is not another\'s', () => {
    auth.set('', TOKEN, true);
    auth.set('http://mac-mini.local:7077', OTHER, true);
    expect(auth.get('')).toBe(TOKEN);
    expect(auth.get('http://mac-mini.local:7077')).toBe(OTHER);

    auth.clear('');
    expect(auth.get('http://mac-mini.local:7077')).toBe(OTHER); // untouched
  });

  it('clearAll signs out of every hub and touches nothing else', () => {
    auth.set('', TOKEN, true);
    auth.set('http://other:7077', OTHER, false);
    g.localStorage.setItem('baton:theme', '"dark"');

    auth.clearAll();
    expect(auth.get('')).toBe('');
    expect(auth.get('http://other:7077')).toBe('');
    expect(g.localStorage.getItem('baton:theme')).toBe('"dark"');
  });

  it('reports no token rather than throwing when storage is unavailable', () => {
    const saved = g.localStorage;
    // Private-mode browsers throw on access rather than returning null.
    g.localStorage = new Proxy({} as MemStorage, {
      get() { throw new Error('storage disabled'); },
    });
    try {
      expect(auth.get('')).toBe('');
      expect(() => auth.clear('')).not.toThrow();
    } finally {
      g.localStorage = saved;
    }
  });
});
