"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "baton-theme";

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/**
 * Light/dark switch for the nav.
 *
 * The *icon* is swapped by CSS off `:root[data-theme]` (see globals.css), not by
 * this component's state — that way the right glyph is painted in the first
 * frame instead of appearing after hydration. React state here exists only to
 * give the button an accurate accessible name once it's interactive.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

    // With no explicit choice saved, keep following the OS while the page is
    // open — someone flipping their system theme shouldn't have to reload.
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (stored()) return;
      const next = systemTheme();
      document.documentElement.setAttribute("data-theme", next);
      setTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const current: Theme =
      document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next: Theme = current === "light" ? "dark" : "light";

    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference just won't survive the reload; the switch still works.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      // Before hydration the theme isn't known here, so the name stays neutral
      // (and still accurate). It sharpens once mounted.
      aria-label={
        theme === null
          ? "Switch color theme"
          : `Switch to ${theme === "light" ? "dark" : "light"} theme`
      }
      title="Switch color theme"
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:border-line-strong hover:text-fg"
    >
      <SunGlyph />
      <MoonGlyph />
    </button>
  );
}

/** Shown while dark is active — clicking goes to light. */
function SunGlyph() {
  return (
    <svg
      className="theme-icon-sun"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7L5.4 5.4" />
    </svg>
  );
}

/** Shown while light is active — clicking goes to dark. */
function MoonGlyph() {
  return (
    <svg
      className="theme-icon-moon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.5 14.4A8.6 8.6 0 1 1 9.6 3.5a6.9 6.9 0 0 0 10.9 10.9z" />
    </svg>
  );
}
