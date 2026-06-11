/* ============================================================
   BATON — PREVIEW data (NOT part of the API contract)
   Token usage + git diffs aren't reported by `baton serve` yet.
   These illustrative values power clearly-labelled "Preview"
   surfaces (Activity, diff viewer, handoff) so the designed
   experience is real without faking live API data.
   Ported from data-preview.js — kept separate to keep the
   honesty boundary explicit.
   ============================================================ */
import type { DemoSession } from "./demoData";
import type { TaskHistory, Project } from "../types";

export type DiffLineType = "add" | "del" | "ctx";
export interface DiffLine { t: DiffLineType; o: number | null; n: number | null; s: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export type FileStatus = "added" | "modified" | "deleted";
export interface DiffFile { path: string; status: FileStatus; hunks: DiffHunk[]; add: number; del: number; lang: string }

export interface Usage { input: number; output: number; requests: number; contextPct: number; spark: number[] }

function hunk(oldStart: number, newStart: number, header: string, text: string): DiffHunk {
  const lines: DiffLine[] = [];
  let o = oldStart, n = newStart;
  text.replace(/^\n/, "").replace(/\n$/, "").split("\n").forEach((raw) => {
    const t = raw[0] || " ";
    const s = raw.slice(1);
    if (t === "+") lines.push({ t: "add", o: null, n: n++, s });
    else if (t === "-") lines.push({ t: "del", o: o++, n: null, s });
    else lines.push({ t: "ctx", o: o++, n: n++, s });
  });
  return { header, lines };
}
const count = (hunks: DiffHunk[]) =>
  hunks.reduce((a, h) => {
    h.lines.forEach((l) => { if (l.t === "add") a.add++; else if (l.t === "del") a.del++; });
    return a;
  }, { add: 0, del: 0 });
const file = (path: string, status: FileStatus, hunks: DiffHunk[]): DiffFile => ({
  path, status, hunks, ...count(hunks), lang: path.split(".").pop() || "",
});

const DIFFS: Record<string, DiffFile[]> = {
  "auth-api-keys": [
    file("src/lib/auth/api-key.ts", "added", [
      hunk(0, 1, "@@ new file @@", `
+import { createHash, randomBytes } from "node:crypto";
+import { db } from "@/lib/db";
+
+export type ApiKey = { id: string; hash: string; lastUsedAt: Date | null };
+
+export function mintKey() {
+  const raw = "bt_" + randomBytes(24).toString("base64url");
+  const hash = createHash("sha256").update(raw).digest("hex");
+  return { raw, hash };
+}
+
+export async function verifyKey(raw: string) {
+  const hash = createHash("sha256").update(raw).digest("hex");
+  return db.apiKey.findUnique({ where: { hash } });
+}`),
    ]),
    file("src/middleware.ts", "modified", [
      hunk(12, 12, "@@ -12,9 +12,16 @@ export async function middleware(req) {", `
   const session = await getSession(req);
-  if (!session) {
-    return NextResponse.redirect(new URL("/login", req.url));
+  if (session) return NextResponse.next();
+
+  const key = req.headers.get("authorization")?.replace("Bearer ", "");
+  if (key) {
+    const found = await verifyKey(key);
+    if (found) return NextResponse.next();
   }
-  return NextResponse.next();
+  return NextResponse.redirect(new URL("/login", req.url));
 }`),
    ]),
    file("prisma/schema.prisma", "modified", [
      hunk(40, 40, "@@ -40,3 +40,11 @@ model User {", `
   email String @unique
 }
+
+model ApiKey {
+  id         String   @id @default(cuid())
+  hash       String   @unique
+  userId     String
+  lastUsedAt DateTime?
+  createdAt  DateTime @default(now())
+}`),
    ]),
  ],
  "trpc-migration": [
    file("src/server/routers/products.ts", "added", [
      hunk(0, 1, "@@ new file @@", `
+import { z } from "zod";
+import { publicProcedure, router } from "../trpc";
+
+export const productsRouter = router({
+  list: publicProcedure
+    .input(z.object({ cursor: z.string().nullish(), limit: z.number().default(20) }))
+    .query(async ({ input, ctx }) => {
+      const items = await ctx.db.product.findMany({ take: input.limit + 1 });
+      const next = items.length > input.limit ? items.pop()!.id : null;
+      return { items, next };
+    }),
+});`),
    ]),
    file("src/app/api/products/route.ts", "deleted", [
      hunk(1, 0, "@@ -1,10 +0,0 @@", `
-import { NextResponse } from "next/server";
-import { db } from "@/lib/db";
-
-export async function GET() {
-  const products = await db.product.findMany();
-  return NextResponse.json(products);
-}`),
    ]),
  ],
  "fix-checkout-e2e": [
    file("src/lib/cart.ts", "modified", [
      hunk(28, 28, "@@ -28,7 +28,7 @@ export class Cart {", `
   async total() {
-    const lines = this.lines.map((l) => l.price * l.qty);
-    return lines.reduce((a, b) => a + b, 0);
+    const lines = await Promise.all(this.lines.map((l) => l.resolvePrice()));
+    return lines.reduce((a, b) => a + b.price * b.qty, 0);
   }`),
    ]),
    file("tests/checkout.spec.ts", "modified", [
      hunk(54, 54, "@@ -54,6 +54,8 @@ test(\"applies discount\", async () => {", `
   await page.getByRole("button", { name: "Checkout" }).click();
+  await page.waitForResponse((r) => r.url().includes("/cart/total"));
+  await expect(page.getByTestId("grand-total")).toHaveText("$84.00");
 });`),
    ]),
  ],
  "settings-dark-mode": [
    file("src/components/ThemeToggle.tsx", "added", [
      hunk(0, 1, "@@ new file @@", `
+"use client";
+import { useTheme } from "next-themes";
+
+export function ThemeToggle() {
+  const { theme, setTheme } = useTheme();
+  return (
+    <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
+      Toggle theme
+    </button>
+  );
+}`),
    ]),
    file("src/app/layout.tsx", "modified", [
      hunk(8, 8, "@@ -8,7 +8,9 @@ export default function RootLayout({ children }) {", `
   return (
     <html lang="en" suppressHydrationWarning>
-      <body>{children}</body>
+      <body>
+        <ThemeProvider attribute="data-theme" defaultTheme="dark">{children}</ThemeProvider>
+      </body>
     </html>
   );`),
    ]),
  ],
  "react-19-upgrade": [
    file("package.json", "modified", [
      hunk(18, 18, "@@ -18,8 +18,8 @@", `
   "dependencies": {
-    "react": "^18.3.1",
-    "react-dom": "^18.3.1",
+    "react": "^19.0.0",
+    "react-dom": "^19.0.0",
     "next": "^15.1.0"
   }`),
    ]),
    file("src/app/layout.tsx", "modified", [
      hunk(1, 1, "@@ -1,5 +1,5 @@", `
-import { useFormState } from "react-dom";
+import { useActionState } from "react";

 export const metadata = { title: "Orbit" };`),
    ]),
  ],
  "image-lazyload": [
    file("src/components/Media.tsx", "modified", [
      hunk(3, 3, "@@ -3,6 +3,9 @@ export function Media({ src, alt }) {", `
   return (
     <img
       src={src}
+      loading="lazy"
+      decoding="async"
+      sizes="(max-width: 768px) 100vw, 50vw"
       alt={alt}
     />
   );`),
    ]),
  ],
  "webhooks-docs": [
    file("docs/webhooks.md", "added", [
      hunk(0, 1, "@@ new file @@", `
+# Outbound webhooks
+
+Baton signs every delivery with an HMAC-SHA256 header:
+
+    X-Baton-Signature: t=<unix>,v1=<hex>
+
+Verify by recomputing v1 over \`{t}.{body}\` with your endpoint secret.`),
    ]),
  ],
  "db-index-tuning": [
    file("prisma/migrations/0007_orders_idx/migration.sql", "added", [
      hunk(0, 1, "@@ new file @@", `
+CREATE INDEX CONCURRENTLY "orders_user_created_idx"
+  ON "Order" ("userId", "createdAt" DESC);`),
    ]),
  ],
};

const TOKENS: Record<string, Usage> = {
  "auth-api-keys": { input: 184200, output: 31400, requests: 47, contextPct: 0.62, spark: [12, 18, 9, 22, 31, 27, 19, 24] },
  "settings-dark-mode": { input: 96500, output: 18900, requests: 31, contextPct: 0.34, spark: [8, 14, 11, 9, 16, 7, 5, 6] },
  "fix-checkout-e2e": { input: 142800, output: 24600, requests: 39, contextPct: 0.71, spark: [10, 9, 21, 28, 33, 25, 30, 22] },
  "trpc-migration": { input: 318700, output: 58200, requests: 86, contextPct: 0.83, spark: [22, 31, 28, 40, 37, 44, 39, 41] },
  "image-lazyload": { input: 61200, output: 9800, requests: 18, contextPct: 0.28, spark: [6, 9, 7, 11, 8, 5, 4, 3] },
  "webhooks-docs": { input: 38400, output: 14200, requests: 12, contextPct: 0.21, spark: [4, 7, 9, 12, 6, 3, 2, 5] },
  "react-19-upgrade": { input: 276300, output: 41800, requests: 73, contextPct: 0.77, spark: [18, 24, 33, 29, 38, 31, 27, 35] },
  "search-typeahead": { input: 8200, output: 1100, requests: 3, contextPct: 0.08, spark: [1, 2, 1, 3, 2, 1, 2, 1] },
  "db-index-tuning": { input: 44600, output: 7200, requests: 14, contextPct: 0.19, spark: [5, 8, 6, 4, 7, 3, 2, 4] },
  "perf-budget-ci": { input: 0, output: 0, requests: 0, contextPct: 0, spark: [0, 0, 0, 0, 0, 0, 0, 0] },
  "accessibility-audit": { input: 0, output: 0, requests: 0, contextPct: 0, spark: [0, 0, 0, 0, 0, 0, 0, 0] },
};

export function getUsage(slug: string): Usage {
  return TOKENS[slug] || { input: 0, output: 0, requests: 0, contextPct: 0, spark: [0, 0, 0, 0, 0, 0, 0, 0] };
}
export function getDiff(slug: string): DiffFile[] {
  return DIFFS[slug] || [];
}
export function fmtTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
  return String(n);
}

/* ---------------- LIVE ACTIVITY (demo-mode scripted stream) ---------------- */
export type LiveEventType = "boot" | "think" | "read" | "edit" | "create" | "delete" | "cmd" | "out" | "commit" | "warn";
export interface LiveEvent { t: LiveEventType; text: string; meta?: string }

interface SessionLike {
  slug: string;
  task: string;
  status: string;
  conflictFiles: string[];
  commits?: { sha: string; message: string }[];
}

/** Build a believable scripted activity stream from the session's diff + commits. */
export function buildActivity(slug: string, s?: SessionLike): LiveEvent[] {
  const files = getDiff(slug);
  const ev: LiveEvent[] = [];
  ev.push({ t: "boot", text: `Attached to worktree .baton/worktrees/${slug}` });
  ev.push({ t: "think", text: `Working on: ${s ? s.task : slug}` });
  ev.push({ t: "read", text: "Read project structure (1,284 files)" });
  files.forEach((f, i) => {
    ev.push({ t: "think", text: `Considering changes to ${f.path.split("/").pop()}` });
    ev.push({ t: "read", text: `Read ${f.path}` });
    ev.push({ t: f.status === "added" ? "create" : f.status === "deleted" ? "delete" : "edit", text: `${f.status === "added" ? "Created" : f.status === "deleted" ? "Deleted" : "Edited"} ${f.path}`, meta: `+${f.add} −${f.del}` });
    if (i === 0) { ev.push({ t: "cmd", text: "npm run typecheck" }); ev.push({ t: "out", text: "tsc --noEmit  ✓ no errors" }); }
  });
  ev.push({ t: "cmd", text: "npm test -- --runInBand" });
  ev.push({ t: "out", text: "PASS  src/lib/__tests__/unit.spec.ts" });
  ev.push({ t: "out", text: "Tests: 42 passed, 42 total" });
  if (s && s.status === "conflict") {
    ev.push({ t: "warn", text: `Detected overlapping edits in ${(s.conflictFiles[0] || "").split("/").pop()} — another session touched this file` });
    ev.push({ t: "think", text: "Pausing for human review before continuing" });
  } else {
    const last = s?.commits?.[s.commits.length - 1];
    const sha = last?.sha || "checkpt";
    const msg = last?.message || "chore: progress checkpoint";
    ev.push({ t: "cmd", text: "git add -A && git commit" });
    ev.push({ t: "commit", text: msg, meta: sha.slice(0, 7) });
    ev.push({ t: "think", text: "Continuing with the next step" });
  }
  return ev;
}

/* ---------------- WORKSPACE (folder → projects) ----------------
   Baton serves a folder that may hold one or many projects. "orbit"
   is the connected project (its data comes from the active scenario);
   the others are preview projects in the same workspace so the
   ProjectSwitcher is exercised. Ported from data-preview.js. */
export interface DemoProject extends Project {
  data?: { sessions: DemoSession[]; history: TaskHistory[] };
}
export interface Workspace {
  folder: string;
  projects: DemoProject[];
}
export type { Project };

const _now = Date.now();
const _MIN = 60_000;
const _HR = 3_600_000;
const _iso = (ago: number) => new Date(_now - ago).toISOString();
const _c = (sha: string, message: string, ago: number) => ({ sha, message, at: _iso(ago) });
const mk = (o: Partial<DemoSession> & Pick<DemoSession, "slug" | "task" | "agent" | "status" | "createdAt">): DemoSession => ({
  ahead: 0, behind: 0, conflictFiles: [], filesChanged: 0, commits: [], ...o,
});

const PULSE: DemoProject["data"] = {
  sessions: [
    mk({ slug: "pulse-ingest-rework", task: "Rework the event ingestion pipeline", agent: "claude", status: "dirty", ahead: 2, behind: 0, filesChanged: 6, createdAt: _iso(2 * _HR), commits: [_c("a31f0c2", "feat(ingest): batched writes", 1 * _HR), _c("7b9e441", "perf(ingest): backpressure queue", 30 * _MIN)] }),
    mk({ slug: "pulse-grafana-dash", task: "Build Grafana dashboards for latency", agent: "codex", status: "clean", ahead: 3, behind: 0, createdAt: _iso(4 * _HR), commits: [_c("c02a8d1", "feat(obs): p50/p95/p99 panels", 3 * _HR), _c("d51b9f3", "feat(obs): alert annotations", 2 * _HR), _c("e8c2a07", "chore(obs): provision as code", 1 * _HR)] }),
    mk({ slug: "pulse-alerting-rules", task: "Define alerting rules for error budgets", agent: "gemini", status: "clean", ahead: 0, behind: 0, createdAt: _iso(20 * _MIN) }),
    mk({ slug: "pulse-retention-policy", task: "Add a data retention + rollup policy", agent: null, status: "clean", ahead: 0, behind: 0, createdAt: _iso(12 * _MIN) }),
  ],
  history: [
    { slug: "pulse-otel", task: "Wire OpenTelemetry tracing", agent: "claude", mergedAt: _iso(20 * _HR), commits: [_c("11aa22b", "feat(otel): trace context propagation", 22 * _HR)] },
  ],
};
const ATLAS: DemoProject["data"] = {
  sessions: [
    mk({ slug: "atlas-search-index", task: "Add full-text search to the docs", agent: "cursor", status: "dirty", ahead: 1, behind: 0, filesChanged: 3, createdAt: _iso(80 * _MIN), commits: [_c("9c10ee2", "feat(search): build lunr index at compile", 40 * _MIN)] }),
    mk({ slug: "atlas-versioned-docs", task: "Support versioned documentation", agent: "aider", status: "clean", ahead: 2, behind: 0, createdAt: _iso(3 * _HR), commits: [_c("4f0b7a1", "feat(docs): version switcher", 2 * _HR), _c("a7e3c90", "feat(docs): per-version routing", 1 * _HR)] }),
    mk({ slug: "atlas-og-images", task: "Generate OG images per page", agent: null, status: "clean", ahead: 0, behind: 0, createdAt: _iso(15 * _MIN) }),
  ],
  history: [],
};

export const WORKSPACE: Workspace = {
  folder: "~/code",
  projects: [
    { id: "orbit", name: "Orbit", path: "/Users/dev/code/orbit", branch: "main", framework: "Next.js · commerce", color: "#6ea8fe", primary: true },
    { id: "pulse", name: "Pulse", path: "/Users/dev/code/pulse", branch: "main", framework: "Analytics API", color: "#f472b6", data: PULSE },
    { id: "atlas", name: "Atlas", path: "/Users/dev/code/atlas", branch: "develop", framework: "Docs site", color: "#a3e635", data: ATLAS },
  ],
};
