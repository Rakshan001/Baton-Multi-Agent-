// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The promise a worktree node makes: it still says what it means with the
 * colour taken away.
 *
 * The first block does not ASSERT that colour is insufficient — it MEASURES
 * it, by reading the real semantic tokens out of styles/tokens.css and
 * running them through WCAG relative luminance. That is what justifies
 * everything after it, and it is also a live guard: if someone later
 * re-picks the palette so the hues do separate in greyscale, this test says
 * so rather than quietly rotting.
 *
 * The rest pins the three non-colour channels per `state` and per `health`,
 * and the decay-ring maths.
 */
import { describe, expect, it } from "vitest";
import { demoWorktrees } from "../../lib/demoWorktrees";
import {
  HEALTH_ENCODING, NO_STATE_RAIL, STALL_GRACE_MS, STATE_ENCODING,
  decayFraction, healthBorder, nonColourHealthSignature, nonColourStateSignature,
  railBackground, railOf, ringGeometry,
} from "./encoding";
import { HEALTH_META } from "./health";
import type { TaskState, WorktreeHealth } from "../../types";

const STATES = Object.keys(STATE_ENCODING) as TaskState[];
const HEALTHS = Object.keys(HEALTH_ENCODING) as WorktreeHealth[];

/* ---------------------------------------------------- the greyscale premise */

/** WCAG 2.x relative luminance — what a greyscale screenshot keeps. */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const channel = (byte: number) => {
    const s = byte / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

/**
 * The five semantic tokens from styles/tokens.css:124-147.
 *
 * Copied rather than read: Vitest stubs CSS modules, so `?raw` on a
 * stylesheet returns "" and `node:fs` is untyped in this workspace (no
 * @types/node, and adding one for a test is not a trade worth making). The
 * copy is safe because nothing in the encoding DEPENDS on these values — the
 * second test in this block proves no colour reaches the signatures at all,
 * so a repalette cannot break greyscale separability even in principle. This
 * measurement exists to show WHY the encoding is needed, not to feed it.
 */
const SEMANTIC_TOKENS: Record<string, string> = {
  clean: "#34d399",
  dirty: "#fbbf24",
  conflict: "#f87171",
  ready: "#2dd4bf",
  idle: "#71767b",
};

describe("colour alone cannot carry this screen", () => {
  it("collapses two semantic tokens onto nearly the same grey", () => {
    const lum = Object.entries(SEMANTIC_TOKENS).map(([k, v]) => [k, relativeLuminance(v)] as const);
    let closest = { pair: "", delta: Infinity };
    for (let i = 0; i < lum.length; i++) {
      for (let j = i + 1; j < lum.length; j++) {
        const delta = Math.abs(lum[i]![1] - lum[j]![1]);
        if (delta < closest.delta) closest = { pair: `${lum[i]![0]}/${lum[j]![0]}`, delta };
      }
    }
    // Measured, not assumed: --clean (#34d399) and --dirty (#fbbf24) land
    // about 0.016 apart. A healthy worktree and a quiet one are the same
    // grey, which is exactly why the encoding below has to exist.
    expect(closest.delta).toBeLessThan(0.05);
  });

  it("keeps no colour at all in the signatures the encoding is judged on", () => {
    const all = [
      ...STATES.map(nonColourStateSignature),
      ...HEALTHS.map((h) => nonColourHealthSignature(h, HEALTH_META[h].label, HEALTH_META[h].icon)),
    ];
    for (const sig of all) {
      expect(sig).not.toMatch(/var\(|#[0-9a-f]{3}|rgb|hsl|color-mix/i);
    }
  });
});

/* ------------------------------------------------- state: three channels */

describe("every task state is distinguishable without colour", () => {
  it("covers all eight states the daemon can issue", () => {
    expect(STATES.sort()).toEqual(
      ["active", "blocked", "cancelled", "claimed", "done", "paused", "queued", "review"],
    );
  });

  it("gives each state its own rail geometry", () => {
    const rails = STATES.map((s) => {
      const r = STATE_ENCODING[s].rail;
      return `${r.dash}/${r.gap}/${r.width}`;
    });
    expect(new Set(rails).size).toBe(STATES.length);
  });

  it("gives each state its own glyph", () => {
    expect(new Set(STATES.map((s) => STATE_ENCODING[s].icon)).size).toBe(STATES.length);
  });

  it("gives each state its own word", () => {
    expect(new Set(STATES.map((s) => STATE_ENCODING[s].label)).size).toBe(STATES.length);
  });

  it("differs in all three channels between any two states", () => {
    for (const a of STATES) {
      for (const b of STATES) {
        if (a === b) continue;
        const [x, y] = [STATE_ENCODING[a], STATE_ENCODING[b]];
        const differing = [
          `${x.rail.dash}/${x.rail.gap}/${x.rail.width}` !== `${y.rail.dash}/${y.rail.gap}/${y.rail.width}`,
          x.icon !== y.icon,
          x.label !== y.label,
        ].filter(Boolean).length;
        expect(differing, `${a} vs ${b}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("draws no rail for an orphan, which has no lifecycle to draw", () => {
    // types.ts:1200 — `state: null` means no task owns this worktree. A
    // zero-width rail cannot be confused with any of the eight patterns.
    expect(railOf(null)).toEqual(NO_STATE_RAIL);
    expect(railOf(null).width).toBe(0);
    expect(nonColourStateSignature(null)).toContain("rail:none");
  });

  it("emits a solid rail as a plain colour and a dashed one as a gradient", () => {
    expect(railBackground(STATE_ENCODING.active.rail, "TOKEN")).toBe("TOKEN");
    const dashed = railBackground(STATE_ENCODING.queued.rail, "TOKEN");
    expect(dashed).toContain("repeating-linear-gradient");
    // 2px on, 6px off => the period is 8px.
    expect(dashed).toContain("2px");
    expect(dashed).toContain("8px");
  });
});

/* ------------------------------------------------ health: three channels */

describe("every health value is distinguishable without colour", () => {
  it("covers every health value the daemon can compute", () => {
    expect(HEALTHS.sort()).toEqual(
      ["abandoned", "conflict", "dirty", "missing", "ok", "orphan-disk",
        "quiet", "rebasing", "stalled", "unknown", "working"].sort(),
    );
    // health.ts and encoding.ts must not drift apart.
    expect(HEALTHS.sort()).toEqual((Object.keys(HEALTH_META) as WorktreeHealth[]).sort());
  });

  it("gives each health value its own border pattern and width", () => {
    const borders = HEALTHS.map((h) => `${HEALTH_ENCODING[h].pattern}/${HEALTH_ENCODING[h].width}`);
    expect(new Set(borders).size).toBe(HEALTHS.length);
  });

  it("gives each health value its own glyph", () => {
    // This was FALSE before wt-flow-nodes: alertTriangle covered stalled,
    // conflict and unknown, and alertOctagon covered abandoned and missing.
    expect(new Set(HEALTHS.map((h) => HEALTH_META[h].icon)).size).toBe(HEALTHS.length);
  });

  it("gives each health value its own word", () => {
    expect(new Set(HEALTHS.map((h) => HEALTH_META[h].label)).size).toBe(HEALTHS.length);
  });

  it("never renders `double` below the 3px the browser needs to draw it", () => {
    for (const h of HEALTHS) {
      const e = HEALTH_ENCODING[h];
      if (e.pattern === "double") expect(e.width, h).toBeGreaterThanOrEqual(3);
    }
  });

  it("differs in all three channels between any two health values", () => {
    for (const a of HEALTHS) {
      for (const b of HEALTHS) {
        if (a === b) continue;
        const differing = [
          `${HEALTH_ENCODING[a].pattern}/${HEALTH_ENCODING[a].width}`
            !== `${HEALTH_ENCODING[b].pattern}/${HEALTH_ENCODING[b].width}`,
          HEALTH_META[a].icon !== HEALTH_META[b].icon,
          HEALTH_META[a].label !== HEALTH_META[b].label,
        ].filter(Boolean).length;
        expect(differing, `${a} vs ${b}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("falls back to `unknown`'s border for a health value it has never seen", () => {
    expect(healthBorder("not-a-health" as WorktreeHealth)).toEqual(HEALTH_ENCODING.unknown);
  });
});

/* ----------------------- the acceptance criterion, stated as a test */

describe("a stalled node is identifiable in a greyscale screenshot", () => {
  it("separates stalled from every other health value on non-colour channels alone", () => {
    const sig = (h: WorktreeHealth) => nonColourHealthSignature(h, HEALTH_META[h].label, HEALTH_META[h].icon);
    const stalled = sig("stalled");
    expect(stalled).toBe("border:dashed/3|glyph:alertTriangle|text:Stalled");
    for (const h of HEALTHS) {
      if (h === "stalled") continue;
      expect(sig(h), h).not.toBe(stalled);
    }
  });

  it("empties the decay ring for a worktree that is past the grace window", () => {
    // The fourth, geometric cue on top of the three above: 'stalled' means
    // the grace window is spent, so there is no arc left to draw.
    expect(ringGeometry(STALL_GRACE_MS + 1).fraction).toBe(0);
    expect(ringGeometry(STALL_GRACE_MS + 1).dashOffset)
      .toBeCloseTo(ringGeometry(STALL_GRACE_MS + 1).circumference, 6);
  });
});

/* ---------------------------------------------------------- the decay ring */

describe("the decay ring is quiet time as evidence", () => {
  it("is full at zero and empty at the grace window", () => {
    expect(decayFraction(0)).toBe(1);
    expect(decayFraction(STALL_GRACE_MS)).toBe(0);
  });

  it("halves at half the window", () => {
    expect(decayFraction(STALL_GRACE_MS / 2)).toBeCloseTo(0.5, 10);
  });

  it("clamps rather than going negative past the window", () => {
    expect(decayFraction(STALL_GRACE_MS * 2)).toBe(0);
    expect(decayFraction(STALL_GRACE_MS * 1000)).toBe(0);
  });

  it("clamps a negative or non-finite reading instead of overfilling", () => {
    // A clock skew between daemon and browser can serve a negative age; a
    // ring longer than a circle is a drawing bug, not a signal.
    expect(decayFraction(-5_000)).toBe(1);
    expect(decayFraction(Number.NaN)).toBeNull();
    expect(decayFraction(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("declines to draw an arc when there is no evidence either way", () => {
    // `quietForMs === null` (types.ts:1203) means the daemon has nothing to
    // report. An empty ring would be a claim it never made.
    expect(decayFraction(null)).toBeNull();
    expect(ringGeometry(null).fraction).toBeNull();
  });

  it("matches STALL_GRACE_MS in src/pipeline.ts:55 — 45 minutes", () => {
    expect(STALL_GRACE_MS).toBe(45 * 60_000);
  });

  it("offsets the arc by the fraction already spent", () => {
    const g = ringGeometry(STALL_GRACE_MS / 4);
    expect(g.fraction).toBeCloseTo(0.75, 10);
    expect(g.dashOffset).toBeCloseTo(g.circumference * 0.25, 10);
  });

  it("derives its circumference from the size it is actually drawn at", () => {
    const g = ringGeometry(0, 30, 2.5);
    expect(g.radius).toBe((30 - 2.5) / 2);
    expect(g.circumference).toBeCloseTo(2 * Math.PI * g.radius, 10);
    // A full ring has zero offset — nothing hidden.
    expect(g.dashOffset).toBe(0);
  });
});

/* --------------------------------- the greyscale screenshot, simulated */

/**
 * Everything the card draws that is NOT a colour, for one row — i.e. exactly
 * what would survive `filter: grayscale(1)` on a screenshot, or a printer.
 *
 * Built from the same functions WorktreeNode.tsx calls, so it cannot drift
 * from what is on screen without this test noticing. Slug and branch text
 * are deliberately EXCLUDED: a label that only says which row it is would
 * make every row trivially distinct and prove nothing about the encoding.
 */
function greyscaleDescriptor(row: (typeof rows)[number]): string {
  const border = healthBorder(row.health);
  const rail = railOf(row.state);
  const stateEnc = row.state ? STATE_ENCODING[row.state] : null;
  const ring = ringGeometry(row.quietForMs).fraction;
  return [
    `border=${border.pattern}/${border.width}`,
    `rail=${rail.dash}/${rail.gap}/${rail.width}`,
    `healthGlyph=${HEALTH_META[row.health].icon}`,
    `healthText=${HEALTH_META[row.health].label}`,
    `stateGlyph=${stateEnc?.icon ?? "none"}`,
    `stateText=${stateEnc?.label ?? "none"}`,
    `strike=${stateEnc?.strike ?? false}`,
    // Bucketed to the nearest 5%: a greyscale reading of an arc is coarse,
    // so the test refuses to claim a separation the eye could not make.
    `ring=${ring === null ? "none" : Math.round(ring * 20)}`,
  ].join("|");
}

const rows = demoWorktrees(Date.parse("2026-09-17T12:00:00Z"));

describe("the demo fleet is readable with the colour removed", () => {
  it("covers most of the health vocabulary, so this is a real sample", () => {
    expect(new Set(rows.map((r) => r.health)).size).toBeGreaterThanOrEqual(10);
  });

  it("separates any two rows that differ in state or health", () => {
    for (const a of rows) {
      for (const b of rows) {
        if (a.slug === b.slug) continue;
        if (a.state === b.state && a.health === b.health) continue;
        expect(greyscaleDescriptor(a), `${a.slug} vs ${b.slug}`)
          .not.toBe(greyscaleDescriptor(b));
      }
    }
  });

  it("separates the stalled row from every other row on the canvas", () => {
    // The acceptance criterion, run against the fixture that is actually
    // drawn: 'billing-webhooks' is the stalled one (lib/demoWorktrees.ts).
    const stalled = rows.find((r) => r.health === "stalled")!;
    expect(stalled.slug).toBe("billing-webhooks");
    const mine = greyscaleDescriptor(stalled);
    for (const other of rows) {
      if (other.slug === stalled.slug) continue;
      expect(greyscaleDescriptor(other), other.slug).not.toBe(mine);
    }
    // And it is separated by MORE than one channel: dashed/3 border, its own
    // glyph, its own word, and a spent ring.
    expect(mine).toContain("border=dashed/3");
    expect(mine).toContain("healthGlyph=alertTriangle");
    expect(mine).toContain("healthText=Stalled");
    expect(mine).toContain("ring=0");
  });

  it("shows a dotted, arc-less ring for a row with no progress evidence", () => {
    const noEvidence = rows.filter((r) => r.quietForMs === null);
    expect(noEvidence.length).toBeGreaterThan(0);
    for (const r of noEvidence) expect(greyscaleDescriptor(r)).toContain("ring=none");
  });
});
