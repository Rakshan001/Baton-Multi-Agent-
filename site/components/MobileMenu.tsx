"use client";

import { useEffect, useRef, useState } from "react";
import { NAV_LINKS } from "./site";

/** Disclosure menu for the nav links on < md viewports. Escape or an
 *  outside click closes it; picking a link closes it before scrolling. */
export default function MobileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-fg"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {open ? (
            <path d="M3 3l10 10M13 3L3 13" />
          ) : (
            <path d="M2 4.5h12M2 8h12M2 11.5h12" />
          )}
        </svg>
      </button>
      {open && (
        <ul
          id="mobile-nav"
          className="absolute right-0 top-11 z-50 w-48 rounded-xl border border-line bg-ink-2/95 p-2 backdrop-blur"
        >
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target={"external" in link && link.external ? "_blank" : undefined}
                rel={
                  "external" in link && link.external
                    ? "noopener noreferrer"
                    : undefined
                }
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
