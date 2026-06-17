# Baton — Logo Generation Prompt

Baton is an open-source coordination hub that passes work between AI coding agents —
named after the baton handed off in a relay race. The logo lives on a near-black
landing page with a single amber/orange accent and cyan as a secondary data color.

Two ways to use this doc:
- **A) Image-model prompt** — paste section A into an image generator (or describe to a
  designer) to explore mark concepts.
- **B) SVG hand-off prompt** — paste section B into a coding session to get clean,
  production SVG files for the site.

---

## A) Image / concept prompt

> Design a modern, minimal logo mark for a developer tool called **"baton"**. The brand
> metaphor is a relay race: work (a baton) passed seamlessly between AI coding agents.
> Vector, flat, geometric, premium — in the visual language of Linear, Vercel, and Resend
> logos. NOT a literal sports illustration, NOT a mascot, NOT 3D, no gradients-everywhere.
>
> **The mark:** a single abstract glyph that reads as both a **baton/capsule being passed**
> and a **forward motion / handoff**. Strong candidates to explore:
> 1. A rounded horizontal capsule (the baton) with a subtle motion notch or arrow cut into
>    its negative space, implying it's mid-pass.
> 2. Two interlocking rounded shapes — one releasing, one receiving — forming a continuous
>    flowing line (the handoff).
> 3. A capsule that doubles as a lowercase "b", with a small detached dot/spark leaving its
>    end like a trailing particle.
>
> **Color:** glowing amber-to-orange (#FF9A3C → #F0641E) baton mark on a near-black
> background (#0A0A0B), with an optional faint cyan (#36E0E0) accent detail or trail.
> Also deliver a flat monochrome version (single amber, and pure white) for small sizes.
>
> **Wordmark:** lowercase "baton" set in a clean geometric grotesk or mono typeface
> (Space Grotesk / Geist / JetBrains Mono feel), tight tracking, the mark sitting to the
> left of the word. Also provide a stacked (mark-over-word) variant.
>
> **Deliver:** the icon alone (square, works as a favicon at 32px), the icon + wordmark
> lockup (horizontal), on both dark and light backgrounds. Crisp edges, balanced optical
> weight, no drop shadows in the flat version (a soft amber glow is OK only for the
> dark-hero "lit" variant).

### Negative prompt / avoid
running figures, people, track lanes, medals, trophies, literal relay imagery, generic
swooshes, AI/robot clichés, brain icons, hexagon-circuit clichés, busy detail, skeuomorphism,
3D bevels, photoreal, stock-icon look.

---

## B) SVG hand-off prompt (for a coding session)

> Create a set of production SVG logo files for "baton" matching the concept below.
> Output clean, hand-optimized SVG (no editor cruft, use `currentColor` where sensible so
> the mark can inherit theme color, viewBox-based, no hardcoded width/height on the root).
>
> **Concept to implement:** a horizontal rounded **capsule (the baton)** as the core icon.
> Carve a forward-pointing notch / arrow into its right end's negative space so it reads as
> "in motion / being passed." Add one small detached rounded dot just past the tip — a
> trailing spark — to imply the handoff. Keep it geometric and balanced; the whole icon
> should sit comfortably in a square and stay legible at 16–32px (favicon).
>
> **Files to produce:**
> 1. `logo-mark.svg` — icon only, square viewBox `0 0 32 32`, single color via `currentColor`.
> 2. `logo-mark-amber.svg` — same mark, filled with the amber gradient
>    (`#FF9A3C` → `#F0641E`, ~25° angle) for the dark hero.
> 3. `logo-lockup.svg` — mark + lowercase wordmark "baton" to its right, set in a geometric
>    sans (convert text to paths OR keep as `<text>` with a Google-font fallback note),
>    optically aligned, tight tracking.
> 4. `favicon.svg` + a 512×512 `icon.png` source note for PWA/OG use.
>
> **Palette:** amber `#FF9A3C`/`#F0641E`, near-black `#0A0A0B`, off-white `#F5F5F4`,
> optional cyan accent `#36E0E0`.
>
> Show all variants rendered on both dark (`#0A0A0B`) and light (`#FFFFFF`) backgrounds
> in a quick preview HTML so I can eyeball them before committing.
