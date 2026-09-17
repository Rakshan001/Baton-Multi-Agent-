// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Column derivation — the board's one piece of judgment.
 *
 * These exist because of a reported failure: an agent process died holding
 * uncommitted work, and the board filed it under "Idle · No agent attached",
 * beside tasks nobody had started. The user read that as "nothing to do here"
 * and the worktree was later lost.
 *
 * The cause was branch ORDER, not a missing branch — `agent === null` returned
 * `idle` before the dirty check could run. Order is therefore what these tests
 * pin: several of them pass a row that matches two rules at once and assert
 * which one wins.
 */
import { describe, expect, it } from "vitest";
import { deriveColumn, COLUMN_DEFS } from "./derive";
import type { StatusRow } from "../types";

/** A live, healthy session: agent attached, nothing uncommitted, nothing ahead. */
const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  slug: "s",
  task: "t",
  agent: "claude",
  status: "clean",
  ahead: 0,
  behind: 0,
  conflictFiles: [],
  filesChanged: 0,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("work at risk outranks the agent being gone", () => {
  it("files a dead agent holding uncommitted changes under stopped, not idle", () => {
    // The reported bug, verbatim. Before the fix this returned "idle".
    expect(deriveColumn(row({ agent: null, status: "dirty", filesChanged: 12 })))
      .toBe("stopped");
  });

  it("files a dead agent holding unpushed commits under stopped", () => {
    // Clean tree, but three commits that exist nowhere else.
    expect(deriveColumn(row({ agent: null, status: "clean", ahead: 3 })))
      .toBe("stopped");
  });

  it("still calls a genuinely empty session idle", () => {
    // No agent AND nothing to lose — this is the only honest "idle".
    expect(deriveColumn(row({ agent: null }))).toBe("idle");
  });
});

describe("a worktree whose directory is gone is never drawn as healthy", () => {
  it("is stopped even while an agent process still appears attached", () => {
    // `status: 'missing'` had no branch at all and fell through to "active" —
    // a worktree that does not exist rendered as work in progress.
    expect(deriveColumn(row({ agent: "claude", status: "missing" })))
      .toBe("stopped");
  });

  it("is stopped when nobody is attached either", () => {
    expect(deriveColumn(row({ agent: null, status: "missing" }))).toBe("stopped");
  });
});

describe("the columns that already worked keep working", () => {
  it("puts conflicts first, even for a dead agent", () => {
    // Conflict is the more specific answer and stays ahead of stopped: the
    // board already draws it as dangerous, and it names the actual problem.
    expect(deriveColumn(row({ agent: null, status: "conflict", conflictFiles: ["a.ts"] })))
      .toBe("conflict");
  });

  it("is dirty when an agent is attached and working", () => {
    expect(deriveColumn(row({ status: "dirty", filesChanged: 4 }))).toBe("dirty");
  });

  it("is ready when clean with commits ahead", () => {
    expect(deriveColumn(row({ status: "clean", ahead: 2 }))).toBe("ready");
  });

  it("is active when attached, clean and nothing committed yet", () => {
    expect(deriveColumn(row())).toBe("active");
  });
});

describe("COLUMN_DEFS", () => {
  it("defines every column deriveColumn can return", () => {
    const defined = new Set(COLUMN_DEFS.map((c) => c.id));
    const reachable: StatusRow[] = [
      row({ status: "conflict" }),
      row({ agent: null, status: "dirty" }),
      row({ agent: null }),
      row({ status: "dirty" }),
      row({ ahead: 1 }),
      row(),
    ];
    for (const r of reachable) expect(defined.has(deriveColumn(r))).toBe(true);
  });

  it("names the risk rather than the absence", () => {
    // "Idle · No agent attached" described the agent. The column a human needs
    // to act on has to describe what is at stake instead.
    const stopped = COLUMN_DEFS.find((c) => c.id === "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.label.toLowerCase()).not.toContain("idle");
    expect(`${stopped!.label} ${stopped!.hint}`.toLowerCase()).toContain("risk");
  });
});
