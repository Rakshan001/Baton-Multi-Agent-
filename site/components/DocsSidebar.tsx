"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DOCS_EXTERNAL, DOCS_GROUPS, DOCS_ORDER } from "./docs-nav";

/**
 * Docs navigation.
 *
 * Two presentations of one list: a sticky rail on lg+, and a disclosure on
 * narrow screens that names the current page when collapsed — so the reader
 * always knows where they are, even with the rail off-screen.
 */
export default function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Navigating closes the mobile disclosure — otherwise it covers the page
  // the reader just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape / outside-click, matching MobileMenu's behavior.
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

  const current = DOCS_ORDER.find((page) => page.href === pathname);

  return (
    <>
      {/* ---- narrow screens: disclosure ---- */}
      <div ref={ref} className="relative mb-8 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? "docs-nav-mobile" : undefined}
          className="panel flex w-full items-center justify-between px-4 py-3 text-sm"
        >
          <span className="flex items-center gap-2.5">
            <span className="eyebrow">docs</span>
            <span className="text-fg">{current?.label ?? "Browse"}</span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`text-faint transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>

        {open && (
          <div
            id="docs-nav-mobile"
            className="absolute inset-x-0 top-full z-30 mt-2 rounded-xl border border-line bg-ink-2/95 p-3 backdrop-blur"
          >
            <NavList pathname={pathname} />
          </div>
        )}
      </div>

      {/* ---- lg+: sticky rail ---- */}
      <aside className="hidden lg:block">
        {/* Its own scroll region, so a long list never outruns the viewport. */}
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-8 pr-2">
          <NavList pathname={pathname} />
        </div>
      </aside>
    </>
  );
}

function NavList({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Docs">
      {DOCS_GROUPS.map((group) => (
        <div key={group.title} className="mb-7 last:mb-0">
          <p className="eyebrow mb-3">{`// ${group.title}`}</p>
          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const active = pathname === page.href;
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    // The amber left-edge is the active marker; it reads at a
                    // glance without relying on color contrast alone.
                    className={`block border-l-2 py-1.5 pl-3 text-sm transition-colors ${
                      active
                        ? "border-l-amber font-medium text-fg"
                        : "border-l-line text-muted hover:border-l-line-strong hover:text-fg"
                    }`}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="mt-7 border-t border-line pt-5">
        <ul className="space-y-0.5">
          {DOCS_EXTERNAL.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block py-1.5 text-sm text-muted transition-colors hover:text-fg"
              >
                {link.label}
                <span aria-hidden="true" className="ml-1 text-faint">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
