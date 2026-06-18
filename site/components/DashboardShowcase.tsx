"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import Section from "./Section";

/**
 * A framed mock of the Baton dashboard inside browser chrome. It sits tilted
 * in 3D perspective and flattens to face-on as it scrolls into view, with an
 * amber glow underneath. Pure CSS/SVG mock — no real screenshot needed.
 */
export default function DashboardShowcase() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });

  const rotateX = useTransform(scrollYProgress, [0, 1], [22, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.92, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [40, 0]);

  return (
    <Section
      eyebrow="// localhost:7077"
      title="A realtime dashboard on your machine."
      intro="Activity, conflicts, terminals, memory, skills, and the knowledge graph — served by the daemon, binding 127.0.0.1 only. Demo mode is the showcase; the daemon-served UI is real."
    >
      <div ref={ref} className="relative [perspective:1600px]">
        <motion.div
          style={{ rotateX, scale, y, transformStyle: "preserve-3d" }}
          className="relative mx-auto max-w-5xl"
        >
          {/* amber glow underneath */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 bottom-0 h-40 translate-y-1/2 rounded-full blur-3xl"
            style={{ background: "radial-gradient(ellipse, #ff9d2e55, transparent 70%)" }}
          />
          <BrowserFrame />
        </motion.div>
      </div>
    </Section>
  );
}

function BrowserFrame() {
  return (
    <div className="panel relative overflow-hidden">
      {/* chrome bar */}
      <div className="flex items-center gap-2 border-b border-line bg-ink-2/80 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-white/15" />
        <span className="h-3 w-3 rounded-full bg-white/15" />
        <span className="h-3 w-3 rounded-full bg-white/15" />
        <div className="ml-3 flex-1 rounded-md border border-line bg-ink px-3 py-1 font-mono text-xs text-faint">
          localhost:7077
        </div>
      </div>

      {/* app body mock */}
      <div className="grid grid-cols-[170px_1fr] bg-ink">
        {/* sidebar */}
        <nav className="hidden border-r border-line p-4 sm:block" aria-label="Dashboard sections (mock)">
          <p className="mb-4 font-mono text-sm text-fg">
            <span className="amber-text">/</span>baton
          </p>
          <ul className="space-y-1.5 text-sm">
            {["Command Center", "Activity", "Conflicts", "Knowledge Graph", "Memory", "History", "Agents", "Skills", "Settings"].map((s, i) => (
              <li
                key={s}
                className={`rounded-md px-2 py-1 ${i === 0 ? "bg-amber/15 text-amber" : "text-muted"}`}
              >
                {s}
              </li>
            ))}
          </ul>
        </nav>

        {/* canvas */}
        <div className="min-h-[340px] p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-fg">Command Center</p>
            <span className="flex items-center gap-2 font-mono text-xs text-faint">
              <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" /> SSE live
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { t: "my-task", a: "Claude Code", c: "#ff9d2e" },
              { t: "fix-auth", a: "Cursor", c: "#36d1dc" },
              { t: "refactor-kb", a: "Codex", c: "#a1a1aa" },
              { t: "docs-pass", a: "Gemini", c: "#36d1dc" },
              { t: "graphify", a: "Claude Code", c: "#ff9d2e" },
              { t: "merge-pr", a: "Cursor", c: "#36d1dc" },
            ].map((card) => (
              <div key={card.t} className="rounded-lg border border-line bg-panel/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: card.c }} />
                  <span className="font-mono text-xs text-fg">{card.t}</span>
                </div>
                <p className="font-mono text-[11px] text-faint">{card.a}</p>
                <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full" style={{ width: "62%", background: card.c }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
