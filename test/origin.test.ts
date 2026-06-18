import { describe, it, expect } from 'vitest';
import { isLoopbackOrigin, isMutatingMethod } from '../src/util/origin.js';

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
