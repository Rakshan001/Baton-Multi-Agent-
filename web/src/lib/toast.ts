/* ============================================================
   BATON — toast bus (ported from primitives.jsx showToast)
   A tiny window-event bus; <ToastViewport/> renders the queue.
   ============================================================ */
export type ToastKind = "ok" | "error" | "info" | "warn";

export interface ToastOptions {
  kind?: ToastKind;
  title: string;
  desc?: string;
  mono?: boolean;
  sticky?: boolean;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

export interface Toast extends ToastOptions {
  id: string;
}

export function showToast(opts: ToastOptions): void {
  const id = Math.random().toString(36).slice(2);
  window.dispatchEvent(new CustomEvent("baton:toast", { detail: { id, ...opts } }));
}
