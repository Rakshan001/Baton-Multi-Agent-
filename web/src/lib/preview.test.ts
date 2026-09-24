// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Demo mode is the showcase. A Diff button that opens onto "No changes on
 * this branch" for a worktree whose card says it holds work teaches that the
 * button is broken, so every demo worktree the panel lets you inspect, and
 * that has work on it, must have a scripted diff behind it.
 */
import { describe, expect, it } from "vitest";
import { getDiff } from "./preview";
import { demoWorktrees } from "./demoWorktrees";
import {
  diffGate, handoffGate, liveGate, mergeGate, pauseGate, takeoverGate,
} from "../components/flow/panel";

describe("demo diffs", () => {
  it("every diffable demo worktree with work has a demo diff", () => {
    const withWork = demoWorktrees()
      .filter((r) => diffGate(r).enabled)
      .filter((r) => (r.filesChanged ?? 0) > 0 || (r.ahead ?? 0) > 0);
    expect(withWork.length).toBeGreaterThan(0);
    for (const r of withWork) {
      expect(getDiff(r.slug).length, r.slug).toBeGreaterThan(0);
    }
  });

  it("a main/external demo row's diff is also scripted — C2's taskless diff must not look empty", () => {
    const rows = demoWorktrees();
    for (const kind of ["main", "external"] as const) {
      const r = rows.find((x) => x.kind === kind)!;
      expect(r, kind).toBeTruthy();
      expect(diffGate(r).enabled, kind).toBe(true);
      expect(getDiff(r.slug).length, r.slug).toBeGreaterThan(0);
    }
  });
});

describe("demo worktrees", () => {
  it("serve unique ids, and a main and an external row with every write/live gate disabled", () => {
    const rows = demoWorktrees();
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    for (const kind of ["main", "external"] as const) {
      const r = rows.find((x) => x.kind === kind)!;
      expect(r, kind).toBeTruthy();
      expect(r.health).toBe("unmanaged");
      const gates = [takeoverGate(r, true), pauseGate(r, true), handoffGate(r, true), liveGate(r),
        mergeGate(r, { integrationHold: null, lanes: [] }, { branch: "main" }, true)];
      expect(gates.every((g) => !g.enabled), kind).toBe(true);
    }
  });
});
