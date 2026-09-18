// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — one worktree, as a node on the flow canvas

   Reads as a card, not a dot: the question this screen answers is
   "which of these has stopped, and what does it still hold" — which
   cannot be asked of a coloured circle.

   Every colour is a `var(...)` token resolved by the browser at paint
   time, so a theme switch needs no JS here at all (see flow/health.ts
   for why that matters and which bug it avoids). Nothing animates: the
   decay ring and the reduced-motion handling belong to wt-flow-nodes,
   and a placeholder animation shipped now would be one more thing for
   that task to unpick.
   ============================================================ */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Icon } from "../Icon";
import { HEALTH_META, STATE_COLOR, quietLabel } from "./health";
import { NODE_H, NODE_W, type WorktreeFlowNode } from "./layout";

/** A chip at the 11px legibility floor — the documented minimum, not a target. */
function Chip({ color, icon, children, title }: {
  color: string; icon?: React.ComponentProps<typeof Icon>["name"]; children: React.ReactNode; title?: string;
}) {
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4, height: 18, padding: "0 6px",
      borderRadius: 999, fontSize: "var(--fs-11)", lineHeight: 1, whiteSpace: "nowrap",
      color, background: `color-mix(in srgb, ${color} 13%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    }}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

function WorktreeNodeInner({ data, selected }: NodeProps<WorktreeFlowNode>) {
  const row = data.row;
  const health = HEALTH_META[row.health] ?? HEALTH_META.unknown;
  const stateColor = row.state ? STATE_COLOR[row.state] : "var(--idle)";

  // The single highest-value fact this screen can state, and the one nothing
  // else in the product surfaces: the record says somebody holds this, and no
  // process is actually there (src/worktrees.ts:96-99).
  const holderGone = row.claimedBy !== null && !row.holderRunning;

  return (
    <div
      style={{
        width: NODE_W, minHeight: NODE_H, boxSizing: "border-box",
        display: "flex", flexDirection: "column", gap: 7,
        padding: "10px 11px", background: "var(--bg-surface)",
        borderRadius: "var(--r-lg)",
        border: `1px solid ${selected ? "var(--accent)" : health.urgent ? health.color : "var(--border-default)"}`,
        // The state lives on the left rail and the health on the chip, so the
        // two questions never fight for the same channel.
        borderLeft: `3px solid ${stateColor}`,
        boxShadow: selected ? "var(--shadow-md)" : "var(--shadow-sm)",
        color: "var(--text-primary)",
      }}
    >
      {/* Connectable={false}: the DAG comes from the plan, and letting somebody
          draw a dependency here would imply the daemon would honour it. */}
      <Handle type="target" position={Position.Left} isConnectable={false}
        style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />
      <Handle type="source" position={Position.Right} isConnectable={false}
        style={{ width: 7, height: 7, background: "var(--border-default)", border: "none" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", fontFamily: "var(--font-mono)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
        }} title={row.slug}>{row.slug}</span>
        <Chip color={health.color} icon={health.icon} title={health.blurb}>{health.label}</Chip>
      </div>

      <div style={{
        fontSize: "var(--fs-11)", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={row.branch ?? row.worktreePath}>
        {row.branch ?? "(no branch)"}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        {row.state && (
          <Chip color={stateColor} title={`Lifecycle state the daemon holds for ${row.slug}`}>{row.state}</Chip>
        )}
        {/* "Quiet for N" is evidence; the health chip above is the reading of
            it. Both are shown so a person can disagree with the reading. */}
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
        {row.unprotected.atRisk && (
          <Chip color="var(--dirty)" icon="alertTriangle"
            title="Uncommitted lines plus commits that exist nowhere but this disk">
            {row.unprotected.lines > 0 ? `${row.unprotected.lines} lines` : ""}
            {row.unprotected.lines > 0 && row.unprotected.commits ? " · " : ""}
            {row.unprotected.commits ? `${row.unprotected.commits} commits` : ""}
            {row.unprotected.lines === 0 && !row.unprotected.commits ? "at risk" : ""}
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
