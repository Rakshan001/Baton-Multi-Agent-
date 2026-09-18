// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — resolved theme tokens for the flow canvas

   THE BUG THIS EXISTS NOT TO REPEAT: components/GraphCanvas.tsx:60-65
   reads its CSS tokens with getComputedStyle inside an effect with a
   `[]` dependency list. That runs exactly once, so switching the theme
   leaves that graph painting the old palette until the screen is
   remounted. Every colour it drew is now a literal from the wrong
   theme, and nothing tells it.

   The cards on this canvas dodge the problem entirely by keeping
   `var(--clean)` etc. in their inline styles — the browser resolves
   those per paint, so a theme switch is free. But React Flow's MiniMap
   hands its `nodeColor` result straight to an SVG `fill`, and a few
   library colours arrive as props rather than CSS, so a handful of
   tokens do have to be resolved to literals in JS.

   For those, this hook re-reads on every theme change instead of once:
   hooks/usePrefs.ts:59-60 stamps the RESOLVED theme onto
   `documentElement.dataset.theme` and :70 writes the accent onto
   `documentElement.style`, so a MutationObserver over exactly those two
   attributes fires on every switch, system-preference flip included.
   ============================================================ */
import { useEffect, useState } from "react";

/** The tokens this canvas cannot express as a `var(...)` string. */
const TOKENS = [
  "--bg-canvas", "--bg-base", "--bg-elevated", "--border-default", "--border-subtle",
  "--grid-dot", "--accent", "--clean", "--dirty", "--conflict", "--ready", "--idle",
  "--text-tertiary",
] as const;

export type FlowTheme = Record<(typeof TOKENS)[number], string>;

/** Fallbacks are the dark palette from styles/tokens.css — used only before
 *  the stylesheet has applied, never as a substitute for reading it. */
const FALLBACK: FlowTheme = {
  "--bg-canvas": "#0b0c0e", "--bg-base": "#08090a", "--bg-elevated": "#1b1e22",
  "--border-default": "rgba(255,255,255,0.1)", "--border-subtle": "rgba(255,255,255,0.06)",
  "--grid-dot": "rgba(255,255,255,0.05)", "--accent": "#5b8cff",
  "--clean": "#34d399", "--dirty": "#fbbf24", "--conflict": "#f87171",
  "--ready": "#2dd4bf", "--idle": "#71767b", "--text-tertiary": "#9ba1a6",
};

function readTokens(): FlowTheme {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as FlowTheme;
  for (const name of TOKENS) {
    out[name] = cs.getPropertyValue(name).trim() || FALLBACK[name];
  }
  return out;
}

/** The theme the shell has actually resolved. "system" never reaches the DOM —
 *  usePrefs.ts:59 turns it into "light" or "dark" before stamping it — so this
 *  is a two-value answer, which is what React Flow's `colorMode` wants. */
function readMode(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export interface FlowThemeState {
  tokens: FlowTheme;
  mode: "light" | "dark";
}

export function useFlowTheme(): FlowThemeState {
  const [state, setState] = useState<FlowThemeState>(() => ({ tokens: readTokens(), mode: readMode() }));

  useEffect(() => {
    const sync = () => setState({ tokens: readTokens(), mode: readMode() });
    // Re-read once on mount: the first render can land before the stylesheet
    // or a persisted theme choice has been applied.
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => obs.disconnect();
  }, []);

  return state;
}

/**
 * `var(--clean)` → the literal colour that token currently holds.
 *
 * Only for the places that cannot take a CSS variable — React Flow's MiniMap
 * writes its `nodeColor` result into an SVG `fill`. Because the tokens come
 * from `useFlowTheme`, which re-reads on every theme change, the resolved
 * literal is replaced on a switch instead of being frozen at first paint.
 * Anything that CAN take a variable should keep taking one.
 */
export function resolveToken(tokens: FlowTheme, value: string): string {
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
  if (!m) return value;
  return (tokens as Record<string, string>)[m[1]!] ?? tokens["--idle"];
}
