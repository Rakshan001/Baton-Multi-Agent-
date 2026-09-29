// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * index.html carries the strict CSP for the built launcher. The dev server
 * needs inline scripts (React Refresh preamble) and injected <style> tags, so
 * it serves the page without the tag. Build output keeps it.
 */
const devDropCsp: Plugin = {
  name: 'baton-dev-drop-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, ''),
};

export default defineConfig({
  plugins: [react(), devDropCsp],
  base: './',
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
  },
  server: { port: 5174, strictPort: true },
});
