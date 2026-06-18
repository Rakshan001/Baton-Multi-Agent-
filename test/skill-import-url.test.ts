import { describe, it, expect } from 'vitest';
import { isBlockedFetchHost } from '../src/skills/install.js';

describe('isBlockedFetchHost (skill-import SSRF guard)', () => {
  it('blocks loopback + localhost', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isBlockedFetchHost(h)).toBe(true);
    }
  });

  it('blocks cloud-metadata + link-local (169.254.0.0/16)', () => {
    expect(isBlockedFetchHost('169.254.169.254')).toBe(true);
    expect(isBlockedFetchHost('169.254.0.1')).toBe(true);
  });

  it('blocks RFC-1918 private + CGNAT + unspecified ranges', () => {
    for (const h of ['10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedFetchHost(h)).toBe(true);
    }
  });

  it('blocks IPv6 unique-local + link-local', () => {
    for (const h of ['fc00::1', 'fd12:3456::1', 'fe80::1', '[fe80::1]']) {
      expect(isBlockedFetchHost(h)).toBe(true);
    }
  });

  it('allows public skill hosts', () => {
    for (const h of ['github.com', 'raw.githubusercontent.com', 'example.com', '8.8.8.8', '172.32.0.1']) {
      expect(isBlockedFetchHost(h)).toBe(false);
    }
  });
});
