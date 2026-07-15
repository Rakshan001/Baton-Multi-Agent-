/* ============================================================
   BATON — modal focus trap
   One implementation of the dialog keyboard contract, shared by
   every overlay: initial focus (prefers [data-autofocus]), Tab
   cycling inside the container, Escape to close, and focus restore
   to the opener on unmount.
   ============================================================ */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

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
      if (first) setTimeout(() => first.focus(), 40);
    }
    const onKey = (e: KeyboardEvent) => {
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
      document.removeEventListener("keydown", onKey, true);
      (lastFocus as HTMLElement | null)?.focus?.();
    };
  }, [enabled, ref, autoFocus]);
}
