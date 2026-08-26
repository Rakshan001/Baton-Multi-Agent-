"use client";
// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Heading = { id: string; text: string };

/**
 * "On this page" rail with scroll-spy.
 *
 * Headings are read from the rendered DOM rather than passed down from each
 * page — that keeps a page's section list in exactly one place (the JSX) and
 * makes it impossible for the rail to drift out of sync with the content.
 */
export default function DocsToc() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLHeadingElement>("#doc-content h2[id]"),
    );
    setHeadings(
      nodes.map((n) => ({
        id: n.id,
        text: n.dataset.tocTitle ?? n.textContent ?? "",
      })),
    );

    if (nodes.length === 0) {
      setActive(null);
      return;
    }

    // Plain scroll listener rather than IntersectionObserver: "the last heading
    // that has passed under the nav" is the behavior readers expect, and it is
    // far easier to get right than reconciling observer entries. Matches the
    // scroll-listener idiom already used in NavShell.
    const onScroll = () => {
      let current = nodes[0].id;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 96) current = node.id;
      }
      setActive(current);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  if (headings.length === 0) return null;

  return (
    <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-8">
      <nav aria-label="On this page">
        <p className="eyebrow mb-3">{"// on this page"}</p>
        <ul className="space-y-0.5">
          {headings.map((heading) => {
            const isActive = active === heading.id;
            return (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  aria-current={isActive ? "location" : undefined}
                  className={`block border-l-2 py-1.5 pl-3 text-sm leading-snug transition-colors ${
                    isActive
                      ? "border-l-amber text-fg"
                      : "border-l-line text-faint hover:border-l-line-strong hover:text-muted"
                  }`}
                >
                  {heading.text}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
