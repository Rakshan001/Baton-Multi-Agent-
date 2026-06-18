"use client";

import { useEffect, useRef, useState, type ElementType } from "react";

/**
 * Scroll-reveal wrapper — CSS-transition based, no animation library on the
 * reveal path so it can never get stuck invisible.
 *
 * It reveals when the element enters the viewport via IntersectionObserver,
 * AND has a fail-safe: if the observer never fires (reduced motion, an unusual
 * viewport, JS hiccup) the content is shown after a short timeout. The starting
 * styles also collapse to "visible" instantly under prefers-reduced-motion.
 */
export default function Reveal({
  children,
  as,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  as?: ElementType;
  delay?: number;
  className?: string;
}) {
  const Tag: ElementType = as ?? "div";
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Fail-safe: reveal no matter what shortly after mount.
    const fallback = window.setTimeout(() => setShown(true), 700);

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
          window.clearTimeout(fallback);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    <Tag
      ref={ref}
      data-shown={shown}
      style={{ transitionDelay: `${delay}s` }}
      className={`reveal ${className}`}
    >
      {children}
    </Tag>
  );
}
