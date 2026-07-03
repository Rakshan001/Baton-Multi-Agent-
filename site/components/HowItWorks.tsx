"use client";

import { useRef, useState } from "react";
import { motion, useScroll, useMotionValueEvent } from "framer-motion";

/**
 * Scroll-driven handoff story. A tall scroll track with a sticky pane:
 * as the user scrolls, the active step advances and the right-hand diagram
 * morphs to match. Reduced-motion users still get every step (the active
 * index is driven by scroll position, not by animation), and crossfades
 * collapse to instant swaps via the global reduced-motion CSS.
 */

type Step = {
  n: string;
  key: string;
  title: string;
  body: string;
  cmd: string;
};

const STEPS: Step[] = [
  {
    n: "01",
    key: "plan",
    title: "Plan",
    body: "Your expensive agent (Claude Code) works in an isolated worktree at .baton/wt/my-task. Every session line streams into a buffer.",
    cmd: "baton new \"my task\"",
  },
  {
    n: "02",
    key: "pass",
    title: "Pass",
    body: "Condense the whole session into a single HANDOFF.md brief — objective, plan, remaining checklist, and an estimated cost — ready for a cheaper agent.",
    cmd: "baton pass my-task --to cursor",
  },
  {
    n: "03",
    key: "take",
    title: "Take",
    body: "The receiving agent prints the execution prompt, marks the task in-progress, and starts committing in its own worktree.",
    cmd: "baton take my-task",
  },
  {
    n: "04",
    key: "coordinate",
    title: "Coordinate",
    body: "Both agents are live. SSE-streamed edit signals show who's editing what. An overlap on the same file flashes a conflict warning — before they collide, not after.",
    cmd: "baton signals",
  },
  {
    n: "05",
    key: "merge",
    title: "Done & merge",
    body: "Mark the brief done, a completion report is filed to .baton/reports/, and the task branch squash-merges back into main.",
    cmd: "baton merge my-task",
  },
];

export default function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    // Map scroll progress across the track to a step index.
    const idx = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
    setActive(idx);
  });

  return (
    <div id="how-it-works" ref={ref} className="relative">
      {/* track height = one viewport per step */}
      <div className="relative" style={{ height: `${STEPS.length * 100}vh` }}>
        <div className="sticky top-0 flex min-h-screen items-center">
          <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-5 py-20 lg:grid-cols-2 lg:gap-16">
            {/* Left: step text */}
            <div>
              <p className="eyebrow mb-8">{"// session handoff"}</p>
              <ol className="space-y-6">
                {STEPS.map((s, i) => {
                  const isActive = i === active;
                  return (
                    <li
                      key={s.key}
                      className={`transition-opacity duration-500 ${
                        isActive ? "opacity-100" : "opacity-35"
                      }`}
                      aria-current={isActive ? "step" : undefined}
                    >
                      <div className="flex items-baseline gap-4">
                        <span className="font-mono text-sm text-amber">{s.n}</span>
                        <h3 className="text-display text-2xl text-fg lg:text-3xl">
                          {s.title}
                        </h3>
                      </div>
                      <div
                        className={`grid transition-all duration-500 ${
                          isActive
                            ? "mt-3 grid-rows-[1fr] opacity-100"
                            : "grid-rows-[0fr] opacity-0"
                        }`}
                      >
                        <div className="overflow-hidden">
                          <p className="max-w-md text-pretty leading-relaxed text-muted">
                            {s.body}
                          </p>
                          <code className="mt-4 inline-block rounded-md border border-line bg-ink-2 px-3 py-1.5 font-mono text-sm text-amber">
                            $ {s.cmd}
                          </code>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Right: animated diagram */}
            <div className="order-first lg:order-none">
              <HandoffDiagram active={active} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The 2.5D diagram. Two agent lanes (A=Claude, B=Cursor) and a card  */
/* that travels between them as the step advances.                     */
/* ------------------------------------------------------------------ */
function HandoffDiagram({ active }: { active: number }) {
  // card horizontal position by step: plan(A) -> pass(mid) -> take(B) ...
  const cardX = [40, 175, 310, 175, 310][active] ?? 40;
  const aActive = active === 0 || active === 1 || active === 3;
  const bActive = active >= 2;
  const conflict = active === 3;
  const done = active === 4;

  return (
    <div className="panel relative aspect-[4/3] w-full overflow-hidden p-6">
      <svg viewBox="0 0 420 320" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id="card-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffb454" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
        </defs>

        {/* connector */}
        <line
          x1="70"
          y1="60"
          x2="350"
          y2="60"
          stroke="#ff9d2e"
          strokeWidth="1.5"
          strokeDasharray="4 7"
          opacity="0.4"
        />

        {/* Agent A — Claude Code */}
        <Lane
          x={40}
          label="Claude Code"
          sub=".baton/wt/my-task"
          active={aActive}
        />
        {/* Agent B — Cursor */}
        <Lane x={290} label="Cursor" sub=".baton/wt/my-task" active={bActive} />

        {/* live edit signal rows under the active agent(s) */}
        <FileRows x={40} show={active >= 3} conflict={false} />
        <FileRows x={290} show={active >= 2} conflict={conflict} />

        {/* The traveling HANDOFF.md card */}
        <motion.g
          animate={{ x: cardX }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        >
          <rect
            x="0"
            y="120"
            width="70"
            height="54"
            rx="6"
            fill="#0e0e10"
            stroke="url(#card-grad)"
            strokeWidth="1.5"
          />
          <text x="35" y="138" textAnchor="middle" fontSize="8" fontFamily="var(--font-mono)" fill="#ffb454">
            HANDOFF.md
          </text>
          <line x1="10" y1="148" x2="60" y2="148" stroke="#ffffff26" strokeWidth="1" />
          <line x1="10" y1="156" x2="50" y2="156" stroke="#ffffff1a" strokeWidth="1" />
          <text x="35" y="168" textAnchor="middle" fontSize="6.5" fontFamily="var(--font-mono)" fill="#a1a1aa">
            est_cost_usd: 0.05
          </text>
        </motion.g>

        {/* conflict flash */}
        {conflict && (
          <motion.g
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          >
            <rect x="150" y="245" width="120" height="22" rx="5" fill="#ff9d2e22" stroke="#ff9d2e" strokeWidth="1" />
            <text x="210" y="259" textAnchor="middle" fontSize="8" fontFamily="var(--font-mono)" fill="#ffb454">
              ⚠ same file
            </text>
          </motion.g>
        )}

        {/* done checkmark */}
        {done && (
          <motion.g
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 14 }}
          >
            <circle cx="210" cy="256" r="16" fill="#ff9d2e22" stroke="#ff9d2e" strokeWidth="1.5" />
            <path d="M202,256 l5,5 l9,-11" fill="none" stroke="#ffb454" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </motion.g>
        )}
      </svg>
    </div>
  );
}

function Lane({
  x,
  label,
  sub,
  active,
}: {
  x: number;
  label: string;
  sub: string;
  active: boolean;
}) {
  return (
    <g opacity={active ? 1 : 0.4}>
      <circle cx={x + 45} cy="60" r="22" fill="#121214" stroke={active ? "#ff9d2e" : "#ffffff26"} strokeWidth={active ? "1.5" : "1"} />
      <circle cx={x + 45} cy="60" r="6" fill={active ? "#ff9d2e" : "#52525b"} />
      <text x={x + 45} y="98" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="#f4f4f5">
        {label}
      </text>
      <text x={x + 45} y="112" textAnchor="middle" fontSize="7" fontFamily="var(--font-mono)" fill="#71717a">
        {sub}
      </text>
    </g>
  );
}

function FileRows({ x, show, conflict }: { x: number; show: boolean; conflict: boolean }) {
  if (!show) return null;
  const rows = ["api.ts", "server.ts"];
  return (
    <g>
      {rows.map((r, i) => (
        <motion.g
          key={r}
          initial={{ opacity: 0 }}
          animate={{ opacity: conflict && i === 0 ? [0.5, 1, 0.5] : 1 }}
          transition={
            conflict && i === 0
              ? { duration: 1.1, repeat: Infinity }
              : { duration: 0.4 }
          }
        >
          <rect
            x={x + 6}
            y={200 + i * 16}
            width="78"
            height="12"
            rx="3"
            fill={conflict && i === 0 ? "#ff9d2e22" : "#ffffff0d"}
          />
          <circle cx={x + 13} cy={206 + i * 16} r="2.5" fill={conflict && i === 0 ? "#ff9d2e" : "#36d1dc"} />
          <text x={x + 22} y={209 + i * 16} fontSize="7" fontFamily="var(--font-mono)" fill="#a1a1aa">
            {r}
          </text>
        </motion.g>
      ))}
    </g>
  );
}
