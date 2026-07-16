/* ============================================================
   BATON — demo-mode project memory
   Canned facts so the Memory page is explorable without a daemon.
   Mirrors the shape of GET /api/memory (src/memory.ts MemoryStatus).
   ============================================================ */
import type { MemoryFactStatus } from "../types";

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Demo sub-projects, so the per-server memory filter is explorable without a daemon. */
export const DEMO_MEMORY_PROJECTS = [
  { id: "api-server", rel: "api-server" },
  { id: "web", rel: "web" },
];

export const DEMO_MEMORY: MemoryFactStatus[] = [
  {
    id: "mem-payments-idempotency-keys-required",
    type: "gotcha",
    fact: "The payments worker retries failed jobs, so every charge call MUST pass an idempotency key — duplicate charges shipped to prod once before this was added.",
    agent: "claude", task: "fix-duplicate-charges", createdAt: ago(2),
    anchors: { commit: "9f31c2a", files: [{ path: "api-server/src/workers/payments.ts", hash: "a1b2c3d4e5f6" }] },
    supersedes: null, freshness: "fresh", staleReason: null, commitsBehind: 0, project: "api-server",
  },
  {
    id: "mem-api-responses-snake-case",
    type: "convention",
    fact: "All public API responses use snake_case keys; the Angular apps read them by string key, so renaming a field is a cross-repo breaking change.",
    agent: "cursor", task: null, createdAt: ago(5),
    anchors: { commit: "77ab019", files: [{ path: "api-server/src/api/serializers.ts", hash: "b2c3d4e5f6a1" }] },
    supersedes: null, freshness: "aging", staleReason: null, commitsBehind: 6, project: null,
  },
  {
    id: "mem-feature-flags-via-redis",
    type: "decision",
    fact: "Feature flags are read from Redis with a 30s in-process cache — we chose this over env vars so flags flip without redeploys. Do not add a second flag source.",
    agent: "claude", task: "feature-flag-system", createdAt: ago(9),
    anchors: { commit: "5c0ffee", files: [{ path: "api-server/src/flags.ts", hash: "c3d4e5f6a1b2" }] },
    supersedes: null, freshness: "fresh", staleReason: null, commitsBehind: 0, project: "api-server",
  },
  {
    id: "mem-auth-middleware-rewritten",
    type: "reference",
    fact: "Session auth lives in web/src/middleware/session.ts; JWTs are only for the mobile API. Web routes must not check JWTs.",
    agent: "codex", task: "auth-cleanup", createdAt: ago(21),
    anchors: { commit: "0badf00", files: [{ path: "web/src/middleware/session.ts", hash: "d4e5f6a1b2c3" }] },
    supersedes: null, freshness: "stale", staleReason: "web/src/middleware/session.ts changed since this was saved", commitsBehind: 14, project: "web",
  },
  {
    // Deliberately prose-only (no verifiable identifiers/paths in the text):
    // Repair can't re-anchor it mechanically, so it demos the review queue.
    id: "mem-exports-stream-not-buffer",
    type: "decision",
    fact: "Exports stream rows to the client instead of buffering the whole report — large tenants ran the box out of memory before this change.",
    agent: "gemini", task: "export-oom-fix", createdAt: ago(30),
    anchors: { commit: "3e11f09", files: [{ path: "api-server/src/exports/stream.ts", hash: "e5f6a1b2c3d4" }] },
    supersedes: null, freshness: "stale", staleReason: "api-server/src/exports/stream.ts changed since this was saved", commitsBehind: 22, project: "api-server",
  },
];
