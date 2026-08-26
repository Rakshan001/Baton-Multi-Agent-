// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stamps the resolved theme onto <html> before the first paint, so a light-mode
 * visitor never sees a black flash (and vice versa).
 *
 * Runs synchronously in <head> — deliberately blocking, because anything
 * deferred is by definition too late to prevent the flash.
 *
 * If localStorage is unavailable (Safari private mode, storage disabled) it
 * leaves the attribute off entirely, and the `:root:not([data-theme])`
 * prefers-color-scheme rules in globals.css take over. Same for no-JS.
 */
const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('baton-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* No storage access — the CSS media-query fallback handles it. */
  }
})();
`;

export default function ThemeScript() {
  return (
    <script
      // Must be inline and un-deferred; next/script would run too late.
      dangerouslySetInnerHTML={{ __html: SCRIPT }}
    />
  );
}
