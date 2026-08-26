// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
// Single source of truth for the docs sidebar, the prev/next pager, and the
// sitemap. Adding a page here wires it into all three — there is no second list
// to forget.

import { README_URL } from "./site";

export type DocsPage = {
  /** Route, e.g. "/docs/architecture". */
  href: string;
  /** Sidebar label. */
  label: string;
  /** One line, shown on the docs index cards. */
  blurb: string;
};

export type DocsGroup = {
  /** Mono eyebrow above the group, e.g. "start here". */
  title: string;
  pages: readonly DocsPage[];
};

export const DOCS_GROUPS: readonly DocsGroup[] = [
  {
    title: "start here",
    pages: [
      {
        href: "/docs",
        label: "Overview & quick start",
        blurb:
          "What Baton is, what it writes to disk, and the four commands that get it running.",
      },
    ],
  },
  {
    title: "guides",
    pages: [
      {
        href: "/docs/how-it-works",
        label: "How it works",
        blurb:
          "The handoff lifecycle end to end — new, pass, take, signals, merge — and what each step writes to disk.",
      },
      {
        href: "/docs/architecture",
        label: "Architecture",
        blurb:
          "The zero-dependency daemon, the SSE event bus, SQLite signal storage, MCP tools, and the loopback security model.",
      },
      {
        href: "/docs/memory",
        label: "Memory & knowledge base",
        blurb:
          "Evidence-anchored facts, staleness detection and repair — plus the code knowledge graph behind CODEBASE.md.",
      },
    ],
  },
  {
    title: "reference",
    pages: [
      {
        href: "/docs/cli",
        label: "CLI reference",
        blurb:
          "Every baton command, grouped by the job it does, with the flags that matter.",
      },
    ],
  },
];

/** External links pinned to the bottom of the sidebar. */
export const DOCS_EXTERNAL = [
  { label: "README on GitHub", href: README_URL },
] as const;

/** Reading order, flattened — drives the prev/next pager. */
export const DOCS_ORDER: readonly DocsPage[] = DOCS_GROUPS.flatMap(
  (group) => group.pages,
);

/** The pages either side of `href` in reading order. */
export function docsNeighbors(href: string): {
  prev: DocsPage | null;
  next: DocsPage | null;
} {
  const i = DOCS_ORDER.findIndex((page) => page.href === href);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? DOCS_ORDER[i - 1] : null,
    next: i < DOCS_ORDER.length - 1 ? DOCS_ORDER[i + 1] : null,
  };
}
