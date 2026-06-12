/* ============================================================
   BATON — preferences hook (ported from app.jsx usePrefs)
   theme / accent / motion / write / view / offline,
   persisted to localStorage and applied to <html>.
   ============================================================ */
import { useState, useEffect } from "react";
import { ACCENTS } from "../lib/registry";
import { BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import { ls } from "../lib/storage";

export type Theme = "system" | "light" | "dark";
export type Motion = "full" | "reduce";
export type View = "board" | "canvas";

// Re-exported for back-compat: callers import `ls` from this module.
export { ls };

export interface Prefs {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (v: Theme) => void;
  accent: string;
  setAccent: (v: string) => void;
  motion: Motion;
  setMotion: (v: Motion) => void;
  writeEnabled: boolean;
  setWriteEnabled: (v: boolean) => void;
  /** Real mode: feed the daemon's /api/meta writeEnabled so the UI follows it
   *  automatically — no hidden per-browser toggle to discover. An explicit user
   *  choice still wins, except a read-only daemon always forces read-only.
   *  Pass null when there is no daemon (demo mode) to restore pure-pref behavior. */
  followDaemonWrite: (daemonWrite: boolean | null) => void;
  view: View;
  setView: (v: View) => void;
  offline: boolean;
  setOffline: (v: boolean) => void;
}

export function usePrefs(): Prefs {
  const [theme, setThemeRaw] = useState<Theme>(() => ls.get<Theme>("baton:theme", "dark"));
  const [accent, setAccentRaw] = useState<string>(() => ls.get("baton:accent", "blue"));
  const [motion, setMotionRaw] = useState<Motion>(() => ls.get<Motion>("baton:motion", "full"));
  // null = the user never chose — follow the daemon's capability in real mode.
  const [writeChoice, setWriteChoice] = useState<boolean | null>(() => ls.get<boolean | null>("baton:write", null));
  const [daemonWrite, setDaemonWrite] = useState<boolean | null>(null);
  // Read-only daemon always forces read-only; otherwise an explicit choice wins,
  // then the daemon's capability, then the safe default (off).
  const writeEnabled = daemonWrite === false ? false : (writeChoice ?? daemonWrite ?? false);
  const [view, setViewRaw] = useState<View>(() => ls.get<View>("baton:view", "board"));
  const [offline, setOfflineRaw] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const r: "light" | "dark" = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = r;
      setResolvedTheme(r);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const ac = ACCENTS.find((a) => a.id === accent) || ACCENTS[0];
    const r = document.documentElement.style;
    r.setProperty("--accent-h", ac.h);
    r.setProperty("--accent-s", ac.s);
    r.setProperty("--accent-l", ac.l);
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.motion = motion === "reduce" ? "reduce" : "";
  }, [motion]);

  useEffect(() => {
    BatonAPI.writeEnabled = writeEnabled;
  }, [writeEnabled]);

  useEffect(() => {
    BatonAPI.setForcedOffline(offline);
  }, [offline]);

  return {
    theme, resolvedTheme,
    setTheme: (v) => { setThemeRaw(v); ls.set("baton:theme", v); },
    accent,
    setAccent: (v) => { setAccentRaw(v); ls.set("baton:accent", v); },
    motion,
    setMotion: (v) => { setMotionRaw(v); ls.set("baton:motion", v); },
    writeEnabled,
    setWriteEnabled: (v) => {
      setWriteChoice(v);
      ls.set("baton:write", v);
      showToast({
        kind: v ? "ok" : "info",
        title: v ? "Write actions enabled" : "Read-only mode",
        desc: v && daemonWrite === false
          ? "The daemon is read-only — restart it with `baton serve --write` for this to take effect."
          : v ? "Merge & Remove are now live." : "Merge & Remove are disabled.",
      });
    },
    followDaemonWrite: setDaemonWrite,
    view,
    setView: (v) => { setViewRaw(v); ls.set("baton:view", v); },
    offline, setOffline: setOfflineRaw,
  };
}
