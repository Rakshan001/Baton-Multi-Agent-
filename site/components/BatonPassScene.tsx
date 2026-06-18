"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * The signature "baton pass" moment.
 *
 * A glowing amber capsule travels a bezier path between four agent nodes,
 * looping forever. When it arrives at a node, that node pulses and a small
 * HANDOFF.md glyph materializes — the relay-race metaphor at the core of Baton.
 *
 * Implemented as animated SVG + framer-motion for reliability and a tiny
 * footprint. Optional upgrade: swap for an R3F 3D scene per
 * docs/landing-page-prompt.md (glassy nodes, bloom, particle trail, parallax).
 *
 * Respects prefers-reduced-motion with a fully static, legible fallback.
 */

type Node = { id: string; label: string; x: number; y: number };

const NODES: Node[] = [
  { id: "claude", label: "Claude Code", x: 110, y: 90 },
  { id: "cursor", label: "Cursor", x: 470, y: 70 },
  { id: "codex", label: "Codex", x: 510, y: 300 },
  { id: "gemini", label: "Gemini", x: 130, y: 320 },
];

// The path the baton travels: claude -> cursor -> codex -> gemini -> claude.
// Each segment is a cubic bezier with a gentle arc so the motion feels alive.
const SEGMENTS = [
  "M110,90 C260,30 360,30 470,70",
  "M470,70 C560,150 560,230 510,300",
  "M510,300 C380,370 270,370 130,320",
  "M130,320 C30,240 30,160 110,90",
];

const FULL_PATH = SEGMENTS.join(" ");
const LOOP_SECONDS = 9.6; // ~2.4s per pass between four nodes

export default function BatonPassScene() {
  const reduce = useReducedMotion();

  return (
    <div className="relative mx-auto aspect-[6/5] w-full max-w-xl">
      {/* Ambient amber bloom behind the scene */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, #ff9d2e55, transparent 70%)" }}
      />

      <svg
        viewBox="0 0 620 410"
        className="relative h-full w-full"
        role="img"
        aria-label="Four AI coding agents — Claude Code, Cursor, Codex, and Gemini — arranged in a ring, with a glowing baton passing between them."
      >
        <defs>
          <linearGradient id="baton-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffb454" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
          <radialGradient id="node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ff9d2e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#ff9d2e" stopOpacity="0" />
          </radialGradient>
          <filter id="soft-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* The relay track */}
        <path
          d={FULL_PATH}
          fill="none"
          stroke="#ffffff14"
          strokeWidth="1.5"
        />
        <path
          d={FULL_PATH}
          fill="none"
          stroke="#ff9d2e"
          strokeWidth="1.5"
          strokeDasharray="3 9"
          strokeLinecap="round"
          opacity="0.35"
        />

        {/* Agent nodes */}
        {NODES.map((node, i) => (
          <AgentNode
            key={node.id}
            node={node}
            reduce={!!reduce}
            delay={(i / NODES.length) * LOOP_SECONDS}
          />
        ))}

        {/* The traveling baton (skipped when reduced motion is preferred) */}
        {!reduce && (
          <g filter="url(#soft-glow)">
            <motion.g
              animate={{ offsetDistance: ["0%", "100%"] }}
              transition={{
                duration: LOOP_SECONDS,
                ease: "easeInOut",
                repeat: Infinity,
              }}
              style={{
                offsetPath: `path("${FULL_PATH}")`,
                offsetRotate: "auto",
              }}
            >
              {/* capsule baton */}
              <rect
                x="-13"
                y="-4"
                width="26"
                height="8"
                rx="4"
                fill="url(#baton-grad)"
              />
              <rect
                x="-13"
                y="-4"
                width="26"
                height="8"
                rx="4"
                fill="#fff"
                opacity="0.35"
              />
            </motion.g>
          </g>
        )}

        {/* Reduced-motion: a static baton resting on the first node */}
        {reduce && (
          <rect
            x="97"
            y="86"
            width="26"
            height="8"
            rx="4"
            fill="url(#baton-grad)"
          />
        )}
      </svg>
    </div>
  );
}

function AgentNode({
  node,
  reduce,
  delay,
}: {
  node: Node;
  reduce: boolean;
  delay: number;
}) {
  return (
    <g>
      {/* arrival pulse glow */}
      {!reduce && (
        <motion.circle
          cx={node.x}
          cy={node.y}
          r="46"
          fill="url(#node-glow)"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.9, 0] }}
          transition={{
            duration: LOOP_SECONDS,
            times: [0.18, 0.25, 0.4],
            repeat: Infinity,
            delay,
            ease: "easeOut",
          }}
        />
      )}

      {/* node body */}
      <circle
        cx={node.x}
        cy={node.y}
        r="26"
        fill="#121214"
        stroke="#ffffff26"
        strokeWidth="1"
      />
      <circle cx={node.x} cy={node.y} r="6" fill="#ff9d2e" />

      {/* HANDOFF.md glyph that materializes on arrival */}
      {!reduce && (
        <motion.g
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: [0, 1, 1, 0], y: [6, 0, 0, 6] }}
          transition={{
            duration: LOOP_SECONDS,
            times: [0.2, 0.27, 0.34, 0.42],
            repeat: Infinity,
            delay,
          }}
        >
          <rect
            x={node.x + 16}
            y={node.y - 34}
            width="58"
            height="20"
            rx="4"
            fill="#0e0e10"
            stroke="#ff9d2e"
            strokeWidth="1"
          />
          <text
            x={node.x + 45}
            y={node.y - 20}
            textAnchor="middle"
            fontSize="9"
            fontFamily="var(--font-mono)"
            fill="#ffb454"
          >
            HANDOFF.md
          </text>
        </motion.g>
      )}

      {/* label */}
      <text
        x={node.x}
        y={node.y + 44}
        textAnchor="middle"
        fontSize="11"
        fontFamily="var(--font-mono)"
        fill="#a1a1aa"
        letterSpacing="0.04em"
      >
        {node.label}
      </text>
    </g>
  );
}
