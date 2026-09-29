// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { openExternalSafe, safeExternalUrl } from '../electron/external-links.ts';

describe('safeExternalUrl', () => {
  it.each([
    ['https://github.com/Rakshan001/baton', 'https://github.com/Rakshan001/baton'],
    ['https://example.com', 'https://example.com/'],
    ['HTTPS://Example.COM/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['  https://example.com/x  ', 'https://example.com/x'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['mailto:a@example.com?subject=hi', 'mailto:a@example.com?subject=hi'],
  ])('accepts %s', (input, normalized) => {
    expect(safeExternalUrl(input)).toBe(normalized);
  });

  it.each([
    ['file:///etc/passwd'],
    ['file://server/share/x.exe'],
    ['smb://attacker.example/share'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['http://example.com/'],
    ['ftp://example.com/'],
    ['ms-msdt:/id PCWDiagnostic'],
    ['search-ms:query=x'],
    ['vscode://file/etc/passwd'],
    ['baton://pair?h=10.0.0.1'],
    ['x-apple.systempreferences:com.apple.preference'],
    ['https://user:pass@example.com/'],
    ['https://github.com@evil.example/'],
    ['not a url'],
    ['//example.com/'],
    ['/relative/path'],
    [''],
    ['https://'],
    [`https://example.com/${'a'.repeat(4096)}`],
  ])('rejects %s', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{ href: 'https://x.example' }], [['https://x.example']]])(
    'rejects non-string input %j',
    (input) => {
      expect(safeExternalUrl(input)).toBeNull();
    },
  );
});

describe('safeExternalUrl — mailto query fields (security #7)', () => {
  it.each([
    ['mailto:a@example.com?subject=hi&body=there'],
    ['mailto:a@example.com?Subject=hi'],
    ['mailto:a@example.com?body=line%0Aline'],
  ])('allows subject and body only: %s', (input) => {
    expect(safeExternalUrl(input)).not.toBeNull();
  });

  it.each([
    ['mailto:a@example.com?attach=/etc/passwd'],
    ['mailto:a@example.com?subject=hi&attach=~/.ssh/id_rsa'],
    ['mailto:a@example.com?Attach=file:///etc/passwd'],
    ['mailto:a@example.com?%61ttach=/etc/passwd'],
    ['mailto:a@example.com?attachment=/etc/passwd'],
    ['mailto:a@example.com?cc=eve@evil.example'],
    ['mailto:a@example.com?bcc=eve@evil.example'],
    ['mailto:a@example.com?to=eve@evil.example'],
    ['mailto:a@example.com?subject=hi&x-header=1'],
  ])('refuses %s', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });
});

describe('openExternalSafe', () => {
  it('opens the normalized URL for an allowed scheme', async () => {
    const open = vi.fn(async () => {});
    const warn = vi.fn();
    await expect(openExternalSafe('  https://example.com/x', open, warn)).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/x');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never calls the opener for a rejected URL and warns without echoing it', async () => {
    const open = vi.fn(async () => {});
    const warn = vi.fn();
    await expect(openExternalSafe('file:///secret/token-123', open, warn)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.join(' '))).not.toContain('token-123');
  });

  it('reports false when the opener fails', async () => {
    const open = vi.fn(async () => { throw new Error('no handler'); });
    const warn = vi.fn();
    await expect(openExternalSafe('mailto:a@example.com', open, warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
