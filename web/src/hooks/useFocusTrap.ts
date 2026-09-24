// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — modal focus trap
   One implementation of the dialog keyboard contract, shared by
   every overlay: initial focus (prefers [data-autofocus]), Tab
   cycling inside the container, Escape to close, and focus restore
   to the opener on unmount.
   ============================================================ */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/**
 * Every armed trap, innermost last.
 *
 * Escape and Tab belong to the innermost overlay only, and `stopPropagation`
 * cannot deliver that: two traps put their listener on the SAME node
 * (`document`) in the SAME phase, where stopping propagation does not reach a
 * sibling listener — only `stopImmediatePropagation` would, and that hands the
 * key to whichever trap registered FIRST, i.e. the dialog underneath. So
 * Escape inside a confirm dialog also threw away the sheet behind it: backing
 * out of "Merge into main?" closed the session you were reading.
 *
 * Registration order is mount order, so the last entry is the overlay on top.
 */
const armed: RefObject<HTMLElement | null>[] = [];

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  onClose?: () => void,
  { enabled = true, autoFocus = true }: { enabled?: boolean; autoFocus?: boolean } = {},
) {
  // Callers pass inline closures — keep them out of the effect deps so the
  // trap doesn't tear down (and steal focus again) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled || !ref.current) return;
    const lastFocus = document.activeElement;
    // Read ref.current lazily: dialogs that swap content (form → success)
    // move the ref to a new element, and the trap must follow it.
    const focusable = () => ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [];
    if (autoFocus) {
      const first = ref.current.querySelector<HTMLElement>("[data-autofocus]") || focusable()[0];
      // Only PUT focus in the dialog — never move it once it is already there.
      // A body that focuses its own field (React `autoFocus` on the Warn
      // textarea, say) had that focus yanked to the confirm button 40 ms later,
      // so the field took one keystroke and the next space press hit the
      // primary button. The trap's job is "focus is inside", not "focus is on
      // the element I picked".
      if (first) setTimeout(() => { if (!ref.current?.contains(document.activeElement)) first.focus(); }, 40);
    }
    armed.push(ref);
    const onKey = (e: KeyboardEvent) => {
      // A trap with something open on top of it is not the one being talked to.
      if (armed[armed.length - 1] !== ref) return;
      if (e.key === "Escape" && onCloseRef.current) { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key === "Tab") {
        const f = Array.from(focusable());
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      const i = armed.lastIndexOf(ref);
      if (i !== -1) armed.splice(i, 1);
      document.removeEventListener("keydown", onKey, true);
      (lastFocus as HTMLElement | null)?.focus?.();
    };
  }, [enabled, ref, autoFocus]);
}
