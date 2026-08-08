# Docs section + light/dark theming for the marketing site

**Date:** 2026-07-27
**Scope:** `site/` only. No changes to `src/`, `web/`, or the daemon.

## Problem

Two things were asked for: update the docs sections, and add a light/dark
toggle with an improved sidebar.

Investigation found the docs sections did not exist in source. The site was a
single-page landing (`Hero → Problem → HowItWorks → Features → BuiltHonest →
DashboardShowcase → OpenSourceCTA`) whose nav "Docs" entry linked out to the
GitHub README. The only trace of a docs section was stale build output in
`site/.next/server/app/docs/` (dated 19 Jul) for `/docs/architecture`,
`/docs/cli`, `/docs/how-it-works` and `/docs/memory`. That source exists on no
branch and in no worktree — it was never committed.

The site was also hard-locked to dark: `color-scheme: dark`, `colorScheme:
"dark"` in the viewport export, and a single dark-only palette in `@theme`.

So this is a build, not an update.

## Content

Page copy was recovered from the stale HTML rather than rewritten, because it
was already grounded in the real CLI surface. Every command was then
re-verified against `src/cli.ts` on `main`. That pass caught real drift:

- `baton orient` and `baton progress` are **top-level** commands. The old copy
  documented them as `baton hooks orient` / `baton hooks progress`.
- `baton skills` gained subcommands (`list`, `install`, `uninstall`, `import`).
- `baton memory rm`, `baton kb share`, `baton kb status`, `baton kb mcp` and
  `baton bugs` were missing entirely.
- `baton review` and `baton mcp-bridge` exist on the feature branch but **not**
  on `main`, so they are deliberately not documented here.
- `hooks guard` and `hooks snapshot` are `{ hidden: true }` — not documented.

## Theming

`@theme` keeps the dark palette as the default, so the dark rendering is
unchanged. Light values are defined once as `--l-*` and remapped onto the
`--color-*` tokens by two selectors:

```css
:root[data-theme="light"]            { /* explicit choice */ }
@media (prefers-color-scheme: light) {
  :root:not([data-theme])            { /* OS default; also the no-JS path */ }
}
```

Every utility already reads `var(--color-*)` at runtime, so no class names
changed.

**Amber is deepened in light mode** (`#ff9d2e` → `#c2410c`). The brand amber is
~2.2:1 on an off-white page and unreadable as text; `#c2410c` is 5.9:1 on
`--l-ink` and still reads as the baton's amber. Deepening the token itself,
rather than adding a second "amber for text" token, keeps every existing
`text-amber` / `bg-amber/10` usage correct without edits.

`light-dark()` was considered and rejected. It would express both values in one
declaration, but this stylesheet composes `color-mix()` on top of the tokens in
`.panel`, `.glow-amber` and `::selection`, and stacking three modern color
features is where quiet breakage lives. Explicit overrides are duplicated but
bulletproof.

Texture intensity is tokenized (`--texture-grid`, `--texture-grain`,
`--glow-near`, `--glow-far`) because the grid, film grain and amber bloom are
tuned for near-black and read as dirt on off-white.

**No flash:** `ThemeScript` stamps `data-theme` on `<html>` in a blocking inline
`<head>` script. If `localStorage` is unavailable it stamps nothing and the
media-query rules take over. The prerendered `<html>` carries no `data-theme`,
so the no-JS path is the OS preference.

**No hydration flicker on the toggle:** the sun/moon swap is driven by CSS off
`:root[data-theme]`, not React state, so the correct glyph is in the first
painted frame. React state exists only to give the button an accurate
accessible name once interactive.

## Theme-locked illustration colors

The landing page's SVG illustrations were hardcoded for dark — `#ffffff14`
strokes, `#121214` fills, `bg-white/5`, `text-black` on amber buttons. On
off-white these are invisible or inverted, so a light theme that shipped without
fixing them would break the hero art. All literal hex in the illustration
components was mapped onto the token system.

Three of those mappings shift dark mode very slightly, having consolidated onto
existing tokens: `#52525b` → `--color-faint` (`#71717a`), and `#ffffff1a` /
`#ffffff0d` → `--color-line` (`#ffffff14`).

## Sidebar

`docs-nav.ts` is the single source for the sidebar, the prev/next pager and the
sitemap, so a new page wires into all three at once.

- Grouped (*start here* / *guides* / *reference*) with mono eyebrows
- Active route via `usePathname()`, marked with an amber left edge and
  `aria-current="page"` — the previous list had no active state
- Sticky rail with its own scroll region on `lg+`
- Mobile disclosure that names the current page when collapsed, reusing
  `MobileMenu`'s escape/outside-click behavior
- "On this page" rail with scroll-spy on `xl+`, scraping `#doc-content h2[id]`
  so a page's section list lives only in its JSX

## Knock-on fixes

- `NAV_LINKS` anchors became root-relative (`/#features`). Bare `#features`
  would jump within the docs page instead of going home.
- The clone chip moved from `lg:` to `2xl:`; adding the toggle pushed the nav
  past its width budget and wrapped the links onto two lines.
- The skip link was `focus:text-black` on amber — below 3:1 once amber deepens.
  Now `focus:text-ink`, which inverts with the theme.
- The docs index sets an absolute title; the layout's `%s — Baton docs` template
  applies to child segments, not the layout's own page.

## Verification

`next build` (14 static routes) and lint clean. Playwright at 1440 and 375 in
both themes: no console errors or hydration warnings, no horizontal page
overflow at 375, toggle flips and persists, icon and accessible name track the
theme, and the prerendered `<html>` ships without `data-theme`.
