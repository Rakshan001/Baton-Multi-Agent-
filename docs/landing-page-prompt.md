# Baton Landing Page — Build Prompt

> Paste everything below this line into a fresh Claude Code session, started in an
> empty directory (the site is a separate Next.js app, deployed to Vercel —
> not part of the baton repo).

---

Build a premium, production-ready marketing landing page for **Baton**, an open-source
multi-agent coordination hub for AI coding agents. The site will be deployed on Vercel
behind a custom domain. It must look and feel like a top-tier dev-tool site — think
**linear.app, vercel.com, resend.com, inngest.com, railway.com** — dark, cinematic,
restrained, with one signature 3D animation, not a theme-park of effects.

## Tech stack (use exactly this)

- **Next.js 15** (App Router, TypeScript strict, static export friendly — no API routes needed)
- **Tailwind CSS v4**
- **Motion (Framer Motion)** for scroll-driven and micro animations
- **React Three Fiber + drei** for the 3D hero/handoff scene (lazy-loaded, `<Suspense>`, never blocks LCP)
- **Lenis** for smooth scrolling
- Fonts via `next/font`: a grotesk display face (e.g. **Geist** or **Space Grotesk**) + **Geist Mono / JetBrains Mono** for code
- No CMS, no auth, no database. One page + maybe `/docs` link out to GitHub.

## Brand direction

- **Metaphor: a relay race.** The product is literally named after the baton passed
  between runners. Every visual should reinforce "work passed seamlessly between agents."
- **Dark theme only.** Near-black background (`#0A0A0B`-ish), high-contrast white type,
  ONE accent — an amber/orange glow (a baton in the dark) with subtle cyan as the
  secondary data color. Glassy panels, 1px borders at low opacity, soft glows. No gradients-everywhere.
- Typography does the premium work: huge, tight-tracked display headlines; generous
  whitespace; small mono labels in uppercase for section eyebrows (e.g. `// SESSION HANDOFF`).
- Subtle film grain or noise texture overlay. Subtle dotted/grid background that
  parallaxes slower than content.
- Respect `prefers-reduced-motion`: every animation needs a static fallback.

## Page structure (in order)

### 1. Nav
Slim, sticky, glassy on scroll. Logo wordmark "baton" (lowercase, mono), links:
How it works · Features · Open Source · Docs. Right side: GitHub star button (live
star count via GitHub API, fetched at build time with fallback) + a copy-to-clipboard
install command chip: `npm i -g baton` style.

### 2. Hero (with the 3D scene)
- Headline: **"Plan on your expensive agent. Pass the baton to your cheap one."**
- Subhead: "Baton coordinates multiple AI coding agents — Claude Code, Cursor, Codex,
  Gemini — on one repo. Isolated git worktrees, a live dashboard, shared memory,
  installable skills, and one-file session handoff. One file. No server lock-in. Open source."
- Two CTAs: "Star on GitHub" (primary, glowing) and "Read the docs" (ghost).
- A terminal-style chip showing `baton pass my-task --to cursor` with a typing animation.
- **3D scene (React Three Fiber), the signature moment:** floating in dark space, 3–4
  glassy nodes representing agents (label them with small floating tags: "Claude Code",
  "Cursor", "Codex", "Gemini"). A glowing amber **baton** (a capsule/cylinder mesh with
  bloom) travels along a curved bezier path from one node to the next, leaving a particle
  trail. When it arrives, the receiving node pulses and a tiny `HANDOFF.md` file glyph
  materializes. The scene slowly auto-rotates; mouse position adds gentle parallax tilt
  (no orbit controls). Loop the pass every ~6s between different node pairs.
  Use `@react-three/postprocessing` Bloom sparingly. Cap DPR at 1.5, pause the loop when
  tab is hidden, and render a static poster image fallback for reduced-motion/mobile-low-power.

### 3. The problem (short, punchy)
Three lines, large type, scroll-revealed one by one (Motion `whileInView` stagger):
- "You run three AI coding agents. They don't know about each other."
- "Two of them just edited the same file."
- "Your expensive agent hit its limit mid-task — and all that context died with the session."

### 4. How it works — scroll-driven handoff story (the second showpiece)
A pinned, scroll-scrubbed section (Motion `useScroll` + sticky positioning) that walks
through the actual flow in 5 steps. Left: step text. Right: an animated 2.5D diagram
(SVG/canvas, animated dashed connector lines like Stripe/Inngest do — **not** another
heavy 3D scene). As the user scrolls, the diagram morphs through these states:

1. **Plan** — Agent A (Claude Code) node active, working in worktree `.baton/wt/my-task`.
   Session JSONL lines stream into a buffer.
2. **Pass** — `baton pass my-task --to cursor` → the session condenses into a glowing
   `HANDOFF.md` card showing real frontmatter: objective, plan, remaining tasks,
   `est_cost_usd: 0.05`.
3. **Take** — `baton take my-task` → the card flies along a path to Agent B (Cursor),
   which lights up and starts committing in its own worktree.
4. **Coordinate** — both agents visible; live edit signals pulse on files; an overlap on
   the same file flashes an amber conflict warning. Caption: "SSE-streamed edit signals.
   Conflicts before they happen, not after."
5. **Done & merge** — `baton done` → checkmark, completion report filed to
   `.baton/reports/`, branch merges to main.

Each step shows its real CLI command in a mono chip.

### 5. Features grid (bento layout)
A 7-cell bento grid, glassy cards with hover glow + slight lift. Cells:
- **Knowledge graph** — "Your repo, indexed into a queryable graph. Agents navigate
  instead of grepping." Mini animated force-directed node cluster inside the card
  (tiny canvas, ~40 nodes).
- **Session handoff** — "One markdown file carries the whole session: objective, plan,
  checklist, cost estimate." Show a tiny HANDOFF.md snippet.
- **Worktree isolation** — "Every agent gets its own git worktree. No clobbered branches,
  ever." Branching-lines mini-graphic.
- **Live edit signals** — "See who's editing what, in real time. Overlaps warn before
  they conflict." Pulsing file rows.
- **Evidence-anchored memory** — "Shared facts pinned to commits and content hashes.
  Stale facts get withheld — agents can't hallucinate from them."
- **Cost arbitrage** — "Reading the repo map: ~824 tokens. Reading the files: ~248k.
  ~300× cheaper." Animated counter.
- **Installable skills** — "A searchable catalog of reusable agent playbooks. One
  click writes a skill into the agent's own config — `.claude/skills/<name>/SKILL.md`
  or `.cursor/rules` — or import your own from a path or URL. e.g. a 'common bug-fix'
  skill maps the repo, confirms the root cause to 95% confidence, then fixes bugs one
  at a time in isolated worktrees." Show two tiny config-path chips (Claude / Cursor).

### 6. Built honest (engineering credibility strip)
Horizontal scroll-revealed row of small mono facts:
"Zero-dependency daemon — raw node:http" · "SSE, not socket.io" · "Plain-markdown
handoffs, no proprietary format" · "tmux-backed agent terminals" · "Git-native: no
external database" · "MCP tools for every agent" · "Skills install to native config —
.claude/skills, .cursor/rules".

### 7. Dashboard showcase
A large framed screenshot/mock of the Baton dashboard inside a browser chrome, tilted
in 3D perspective that flattens as you scroll (Motion transform on scroll progress),
amber glow underneath. Caption: "A realtime dashboard on localhost:7077. Activity,
conflicts, terminals, memory, skills, the graph."

### 8. Open source CTA
Big centered section: "Baton is open source." Live-ish GitHub stat chips (stars, license
MIT), contributor avatars row placeholder, primary CTA "Star on GitHub", secondary
"Good first issues". A one-line quickstart in a copyable code block:
```
git clone … && npm run build && node dist/cli.js serve --write
```

### 9. Footer
Minimal: wordmark, "Pass it on." microcopy, GitHub / Docs / License links.

## Animation & performance rules

- LCP under 2.5s: the 3D canvas lazy-loads after first paint behind a poster frame.
- Use `next/dynamic` with `ssr: false` for the R3F scene; code-split postprocessing.
- All scroll animations via Motion's `useScroll`/`useInView`, not scroll listeners.
- 60fps budget: no more than one pinned scrub section, cap particle counts, no
  full-screen blur layers stacking.
- Lighthouse ≥ 90 on performance/accessibility/SEO. Semantic landmarks, focus-visible
  states, alt text, `prefers-reduced-motion` everywhere.

## SEO / meta

- Title: "Baton — coordinate AI coding agents on one repo"
- Description from the hero subhead. OpenGraph image: dark card with the baton-pass
  visual and the headline. Add JSON-LD `SoftwareApplication` schema. Sitemap + robots.

## Deliverable

A complete, runnable Next.js project: `npm i && npm run dev` works, `npm run build`
passes with zero TypeScript errors. Verify in the browser before finishing: check
console for errors, confirm the 3D scene renders and the scroll story scrubs correctly,
and screenshot the hero and the handoff section.
