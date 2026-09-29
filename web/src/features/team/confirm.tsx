// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — confirmation dialog host + action helpers

   Irreversible actions go through lib/signedActions.ts `confirmAndSign`
   with structured params only. In the desktop app, Electron main shows
   a native dialog. In demo mode the demo "main" (lib/teamApi.ts) builds
   the text from the params and asks through the dialog mounted here.

   `useAct` runs actions and keeps the error next to the control that
   caused it, instead of only in a toast.
   ============================================================ */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { confirmAndSign, type SignedAction, type SignedResult } from "@/lib/signedActions";
import { setDemoPrompter, type DemoPrompt } from "@/lib/teamApi";
import { showToast } from "@/lib/toast";

/** Mount once. The demo stand-in for Electron's native confirmation dialog. */
export function ConfirmHost() {
  const [pending, setPending] = useState<{ prompt: DemoPrompt; resolve: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    setDemoPrompter((prompt) => new Promise<boolean>((resolve) => {
      setPending((prev) => { prev?.resolve(false); return { prompt, resolve }; });
    }));
    return () => setDemoPrompter(null);
  }, []);

  const settle = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  const p = pending?.prompt;
  return (
    <Dialog open={!!pending} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        {p && (
          <>
            <DialogHeader>
              <DialogTitle>{p.title}</DialogTitle>
              <DialogDescription>{p.body}</DialogDescription>
            </DialogHeader>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden className="size-3.5" />
              Signed with this device's key. In the desktop app this is a native dialog.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => settle(false)}>Cancel</Button>
              <Button variant={p.tone === "danger" ? "destructive" : "default"} onClick={() => settle(true)} autoFocus>
                {p.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-control action runner. `run` for reversible actions, `sign` for
 * irreversible ones. Failures land in `error`; render it with <ActError>
 * right next to the control.
 */
export function useAct() {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((fn: () => void, ok?: string) => {
    try {
      fn();
      setError(null);
      if (ok) showToast({ kind: "ok", title: ok });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);
  const sign = useCallback(async (action: SignedAction, ok?: string): Promise<SignedResult> => {
    const r = await confirmAndSign(action);
    if (r.ok) { setError(null); if (ok) showToast({ kind: "ok", title: ok }); }
    else if (r.reason !== "cancelled") setError(r.message ?? "That didn't go through.");
    return r;
  }, []);
  return { error, run, sign, clear: () => setError(null) };
}

export function ActError({ error, className }: { error: string | null; className?: string }) {
  if (!error) return null;
  return <p role="alert" className={`text-xs text-status-danger-foreground ${className ?? ""}`}>{error}</p>;
}

/** A button that performs one signed action and shows its error beside itself. */
export function SignButton({ action, ok, children, variant = "outline" }: {
  action: SignedAction; ok: string; children: ReactNode; variant?: "default" | "outline" | "ghost" | "destructive";
}) {
  const act = useAct();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant={variant} className="max-md:h-11" onClick={() => void act.sign(action, ok)}>{children}</Button>
      <ActError error={act.error} />
    </span>
  );
}
