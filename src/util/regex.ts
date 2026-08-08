// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Escape a string so it can be matched literally inside a RegExp.
 *
 * Shared by routing (keyword hints), memory (topic scoring), and the MCP-config
 * writer (TOML table names). The parallel web copy in web/src/lib/routing.ts is
 * intentionally separate (no cross-workspace imports) and behaviour-parity-tested.
 */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
