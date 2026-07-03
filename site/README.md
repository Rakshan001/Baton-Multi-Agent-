# Baton — marketing site

A premium, dark, cinematic landing page for [Baton](https://github.com/Rakshan001/Baton-Multi-Agent-),
the open-source coordination hub for running multiple AI coding agents on one repo.

Built with **Next.js 15** (App Router, strict TypeScript), **Tailwind CSS v4**
(CSS-first `@import "tailwindcss"`), and **Framer Motion**.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

```bash
npm run build && npm run start   # production build + serve
npm run lint                     # eslint (next/core-web-vitals)
```

## What's here

| Section | Component |
| --- | --- |
| Sticky glassy nav + live GitHub star count + copy-install chip | `components/Nav.tsx`, `components/NavShell.tsx` |
| Hero with the signature SVG **baton-pass** animation | `components/Hero.tsx`, `components/BatonPassScene.tsx`, `components/TypingCommand.tsx` |
| Scroll-revealed problem statement | `components/Problem.tsx` |
| Scroll-driven 5-step handoff story (pinned) | `components/HowItWorks.tsx` |
| 7-cell features bento with mini graphics | `components/Features.tsx` |
| "Built honest" engineering marquee | `components/BuiltHonest.tsx` |
| Tilt-to-flat dashboard showcase | `components/DashboardShowcase.tsx` |
| Open-source CTA + quickstart | `components/OpenSourceCTA.tsx` |
| Footer | `components/Footer.tsx` |

Shared constants (repo URL, nav links, agent list) live in `components/site.ts`.
SEO/metadata/JSON-LD `SoftwareApplication`, fonts (`next/font`), robots, and
sitemap are wired in `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`.

## Design notes

- **Theme tokens** (`app/globals.css`): near-black `#0A0A0B`, a single amber
  accent, subtle cyan as the data color, glassy 1px-border panels, a faint grid
  + film-grain overlay.
- **Accessibility**: semantic landmarks, a skip link, `:focus-visible` rings,
  alt/`aria` text on the SVG scenes, and a `prefers-reduced-motion` fallback for
  every animation (the baton rests static, marquees stop, the scroll story still
  advances by scroll position).

## The signature animation

The hero "baton pass" is an **animated SVG + Framer Motion** moment — a glowing
amber capsule travels a bezier path between four agent nodes, looping; each
arrival pulses the node and materializes a `HANDOFF.md` glyph.

> Optional upgrade: swap `components/BatonPassScene.tsx` for a React Three Fiber
> 3D scene (glassy node meshes, bloom, particle trail, mouse parallax) as
> described in `docs/landing-page-prompt.md`. It was intentionally implemented in
> SVG here so the build stays dependency-light and runs anywhere.

## Notes

- The GitHub star count is fetched at build time with a graceful fallback (`★`);
  no token is required.
- The dashboard "screenshot" is a CSS/SVG mock, not a captured image, so the
  repo ships nothing binary.
