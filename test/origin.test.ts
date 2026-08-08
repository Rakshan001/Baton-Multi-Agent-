// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, isLoopbackOrigin, isLoopbackHost, isMutatingMethod } from '../src/util/origin.js';

describe('isLoopbackOrigin (anti-CSRF)', () => {
  it('allows a missing Origin (curl / same-origin navigation)', () => {
    expect(isLoopbackOrigin(undefined)).toBe(true);
    expect(isLoopbackOrigin(null)).toBe(true);
    expect(isLoopbackOrigin('')).toBe(true);
  });

  it('allows loopback origins on any port', () => {
    for (const o of [
      'http://localhost',
      'http://localhost:5173',
      'http://127.0.0.1:7077',
      'https://localhost:443',
      'http://[::1]:7077',
    ]) {
      expect(isLoopbackOrigin(o)).toBe(true);
    }
  });

  it('refuses third-party web origins (the CSRF case)', () => {
    for (const o of [
      'https://evil.com',
      'http://attacker.example',
      'https://localhost.evil.com',     // suffix trick
      'http://127.0.0.1.evil.com',      // prefix trick
      'http://notlocalhost',
      'http://10.0.0.5:7077',           // LAN, not loopback
    ]) {
      expect(isLoopbackOrigin(o)).toBe(false);
    }
  });
});

describe('isMutatingMethod', () => {
  it('flags state-changing methods', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(isMutatingMethod(m)).toBe(true);
    }
  });
  it('treats reads as non-mutating', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isMutatingMethod(m)).toBe(false);
    }
  });
});

/**
 * DNS rebinding — the attack the Origin guard structurally cannot see. An
 * attacker page on evil.com re-points its DNS at 127.0.0.1; the browser then
 * considers the daemon SAME-ORIGIN, so it sends no cross-origin Origin header
 * and CORS never applies. isLoopbackOrigin(undefined) is `true` by design (curl),
 * so every read sailed through: a forged `Host: evil.attacker.com` returned the
 * full task list from a live daemon. The Host header is the one part of such a
 * request the attacker cannot forge away — the browser sets it to the name it
 * dialled — so the daemon must require Host to name a loopback address.
 */
describe('isLoopbackHost (anti-DNS-rebinding)', () => {
  it('allows the loopback names a browser can legitimately reach the daemon by', () => {
    for (const h of [
      'localhost',
      'localhost:7077',
      '127.0.0.1',
      '127.0.0.1:7077',
      '[::1]:7077',
      '[::1]',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('refuses a rebound third-party Host (the attack)', () => {
    for (const h of [
      'evil.attacker.com',
      'evil.attacker.com:7077',
      'baton.evil.com',
      // Substring traps: a loopback name appearing somewhere in the host is not
      // a loopback host.
      'localhost.evil.com',
      'evil.com:7077/localhost',
      '127.0.0.1.evil.com',
      'notlocalhost',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  /**
   * Unlike Origin, a MISSING Host is not benign-by-default: HTTP/1.1 requires it
   * and every browser sends it, so absence means a hand-rolled client — which is
   * exactly what an attacker would use to skip the check. curl still works: it
   * sets Host itself.
   */
  it('refuses a missing or empty Host', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  // 0.0.0.0 and 127.x.x.x resolve locally but are not names a browser would be
  // pointed at for this daemon; only the canonical loopback forms are allowed.
  it('refuses non-canonical local-ish hosts', () => {
    expect(isLoopbackHost('0.0.0.0:7077')).toBe(false);
    expect(isLoopbackHost('127.0.0.2:7077')).toBe(false);
  });
});

/**
 * The Origin allow-list that makes a dashboard usable over `--host`.
 *
 * Widening the anti-CSRF check is the kind of change that quietly re-opens what
 * it was protecting, so the refusals are tested harder than the allowances.
 */
describe('isAllowedOrigin (anti-CSRF under --host)', () => {
  const allowed = ['mac-mini.local', 'baton.example.com'];

  it('keeps every loopback rule intact, declared names or not', () => {
    for (const list of [[], allowed]) {
      expect(isAllowedOrigin(undefined, list)).toBe(true);   // curl / same-origin
      expect(isAllowedOrigin('http://localhost:5173', list)).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:7077', list)).toBe(true);
    }
  });

  it('allows exactly the names the operator declared, on either scheme', () => {
    expect(isAllowedOrigin('http://mac-mini.local:7077', allowed)).toBe(true);
    expect(isAllowedOrigin('https://baton.example.com', allowed)).toBe(true);
  });

  it('refuses a third-party site — the attack the check exists for', () => {
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evil.com', [])).toBe(false);
  });

  /*
   * Suffix and prefix confusion: a name that merely CONTAINS a declared name is
   * a different host, and matching it would hand the allow-list to anyone who
   * can register `mac-mini.local.evil.com`.
   */
  it('never matches on substring, suffix or prefix', () => {
    expect(isAllowedOrigin('http://mac-mini.local.evil.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://evil-mac-mini.local', allowed)).toBe(false);
    expect(isAllowedOrigin('http://baton.example.com.evil', allowed)).toBe(false);
    expect(isAllowedOrigin('http://notbaton.example.com', allowed)).toBe(false);
  });

  it('refuses opaque and non-http origins', () => {
    // `null` is what a sandboxed iframe or a file:// page sends — the exact
    // shape a hostile embed arrives as. It is a value, not an absent header.
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('file://', allowed)).toBe(false);
    expect(isAllowedOrigin('ftp://mac-mini.local', allowed)).toBe(false);
    expect(isAllowedOrigin('http://mac-mini.local/path', allowed)).toBe(false);
  });

  it('an empty allow-list widens nothing', () => {
    expect(isAllowedOrigin('http://mac-mini.local:7077', [])).toBe(false);
    // …and a blank entry never becomes a wildcard
    expect(isAllowedOrigin('http://mac-mini.local:7077', ['', ' '])).toBe(false);
  });

  it('ignores the port and is case-insensitive, like a hostname comparison is', () => {
    expect(isAllowedOrigin('http://MAC-MINI.local:9999', allowed)).toBe(true);
    expect(isAllowedOrigin('http://mac-mini.local', ['mac-mini.local:7077'])).toBe(true);
  });
});
