// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Timeline and inbox sentences come from local templates only: peers send
   ids and event kinds, never the words shown here (Team Sync §12.6). */
import type { TaskEvent } from "@/types";
import type { TeamCtx } from "./context";

export function eventText(ctx: TeamCtx, e: TaskEvent): string {
  const a = ctx.person(e.actorId)?.name ?? "Someone";
  const t = ctx.person(e.targetId)?.name ?? "someone";
  switch (e.kind) {
    case "created": return `${a} created the task`;
    case "assigned": return `${a} assigned it to ${t}`;
    case "delivered": return `Delivered to ${t}${e.viaDevice ? ` via ${e.viaDevice}` : ""} after they came online`;
    case "acknowledged": return `${a} acknowledged it`;
    case "reminded": return `${a} sent a reminder`;
    case "taken": return `${a}'s agent took the task`;
    case "pushed": return `${a} pushed the branch`;
    case "review.requested": return `${a} asked for review`;
    case "review.decided": return `${a} decided the review`;
    case "reassigned": return `${a} reassigned it to ${t}`;
    case "completed": return `${a} marked it complete`;
    case "conflict": return "Conflicting changes arrived; it needs an owner";
    case "lost-claim": return `${a} lost the claim to ${t}`;
    case "merged": return `${a} merged it`;
    case "resolved": return `${a} resolved the conflict`;
  }
}

export function EventLine({ ctx, e }: { ctx: TeamCtx; e: TaskEvent }) {
  return <>{eventText(ctx, e)}</>;
}
