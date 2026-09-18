// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — one plan/phase group, expanded or collapsed

   ONE COMPONENT, TWO PRESENTATIONS, because they are the same node:
   React Flow keeps identity, position and selection on the node object
   (flow/groups.ts:mergeGroupNodes), so collapsing must not swap it for
   a different one.

     EXPANDED  — a container drawn BEHIND its children: a header bar
       with the label, the count and the rolled-up health, and a body
       that is deliberately transparent to the pointer so the cards
       inside stay clickable and a box-select still works over it.
     COLLAPSED — one card the width of a worktree card, carrying the
       count and the WORST child health (flow/groups.ts:HEALTH_SEVERITY).

   WHY THE ROLLED-UP HEALTH IS THE WORST CHILD'S AND NEVER AN AVERAGE:
   a group holding one stalled worktree and nine working ones has to
   read as stalled, or collapsing becomes a way to hide problems and
   this whole screen — which exists to tell a stopped agent from a
   working one — is undone by its own tidy-up button. The reasoning for
   the exact ordering, `unknown` included, is on HEALTH_SEVERITY.

   The collapsed card reuses the SAME non-colour channels a worktree
   card uses for health (flow/encoding.ts): the border pattern and
   width, the glyph, and the health word. So a collapsed group holding
   something abandoned is identifiable in a greyscale screenshot too —
   the rollup is not allowed to be the one place colour carries meaning
   alone.

   Every colour is a `var(--…)` token resolved by the browser at paint
   time, so a theme switch needs no JS here (flow/health.ts explains
   which bug that avoids). 11px is the documented legibility floor and
   nothing below it appears.
   ============================================================ */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Icon } from "../Icon";
import { HEALTH_META } from "./health";
import { healthBorder } from "./encoding";
import { useNodeMotion } from "./useNodeMotion";
import { useGroupToggle } from "./collapseStore";
import { COLLAPSED_H, COLLAPSED_W, GROUP_PAD_TOP, type GroupFlowNode } from "./groups";

/** Same chip shape as the worktree card's, at the same 11px floor, so a
 *  rolled-up health and a single worktree's health read as one vocabulary. */
function Chip({ color, icon, children, title }: {
  color: string; icon?: React.ComponentProps<typeof Icon>["name"];
  children: React.ReactNode; title?: string;
}) {
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4, height: 17, padding: "0 6px",
      borderRadius: 999, fontSize: "var(--fs-11)", lineHeight: 1, whiteSpace: "nowrap",
      color, background: `color-mix(in srgb, ${color} 13%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    }}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

function GroupNodeInner({ data, selected }: NodeProps<GroupFlowNode>) {
  const { group, collapsed } = data;
  const health = HEALTH_META[group.worstHealth] ?? HEALTH_META.unknown;
  const border = healthBorder(group.worstHealth);
  const toggle = useGroupToggle();
  const mayAnimate = useNodeMotion();

  // Said once, used by both presentations and by the screen reader: the count
  // and the worst health are the two facts a collapsed group must not lose.
  const rollup = `${group.count} worktree${group.count === 1 ? "" : "s"}`;
  const worstTitle = `Worst health among the ${rollup} in ${group.label}: ${health.label}. `
    + "A group always shows its worst child, never an average — otherwise collapsing would hide it.";

  const toggleButton = (
    <button
      type="button"
      // nodrag/nopan are React Flow's own opt-outs: without them a click on the
      // button starts a node drag and the click never lands.
      className="nodrag nopan"
      onClick={(e) => { e.stopPropagation(); toggle(group.id); }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${group.label} (${rollup})` : `Collapse ${group.label} (${rollup})`}
      data-tip={collapsed ? "Expand this phase" : "Collapse this phase into one node"}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 18, height: 18, flex: "0 0 auto", padding: 0, cursor: "pointer",
        borderRadius: "var(--r-sm)", border: "1px solid var(--border-default)",
        background: "var(--bg-elevated)", color: "var(--text-secondary)",
        transition: mayAnimate ? "background 120ms ease-out" : "none",
      }}
    >
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
    </button>
  );

  const label = (
    <span className="mono" style={{
      flex: 1, minWidth: 0, fontSize: "var(--fs-11)", fontWeight: "var(--fw-semibold)",
      color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }} title={`${group.label} — ${rollup}`}>{group.label}</span>
  );

  /* ---------------------------------------------------------- collapsed */

  if (collapsed) {
    return (
      <div
        aria-label={`${group.label}, collapsed, ${rollup}, worst health ${health.label}`}
        style={{
          boxSizing: "border-box", width: COLLAPSED_W, height: COLLAPSED_H,
          display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px",
          background: "var(--bg-surface)", borderRadius: "var(--r-lg)",
          // Health's non-colour channel, identical to a worktree card's, so the
          // rollup is legible without colour. Selection recolours it and never
          // changes the PATTERN — selecting a group cannot erase its health.
          border: `${border.width}px ${border.pattern} ${
            selected ? "var(--accent)" : health.urgent ? health.color : "var(--border-default)"
          }`,
          boxShadow: selected ? "var(--shadow-md)" : "var(--shadow-sm)",
          color: "var(--text-primary)",
          transition: mayAnimate ? "box-shadow 120ms ease-out" : "none",
        }}
      >
        {/* Rerouted edges land here. Rendered only when collapsed — expanded,
            every edge points at a child and an unused handle would be noise. */}
        <Handle type="target" position={Position.Left} isConnectable={false}
          style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />
        <Handle type="source" position={Position.Right} isConnectable={false}
          style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {toggleButton}
          {label}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <Chip color="var(--idle)" icon="layers" title={`${rollup} folded into this node`}>
            {group.count}
          </Chip>
          <Chip color={health.color} icon={health.icon} title={worstTitle}>{health.label}</Chip>
          {group.atRiskCount > 0 && (
            <Chip color="var(--dirty)" icon="alertTriangle"
              title={`${group.atRiskCount} of these hold work that exists nowhere but this disk`}>
              {group.atRiskCount} at risk
            </Chip>
          )}
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------------- expanded */

  return (
    <div
      aria-label={`${group.label}, ${rollup}`}
      style={{
        boxSizing: "border-box", width: "100%", height: "100%",
        borderRadius: "var(--r-lg)",
        border: "1px dashed var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-surface) 35%, transparent)",
        // THE BODY IS TRANSPARENT TO THE POINTER. React Flow paints a parent
        // beneath its children, so without this the container would still eat
        // shift-drag box-selects and pane drags started over its empty space.
        // The header re-enables pointer events for itself.
        pointerEvents: "none",
      }}
    >
      <div
        // The drag handle named in groups.ts:mergeGroupNodes. A phase moves by
        // its header, never by its background — grabbing empty canvas inside a
        // group should pan, the way it does everywhere else on the canvas.
        className="baton-group-handle"
        style={{
          pointerEvents: "auto", cursor: "grab",
          display: "flex", alignItems: "center", gap: 6,
          height: GROUP_PAD_TOP - 10, margin: "5px 8px 0",
          padding: "0 6px", borderRadius: "var(--r-sm)",
          background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
        }}
      >
        {toggleButton}
        {label}
        <Chip color="var(--idle)" icon="layers" title={`${rollup} in this phase`}>{group.count}</Chip>
        {/* Shown expanded too, not only collapsed: the header has to say the
            same thing the collapsed card would, or collapsing a group would
            look like it CHANGED the verdict rather than just folding it up. */}
        <Chip color={health.color} icon={health.icon} title={worstTitle}>{health.label}</Chip>
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeInner);
