/* ============================================================
   BATON — Agent registry + accents (ported from registry.jsx / admin.jsx)
   Original geometric glyphs (no brand logos). currentColor.
   ============================================================ */
import type { CSSProperties } from "react";
import type { AgentId } from "../types";

export interface AgentDef {
  id: AgentId | null;
  label: string;
  short: string;
  color: string;
  path: string;
  fill: boolean;
  stroke?: number;
}

export const AGENT_REGISTRY: AgentDef[] = [
  {
    id: "claude", label: "Claude Code", short: "Claude", color: "#e0875f",
    // eight-point spark
    path: "M12 2.5c.5 3.1 1.4 4 4.5 4.5-3.1.5-4 1.4-4.5 4.5-.5-3.1-1.4-4-4.5-4.5 3.1-.5 4-1.4 4.5-4.5Z M18 12.5c.3 1.8.9 2.4 2.7 2.7-1.8.3-2.4.9-2.7 2.7-.3-1.8-.9-2.4-2.7-2.7 1.8-.3 2.4-.9 2.7-2.7Z M7 13c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3Z",
    fill: true,
  },
  {
    id: "cursor", label: "Cursor", short: "Cursor", color: "#a78bfa",
    path: "M6 4.2 18.2 11l-5.1 1.2-1.2.3-.3 1.2L10.4 19 6 4.2Z",
    fill: true,
  },
  {
    id: "codex", label: "Codex", short: "Codex", color: "#2dd4bf",
    path: "M9 7 4.5 12 9 17 M15 7l4.5 5L15 17",
    fill: false, stroke: 2.2,
  },
  {
    id: "gemini", label: "Gemini", short: "Gemini", color: "#6ea8fe",
    path: "M12 2c.8 5.2 4 8.4 9.2 9.2C16 12 12.8 15.2 12 20.4 11.2 15.2 8 12 2.8 11.2 8 10.4 11.2 7.2 12 2Z",
    fill: true,
  },
  {
    id: "antigravity", label: "Antigravity", short: "Antigrav", color: "#fbbf24",
    // levitation: an arrow rising off two ground lines
    path: "M12 4.5v8 M8.5 8 12 4.5 15.5 8 M6.5 16h11 M8.5 19h7",
    fill: false, stroke: 2,
  },
  {
    id: "aider", label: "Aider", short: "Aider", color: "#f472b6",
    path: "M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z M7.5 10l2.4 2.2-2.4 2.2 M12.6 14.6h4",
    fill: false, stroke: 1.9,
  },
  {
    id: "opencode", label: "OpenCode", short: "OpenCode", color: "#a3e635",
    path: "M12 3.2 19 7.1v9.8L12 20.8 5 16.9V7.1L12 3.2Z M12 8.4 15.4 10.3v3.4L12 15.6 8.6 13.7v-3.4L12 8.4Z",
    fill: false, stroke: 1.8,
  },
];

export const AGENT_MAP: Record<string, AgentDef> = AGENT_REGISTRY.reduce(
  (m, a) => {
    if (a.id) m[a.id] = a;
    return m;
  },
  {} as Record<string, AgentDef>,
);

export const NEUTRAL_AGENT: AgentDef = {
  id: null, label: "Idle", short: "Idle", color: "var(--idle)",
  path: "M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z M9.5 12h5",
  fill: false, stroke: 1.8,
};

export function getAgent(id: AgentId | null | undefined): AgentDef {
  if (!id) return NEUTRAL_AGENT;
  return AGENT_MAP[id] || { ...NEUTRAL_AGENT, id, label: id, short: id, color: "var(--idle)" };
}

/** AgentGlyph — renders the geometric mark in the agent color. */
export function AgentGlyph({
  id, size = 16, color, style,
}: {
  id: AgentId | null;
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const a = getAgent(id);
  const col = color || a.color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={style}
      fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d={a.path}
        fill={a.fill ? col : "none"}
        stroke={a.fill ? "none" : col}
        strokeWidth={a.stroke || 0}
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ---- Accents (ported from admin.jsx ACCENTS) ---- */
export interface Accent {
  id: string;
  label: string;
  h: string;
  s: string;
  l: string;
}

export const ACCENTS: Accent[] = [
  { id: "blue", label: "Blue", h: "217", s: "91%", l: "60%" },
  { id: "indigo", label: "Indigo", h: "245", s: "75%", l: "65%" },
  { id: "emerald", label: "Emerald", h: "160", s: "70%", l: "45%" },
  { id: "violet", label: "Violet", h: "270", s: "75%", l: "66%" },
  { id: "orange", label: "Orange", h: "24", s: "90%", l: "57%" },
];
