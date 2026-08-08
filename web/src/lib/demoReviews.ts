// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   Demo fixtures for the Reviews screen.

   Demo mode is the showcase and must keep working, so the fixture
   deliberately exercises every state the real screen can hit:
   an open finding on each axis, a `hard` Standards breach, a
   resolved one, a dismissed one, a skipped axis, a partial review,
   and a stale record whose head no longer matches.
   ============================================================ */
import type { ReviewRecord } from "../types";

export const DEMO_REVIEWS: ReviewRecord[] = [
  {
    slug: "add-rate-limit",
    fixedPoint: "origin/main",
    head: "9c41ab2",
    axes: ["standards", "spec", "security"],
    skipped: [],
    findings: [
      {
        id: "a1b2c3d4e5",
        axis: "security",
        title: "Token compared with a non-constant-time equality",
        file: "src/server.ts",
        line: 412,
        source: "src/server.ts:412 — `if (token === expected)`",
        detail: "The proxy token is compared byte-by-byte with `===`, which returns early on the first mismatch.",
        hard: false,
        status: "open",
        route: "bug-fix",
      },
      {
        id: "b2c3d4e5f6",
        axis: "spec",
        title: "Limit is per-process, but the spec says per-project",
        file: "src/limit.ts",
        line: 28,
        source: "docs/superpowers/specs/2026-07-12-rate-limit-design.md:44",
        detail: "The design pins the budget to a project id; the implementation keys it on the daemon pid, so two daemons double the allowance.",
        hard: false,
        status: "open",
        route: "systematic-debugging",
      },
      {
        id: "c3d4e5f6a7",
        axis: "standards",
        title: "Shells out to git instead of util/exec.ts",
        file: "src/limit.ts",
        line: 61,
        source: "CLAUDE.md — “Git calls go through src/util/exec.ts (hardened, shell-free)”",
        detail: "`execSync(`git log ${range}`)` reintroduces a shell on a path that already has a hardened wrapper.",
        hard: true,
        status: "open",
        route: "fix-directly",
      },
      {
        id: "d4e5f6a7b8",
        axis: "standards",
        title: "Duplicated window-clamp helper",
        file: "src/limit.ts",
        line: 94,
        source: "src/limit.ts:94 vs src/signals.ts:108",
        hard: false,
        status: "fixed",
        route: "fix-directly",
      },
      {
        id: "e5f6a7b8c9",
        axis: "standards",
        title: "Prefers a named export over the file's default-export convention",
        file: "src/limit.ts",
        line: 12,
        source: "src/limit.ts:12",
        detail: "Judgement call — the surrounding files use both.",
        hard: false,
        status: "dismissed",
      },
    ],
    agent: "claude",
    author: "priya@example.com",
    createdAt: "2026-07-29T09:12:00.000Z",
    updatedAt: "2026-07-29T11:40:00.000Z",
    open: { standards: 1, spec: 1, security: 1 },
    stale: false,
  },
  {
    slug: "worktree-gc",
    fixedPoint: "HEAD~6",
    head: "41d0f8e",
    axes: ["standards", "security"],
    skipped: [{ axis: "spec", why: "no spec or issue was linked to this branch" }],
    findings: [
      {
        id: "f6a7b8c9d0",
        axis: "security",
        title: "Recursive delete takes a path from the request body",
        file: "src/cleanup.ts",
        line: 143,
        source: "src/cleanup.ts:143 — `rm(body.path, { recursive: true })`",
        detail: "Nothing constrains the path to the hub root, so `../..` escapes it.",
        hard: false,
        status: "open",
        route: "bug-fix",
      },
    ],
    partial: "diff was 41k lines; only src/ and test/ were reviewed",
    agent: "cursor",
    author: "jules@example.com",
    createdAt: "2026-07-24T16:02:00.000Z",
    updatedAt: "2026-07-24T16:02:00.000Z",
    open: { standards: 0, spec: 0, security: 1 },
    stale: true,
  },
];

export const DEMO_REVIEW_HEAD = "9c41ab2";
