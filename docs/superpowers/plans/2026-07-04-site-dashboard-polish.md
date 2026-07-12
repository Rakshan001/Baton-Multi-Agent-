# Site Hosting Readiness + Dashboard Edge-Case Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the marketing site (`site/`) hosting-ready on Vercel (env-driven URLs, PNG social image, favicon, correct quick-start commands, mobile menu) and fix the verified dashboard (`web/`) edge cases (SSE reconnect indicator, fetch-error retry UI, loading skeletons, overflow).

**Architecture:** Two independent workstreams. Site changes are Next.js App-Router file conventions (`opengraph-image.tsx`, `icon.svg`) plus small component edits. Dashboard changes are presentational React edits using existing primitives (`ErrorState`, `CardSkeleton`) and one hook extension (`useEvents` gains `reconnecting`). No backend changes, no new event types, no new dependencies.

**Tech Stack:** Next.js 15 App Router + Tailwind (site/), React 18 + Vite with inline-style tokens (web/), strict TypeScript both.

**Spec:** `docs/superpowers/specs/2026-07-04-site-dashboard-polish-design.md`

## Global Constraints

- Zero new dependencies in either workspace (`next/og` ships with Next).
- No backend/daemon changes; the backend test suite must stay at **292 passing**.
- Demo mode (`BatonAPI.demo`) must keep working untouched.
- Strict TypeScript in both workspaces; both `npm run build` (site/) and `npm run build --prefix web` must pass.
- web/ styling uses the existing CSS-variable tokens (`var(--fs-13)`, `var(--conflict-text)`, …) — never hard-coded colors/sizes.
- site/ styling uses the existing Tailwind utility vocabulary (`text-muted`, `border-line`, `bg-ink-2`, `text-amber`, …).
- No literal `baton.dev` may remain anywhere in `site/`.
- Neither workspace has a JS test runner — each task verifies via typecheck/build plus the stated manual/browser check; there is no vitest step for these tasks.
- Commit after each task (approval already given for this build's task commits; never push).

---

### Task 1: Env-driven site URL (kill baton.dev)

**Files:**
- Create: `site/lib/site-url.ts`
- Modify: `site/app/layout.tsx` (lines 17, 23, 41, 44)
- Modify: `site/app/robots.ts`
- Modify: `site/app/sitemap.ts`

**Interfaces:**
- Produces: `SITE_URL: string` exported from `site/lib/site-url.ts` — absolute origin, `https://`-prefixed, no trailing slash. Task 2 relies on `layout.tsx` importing it.

- [ ] **Step 1: Create `site/lib/site-url.ts`**

```ts
// Single source of truth for the site's public origin.
// Precedence: explicit NEXT_PUBLIC_SITE_URL → Vercel's production URL →
// Vercel's per-deployment URL → local dev. Vercel injects its URLs without
// a protocol, so normalize adds https:// and strips trailing slashes.
function normalize(url: string): string {
  const withProtocol = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProtocol.replace(/\/+$/, "");
}

const fromEnv =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.VERCEL_PROJECT_PRODUCTION_URL ||
  process.env.VERCEL_URL;

export const SITE_URL = fromEnv ? normalize(fromEnv) : "http://localhost:3000";
```

- [ ] **Step 2: Use it in `site/app/layout.tsx`**

Replace line 17 (`const SITE_URL = "https://baton.dev";`) with:

```ts
import { SITE_URL } from "@/lib/site-url";
```

(put the import with the other imports at the top; delete the const). The existing `metadataBase: new URL(SITE_URL)`, `alternates.canonical`, `openGraph.url`, and JSON-LD `url` lines keep working unchanged.

- [ ] **Step 3: Use it in `site/app/robots.ts`**

```ts
import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

- [ ] **Step 4: Use it in `site/app/sitemap.ts`**

```ts
import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
```

- [ ] **Step 5: Verify**

Run: `grep -rn "baton\.dev" site/app site/components site/lib` → expected: **no matches**.
Run: `npm run build` in `site/` → expected: build succeeds.
Run: `NEXT_PUBLIC_SITE_URL=https://example.com/ npm run build` in `site/` → expected: build succeeds (trailing slash exercised; no crash).

- [ ] **Step 6: Commit**

```bash
git add site/lib/site-url.ts site/app/layout.tsx site/app/robots.ts site/app/sitemap.ts
git commit -m "fix(site): env-driven site URL — no hard-coded baton.dev in canonical/OG/sitemap"
```

---

### Task 2: PNG social image + favicon (file conventions)

**Files:**
- Create: `site/app/opengraph-image.tsx`
- Create: `site/app/apple-icon.tsx`
- Create: `site/app/icon.svg`
- Modify: `site/app/layout.tsx` (remove `openGraph.images` and `twitter.images` arrays)
- Delete: `site/public/og.svg`

**Interfaces:**
- Consumes: nothing from Task 1 beyond `layout.tsx` compiling.
- Produces: Next file-convention routes `/opengraph-image`, `/apple-icon`, `/icon.svg` — Next injects the `og:image`/`twitter:image`/favicon tags automatically; no manual metadata entries remain.

- [ ] **Step 1: Create `site/app/opengraph-image.tsx`**

Satori (behind `ImageResponse`) requires explicit `display: "flex"` on any element with multiple children; keep every container flex.

```tsx
import { ImageResponse } from "next/og";

export const alt =
  "Baton — Plan on your expensive agent. Pass the baton to your cheap one.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0a0a0b";
const FG = "#f4f4f5";
const MUTED = "#a1a1aa";
const AMBER = "#ff9d2e";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: INK,
          color: FG,
        }}
      >
        <div style={{ display: "flex", fontSize: 40, fontWeight: 600 }}>
          <span style={{ color: AMBER }}>/</span>
          <span>baton</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 62, fontWeight: 700 }}>
            <span>Plan on your&nbsp;</span>
            <span style={{ color: AMBER }}>expensive</span>
            <span>&nbsp;agent.</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 62,
              fontWeight: 700,
              color: MUTED,
            }}
          >
            <span>Pass the baton to your cheap one.</span>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
          <span>
            Coordinate Claude Code · Cursor · Codex · Gemini on one repo — open
            source
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
```

- [ ] **Step 2: Create `site/app/apple-icon.tsx`**

```tsx
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0b",
          color: "#ff9d2e",
          fontSize: 120,
          fontWeight: 700,
        }}
      >
        /
      </div>
    ),
    { ...size },
  );
}
```

- [ ] **Step 3: Create `site/app/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0a0b"/>
  <text x="32" y="47" font-family="ui-monospace, Menlo, monospace" font-size="46" font-weight="700" fill="#ff9d2e" text-anchor="middle">/</text>
</svg>
```

- [ ] **Step 4: Remove manual image metadata from `site/app/layout.tsx`**

In the `metadata` object, delete the `images: [...]` property from `openGraph` (lines 48–55) and the `images: ["/og.svg"]` property from `twitter` (line 61). Keep every other field. Next now derives both tags from `opengraph-image.tsx`.

- [ ] **Step 5: Delete the SVG social image**

```bash
git rm site/public/og.svg
```

- [ ] **Step 6: Verify**

Run: `npm run build` in `site/` → expected: build output lists `/opengraph-image` and `/apple-icon` routes and `/icon.svg`.
Run: `grep -rn "og\.svg" site/app site/components` → expected: no matches.
Then start the dev server and check `curl -sI http://localhost:3000/opengraph-image | head -3` → expected: `200` with `content-type: image/png`.

- [ ] **Step 7: Commit**

```bash
git add site/app/opengraph-image.tsx site/app/apple-icon.tsx site/app/icon.svg site/app/layout.tsx
git commit -m "feat(site): PNG social image + favicon via App Router file conventions; drop og.svg"
```

---

### Task 3: Correct quick-start commands + star-count fallback

**Files:**
- Modify: `site/components/site.ts`
- Modify: `site/components/CopyChip.tsx`
- Modify: `site/components/Nav.tsx` (lines 65, 74–81)
- Modify: `site/components/OpenSourceCTA.tsx` (lines 55–75)

**Interfaces:**
- Consumes: `REPO_URL` from `site/components/site.ts`.
- Produces: `CLONE_CMD: string` and `QUICKSTART_CMD: string` in `site.ts`; `CopyChip` gains an optional `display?: string` prop (text shown when it differs from what's copied). Task 4 doesn't depend on these.

- [ ] **Step 1: Add command constants to `site/components/site.ts`**

Below the existing URL constants add:

```ts
/** The one command a visitor needs — clone the repo. */
export const CLONE_CMD = `git clone ${REPO_URL}.git`;

/** Full quick start, matching README.md exactly (clone → deps → build → serve). */
export const QUICKSTART_CMD = [
  `git clone ${REPO_URL}.git baton && cd baton`,
  "npm install && npm install --prefix web",
  "npm run build && npm run build --prefix web",
  "node dist/cli.js serve --write",
].join("\n");
```

- [ ] **Step 2: Add the `display` prop to `site/components/CopyChip.tsx`**

Change the props and the label span:

```tsx
export default function CopyChip({
  command,
  display,
  prefix = "$",
  className = "",
}: {
  command: string;
  display?: string;
  prefix?: string;
  className?: string;
}) {
```

and in the JSX replace `<span className={`text-fg ${className}`}>{command}</span>` with:

```tsx
      <span className={`text-fg ${className}`}>{display ?? command}</span>
```

(the `aria-label` and `copy()` still use `command` — the full text is what's copied).

- [ ] **Step 3: Fix the Nav chip in `site/components/Nav.tsx`**

Replace line 65:

```tsx
            <CopyChip command="npm install && node dist/cli.js serve --write" prefix="$" />
```

with:

```tsx
            <CopyChip command={CLONE_CMD} prefix="$" />
```

and extend the import on line 4 to `import { NAV_LINKS, REPO_URL, CLONE_CMD } from "./site";`.

- [ ] **Step 4: Hide the star count when null or 0 in `site/components/Nav.tsx`**

Replace lines 74–81 (the `<span>Star</span>` + count span) with:

```tsx
            <span>Star</span>
            {stars !== null && stars > 0 && (
              <span
                className="font-mono text-amber"
                aria-label={`${stars} GitHub stars`}
              >
                {formatStars(stars)}
              </span>
            )}
```

(no more `"★"` fallback rendered as a count; `STAR_FALLBACK` in `site.ts` becomes unused — delete that constant and its comment.)

- [ ] **Step 5: Full quick start in `site/components/OpenSourceCTA.tsx`**

Update the import (line 3) to include the new constant:

```tsx
import { REPO_URL, LICENSE_URL, GOOD_FIRST_ISSUES_URL, QUICKSTART_CMD } from "./site";
```

Replace the `<pre>` block content (lines 56–68) with the full sequence:

```tsx
          <pre className="overflow-x-auto rounded-xl border border-line bg-ink-2 p-4 font-mono text-sm leading-relaxed text-muted">
            <code>
              <span className="text-faint">$</span> git clone {"\\"}
              {"\n  "}https://github.com/Rakshan001/Baton-Multi-Agent-.git baton
              {"\n"}
              <span className="text-faint">$</span> cd baton && npm install && npm install --prefix web
              {"\n"}
              <span className="text-faint">$</span> npm run build && npm run build --prefix web
              {"\n"}
              <span className="text-faint">$</span> node dist/cli.js{" "}
              <span className="text-amber">serve --write</span>
              {"\n  "}
              <span className="text-faint"># → http://localhost:7077</span>
            </code>
          </pre>
```

and replace the `CopyChip` beneath it (lines 70–73) with:

```tsx
            <CopyChip
              command={QUICKSTART_CMD}
              display="Copy the full quick start"
              prefix="$"
            />
```

- [ ] **Step 6: Verify**

Run: `npm run build` in `site/` → expected: pass.
Run: `grep -n "node dist/cli.js" site/components/Nav.tsx` → expected: no matches.
Manual: on the dev server confirm the nav chip shows the clone command, the CTA block shows 4 steps, and the star button shows no `0`.

- [ ] **Step 7: Commit**

```bash
git add site/components/site.ts site/components/CopyChip.tsx site/components/Nav.tsx site/components/OpenSourceCTA.tsx
git commit -m "fix(site): working clone/build quick-start commands; hide zero star count"
```

---

### Task 4: Mobile nav menu + no-JS reveal fallback

**Files:**
- Create: `site/components/MobileMenu.tsx`
- Modify: `site/components/Nav.tsx` (render `<MobileMenu />` in the right-hand group)
- Modify: `site/app/layout.tsx` (noscript style)

**Interfaces:**
- Consumes: `NAV_LINKS` from `site/components/site.ts`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Create `site/components/MobileMenu.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { NAV_LINKS } from "./site";

/** Disclosure menu for the nav links on < md viewports. Escape or an
 *  outside click closes it; picking a link closes it before scrolling. */
export default function MobileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-fg"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {open ? (
            <path d="M3 3l10 10M13 3L3 13" />
          ) : (
            <path d="M2 4.5h12M2 8h12M2 11.5h12" />
          )}
        </svg>
      </button>
      {open && (
        <ul
          id="mobile-nav"
          className="absolute right-0 top-11 z-50 w-48 rounded-xl border border-line bg-ink-2/95 p-2 backdrop-blur"
        >
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target={"external" in link && link.external ? "_blank" : undefined}
                rel={
                  "external" in link && link.external
                    ? "noopener noreferrer"
                    : undefined
                }
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render it in `site/components/Nav.tsx`**

Add `import MobileMenu from "./MobileMenu";` with the other imports, then inside the right-hand `<div className="flex items-center gap-3">` add `<MobileMenu />` as the **last** child (after the Star link) so it sits at the far right on phones.

- [ ] **Step 3: No-JS reveal fallback in `site/app/layout.tsx`**

Inside `<body>`, directly before the skip link, add:

```tsx
        <noscript>
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
```

- [ ] **Step 4: Verify**

Run: `npm run build` in `site/` → expected: pass.
Manual (preview at 375px width): hamburger visible, opens the four links, Escape closes, tapping a link scrolls and closes. At ≥ 768px the hamburger is hidden.

- [ ] **Step 5: Commit**

```bash
git add site/components/MobileMenu.tsx site/components/Nav.tsx site/app/layout.tsx
git commit -m "feat(site): mobile nav menu; keep content visible without JavaScript"
```

---

### Task 5: SSE reconnect indicator (web)

**Files:**
- Modify: `web/src/hooks/useEvents.ts`
- Modify: `web/src/components/primitives.tsx` (the `ApiDot` component)
- Modify: `web/src/App.tsx` (TopBar props ~line 250–253, ApiDot render line 292, TopBar call site ~line 508)

**Interfaces:**
- Consumes: existing `useEvents` / `ApiDot`.
- Produces: `useEvents(...)` return gains `reconnecting: boolean`; `ApiDot` gains prop `reconnecting?: boolean`. Tasks 6–7 don't depend on this.

- [ ] **Step 1: Track reconnecting in `web/src/hooks/useEvents.ts`**

Change the hook signature/return and the open/error handlers:

```ts
export function useEvents({ enabled = true, baseUrl = "" }: { enabled?: boolean; baseUrl?: string } = {}): {
  live: boolean;
  reconnecting: boolean;
  subscribe: (type: string, fn: Handler) => () => void;
} {
  const [live, setLive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const everLive = useRef(false);
  const handlersRef = useRef(new Map<string, Set<Handler>>());
```

In the effect, replace the `setLive(false)` early-return branch's body with `setLive(false); setReconnecting(false);` and replace the two handlers:

```ts
    es.onopen = () => { everLive.current = true; setLive(true); setReconnecting(false); };
    // EventSource retries on its own; only call it "reconnecting" if the
    // stream has ever been open — a daemon that was never up is just offline.
    es.onerror = () => { setLive(false); if (everLive.current) setReconnecting(true); };
```

and in the cleanup add `setReconnecting(false);` after `setLive(false);`. Finally return `{ live, reconnecting, subscribe }`.

- [ ] **Step 2: Amber state in `ApiDot` (`web/src/components/primitives.tsx`)**

Change the signature and meta selection:

```tsx
export function ApiDot({ state, lastUpdated, onRefresh, live = false, reconnecting = false }: { state: "online" | "fetching" | "offline"; lastUpdated: number | null; onRefresh: () => void; live?: boolean; reconnecting?: boolean }) {
```

```tsx
  const meta = state !== "offline" && reconnecting
    ? { c: "var(--dirty)", t: "Event stream reconnecting — polling keeps data fresh" }
    : ({ online: { c: "var(--clean)", t: live ? "Live (push)" : "Connected (polling)" }, fetching: { c: "var(--accent)", t: "Syncing…" }, offline: { c: "var(--conflict)", t: "Offline" } } as const)[state] || { c: "var(--idle)", t: "—" };
```

and change the visible text expression so the reconnecting state is explicit:

```tsx
      <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
        {state === "offline" ? "Offline" : reconnecting ? "reconnecting…" : <>updated <span className="mono">{ago === "just now" ? "0s" : timeAgoShort(lastUpdated)}</span></>}
      </span>
```

- [ ] **Step 3: Wire through `web/src/App.tsx`**

TopBar props (~line 250–253): add `reconnecting` to the destructured props and to the type — `demo: boolean; live: boolean; reconnecting: boolean;`. Line 292 becomes:

```tsx
      <ApiDot state={apiState} lastUpdated={lastUpdated} onRefresh={onRefresh} live={live} reconnecting={reconnecting} />
```

At the TopBar call site (~line 508) add `reconnecting={events.reconnecting}` next to `live={events.live}`.

- [ ] **Step 4: Verify**

Run: `npm run build --prefix web` → expected: pass.
Manual: `node dist/cli.js serve` on a test dir, open the dashboard, kill the daemon → the dot turns amber with "reconnecting…"; restart the daemon → returns to green "updated Xs". Demo mode (`npm run dev --prefix web`): dot unchanged from today.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useEvents.ts web/src/components/primitives.tsx web/src/App.tsx
git commit -m "feat(web): surface SSE reconnecting state in the TopBar ApiDot"
```

---

### Task 6: Memory — error retry, loading skeletons, overflow fix

**Files:**
- Modify: `web/src/features/Memory.tsx` (list rendering ~lines 192–212, FactCard files span ~line 276–280, imports)

**Interfaces:**
- Consumes: `ErrorState`, `CardSkeleton` from `web/src/components/primitives.tsx` (existing exports); `data` is `usePoll`'s `PollState` which already exposes `error`, `refetch`, `isFetching`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Import the primitives**

`Memory.tsx` already imports from `../components/primitives` (check the top of the file); ensure the import list includes `ErrorState` and `CardSkeleton` (add them, or add the import line if none exists):

```tsx
import { ErrorState, CardSkeleton } from "../components/primitives";
```

(merge into the existing primitives import if one is present — do not create a duplicate import from the same module.)

- [ ] **Step 2: Error + skeleton states in the list block**

Replace the current list block (lines 192–194):

```tsx
        {/* list */}
        {data.isLoading ? (
          <div style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-13)", padding: 24, textAlign: "center" }}>Loading memory…</div>
        ) : visible.length === 0 ? (
```

with:

```tsx
        {/* list */}
        {data.error && !data.data ? (
          <ErrorState title="Couldn't load memory" desc={(data.error as Error).message}
            command="baton serve" onRetry={data.refetch} retrying={data.isFetching} />
        ) : data.isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : visible.length === 0 ? (
```

(the rest of the ternary chain — empty state, then `visible.map` — is unchanged. Note the guard is `error && !data.data`: while stale data exists we keep showing it and let polling recover.)

- [ ] **Step 3: Fix the anchored-files ellipsis in `FactCard`**

Replace (lines 276–280):

```tsx
          {f.anchors.files.length > 0 && (
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis" }}>
              <Icon name="folder" size={11} /> {f.anchors.files.map((a) => a.path).join(", ")}
            </span>
          )}
```

with:

```tsx
          {f.anchors.files.length > 0 && (
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, maxWidth: "100%" }}>
              <Icon name="folder" size={11} style={{ flex: "none" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.anchors.files.map((a) => a.path).join(", ")}
              </span>
            </span>
          )}
```

- [ ] **Step 4: Verify**

Run: `npm run build --prefix web` → expected: pass.
Manual (real mode, daemon stopped after load): Memory screen shows the ErrorState with a working Retry, **not** "No memories yet". Demo mode: memory list renders exactly as before; a fact with many long anchored paths shows a single ellipsized line.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/Memory.tsx
git commit -m "fix(web): memory screen — error state with retry, loading skeletons, path ellipsis"
```

---

### Task 7: Activity / Conflicts / KnowledgeGraph state fixes

**Files:**
- Modify: `web/src/features/Activity.tsx` (`LiveSignalsSection`, ~lines 51–83)
- Modify: `web/src/features/Conflicts.tsx` (`LiveSignals`, ~lines 15–20)
- Modify: `web/src/features/KnowledgeGraph.tsx` (graph fetch effect ~lines 76–86, canvas empty state ~lines 256–260, state declarations ~line 44)

**Interfaces:**
- Consumes: `usePoll`'s `error`/`refetch`; `EmptyState` (already imported in both Conflicts and KnowledgeGraph).
- Produces: nothing later tasks use.

- [ ] **Step 1: Error line in Activity's `LiveSignalsSection`**

In the section body (line 61), extend the ternary so a failed fetch with no data explains itself instead of claiming "No files being edited right now.":

```tsx
      <div style={{ padding: rows.length ? "4px 16px 10px" : 0 }}>
        {signals.error && !signals.data ? (
          <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--conflict-text)", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="alertTriangle" size={13} style={{ flex: "none" }} />
            Couldn't load live signals.
            <button className="btn btn-sm fr" onClick={signals.refetch} style={{ marginLeft: "auto" }}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>No files being edited right now.</div>
        ) : rows.slice(0, 10).map((s) => (
```

(the map body is unchanged; only the ternary head grew a branch.)

- [ ] **Step 2: All-clear line in Conflicts' `LiveSignals`**

Replace line 18 (`if (!rows.length) return null;`) with:

```tsx
  if (!rows.length) {
    return (
      <div className="card" style={{ marginBottom: 16, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
        <Icon name="zap" size={13} style={{ color: signals.error ? "var(--idle)" : "var(--clean)", flex: "none" }} />
        {signals.error ? "Live signals unavailable right now." : "No files under live edit — all clear."}
      </div>
    );
  }
```

- [ ] **Step 3: Graph fetch error state in `KnowledgeGraph.tsx`**

Add two state hooks next to the existing `graphLoading` declaration (~line 44):

```tsx
  const [graphError, setGraphError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
```

Update the fetch effect (lines 76–86) — clear the error on each run, record it in the catch, and re-run on retry:

```tsx
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setGraphLoading(true);
    setGraphError(null);
    setSelected(null); setQuery(""); setCommunity(null);
    BatonAPI.getKbGraph(activeId)
      .then((g) => { if (!cancelled) setGraph(g); })
      .catch((e) => {
        if (!cancelled) {
          setGraph(null);
          setGraphError((e as Error).message);
          showToast({ kind: "error", title: "Could not load graph", desc: (e as Error).message });
        }
      })
      .finally(() => { if (!cancelled) setGraphLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, retryTick]);
```

Then split the canvas fallback (lines 256–260) so a fetch failure no longer masquerades as "Graph not built yet":

```tsx
          {!graph && !graphLoading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              {graphError ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", maxWidth: 380 }}>
                  <EmptyState icon="alertTriangle" title="Couldn't load the graph" desc={graphError} />
                  <button className="btn btn-primary fr" onClick={() => setRetryTick((t) => t + 1)}>
                    <Icon name="refresh" size={14} /> Retry
                  </button>
                </div>
              ) : (
                <EmptyState icon="alertTriangle" title="Graph not built yet" desc="Run `baton kb rebuild` (or the Rebuild button with --write) to build it." />
              )}
            </div>
          )}
```

- [ ] **Step 4: Verify**

Run: `npm run build --prefix web` → expected: pass.
Manual: demo mode — Activity/Conflicts/KB screens render exactly as before (fixtures never reject); Conflicts now shows the "all clear" card when no signals. Real mode with the daemon killed mid-session: Activity's signals card shows the error line with Retry; the KB canvas shows "Couldn't load the graph" + Retry instead of "Graph not built yet".

- [ ] **Step 5: Commit**

```bash
git add web/src/features/Activity.tsx web/src/features/Conflicts.tsx web/src/features/KnowledgeGraph.tsx
git commit -m "fix(web): honest error/empty states for signals and the graph canvas"
```

---

### Task 8: Docs, STATUS, and whole-feature verification

**Files:**
- Modify: `STATUS.md` (add a row for this pass in the appropriate table/section)
- Verify: everything

**Interfaces:** none.

- [ ] **Step 1: STATUS.md**

Add one line to the relevant "what is built" section (match the file's existing row format):

```markdown
| Site hosting readiness + dashboard edge cases | done | env-driven site URL, PNG OG image + favicon, correct quick-start, mobile menu; SSE reconnect indicator, error/loading states (Memory, signals, graph), overflow fix | site/, web/src/ |
```

(adjust the columns to STATUS.md's actual table shape — read it first.)

- [ ] **Step 2: Full verification**

Run each; all must pass:

```bash
npm run build && npx vitest run          # backend untouched → 292 passing
npm run build --prefix web               # dashboard clean
cd site && npm run build                 # site clean, OG/icon routes listed
grep -rn "baton\.dev" site/app site/components site/lib   # no matches
```

Browser pass (dev server): hero, mobile menu at 375px, star button without a count, CTA quick-start block, `/opengraph-image` returns a PNG; scroll the full page top-to-bottom in a real browser and confirm every section renders (the deep-scroll black frames seen in the headless preview must be re-checked here — if sections genuinely go black in a real browser, STOP and report; do not attempt a fix inside this task).

- [ ] **Step 3: Commit**

```bash
git add STATUS.md
git commit -m "docs: record site hosting readiness + dashboard edge-case pass in STATUS"
```
