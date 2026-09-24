// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   What the worktree detail panel decides — pinned.

   Every assertion here is about a rule the plan states in words, so a
   regression fails the suite instead of waiting to be noticed in a
   browser: the section ORDER, the two (and only two) things Copy prompt
   can resolve to, what the write gates refuse, and the places where
   "unknown" must not be rendered as zero.
   ============================================================ */
import { describe, expect, it } from "vitest";
import {
  MERGE_NO_TASK_TIP, PANEL_SECTION_ORDER, READ_ONLY_TIP, blockerFor, briefFor, handoffGate,
  inspectGate, mergeGate, pauseGate, pickupCommand, planProgress, progressHeadline,
  resolveCopyPrompt, takeoverGate, whoFacts, workInFlightFacts, type PanelBrief,
  type PanelMeta, type PanelPipeline, type WorktreeProgress,
} from "./panel";
import type { WorktreeRow } from "../../types";

/* ---------- fixtures ---------------------------------------------------- */

function row(o: Partial<WorktreeRow> & { slug: string }): WorktreeRow {
  return {
    branch: `baton/${o.slug}`,
    worktreePath: `/repo/.baton/worktrees/${o.slug}`,
    state: "active",
    health: "stalled",
    quietForMs: 60 * 60_000,
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

/* `PanelBrief`, not the full `HandoffBriefEntry`: these are the only fields
   Copy prompt reads, and a fixture spelling out the whole brief would pin a
   shape this module does not use (see the note in panel.ts). */
function brief(o: Partial<PanelBrief> = {}): PanelBrief {
  return {
    slug: "stuck-thing",
    markdown: "---\nbaton: 1\n---\n\nBODY FROM THE DAEMON",
    body: "BODY FROM THE DAEMON",
    ...o,
  };
}

function ledger(o: Partial<WorktreeProgress> = {}): WorktreeProgress {
  return {
    slug: "stuck-thing", hasLedger: true, plan: [], notes: [], next: null,
    filesEdited: [], stamp: null, flagged: null, updatedAt: null, ...o,
  };
}

const pipelineWith = (
  slug: string,
  blocker: string | null,
  integrationHold: number | null = null,
): PanelPipeline => ({
  integrationHold,
  lanes: [
    { tasks: [] },
    { tasks: [{ slug, blocker }] },
  ],
});

/* A pipeline with nothing to say about this slug — the normal case for a task
   the record already calls done, because `blockers()` skips terminal states
   (src/pipeline.ts:283). */
const quietPipeline = (integrationHold: number | null = null): PanelPipeline =>
  ({ integrationHold, lanes: [{ tasks: [] }] });

/** A worktree that satisfies every merge condition, so each test below can
 *  break exactly one of them and nothing else. */
const mergeable = (o: Partial<WorktreeRow> = {}): WorktreeRow => row({
  slug: "design-the-schema", state: "done", health: "ok", repoState: "clean",
  filesChanged: 0, ahead: 3, behind: 0, phase: 1, ...o,
});

const META: PanelMeta = { branch: "main" };

/* ---------- 1. the order IS the spec ----------------------------------- */

describe("panel order", () => {
  it("is diagnosis-first: the verdict leads and identity comes second-to-last", () => {
    // The plan is explicit about this order, and it is the whole reason the
    // panel is not a conventional detail pane. Any reshuffle fails here.
    expect([...PANEL_SECTION_ORDER]).toEqual([
      "verdict", "why", "who", "work", "progress", "identity", "actions",
    ]);
  });

  it("puts identity AFTER the diagnosis, not at the top", () => {
    const order = [...PANEL_SECTION_ORDER];
    expect(order.indexOf("identity")).toBeGreaterThan(order.indexOf("verdict"));
    expect(order.indexOf("identity")).toBeGreaterThan(order.indexOf("why"));
    expect(order.indexOf("identity")).toBeGreaterThan(order.indexOf("progress"));
    expect(order.indexOf("actions")).toBe(order.length - 1);
  });

  it("has no duplicates — every section renders exactly once", () => {
    expect(new Set(PANEL_SECTION_ORDER).size).toBe(PANEL_SECTION_ORDER.length);
  });
});

/* ---------- 2. why: the refusal is passed through, never reworded ------ */

describe("blockerFor", () => {
  it("returns the pipeline's sentence byte for byte", () => {
    const said = "phase 3 locked behind phase 2";
    expect(blockerFor(pipelineWith("stuck-thing", said), "stuck-thing")).toBe(said);
  });

  it("returns null for a slug the pipeline has no task for", () => {
    // An orphan worktree has no pipeline task, and inventing "nothing is
    // blocking this" for it would be an answer the daemon never gave.
    expect(blockerFor(pipelineWith("other", "blocked"), "stuck-thing")).toBeNull();
  });

  it("distinguishes 'no pipeline yet' from 'nothing blocking'", () => {
    expect(blockerFor(null, "stuck-thing")).toBeNull();
    expect(blockerFor(pipelineWith("stuck-thing", null), "stuck-thing")).toBeNull();
  });
});

/* ---------- 3. who: the holder and the process are two questions ------- */

describe("whoFacts", () => {
  it("names the dead holder rather than reporting nobody", () => {
    const f = whoFacts(row({ slug: "s", claimedBy: "cursor", agent: null, holderRunning: false }));
    expect(f.badge).toBe("cursor");
    expect(f.running).toBe(false);
    expect(f.line).toContain("no process is running");
  });

  it("reports a live process", () => {
    const f = whoFacts(row({ slug: "s", claimedBy: "claude", agent: "claude", holderRunning: true }));
    expect(f).toMatchObject({ badge: "claude", running: true });
  });

  it("says nobody holds it when nobody does", () => {
    const f = whoFacts(row({ slug: "s" }));
    expect(f.badge).toBeNull();
    expect(f.running).toBe(false);
  });
});

/* ---------- 4. work in flight: unknown is not zero -------------------- */

describe("workInFlightFacts", () => {
  it("renders a null counter as 'unknown', never 0", () => {
    // "git did not answer" and "nothing changed" are opposite facts about
    // whether the work here is safe; collapsing them loses the whole point.
    const facts = workInFlightFacts(row({ slug: "s", ahead: null, behind: null, filesChanged: null }));
    for (const key of ["ahead", "behind", "files"]) {
      expect(facts.find((f) => f.key === key)?.value).toBe("unknown");
    }
  });

  it("adds the at-risk accounting only when the daemon says at risk", () => {
    expect(workInFlightFacts(row({ slug: "s" })).some((f) => f.key === "atRisk")).toBe(false);
    const risky = workInFlightFacts(row({
      slug: "s", unprotected: { lines: 47, commits: 1, atRisk: true },
    }));
    const fact = risky.find((f) => f.key === "atRisk");
    expect(fact?.value).toBe("47 lines · 1 commits");
    expect(fact?.urgent).toBe(true);
  });

  it("surfaces a half-finished git operation", () => {
    const facts = workInFlightFacts(row({ slug: "s", repoState: "rebasing" }));
    expect(facts.find((f) => f.key === "repoState")?.value).toBe("rebasing");
  });

  it("says nothing about a repo state of 'clean'", () => {
    expect(workInFlightFacts(row({ slug: "s", repoState: "clean" })).some((f) => f.key === "repoState")).toBe(false);
  });
});

/* ---------- 5. the ledger: 'said nothing' is a real answer ------------- */

describe("progress section", () => {
  it("has its own sentence for a worktree that never checkpointed", () => {
    const line = progressHeadline(ledger({ hasLedger: false }));
    expect(line).toContain("never checkpointed");
  });

  it("counts completed plan items", () => {
    const view = ledger({
      plan: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "in_progress" },
      ],
      notes: ["one"],
    });
    expect(planProgress(view)).toEqual({ done: 2, total: 3 });
    expect(progressHeadline(view)).toBe("2 of 3 planned items done · 1 note");
  });

  it("does not claim a plan that is not there", () => {
    expect(progressHeadline(ledger({ notes: [] }))).toBe("no plan recorded · 0 notes");
  });
});

/* ---------- 6. Copy prompt: exactly two answers ----------------------- */

describe("resolveCopyPrompt", () => {
  const r = row({ slug: "stuck-thing" });

  it("copies the daemon-built brief body verbatim when a brief is open", () => {
    const out = resolveCopyPrompt(r, brief(), false);
    expect(out.kind).toBe("brief");
    expect(out.text).toBe("BODY FROM THE DAEMON");
  });

  it("falls back to the whole brief file rather than an empty clipboard", () => {
    const out = resolveCopyPrompt(r, brief({ body: "   " }), true);
    expect(out.kind).toBe("brief");
    expect(out.text).toContain("BODY FROM THE DAEMON");
  });

  it("copies the pickup command — not a fabricated brief — when read-only with no brief", () => {
    const out = resolveCopyPrompt(r, null, false);
    expect(out.kind).toBe("pickup");
    expect(out.text).toBe("cd /repo/.baton/worktrees/stuck-thing && baton take stuck-thing");
  });

  it("still copies the pickup command when writable with no brief", () => {
    // There is no third branch. A writable daemon can WRITE a brief (Hand
    // off), but nothing may assemble prompt text in the browser, so the
    // clipboard gets the command and the tip points at Hand off.
    const out = resolveCopyPrompt(r, null, true);
    expect(out.kind).toBe("pickup");
    expect(out.text).toBe(pickupCommand(r));
    expect(out.tip).toContain("Hand off");
  });

  it("an orphan copies an inspect command, not a take", () => {
    // No task owns it, so `baton take <basename>` fails. Looking is what helps.
    const orphan = row({ slug: "hotfix", orphan: true, state: null, worktreePath: "/repo/My Work/hotfix" });
    const out = resolveCopyPrompt(orphan, null, true);
    expect(out.text).toBe("cd '/repo/My Work/hotfix' && git status");
    expect(out.text).not.toContain("baton take");
    expect(out.label).toBe("Copy inspect command");
  });

  it("never copies a task's brief for an orphan that shares its basename", () => {
    // A queued task with no worktree is not in `rows`, so nothing renames the
    // orphan: the brief keyed on that slug is somebody else's.
    const orphan = row({ slug: "stuck-thing", orphan: true, state: null });
    const out = resolveCopyPrompt(orphan, brief(), true);
    expect(out.kind).toBe("inspect");
    expect(out.text).not.toContain("BODY FROM THE DAEMON");
  });

  it("says clean --fix deletes the orphan's branch and the other junk it listed", () => {
    const tip = inspectGate(row({ slug: "h", orphan: true, state: null })).tip!;
    expect(tip).toContain("deletes its branch");
    expect(tip).toContain("any other junk the dry run listed");
  });

  it("quotes a path with spaces", () => {
    const spaced = row({ slug: "stuck-thing", worktreePath: "/Users/me/My Repo/it's here" });
    expect(pickupCommand(spaced)).toBe("cd '/Users/me/My Repo/it'\\''s here' && baton take stuck-thing");
  });

  it("adds --resume for a stalled holder", () => {
    // `baton take` refuses a task somebody else holds unless told to resume
    // it (src/commands/take.ts), so the copied command would just fail.
    expect(pickupCommand(row({ slug: "a", claimedBy: "cursor", state: "active" }))).toMatch(/ --resume$/);
    expect(pickupCommand(row({ slug: "a", claimedBy: "cursor", state: "claimed" }))).toMatch(/ --resume$/);
    expect(pickupCommand(row({ slug: "a", claimedBy: null, state: "active" }))).not.toContain("--resume");
    expect(pickupCommand(row({ slug: "a", claimedBy: "cursor", state: "queued" }))).not.toContain("--resume");
  });

  it("never resolves to text neither the daemon nor the CLI produced", () => {
    const daemonBody = "BODY FROM THE DAEMON";
    const cases = [
      resolveCopyPrompt(r, brief(), true),
      resolveCopyPrompt(r, brief(), false),
      resolveCopyPrompt(r, null, true),
      resolveCopyPrompt(r, null, false),
    ];
    for (const c of cases) {
      expect([daemonBody, pickupCommand(r)]).toContain(c.text);
    }
  });
});

describe("briefFor", () => {
  it("matches on slug and tolerates no briefs at all", () => {
    expect(briefFor(null, "stuck-thing")).toBeNull();
    expect(briefFor([], "stuck-thing")).toBeNull();
    expect(briefFor([brief({ slug: "other" })], "stuck-thing")).toBeNull();
    expect(briefFor([brief()], "stuck-thing")?.slug).toBe("stuck-thing");
  });
});

/* ---------- 7. the gates -------------------------------------------- */

describe("write gates", () => {
  const stalled = row({ slug: "s", state: "active", claimedBy: "cursor" });

  it("refuse every write on a read-only daemon, with the tooltip this app already uses", () => {
    for (const gate of [takeoverGate, pauseGate, handoffGate]) {
      expect(gate(stalled, false)).toEqual({ enabled: false, tip: READ_ONLY_TIP });
    }
  });

  it("allow the write when the daemon accepts writes", () => {
    for (const gate of [takeoverGate, pauseGate, handoffGate]) {
      expect(gate(stalled, true).enabled).toBe(true);
    }
  });

  it("refuse a worktree no task owns — there is no claim to move", () => {
    const orphan = row({ slug: "hotfix", orphan: true, state: null });
    expect(takeoverGate(orphan, true).enabled).toBe(false);
    expect(pauseGate(orphan, true).tip).toContain("baton clean");
  });

  it("never suggests a command that does not exist", () => {
    // There is no `baton adopt`. An orphan is inspected, kept by committing or
    // pushing, and then removed by `baton clean --fix`.
    const orphan = row({ slug: "hotfix", orphan: true, state: null });
    const tips = [
      takeoverGate(orphan, true).tip, pauseGate(orphan, true).tip, handoffGate(orphan, true).tip,
      inspectGate(orphan).tip, mergeGate(orphan, quietPipeline(), META, true).tip, MERGE_NO_TASK_TIP,
    ];
    for (const tip of tips) {
      expect(tip).not.toContain("baton adopt");
      expect(tip).toContain("baton clean");
      expect(tip).toContain("--fix");
    }
  });

  it("do NOT re-implement the stall barrier — a live holder is still offered", () => {
    // The daemon owns that refusal (src/lifecycle.ts:169) and answers it with
    // its own sentence as a 409. A second copy of the rule in the browser
    // would disagree with the first exactly when it mattered.
    const working = row({ slug: "s", state: "active", agent: "claude", holderRunning: true, health: "working" });
    expect(takeoverGate(working, true).enabled).toBe(true);
  });
});

describe("inspectGate", () => {
  it("does not gate reads on --write", () => {
    // GET /api/worktrees is deliberately not write-gated: somebody looking for
    // work that has gone quiet must be able to see it from a daemon that
    // cannot touch anything. Gating the inspection would lock the panel away
    // from exactly the person it was built for.
    expect(inspectGate(row({ slug: "s" })).enabled).toBe(true);
  });

  it("refuses when there is genuinely nothing left to read", () => {
    expect(inspectGate(row({ slug: "s", health: "missing" })).enabled).toBe(false);
    expect(inspectGate(row({ slug: "s", orphan: true, state: null })).enabled).toBe(false);
  });
});


/* ---------- 8. Merge, the one action that can land work -------------- */

describe("mergeGate — the target branch", () => {
  it("NAMES the branch the daemon reports, and never assumes main", () => {
    // The whole point of the task: `baton merge` lands on
    // currentBranch(gitRepo) (src/commands/merge.ts:104), so the button has to
    // carry whatever /api/meta said — here a release branch, not "main".
    const g = mergeGate(mergeable(), quietPipeline(), { branch: "release/24.4" }, true);
    expect(g.enabled).toBe(true);
    expect(g.target).toBe("release/24.4");
    expect(g.commits).toBe(3);
  });

  it("refuses when meta has not arrived — there is no target to name", () => {
    const g = mergeGate(mergeable(), quietPipeline(), null, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
    // And it must not have silently fallen back to a branch name.
    expect(g.tip).not.toContain("main");
  });

  it("refuses when the daemon reports no branch at all", () => {
    const g = mergeGate(mergeable(), quietPipeline(), { branch: null }, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
  });

  it("refuses in a hub, where the branch it would land on is not the one meta reports", () => {
    // In a hub the merge runs in `task.repoRoot`, not the hub root
    // (src/commands/merge.ts:100), so /api/meta's branch is the wrong answer
    // even when it is a string.
    const g = mergeGate(mergeable(), quietPipeline(), { branch: "main", hub: true }, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
    expect(g.tip).toContain("baton merge design-the-schema");
  });
});

describe("mergeGate — when it is offered at all", () => {
  it("is offered only for work the task record calls done", () => {
    for (const state of ["queued", "claimed", "active", "paused", "blocked", "review"] as const) {
      expect(mergeGate(mergeable({ state }), quietPipeline(), META, true).enabled).toBe(false);
    }
    expect(mergeGate(mergeable({ state: "done" }), quietPipeline(), META, true).enabled).toBe(true);
  });

  it("says WHY a task in review is not mergeable — no approval reaches this screen", () => {
    // `reviewedBy.verdict` (src/pipeline.ts:80) is not carried into LaneTask or
    // WorktreeRow, so "approved" is a fact nothing served here can evidence.
    // The refusal has to say that rather than imply the review failed.
    const g = mergeGate(mergeable({ state: "review" }), quietPipeline(), META, true);
    expect(g.enabled).toBe(false);
    expect(g.tip).toContain("review verdict");
  });

  it("refuses a worktree no task owns", () => {
    const g = mergeGate(mergeable({ orphan: true, state: null }), quietPipeline(), META, true);
    expect(g).toEqual({ enabled: false, tip: MERGE_NO_TASK_TIP, refused: false });
  });

  it("is write-gated with the tooltip this app already uses", () => {
    expect(mergeGate(mergeable(), quietPipeline(), META, false))
      .toEqual({ enabled: false, tip: READ_ONLY_TIP, refused: false });
  });
});

describe("mergeGate — clean and conflict-free", () => {
  it("refuses uncommitted work, because a merge would leave it behind", () => {
    const g = mergeGate(mergeable({ filesChanged: 4 }), quietPipeline(), META, true);
    expect(g.enabled).toBe(false);
    expect(g.tip).toContain("4 uncommitted files");
  });

  it("refuses unresolved conflicts out loud", () => {
    const g = mergeGate(mergeable({ health: "conflict" }), quietPipeline(), META, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
  });

  it("refuses a half-finished git operation, naming it", () => {
    const g = mergeGate(mergeable({ repoState: "rebasing", health: "rebasing" }), quietPipeline(), META, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
    expect(g.tip).toContain("rebasing");
  });

  it("refuses a worktree whose directory is gone", () => {
    expect(mergeGate(mergeable({ health: "missing" }), quietPipeline(), META, true).enabled).toBe(false);
  });

  it("offers a done branch with nothing ahead, and reports the count honestly as 0", () => {
    // Zero is a real answer, not a reason to hide the button: the confirmation
    // says the merge would land nothing, which is the truth.
    const g = mergeGate(mergeable({ ahead: 0 }), quietPipeline(), META, true);
    expect(g.enabled).toBe(true);
    expect(g.commits).toBe(0);
  });

  it("carries `behind` through, so the confirmation can warn it may halt", () => {
    const g = mergeGate(mergeable({ behind: 5 }), quietPipeline(), META, true);
    expect(g.enabled).toBe(true);
    expect(g.behind).toBe(5);
  });
});

describe("mergeGate — absence of evidence is not evidence of safety", () => {
  // Every nullable git fact on the row. Not one of them may read as "clean".
  it("treats every unknown as a reason NOT to offer the merge", () => {
    const unknowns: Array<Partial<WorktreeRow>> = [
      { repoState: null },
      { filesChanged: null },
      { ahead: null },
      { behind: null },
      { health: "unknown" },
      { branch: null },
    ];
    for (const u of unknowns) {
      const g = mergeGate(mergeable(u), quietPipeline(), META, true);
      expect(g.enabled, `unknown ${JSON.stringify(u)} must not be mergeable`).toBe(false);
      expect(g.tip).toBeTruthy();
    }
  });

  it("does not offer a merge while the pipeline is still being read", () => {
    // An unanswered phase barrier is not a cleared one.
    expect(mergeGate(mergeable(), null, META, true).enabled).toBe(false);
  });
});

describe("mergeGate — the phase barrier REFUSES", () => {
  it("refuses a phase above the hold, naming both phases and the command", () => {
    // integrationHold exists to stop exactly this: phase 1's branches are
    // finished but have never been combined, so landing phase 3 on top of a
    // base that is missing phase 1 surfaces later as a conflict nobody can
    // attribute (src/pipeline.ts:136-152).
    const g = mergeGate(mergeable({ phase: 3 }), quietPipeline(1), META, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
    expect(g.tip).toContain("phase 1");
    expect(g.tip).toContain("baton integrate");
  });

  it("still offers a branch OF the held phase — merging it is what clears the hold", () => {
    const g = mergeGate(mergeable({ phase: 1 }), quietPipeline(1), META, true);
    expect(g.enabled).toBe(true);
  });

  it("refuses when the hold is on and the worktree records no phase", () => {
    // Nothing here can place it either side of the barrier, so it is not
    // placed on the safe side by default.
    const g = mergeGate(mergeable({ phase: null }), quietPipeline(2), META, true);
    expect(g.enabled).toBe(false);
    expect(g.refused).toBe(true);
  });

  it("renders the pipeline's own sentence VERBATIM when it has one", () => {
    // Normally a done task carries no blocker (blockers() skips terminal
    // states), but if the daemon ever issues one for this slug it is passed
    // through untouched rather than reworded — the rule the whole panel keeps.
    const said = "phase 3 locked — phase 1 is finished but not integrated (baton integrate)";
    const g = mergeGate(mergeable({ phase: 3 }), pipelineWith("design-the-schema", said, 1), META, true);
    expect(g.enabled).toBe(false);
    expect(g.tip).toBe(said);
    expect(g.refused).toBe(true);
  });
});
