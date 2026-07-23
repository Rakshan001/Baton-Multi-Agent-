import { describe, it, expect } from 'vitest';
import { isLoopbackOrigin, isLoopbackHost, isMutatingMethod } from '../src/util/origin.js';

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
