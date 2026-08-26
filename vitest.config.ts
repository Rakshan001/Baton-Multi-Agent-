// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only Baton's own tests — never the reference clones in .refs/.
    include: ['test/**/*.test.ts'],
    exclude: ['.refs/**', 'node_modules/**', 'dist/**'],
  },
});
