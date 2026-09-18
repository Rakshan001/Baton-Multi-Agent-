// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — the non-colour encoding for a worktree node

   WHY THIS FILE EXISTS: colour is the one channel this screen may not
   rely on. Run the five semantic tokens at styles/tokens.css:124-147
   through WCAG relative luminance and `--clean` (#34d399, L≈0.563) and
   `--dirty` (#fbbf24, L≈0.579) land 0.016 apart — indistinguishable in
   a greyscale screenshot, and indistinguishable to a deuteranope in
   colour. `encoding.test.ts` computes that rather than asserting it.

   So every `state` and every `health` value is ALSO carried by three
   channels that survive desaturation:

     state  → rail geometry (dash/gap/width on the left edge)
            + glyph
            + the state word itself
     health → border style + width on the card
            + glyph
            + the health word itself

   Each of those three is UNIQUE per value, so any two values differ in
   all three channels, not merely in their combination. `nonColour*
   Signature` below is the string the test pins, and it is a compile
   -time impossibility for a colour to leak into it: nothing in this
   file holds a colour at all. The hues stay in health.ts.

   The shapes are not arbitrary — the form says what the value means:
     solid  — record and disk agree, nothing was interrupted
     dashed — evidence is thinning (silence: quiet, stalled)
     dotted — nobody is here (orphan, missing, unanswered)
     double — two truths disagree (the record says held, the disk says
              gone; a half-finished rebase; an unresolved conflict)
   ============================================================ */
import type { IconName } from "../Icon";
import type { TaskState, WorktreeHealth } from "../../types";

/* ---------------------------------------------------------------- state */

/**
 * The left rail's geometry. `gap: 0` means solid; anything else is a
 * repeating dash of `dash` px on, `gap` px off, drawn as a background
 * gradient because CSS `border-style` offers four patterns and this needs
 * eight distinguishable ones.
 */
export interface Rail {
  dash: number;
  gap: number;
  width: number;
}

export interface StateEncoding {
  rail: Rail;
  icon: IconName;
  /** Rendered verbatim on the pill. The state word IS a channel — text
   *  survives greyscale, a screenshot and a screen reader alike. */
  label: string;
  /** Only `cancelled` is struck through, mirroring the pill at
   *  features/Pipeline.tsx:71 so the two screens agree. */
  strike: boolean;
}

/**
 * Keyed by the daemon's `TaskState` (types.ts:1039) — the SAME eight names
 * Pipeline.tsx already uses. Health is never a key here: health is a
 * modifier on a state, never a ninth peer (src/worktrees.ts:19-27).
 *
 * Every rail triple is distinct and every glyph is distinct; the test pins
 * both, because a duplicate would silently merge two states in greyscale.
 */
export const STATE_ENCODING: Record<TaskState, StateEncoding> = {
  // Nothing has started: the faintest rhythm on the rail.
  queued: { rail: { dash: 2, gap: 6, width: 3 }, icon: "inbox", label: "queued", strike: false },
  // Spoken for, not yet moving.
  claimed: { rail: { dash: 6, gap: 4, width: 3 }, icon: "lock", label: "claimed", strike: false },
  // The only unbroken medium rail — continuous work, continuous line.
  active: { rail: { dash: 0, gap: 0, width: 3 }, icon: "play", label: "active", strike: false },
  // Deliberately interrupted: the longest gaps on the canvas.
  paused: { rail: { dash: 12, gap: 8, width: 3 }, icon: "pause", label: "paused", strike: false },
  // Wants a human, so the rail thickens.
  review: { rail: { dash: 4, gap: 4, width: 5 }, icon: "search", label: "review", strike: false },
  blocked: { rail: { dash: 3, gap: 3, width: 5 }, icon: "alertOctagon", label: "blocked", strike: false },
  // Terminal and landed: unbroken AND heavy.
  done: { rail: { dash: 0, gap: 0, width: 5 }, icon: "check", label: "done", strike: false },
  // Terminal and abandoned by choice: the thinnest rail there is.
  cancelled: { rail: { dash: 2, gap: 2, width: 1 }, icon: "x", label: "cancelled", strike: true },
};

/**
 * An orphan worktree has `state: null` (types.ts:1200) because no task owns
 * it, so it has no lifecycle to draw. It gets NO rail rather than a guessed
 * one — absence is itself the honest signal, and a zero-width rail cannot be
 * mistaken for any of the eight above.
 */
export const NO_STATE_RAIL: Rail = { dash: 0, gap: 0, width: 0 };

export function railOf(state: TaskState | null): Rail {
  return state ? STATE_ENCODING[state].rail : NO_STATE_RAIL;
}

/**
 * CSS for a rail, colour supplied by the caller. Solid rails skip the
 * gradient entirely so the common case is a plain background.
 */
export function railBackground(rail: Rail, color: string): string {
  if (rail.gap === 0) return color;
  const period = rail.dash + rail.gap;
  return `repeating-linear-gradient(to bottom, ${color} 0, ${color} ${rail.dash}px, transparent ${rail.dash}px, transparent ${period}px)`;
}

/* --------------------------------------------------------------- health */

/** CSS border-style values, chosen because all four read in greyscale. */
export type BorderPattern = "solid" | "dashed" | "dotted" | "double";

export interface HealthEncoding {
  pattern: BorderPattern;
  /** `double` needs >= 3px or the browser collapses it to one line. */
  width: number;
}

/**
 * Card border per health. Eleven values, eleven distinct (pattern, width)
 * pairs — see the form vocabulary in the header comment for why each value
 * got the shape it did.
 *
 * Width rises with how much a human is wanted, so the encoding is also
 * ordinal at a glance: a 5px double border is the worst thing on the canvas
 * and it is the widest mark on it.
 */
export const HEALTH_ENCODING: Record<WorktreeHealth, HealthEncoding> = {
  /* agreement — solid */
  ok: { pattern: "solid", width: 1 },
  working: { pattern: "solid", width: 2 },
  dirty: { pattern: "solid", width: 3 },
  /* silence — dashed */
  quiet: { pattern: "dashed", width: 1 },
  stalled: { pattern: "dashed", width: 3 },
  /* nobody home — dotted */
  "orphan-disk": { pattern: "dotted", width: 1 },
  unknown: { pattern: "dotted", width: 2 },
  missing: { pattern: "dotted", width: 3 },
  /* two truths disagreeing — double */
  rebasing: { pattern: "double", width: 3 },
  conflict: { pattern: "double", width: 4 },
  abandoned: { pattern: "double", width: 5 },
};

export function healthBorder(health: WorktreeHealth): HealthEncoding {
  return HEALTH_ENCODING[health] ?? HEALTH_ENCODING.unknown;
}

/* ----------------------------------------------------------- decay ring */

/**
 * Mirrors STALL_GRACE_MS at src/pipeline.ts:55. Duplicated because `web/`
 * cannot import from `src/` — if that constant ever moves, this comment is
 * the breadcrumb. It is a display scale here, never a verdict: the daemon
 * decides what `stalled` means, this file only draws how far along the
 * window a worktree has travelled.
 */
export const STALL_GRACE_MS = 45 * 60_000;

/**
 * Quiet time → how much ring is LEFT, in [0, 1].
 *
 *   0 ms            → 1   (a full ring)
 *   STALL_GRACE_MS  → 0   (an empty ring)
 *   beyond          → 0   (clamped; a ring cannot go negative)
 *   null            → null — no evidence either way, and an empty ring
 *                     would be a claim the daemon never made. The caller
 *                     draws the track alone.
 *
 * This is the point of the whole task: an `active` node whose ring has run
 * out reads as "claimed two hours ago, and nothing has happened in
 * forty-five minutes" — stall shown as EVIDENCE, not as a verdict.
 */
export function decayFraction(quietForMs: number | null): number | null {
  if (quietForMs === null || !Number.isFinite(quietForMs)) return null;
  const remaining = 1 - quietForMs / STALL_GRACE_MS;
  if (remaining <= 0) return 0;
  if (remaining >= 1) return 1;
  return remaining;
}

export interface RingGeometry {
  size: number;
  radius: number;
  strokeWidth: number;
  circumference: number;
  /** `strokeDashoffset` for the arc; equals the circumference when empty. */
  dashOffset: number;
  /** null when there is no evidence — the caller then draws no arc at all. */
  fraction: number | null;
}

/** Ring maths, kept out of the component so it is testable without a DOM. */
export function ringGeometry(quietForMs: number | null, size = 30, strokeWidth = 2.5): RingGeometry {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = decayFraction(quietForMs);
  return {
    size, radius, strokeWidth, circumference,
    dashOffset: circumference * (1 - (fraction ?? 0)),
    fraction,
  };
}

/* ------------------------------------------------- the greyscale contract */

/**
 * The state's encoding with every colour removed. Two different states must
 * never produce the same string, or they are the same node in a greyscale
 * screenshot. Pinned by encoding.test.ts.
 */
export function nonColourStateSignature(state: TaskState | null): string {
  if (!state) return "rail:none|glyph:none|text:none|strike:false";
  const e = STATE_ENCODING[state];
  return `rail:${e.rail.dash}/${e.rail.gap}/${e.rail.width}|glyph:${e.icon}|text:${e.label}|strike:${e.strike}`;
}

/** As above, for health. The three channels are border, glyph and word. */
export function nonColourHealthSignature(health: WorktreeHealth, label: string, icon: IconName): string {
  const b = healthBorder(health);
  return `border:${b.pattern}/${b.width}|glyph:${icon}|text:${label}`;
}
