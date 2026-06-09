/* ============================================================
   BATON — Demo dataset (UI-preview shim, NOT part of the contract)
   Ported from the design prototype's data.js. Mirrors the local API
   contract EXACTLY (only contract fields). Powers a clearly-labelled
   "demo mode" so the whole UI is viewable without a running daemon.
   Scenarios: busy (default), calm, empty, offline. Timestamps are
   generated relative to load time so relative-time labels stay sane.

   This is the honesty boundary: real `baton serve` data flows through
   the unchanged fetch path in lib/api.ts when demo mode is OFF.
   ============================================================ */
import type { StatusRow, TaskDetail, TaskHistory, CommitInfo } from "../types";

/** A demo session = a contract StatusRow plus the per-branch commits
 *  that /api/tasks/:slug would return. */
export interface DemoSession extends StatusRow {
  commits: CommitInfo[];
}

export interface Scenario {
  sessions: DemoSession[];
  history: TaskHistory[];
  offline?: boolean;
}
export type ScenarioName = "busy" | "calm" | "empty" | "offline";

const now = Date.now();
const MIN = 60 * 1000;
const HR = 60 * MIN;
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const c = (sha: string, message: string, msAgo: number): CommitInfo => ({ sha, message, at: iso(msAgo) });

/* ---- Worktree / branch metadata (returned by /api/tasks/:slug) ----
   Paths mirror the real CLI: worktrees live at <repo>/.baton/wt/<slug>
   (src/commands/new.ts), branches are baton/<slug>. */
export const REPO = "/Users/dev/code/orbit";
export const wt = (slug: string, repo = REPO) => `${repo}/.baton/wt/${slug}`;
export const br = (slug: string) => `baton/${slug}`;

/* ---------- BUSY scenario (the tense moment) ---------- */
const busySessions: DemoSession[] = [
  {
    slug: "auth-api-keys", task: "Refactor auth middleware to support API keys", agent: "claude",
    status: "dirty", ahead: 3, behind: 1, conflictFiles: [], filesChanged: 7, createdAt: iso(2 * HR + 12 * MIN),
    commits: [
      c("a1f9c20", "feat(auth): add ApiKey model + migration", 38 * MIN),
      c("7e3b8d1", "feat(auth): verify keys in middleware chain", 1 * HR + 20 * MIN),
      c("3c1a0f4", "chore(auth): scaffold key rotation service", 1 * HR + 58 * MIN),
    ],
  },
  {
    slug: "settings-dark-mode", task: "Add dark mode to the settings panel", agent: "cursor",
    status: "clean", ahead: 4, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(6 * HR + 4 * MIN),
    commits: [
      c("b8d44e1", "feat(settings): theme provider + persistence", 5 * HR),
      c("9a2c7f0", "feat(settings): system-aware toggle control", 4 * HR + 30 * MIN),
      c("4f6e1b3", "style(settings): token map for light surfaces", 3 * HR + 50 * MIN),
      c("e07d9a8", "test(settings): theme switch + a11y snapshot", 3 * HR + 10 * MIN),
    ],
  },
  {
    slug: "fix-checkout-e2e", task: "Fix flaky e2e tests in the checkout flow", agent: "codex",
    status: "conflict", ahead: 2, behind: 2, conflictFiles: ["src/lib/cart.ts", "tests/checkout.spec.ts"], filesChanged: 5, createdAt: iso(3 * HR + 40 * MIN),
    commits: [
      c("d51b7c9", "test(checkout): stabilize cart fixtures", 2 * HR + 40 * MIN),
      c("c93f2a7", "fix(cart): await async total recompute", 2 * HR),
    ],
  },
  {
    slug: "trpc-migration", task: "Migrate REST endpoints to tRPC", agent: "gemini",
    status: "dirty", ahead: 6, behind: 3, conflictFiles: [], filesChanged: 14, createdAt: iso(8 * HR + 18 * MIN),
    commits: [
      c("f2a8e10", "feat(trpc): bootstrap router + context", 7 * HR + 30 * MIN),
      c("1bc6d44", "feat(trpc): port /products to query", 6 * HR + 40 * MIN),
      c("8e0a5f2", "feat(trpc): port /cart mutations", 5 * HR + 55 * MIN),
      c("aa71c30", "refactor: shared zod schemas", 4 * HR + 20 * MIN),
      c("5d9b2e8", "feat(trpc): port /orders + pagination", 3 * HR),
      c("b40f7a1", "wip: client hooks for tRPC queries", 1 * HR + 30 * MIN),
    ],
  },
  {
    slug: "image-lazyload", task: "Optimize the image pipeline with lazy loading", agent: "aider",
    status: "clean", ahead: 2, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(4 * HR + 6 * MIN),
    commits: [
      c("c2e9f01", "perf(media): blur-up placeholders + srcset", 3 * HR + 30 * MIN),
      c("7b3a8d5", "perf(media): intersection-observer lazyload", 2 * HR + 50 * MIN),
    ],
  },
  {
    slug: "webhooks-docs", task: "Write API docs for outbound webhooks", agent: "claude",
    status: "dirty", ahead: 1, behind: 0, conflictFiles: [], filesChanged: 3, createdAt: iso(58 * MIN),
    commits: [c("e5c1a93", "docs(webhooks): event catalog + signing", 22 * MIN)],
  },
  {
    slug: "react-19-upgrade", task: "Upgrade the app to React 19", agent: "opencode",
    status: "conflict", ahead: 5, behind: 4, conflictFiles: ["package.json", "src/lib/cart.ts", "src/app/layout.tsx"], filesChanged: 11, createdAt: iso(12 * HR + 30 * MIN),
    commits: [
      c("9f4b2c1", "chore: bump react + react-dom to 19", 11 * HR),
      c("2a8e6d0", "fix: migrate off legacy ref callbacks", 9 * HR + 40 * MIN),
      c("d6c0f93", "fix: useFormState -> useActionState", 7 * HR + 20 * MIN),
      c("8b15a4e", "chore: update testing-library peers", 5 * HR + 10 * MIN),
      c("41f9c08", "fix: suspense boundary for new transitions", 2 * HR + 5 * MIN),
    ],
  },
  {
    slug: "search-typeahead", task: "Build typeahead for global product search", agent: "gemini",
    status: "clean", ahead: 0, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(14 * MIN), commits: [],
  },
  {
    slug: "db-index-tuning", task: "Tune Postgres indexes for the orders table", agent: "cursor",
    status: "clean", ahead: 1, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(92 * MIN),
    commits: [c("3e7d1f0", "perf(db): composite index on (user, created_at)", 40 * MIN)],
  },
  {
    slug: "perf-budget-ci", task: "Add a performance budget gate to CI", agent: null,
    status: "clean", ahead: 0, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(28 * MIN), commits: [],
  },
  {
    slug: "accessibility-audit", task: "Audit and fix keyboard traps across modals", agent: null,
    status: "clean", ahead: 0, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(19 * MIN), commits: [],
  },
];

/* ---------- CALM scenario ---------- */
const calmSessions: DemoSession[] = [
  {
    slug: "settings-dark-mode", task: "Add dark mode to the settings panel", agent: "claude",
    status: "clean", ahead: 2, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(3 * HR),
    commits: [
      c("b8d44e1", "feat(settings): theme provider + persistence", 2 * HR + 30 * MIN),
      c("9a2c7f0", "feat(settings): system-aware toggle control", 1 * HR + 40 * MIN),
    ],
  },
  {
    slug: "image-lazyload", task: "Optimize the image pipeline with lazy loading", agent: "aider",
    status: "dirty", ahead: 1, behind: 0, conflictFiles: [], filesChanged: 4, createdAt: iso(70 * MIN),
    commits: [c("c2e9f01", "perf(media): blur-up placeholders + srcset", 30 * MIN)],
  },
  {
    slug: "perf-budget-ci", task: "Add a performance budget gate to CI", agent: null,
    status: "clean", ahead: 0, behind: 0, conflictFiles: [], filesChanged: 0, createdAt: iso(15 * MIN), commits: [],
  },
];

/* ---------- HISTORY ---------- */
const busyHistory: TaskHistory[] = [
  {
    slug: "rate-limiter", task: "Add token-bucket rate limiting to the API gateway", agent: "claude", mergedAt: iso(3 * HR + 10 * MIN),
    commits: [
      c("aa01f29", "feat(gateway): token-bucket limiter", 5 * HR),
      c("bb12e84", "feat(gateway): per-key quotas + headers", 4 * HR + 10 * MIN),
      c("cc23d70", "test(gateway): burst + refill cases", 3 * HR + 30 * MIN),
    ],
  },
  {
    slug: "empty-states", task: "Design empty states for the dashboard", agent: "cursor", mergedAt: iso(6 * HR + 25 * MIN),
    commits: [
      c("dd34c61", "feat(ui): dashboard empty states", 8 * HR),
      c("ee45b52", "feat(ui): illustration + CTA copy", 7 * HR + 5 * MIN),
    ],
  },
  {
    slug: "csv-export", task: "Add CSV export to the reports page", agent: "codex", mergedAt: iso(1 * HR + 5 * MIN),
    commits: [
      c("ff56a43", "feat(reports): streaming csv export", 2 * HR + 30 * MIN),
      c("1067934", "fix(reports): escape embedded commas", 1 * HR + 50 * MIN),
    ],
  },
  {
    slug: "stripe-webhooks", task: "Handle Stripe webhook idempotency", agent: "gemini", mergedAt: iso(22 * HR),
    commits: [
      c("21788a5", "feat(billing): idempotency keys", 26 * HR),
      c("3289b16", "fix(billing): replay-safe event store", 24 * HR + 30 * MIN),
      c("43900c7", "test(billing): duplicate delivery", 23 * HR + 10 * MIN),
    ],
  },
  {
    slug: "skeleton-loaders", task: "Replace spinners with skeleton loaders", agent: "aider", mergedAt: iso(28 * HR),
    commits: [c("54a11d8", "refactor(ui): skeletons over spinners", 30 * HR)],
  },
  {
    slug: "i18n-scaffold", task: "Scaffold i18n with message catalogs", agent: "claude", mergedAt: iso(2 * 24 * HR + 4 * HR),
    commits: [
      c("65b22e9", "feat(i18n): catalog loader + provider", 52 * HR),
      c("76c33fa", "feat(i18n): extract dashboard strings", 50 * HR),
    ],
  },
  {
    slug: "oauth-google", task: "Add Google OAuth sign-in", agent: "codex", mergedAt: iso(3 * 24 * HR),
    commits: [
      c("87d440b", "feat(auth): google oauth provider", 74 * HR),
      c("98e551c", "fix(auth): callback state validation", 72 * HR),
    ],
  },
  {
    slug: "perf-bundle-split", task: "Code-split the editor route", agent: "opencode", mergedAt: null, // not yet merged
    commits: [
      c("a9f662d", "perf: lazy import editor chunk", 30 * MIN),
      c("ba07730", "perf: prefetch on intent hover", 12 * MIN),
    ],
  },
];

const calmHistory = busyHistory.slice(0, 4);

/* ---- contract projections ---- */

/** /api/status strips worktree/branch/commits. */
export function statusFrom(sessions: DemoSession[]): StatusRow[] {
  return sessions.map((s) => ({
    slug: s.slug, task: s.task, agent: s.agent, status: s.status,
    ahead: s.ahead, behind: s.behind, conflictFiles: s.conflictFiles.slice(),
    filesChanged: s.filesChanged, createdAt: s.createdAt,
  }));
}

export function historyFrom(list: TaskHistory[]): TaskHistory[] {
  return list.map((h) => ({ ...h, commits: h.commits.map((x) => ({ ...x })) }));
}

/** Build the /api/tasks/:slug detail for a demo session. */
export function detailFrom(s: DemoSession, repo = REPO): TaskDetail {
  return {
    slug: s.slug, task: s.task, agent: s.agent, status: s.status,
    ahead: s.ahead, behind: s.behind, conflictFiles: s.conflictFiles.slice(),
    filesChanged: s.filesChanged, createdAt: s.createdAt,
    worktreePath: wt(s.slug, repo), branch: br(s.slug),
    commits: (s.commits || []).map((x) => ({ ...x })),
  };
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  busy: { sessions: busySessions, history: busyHistory },
  calm: { sessions: calmSessions, history: calmHistory },
  empty: { sessions: [], history: [] },
  offline: { sessions: busySessions, history: busyHistory, offline: true },
};
