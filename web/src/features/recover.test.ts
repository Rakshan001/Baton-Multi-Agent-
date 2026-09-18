// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   What the Recover screen decides — pinned.

   Every assertion here is about a rule the plan or the daemon states in
   words, so a regression fails the suite instead of waiting to be
   noticed in a browser: the sort (unmerged commits DESCENDING), the
   three places an unknown must not be rendered or ranked as a zero, the
   categories, and which rows may offer a delete button at all.

   Deliberately free of imports from the dirty working tree's shapes
   beyond `WorktreeRow`, which is byte-identical at HEAD.
   ============================================================ */
import { describe, expect, it } from "vitest";
import type { DoctorReport, JunkItem } from "../lib/api";
import type { WorktreeRow } from "../types";
import {
  DISCARD_CLI, buildStrandings, canDiscard, compareUnknownFirst, discardConsequence,
  exposureOf, recoverSteps, recoverTaskDescription, stakesOf, strandingsIn, type Stranding,
} from "./recover";
import { demoDiscardRefusal, demoDoctorReport } from "../lib/demoRecover";

/* ---------- fixtures ---------------------------------------------------- */

function item(o: Partial<JunkItem> & { kind: JunkItem["kind"]; id: string }): JunkItem {
  return { path: null, reason: "because", action: "delete it", blocked: null, bytes: null, ...o };
}

function report(items: JunkItem[]): DoctorReport {
  return {
    items,
    scannedAt: "2026-09-18T00:00:00.000Z",
    counts: {
      "orphan-worktree-task": 0, "orphan-worktree-disk": 0, "orphan-branch": 0,
      "orphan-tmux": 0, "tmp-file": 0, "tmp-upload": 0,
    },
  };
}

function row(o: Partial<WorktreeRow> & { slug: string }): WorktreeRow {
  return {
    branch: `baton/${o.slug}`,
    worktreePath: `/repo/.baton/wt/${o.slug}`,
    state: "queued",
    health: "ok",
    quietForMs: null,
    lastActivityAt: null,
    unprotected: { lines: 0, commits: 0, atRisk: false },
    filesChanged: 0,
    ahead: 0,
    behind: 0,
    repoState: "clean",
    agent: null,
    claimedBy: null,
    holderRunning: false,
    planId: null,
    phase: null,
    dependsOn: [],
    orphan: false,
    wipRef: null,
    ...o,
  };
}

const stranding = (o: Partial<Stranding> & { id: string }): Stranding => ({
  category: "worktree", slug: null, branch: null, path: null, wipRef: null,
  commits: null, lines: null, reason: "", blockedDirty: false, junkKind: null,
  ...o,
});

/* ---------- the sort: unmerged commits descending ----------------------- */

describe("sorting", () => {
  it("ranks a counted row by commits, descending", () => {
    expect(compareUnknownFirst(9, 2)).toBeLessThan(0);
    expect(compareUnknownFirst(2, 9)).toBeGreaterThan(0);
    expect(compareUnknownFirst(4, 4)).toBe(0);
  });

  it("puts an UNCOUNTED row above every counted one — unknown is not zero", () => {
    expect(compareUnknownFirst(null, 400)).toBeLessThan(0);
    expect(compareUnknownFirst(400, null)).toBeGreaterThan(0);
    expect(compareUnknownFirst(null, null)).toBe(0);
    // and specifically not below a zero, which is the sink an unknown must not
    // fall into: a zero is evidence of safety, an unknown is not.
    expect(compareUnknownFirst(null, 0)).toBeLessThan(0);
  });

  it("orders a real section by commits descending within its category", () => {
    const strandings = buildStrandings(
      report([
        item({ kind: "orphan-worktree-task", id: "small", branch: "baton/small" }),
        item({ kind: "orphan-worktree-task", id: "big", branch: "baton/big" }),
        item({ kind: "orphan-worktree-task", id: "uncounted", branch: "baton/uncounted" }),
      ]),
      [
        row({ slug: "small", unprotected: { lines: 0, commits: 2, atRisk: true } }),
        row({ slug: "big", unprotected: { lines: 0, commits: 31, atRisk: true } }),
        // No row for `uncounted` at all: nothing could count it.
      ],
    );
    expect(strandings.map((s) => s.slug)).toEqual(["uncounted", "big", "small"]);
  });
});

/* ---------- reading the daemon's numbers honestly ----------------------- */

describe("counts", () => {
  it("reads an orphan-disk row's SYNTHESIZED zeros as unknown", () => {
    // src/worktrees.ts declines to run `worktreeStatus` per orphan (one spawn
    // each is the fan-out that route must not do) and fills the row with zeros.
    // Believing them would print "nothing at risk" about an unexamined worktree.
    const [s] = buildStrandings(
      report([item({ kind: "orphan-worktree-disk", id: "hotfix", path: "/repo/.baton/wt/hotfix" })]),
      [row({ slug: "hotfix", orphan: true, health: "orphan-disk", state: null })],
    );
    expect(s.commits).toBeNull();
    expect(s.lines).toBeNull();
    expect(exposureOf(s)).toBe("unknown");
  });

  it("reads lines as unknown when git did not answer for the row", () => {
    const [s] = buildStrandings(
      report([item({ kind: "orphan-worktree-task", id: "gone" })]),
      [row({ slug: "gone", health: "missing", filesChanged: null, unprotected: { lines: 0, commits: 4, atRisk: true } })],
    );
    expect(s.commits).toBe(4); // the refs read still worked
    expect(s.lines).toBeNull(); // `unprotected.lines` was 0 by construction
  });

  it("keeps a branch stranding's commits unknown — no route counts them", () => {
    const [s] = buildStrandings(report([item({ kind: "orphan-branch", id: "baton/x", branch: "baton/x" })]), []);
    expect(s.category).toBe("branch");
    expect(s.commits).toBeNull();
  });

  it("survives a daemon with no /api/worktrees, with every count unknown", () => {
    const strandings = buildStrandings(report([item({ kind: "orphan-worktree-task", id: "a" })]), null);
    expect(strandings).toHaveLength(1);
    expect(strandings[0].commits).toBeNull();
  });
});

/* ---------- the three categories --------------------------------------- */

describe("categories", () => {
  const built = buildStrandings(
    report([
      item({ kind: "orphan-worktree-task", id: "stale", branch: "baton/stale" }),
      item({ kind: "orphan-worktree-disk", id: "ondisk", path: "/repo/.baton/wt/ondisk" }),
      item({ kind: "orphan-branch", id: "baton/bare", branch: "baton/bare" }),
      // Hold no work, so they are junk in the original sense and must be dropped.
      item({ kind: "orphan-tmux", id: "ghost" }),
      item({ kind: "tmp-file", id: "tasks.json.1.tmp", path: "/repo/.baton/tasks.json.1.tmp" }),
      item({ kind: "tmp-upload", id: "blob", path: "/repo/.baton/tmp/blob" }),
    ]),
    [row({ slug: "snapped", wipRef: "refs/baton/wip/snapped" })],
  );

  it("lists orphaned worktrees, stranded branches and wip snapshots", () => {
    expect(strandingsIn(built, "worktree").map((s) => s.slug)).toEqual(["ondisk", "stale"]);
    expect(strandingsIn(built, "branch").map((s) => s.branch)).toEqual(["baton/bare"]);
    expect(strandingsIn(built, "snapshot").map((s) => s.wipRef)).toEqual(["refs/baton/wip/snapped"]);
  });

  it("drops tmux sessions and temp files — they hold no work", () => {
    expect(built).toHaveLength(4);
    expect(built.some((s) => s.id.includes("tmp"))).toBe(false);
    expect(built.some((s) => s.id.includes("ghost"))).toBe(false);
  });

  it("carries the wip ref onto the worktree row it belongs to as well", () => {
    const [s] = buildStrandings(
      report([item({ kind: "orphan-worktree-task", id: "gone" })]),
      [row({ slug: "gone", health: "missing", wipRef: "refs/baton/wip/gone" })],
    );
    expect(s.wipRef).toBe("refs/baton/wip/gone");
  });
});

/* ---------- stakes: never reassuring about an unknown ------------------- */

describe("stakes", () => {
  it("says an uncounted row is uncounted rather than printing a zero", () => {
    const text = stakesOf(stranding({ id: "x" }));
    expect(text).toContain("uncounted");
    expect(text).not.toContain("0 ");
  });

  it("names commits and uncommitted lines when both are known", () => {
    expect(stakesOf(stranding({ id: "x", commits: 3, lines: 47 })))
      .toBe("3 commits nowhere else · 47 uncommitted lines");
  });

  it("only says everything is on a remote when both counts are a real zero", () => {
    const safe = stranding({ id: "x", commits: 0, lines: 0 });
    expect(exposureOf(safe)).toBe("pushed");
    expect(stakesOf(safe)).toContain("already on a remote");
  });

  it("calls a snapshot's content unverified — nothing reports its size", () => {
    expect(exposureOf(stranding({ id: "x", category: "snapshot", wipRef: "refs/baton/wip/x" }))).toBe("unknown");
  });

  it("calls unmerged commits exposed", () => {
    expect(exposureOf(stranding({ id: "x", commits: 2, lines: 0 }))).toBe("nowhere-else");
  });
});

/* ---------- the two verbs ---------------------------------------------- */

describe("actions", () => {
  it("offers a per-row delete ONLY for the kind with a per-item route", () => {
    expect(canDiscard(stranding({ id: "a", junkKind: "orphan-worktree-task" }))).toBe(true);
    expect(canDiscard(stranding({ id: "b", junkKind: "orphan-worktree-disk" }))).toBe(false);
    expect(canDiscard(stranding({ id: "c", junkKind: "orphan-branch" }))).toBe(false);
    expect(canDiscard(stranding({ id: "d", category: "snapshot", junkKind: null }))).toBe(false);
    expect(DISCARD_CLI).toBe("baton clean --apply");
  });

  it("names the consequence of a delete, and never softens an unknown", () => {
    expect(discardConsequence(stranding({ id: "a", commits: 5 }))).toContain("5 commits that exist nowhere else");
    expect(discardConsequence(stranding({ id: "a" }))).toContain("an unknown number of commits");
    expect(discardConsequence(stranding({ id: "a", commits: 0 }))).toContain("no unmerged commits");
  });

  it("grafts a branch stranding with a merge, after showing it to the reader", () => {
    const steps = recoverSteps(stranding({ id: "a", branch: "baton/lost" }), "/repo/.baton/wt/rescue");
    expect(steps.map((s) => s.command)).toEqual([
      "git -C /repo/.baton/wt/rescue log --oneline baton/lost",
      "git -C /repo/.baton/wt/rescue merge --no-ff baton/lost",
    ]);
  });

  it("uses the wip-snapshot recipe for a snapshot stranding", () => {
    const steps = recoverSteps(
      stranding({ id: "a", category: "snapshot", wipRef: "refs/baton/wip/lost" }),
      "/repo/.baton/wt/rescue",
    );
    expect(steps[0].command).toBe("git show refs/baton/wip/lost --stat");
    expect(steps[1].command).toBe("git -C /repo/.baton/wt/rescue restore --source refs/baton/wip/lost -- .");
  });

  it("adds the snapshot on top when a worktree stranding has both", () => {
    const steps = recoverSteps(
      stranding({ id: "a", branch: "baton/lost", wipRef: "refs/baton/wip/lost" }),
      "/wt",
    );
    expect(steps).toHaveLength(3);
    expect(steps[2].command).toBe("git -C /wt restore --source refs/baton/wip/lost -- .");
  });

  it("never leaves a rescue with no command at all", () => {
    expect(recoverSteps(stranding({ id: "a" }), "/wt")).toHaveLength(1);
  });

  it("describes the rescue task by the thing it is rescuing", () => {
    expect(recoverTaskDescription(stranding({ id: "a", branch: "baton/lost" })))
      .toBe("Recover stranded work from baton/lost");
  });
});

/* ---------- the demo fixture ------------------------------------------- */

describe("demo mode", () => {
  it("builds all three categories from the demo audit alone", () => {
    const strandings = buildStrandings(demoDoctorReport(), null);
    expect(strandingsIn(strandings, "worktree")).toHaveLength(2);
    expect(strandingsIn(strandings, "branch")).toHaveLength(2);
    // Snapshots come from `/api/worktrees`, so with no rows there are none.
    expect(strandingsIn(strandings, "snapshot")).toHaveLength(0);
  });

  it("drops the demo's temp file and ghost tmux session", () => {
    const strandings = buildStrandings(demoDoctorReport(), null);
    expect(strandings).toHaveLength(4);
  });

  it("stops reporting an item the demo delete removed", () => {
    const after = demoDoctorReport(Date.now(), new Set(["spike-the-oauth-flow"]));
    expect(after.items.some((i) => i.id === "spike-the-oauth-flow")).toBe(false);
    expect(after.counts["orphan-worktree-task"]).toBe(0);
  });

  it("reproduces the daemon's own refusals rather than pretending success", () => {
    const disk = demoDoctorReport().items.find((i) => i.kind === "orphan-worktree-disk")!;
    // No per-item route for this kind at all.
    expect(demoDiscardRefusal(disk)).toContain("baton clean --apply");
    // DirtyWorktreeError's exact format (src/commands/rm.ts:23).
    expect(demoDiscardRefusal(item({ kind: "orphan-worktree-task", id: "x", blocked: "dirty" })))
      .toBe("x has uncommitted changes (dirty)");
    // Nothing to refuse.
    expect(demoDiscardRefusal(item({ kind: "orphan-worktree-task", id: "x" }))).toBeNull();
  });
});
