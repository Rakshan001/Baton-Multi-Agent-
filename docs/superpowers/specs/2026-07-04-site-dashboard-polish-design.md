# Site hosting readiness + dashboard edge-case pass

**Date:** 2026-07-04 · **Status:** approved · **Scope:** `site/` + `web/` (no backend changes)

## Problem

The marketing site hard-codes `https://baton.dev` (not owned) into canonical/OG/
sitemap URLs, ships an SVG social image that X/Slack/LinkedIn/WhatsApp will not
render, has no favicon, and shows visitors two broken/incomplete quick-start
commands — so hosting it today would misdirect crawlers and fail anyone who
clones. Separately, a dashboard audit found eight high-priority edge-case gaps:
silent fetch failures, missing empty/loading states, no SSE-disconnect
indicator, ungated write buttons, and overflow bugs.

User decisions (2026-07-04): host on Vercel; scope = hosting blockers + the
HIGH dashboard findings only (approach A).

## Decision summary

Two independent workstreams. Zero new dependencies in either workspace. Demo
mode untouched. Strict TS both sides.

## Workstream 1 — landing page (`site/`)

| # | Change | Detail |
|---|--------|--------|
| 1 | Env-driven site URL | New `site/lib/site-url.ts` exporting `SITE_URL`: `NEXT_PUBLIC_SITE_URL` if set, else `https://${VERCEL_URL}` (add protocol), else `http://localhost:3000`. Strip trailing slash. Consumed by `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`. No literal `baton.dev` remains. |
| 2 | PNG social image | `app/opengraph-image.tsx` via `next/og` `ImageResponse` — 1200×630, ink background, `/baton` wordmark, hero tagline, amber accent. `twitter` metadata reuses it. Delete `public/og.svg` and its metadata references. |
| 3 | Favicon | `app/icon.svg` (amber `/` on ink rounded square) + `app/apple-icon.tsx` via `ImageResponse` (180×180). |
| 4 | Nav quick-start chip | Replace broken `npm install && node dist/cli.js serve --write` with the clone command `git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git` (from `REPO_URL` constant, not a second literal). |
| 5 | Open Source quick start | `<pre>` block matches README exactly: clone → `npm install && npm install --prefix web` → `npm run build && npm run build --prefix web` → `node dist/cli.js serve --write  # → http://localhost:7077`. Copy chip copies the full multi-line sequence. |
| 6 | Star-count fallback | Hide the numeric badge when the fetched count is `null` **or `0`** — render glyph + "Star" only. No literal "Star 0", no fallback `★` glyph shown as a count. |
| 7 | Mobile nav menu | Hamburger disclosure below `md:` exposing the four `NAV_LINKS`; client component, Escape closes, focus-visible styles, no library. |
| 8 | No-JS reveal | `<noscript><style>.reveal{opacity:1;transform:none}</style></noscript>` in layout so content is never invisible without JavaScript. |

Also: verify deep-scroll rendering in a real browser (headless preview showed
black frames at scroll ≥ ~4000px while DOM/computed styles were fully visible —
presumed tooling artifact; confirm and fix only if real).

## Workstream 2 — dashboard (`web/`)

Code-verification note (2026-07-04): four audit findings proved already handled
in code and are dropped — Memory's filtered-to-empty message (Memory.tsx:200),
write gating on Memory quick-add (Memory.tsx:164) and KnowledgeGraph
import/rebuild (KnowledgeGraph.tsx:202,209), and Board session-card title clamp
(SessionCard.tsx:65). `usePoll` already exposes `error`/`refetch`; screens just
don't render them. The verified scope:

| # | Change | Detail |
|---|--------|--------|
| 1 | SSE health indicator | `useEvents` additionally exposes `reconnecting: boolean` (true after `onerror` once the stream has ever been open; EventSource auto-retries). `ApiDot` shows an amber "reconnecting…" state + tooltip; TopBar/App wire it through. Client-side only; no new event types. |
| 2 | Fetch-error retry UI | Memory: `ErrorState` + retry when the poll errors with no data (today an error renders as the misleading "No memories yet"). Activity `LiveSignalsSection`: inline error line + retry. KnowledgeGraph: `graphError` state — the graph-blob fetch failure currently falls into the "Graph not built yet" empty state; show an error panel with Retry instead. |
| 3 | Empty state | Conflicts `LiveSignals`: subtle "all clear" line instead of `return null` (also covers its error case with a "signals unavailable" variant). |
| 4 | Loading state | Memory: `CardSkeleton` cards while loading (matching History) instead of bare "Loading memory…" text. |
| 5 | Overflow | Memory fact row's anchored-files span: `inline-flex` + `text-overflow` never ellipsizes — restructure with `min-width: 0` and an inner truncating span. |

## Edge cases

| Case | Behavior |
|------|----------|
| `VERCEL_URL` lacks protocol | `site-url.ts` prepends `https://` |
| `NEXT_PUBLIC_SITE_URL` has trailing slash | stripped |
| Neither env var set (local dev) | `http://localhost:3000` |
| GitHub API rate-limited at build | star badge hidden, button still links |
| Repo has 0 stars | badge hidden (no "Star 0") |
| JS disabled | noscript override keeps all content visible |
| Daemon dies mid-session | ApiDot shows reconnecting while REST still answers; full outage flips to Offline |
| Memory fetch fails persistently | ErrorState with retry, never the "No memories yet" empty state |
| Long anchored-file lists on facts | single-line ellipsis, layout intact |

## Out of scope (parked)

LOW a11y findings, inline form-validation messages, context-pack feature card
on the landing page, persistent inline write-error rows, npm packaging.

## Verification

- `npm run build` in `site/` (next build renders the OG/apple-icon routes; grep
  output for `baton.dev` → zero hits).
- `npm run build --prefix web` clean; backend suite untouched at 292.
- Browser checks: mobile menu, star fallback, OG image at
  `/opengraph-image`, robots/sitemap URLs, SSE reconnect state (kill daemon),
  each new error/empty/loading state, demo mode still fully working.
