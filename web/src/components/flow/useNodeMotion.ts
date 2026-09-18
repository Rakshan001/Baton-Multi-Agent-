// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — may a worktree node animate?

   WHY THIS IS A JS QUESTION AND NOT A CSS ONE.

   styles/base.css:62-74 already clamps `animation-duration` and
   `transition-duration` to 0.001ms under `prefers-reduced-motion:
   reduce` and under `:root[data-motion="reduce"]`. That is a real
   guard and it stays — but it only reaches things the CASCADE owns. It
   cannot reach:

     · an animation driven from JS — a requestAnimationFrame loop or an
       inline style written per frame is not a CSS animation, so no
       `!important` duration touches it;
     · React Flow's own node transitions, which it applies through its
       library CSS and its own JS on drag, fit and zoom;
     · a decision NOT to render a moving thing at all. Clamping a pulse
       to 0.001ms leaves a dot that has technically finished animating
       mid-cycle; the honest result is a static dot, and only the
       component can choose that.

   So the answer is computed here and the component branches on it.

   TWO INPUTS, EITHER ONE WINS:
     1. the OS/browser setting, via hooks/useMediaQuery.ts (which
        subscribes to `change`, so a mid-session flip is picked up);
     2. Baton's own in-app preference, which hooks/usePrefs.ts:73 stamps
        onto `documentElement.dataset.motion`. There is no media query
        for that, so it is watched with a MutationObserver over exactly
        that attribute — the same technique, and for the same reason, as
        flow/useFlowTheme.ts.

   Default is "do not animate" until proven otherwise: the first render
   can land before prefs have been applied, and a flash of motion is
   precisely what someone who set this preference asked not to see.
   ============================================================ */
import { useEffect, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";

/** The app preference, read off the DOM that usePrefs.ts:73 writes. */
function readAppReduce(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.dataset.motion === "reduce";
}

function useAppReducedMotion(): boolean {
  const [reduce, setReduce] = useState(readAppReduce);
  useEffect(() => {
    const sync = () => setReduce(readAppReduce());
    sync(); // the attribute may have been stamped before this mounted
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => obs.disconnect();
  }, []);
  return reduce;
}

/**
 * `true` when a node may animate. Every caller must branch on it rather
 * than emitting an animation and hoping the cascade clamps it.
 *
 * Note what this does NOT gate: the decay ring. The ring is geometry, not
 * motion — it is redrawn when the data changes and never tweened — which is
 * deliberate, because the one signal this screen exists to carry has to
 * survive a reduced-motion setting intact.
 */
export function useNodeMotion(): boolean {
  const osReduce = useMediaQuery("(prefers-reduced-motion: reduce)");
  const appReduce = useAppReducedMotion();
  return !osReduce && !appReduce;
}
