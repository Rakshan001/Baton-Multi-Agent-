// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — one worktree, as a node on the flow canvas

   Reads as a card, not a dot: the question this screen answers is
   "which of these has stopped, and what does it still hold" — which
   cannot be asked of a coloured circle.

   WHAT wt-flow-nodes ADDED, AND WHY EACH PIECE IS NOT DECORATION:

   1. NOTHING HERE DEPENDS ON COLOUR. `--clean` and `--dirty` are 0.016
      apart in WCAG relative luminance (computed in encoding.test.ts),
      so in a greyscale screenshot — or to a deuteranope — a healthy
      node and a quiet one are the same grey. Every `state` and every
      `health` value therefore carries THREE channels that survive
      desaturation, all defined in flow/encoding.ts:
        state  → left-rail dash geometry + glyph + the state word
        health → card border pattern/width + glyph + the health word
      Colour still does its job for everyone who can see it; it is just
      never the only thing doing it.

   2. THE DECAY RING. Quiet time is drawn as an arc that shortens from
      full to empty across STALL_GRACE_MS. An `active` node with an
      empty ring reads as "claimed two hours ago, nothing has happened
      in forty-five minutes" — the stall stated as EVIDENCE the viewer
      can disagree with, not as a verdict the daemon never issued. A
      worktree with no evidence at all (`quietForMs === null`) gets a
      DOTTED track and no arc, because an empty ring would be a claim.

   3. MOTION IS A JS DECISION. flow/useNodeMotion.ts explains why the
      `prefers-reduced-motion` block at styles/base.css:62-74 is not
      sufficient on its own. When motion is off, the liveness dot is
      rendered STATIC rather than animated-then-clamped, and the card's
      hover/selection transition is removed outright.

   Every colour below is a `var(...)` token resolved by the browser at
   paint time, so a theme switch needs no JS here at all (see
   flow/health.ts for which bug that avoids). The ring is geometry, not
   animation: it is never tweened, so reduced motion costs it nothing.
   ============================================================ */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Icon } from "../Icon";
import { HEALTH_META, STATE_COLOR, quietLabel } from "./health";
import {
  STALL_GRACE_MS, STATE_ENCODING, healthBorder, railBackground, railOf, ringGeometry,
} from "./encoding";
import { useNodeMotion } from "./useNodeMotion";
import { NODE_H, NODE_W, type WorktreeFlowNode } from "./layout";
import { displayName, shownAtRisk } from "./panel";

/** A chip at the 11px legibility floor — the documented minimum, not a target. */
function Chip({ color, icon, children, title, strike }: {
  color: string; icon?: React.ComponentProps<typeof Icon>["name"];
  children: React.ReactNode; title?: string; strike?: boolean;
}) {
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4, height: 18, padding: "0 6px",
      borderRadius: 999, fontSize: "var(--fs-11)", lineHeight: 1, whiteSpace: "nowrap",
      color, background: `color-mix(in srgb, ${color} 13%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      textDecoration: strike ? "line-through" : "none",
    }}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

/**
 * The decay ring: how much of the grace window is left, with the health
 * glyph in the middle.
 *
 * Two circles, no animation. The arc is rotated -90° so it empties
 * clockwise from twelve o'clock, and `strokeLinecap: "butt"` is deliberate —
 * a round cap would leave a visible stub at fraction 0, i.e. would draw a
 * little bit of "still fine" onto a worktree that has none left.
 */
function DecayRing({ quietForMs, color, icon, label }: {
  quietForMs: number | null; color: string;
  icon: React.ComponentProps<typeof Icon>["name"]; label: string;
}) {
  const g = ringGeometry(quietForMs);
  const c = g.size / 2;
  const pct = g.fraction === null ? null : Math.round(g.fraction * 100);
  const title = g.fraction === null
    ? `${label} · no progress evidence for this worktree`
    : `${label} · ${pct}% of the ${Math.round(STALL_GRACE_MS / 60_000)}-minute grace window left (quiet ${quietLabel(quietForMs)})`;

  return (
    <span title={title} style={{ position: "relative", width: g.size, height: g.size, flex: "0 0 auto" }}>
      <svg width={g.size} height={g.size} viewBox={`0 0 ${g.size} ${g.size}`} aria-hidden="true">
        {/* Track. Dotted when there is no evidence at all — a solid track
            behind no arc would read as "spent", which is a different claim. */}
        <circle
          cx={c} cy={c} r={g.radius} fill="none"
          stroke="var(--border-default)" strokeWidth={g.strokeWidth}
          strokeDasharray={g.fraction === null ? "1.5 3" : undefined}
        />
        {g.fraction !== null && g.fraction > 0 && (
          <circle
            cx={c} cy={c} r={g.radius} fill="none"
            stroke={color} strokeWidth={g.strokeWidth} strokeLinecap="butt"
            strokeDasharray={g.circumference} strokeDashoffset={g.dashOffset}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
      <span style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center",
        justifyContent: "center", color,
      }}>
        <Icon name={icon} size={13} />
      </span>
    </span>
  );
}

function WorktreeNodeInner({ data, selected }: NodeProps<WorktreeFlowNode>) {
  const row = data.row;
  const health = HEALTH_META[row.health] ?? HEALTH_META.unknown;
  const stateColor = row.state ? STATE_COLOR[row.state] : "var(--idle)";
  const stateEnc = row.state ? STATE_ENCODING[row.state] : null;
  const rail = railOf(row.state);
  const border = healthBorder(row.health);
  const mayAnimate = useNodeMotion();

  // The single highest-value fact this screen can state, and the one nothing
  // else in the product surfaces: the record says somebody holds this, and no
  // process is actually there (src/worktrees.ts:96-99).
  const holderGone = row.claimedBy !== null && !row.holderRunning;
  const live = row.health === "working" && row.holderRunning;

  return (
    <div
      // One sentence, in the order someone hunting stuck work reads it:
      // verdict, then state, then the evidence behind the verdict.
      aria-label={`${displayName(row)}: ${health.label}${row.state ? `, ${row.state}` : ""}, quiet ${quietLabel(row.quietForMs)}`}
      style={{
        position: "relative",
        width: NODE_W, minHeight: NODE_H, boxSizing: "border-box",
        display: "flex", flexDirection: "column", gap: 7,
        // Health's third channel. Pattern and width are what carry it; the
        // colour on top is a fourth, redundant one. Selection recolours this
        // border and adds a shadow ring — it never changes the PATTERN, so
        // selecting a node cannot erase its health.
        border: `${border.width}px ${border.pattern} ${
          selected ? "var(--accent)" : health.urgent ? health.color : "var(--border-default)"
        }`,
        // Rail width is state's channel and must not be eaten by the text.
        padding: `10px 11px 10px ${11 + rail.width}px`,
        background: "var(--bg-surface)",
        borderRadius: "var(--r-lg)",
        boxShadow: selected ? "var(--shadow-md)" : "var(--shadow-sm)",
        color: "var(--text-primary)",
        // React Flow adds its own transitions; this is the card's, and it is
        // removed rather than clamped when motion is off (useNodeMotion.ts).
        transition: mayAnimate ? "box-shadow 120ms ease-out" : "none",
      }}
    >
      {/* The state rail. A background gradient rather than a border-left
          because CSS offers four border patterns and state needs eight
          distinguishable ones (encoding.ts). `state: null` — an orphan, which
          has no lifecycle — gets width 0, i.e. no rail rather than a guess. */}
      {rail.width > 0 && (
        <span aria-hidden="true" style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: rail.width,
          background: railBackground(rail, stateColor),
          borderTopLeftRadius: "var(--r-lg)", borderBottomLeftRadius: "var(--r-lg)",
          pointerEvents: "none",
        }} />
      )}

      {/* Connectable={false}: the DAG comes from the plan, and letting somebody
          draw a dependency here would imply the daemon would honour it. */}
      <Handle type="target" position={Position.Left} isConnectable={false}
        style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />
      <Handle type="source" position={Position.Right} isConnectable={false}
        style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <DecayRing quietForMs={row.quietForMs} color={health.color} icon={health.icon} label={health.label} />
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            <span style={{
              fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", fontFamily: "var(--font-mono)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
            }} title={row.slug}>{displayName(row)}</span>
            {/* The one moving thing on the card, and only when a process is
                genuinely there. Under reduced motion it is still DRAWN — the
                fact must not vanish — it simply stops breathing. */}
            {live && (
              <span
                aria-hidden="true"
                title={mayAnimate ? "A process is running here" : "A process is running here (motion reduced)"}
                style={{
                  width: 5, height: 5, borderRadius: 999, flex: "0 0 auto", background: health.color,
                  animation: mayAnimate ? "pulse-dot 1.8s ease-in-out infinite" : "none",
                }}
              />
            )}
          </div>
          <div style={{
            fontSize: "var(--fs-11)", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={row.branch ?? row.worktreePath}>
            {row.branch ?? "(no branch)"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        {/* Health's first two channels: its own glyph and its own word, both
            unique across all eleven values (health.ts). */}
        <Chip color={health.color} icon={health.icon} title={health.blurb}>{health.label}</Chip>
        {stateEnc && (
          <Chip color={stateColor} icon={stateEnc.icon} strike={stateEnc.strike}
            title={`Lifecycle state the daemon holds for ${row.slug}`}>{stateEnc.label}</Chip>
        )}
        {/* "Quiet for N" is the number behind the ring, and the ring is the
            reading of it. Both are shown so a person can disagree with the
            reading — which is the whole difference between evidence and a
            verdict. */}
        <Chip color="var(--idle)" icon="clock" title="Since the progress token last advanced">
          {quietLabel(row.quietForMs)}
        </Chip>
        {holderGone && (
          <Chip color="var(--conflict)" icon="bot" title={`${row.claimedBy} holds this task, but no process is running in the worktree`}>
            {row.claimedBy} gone
          </Chip>
        )}
        {row.agent && row.holderRunning && (
          <Chip color="var(--ready)" icon="bot" title={`${row.agent} is running in this worktree`}>{row.agent}</Chip>
        )}
        {shownAtRisk(row) && (
          <Chip color="var(--dirty)" icon="alertTriangle"
            title="Uncommitted lines plus commits that exist nowhere but this disk">
            {row.unprotected.lines > 0 ? `${row.unprotected.lines} lines` : ""}
            {row.unprotected.lines > 0 && row.unprotected.commits ? " · " : ""}
            {row.unprotected.commits ? `${row.unprotected.commits} commits` : ""}
            {row.unprotected.lines === 0 && !row.unprotected.commits ? "at risk" : ""}
          </Chip>
        )}
        {/* Own color, not tied to health severity: overlap is a coordination
            fact ("another agent also touches this path"), not a health rung. */}
        {row.overlapCount > 0 && (
          <Chip color="var(--accent)" icon="network"
            title={`Also being edited in: ${[...new Set(row.files?.flatMap((f) => f.overlaps ?? []) ?? [])].join(", ")}`}>
            {row.overlapCount} shared
          </Chip>
        )}
        {row.repoState && row.repoState !== "clean" && (
          <Chip color="var(--dirty)" icon="gitMerge" title="An in-progress git operation nobody has finished">
            {row.repoState}
          </Chip>
        )}
        {row.wipRef && (
          <Chip color="var(--clean)" icon="gitCommit" title={`Uncommitted work was snapshotted to ${row.wipRef}`}>
            snapshot
          </Chip>
        )}
      </div>
    </div>
  );
}

export const WorktreeNode = memo(WorktreeNodeInner);
