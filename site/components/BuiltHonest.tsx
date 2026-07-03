"use client";

import { useReducedMotion } from "framer-motion";

const FACTS = [
  "Zero-dependency daemon — raw node:http",
  "SSE, not socket.io",
  "Plain-markdown handoffs — no proprietary format",
  "tmux-backed agent terminals",
  "Git-native — no external database",
  "MCP tools for every agent",
  "Skills install to native config — .claude/skills, .cursor/rules",
  "Loopback-only API — anti-CSRF Origin guard on every write",
  "Strict TypeScript, Node ≥ 20",
];

/**
 * Engineering-credibility strip. A continuous mono marquee of honest facts.
 * Reduced-motion: renders a static wrapped list, no scrolling.
 */
export default function BuiltHonest() {
  const reduce = useReducedMotion();

  return (
    <section
      aria-labelledby="built-honest-title"
      className="border-y border-line bg-ink-2/40 py-8"
    >
      <h2 id="built-honest-title" className="sr-only">
        Built honest — engineering facts
      </h2>

      {reduce ? (
        <ul className="mx-auto flex max-w-7xl flex-wrap justify-center gap-x-6 gap-y-3 px-5 font-mono text-xs text-faint">
          {FACTS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : (
        <div className="relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]">
          <Track facts={FACTS} />
          <Track facts={FACTS} aria-hidden />
        </div>
      )}
    </section>
  );
}

function Track({
  facts,
  ...rest
}: {
  facts: string[];
  "aria-hidden"?: boolean;
}) {
  return (
    <ul
      className="flex shrink-0 items-center gap-8 px-4 font-mono text-xs text-faint"
      style={{ animation: "marquee 38s linear infinite" }}
      {...rest}
    >
      {facts.map((f, i) => (
        <li key={i} className="flex items-center gap-8 whitespace-nowrap">
          <span>{f}</span>
          <span className="text-amber/60" aria-hidden="true">
            ·
          </span>
        </li>
      ))}
    </ul>
  );
}
