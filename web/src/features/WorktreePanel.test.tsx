// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The panel's writes, driven the way a person drives them.
 *
 * 1. A refusal belongs to the worktree it was said about. Selecting another
 *    worktree must not leave "The daemon refused: …" under the new one's name.
 * 2. One Enter is one write. Takeover is a data-loss operation on somebody's
 *    worktree; a second keypress while the first is in flight must not send a
 *    second request.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePanel, type WorktreePanelProps } from "./WorktreePanel";
import { BatonAPI } from "../lib/api";
import type { WorktreeRow } from "../types";

const row = (over: Partial<WorktreeRow> & { slug: string }): WorktreeRow => ({
  kind: over.orphan ? "orphan" : "task",
  branch: `baton/${over.slug}`,
  worktreePath: `/tmp/${over.slug}`,
  state: "active",
  health: "abandoned",
  quietForMs: 0,
  lastActivityAt: null,
  unprotected: { lines: 0, commits: 0, atRisk: false },
  filesChanged: 0, files: [], filesTruncated: false, overlapCount: 0,
  ahead: 0, behind: 0, repoState: "clean",
  agent: null, claimedBy: "cursor", holderRunning: false,
  planId: "p", phase: 1, dependsOn: [], orphan: false, wipRef: null,
  ...over,
});

const props = (r: WorktreeRow): WorktreePanelProps => ({
  row: r, pipeline: null, briefs: null, meta: null, writeEnabled: true,
  onClose: () => {}, onRefresh: () => {}, onOpenDiff: () => {}, onLive: () => {},
  onHandoff: () => {}, headingId: "h",
});

beforeEach(() => {
  // jsdom has no matchMedia; the panel's motion check asks it.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(BatonAPI, "getWorktreeProgress").mockResolvedValue({
    slug: "a", hasLedger: false, plan: [], notes: [], next: null,
    filesEdited: [], stamp: null, flagged: null, updatedAt: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openTakeover = (agent: string) => {
  fireEvent.click(screen.getByRole("button", { name: /Take over/ }));
  const input = screen.getByPlaceholderText("claude");
  fireEvent.change(input, { target: { value: agent } });
  return input;
};

describe("the worktree panel", () => {
  it("does not carry a refusal to the next worktree", async () => {
    vi.spyOn(BatonAPI, "takeoverWorktree").mockRejectedValue(new Error("holder is alive"));
    const view = render(<WorktreePanel {...props(row({ slug: "a" }))} />);
    const input = openTakeover("claude");
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.getByText(/The daemon refused/)).toBeTruthy();

    view.rerender(<WorktreePanel {...props(row({ slug: "b" }))} />);
    expect(screen.queryByText(/The daemon refused/)).toBeNull();
  });

  it("never shows a task's blocker or brief under an orphan that shares its slug", () => {
    const orphan = row({ slug: "a", orphan: true, state: null, claimedBy: null });
    render(<WorktreePanel {...props(orphan)}
      pipeline={{ integrationHold: null, lanes: [{ tasks: [{ slug: "a", blocker: "TASK BLOCKER" }] }] } as never}
      briefs={[{ slug: "a", body: "TASK BRIEF", markdown: "TASK BRIEF" }] as never} />);
    expect(screen.queryByText("TASK BLOCKER")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy prompt/ })).toBeNull();
    // Path already names the directory; a synthetic slug is not copyable.
    expect(screen.queryByText("Slug")).toBeNull();
    expect(screen.queryByText("Directory")).toBeNull();
    expect(screen.getByText("Path")).toBeTruthy();
  });

  it("never polls the progress ledger for an external row, and shows no Slug field", () => {
    const ledger = vi.mocked(BatonAPI.getWorktreeProgress);
    const ext = row({ slug: "cx~0123456789", kind: "external", state: null, health: "unmanaged", claimedBy: null, planId: null, phase: null });
    render(<WorktreePanel {...props(ext)} />);
    expect(ledger).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn.t read the progress ledger/)).toBeNull();
    expect(screen.getByText(/Baton did not create this worktree, so there is no progress ledger/)).toBeTruthy();
    expect(screen.queryByText("Slug")).toBeNull();
    // The heading reads the directory name; the full id stays in its title.
    expect(screen.getByTitle("cx~0123456789").textContent).toBe("cx");
  });

  it("Enter submits takeover once", async () => {
    let finish!: () => void;
    const takeover = vi.spyOn(BatonAPI, "takeoverWorktree")
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorktreePanel {...props(row({ slug: "a" }))} />);
    const input = openTakeover("claude");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(takeover).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it("Enter submits pause once", async () => {
    let finish!: () => void;
    const pause = vi.spyOn(BatonAPI, "pauseWorktree")
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorktreePanel {...props(row({ slug: "a" }))} />);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    const input = screen.getByPlaceholderText("out of context");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pause).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });
});

describe("Changed files", () => {
  it("renders a rename as oldPath → path, and an overlap chip", () => {
    const r = row({
      slug: "a",
      files: [
        { path: "src/app.ts", status: "modified", overlaps: ["other-task"] },
        { path: "src/new-name.ts", status: "renamed", oldPath: "src/old-name.ts" },
      ],
    });
    render(<WorktreePanel {...props(r)} />);
    expect(screen.getByText("src/old-name.ts → src/new-name.ts")).toBeTruthy();
    expect(screen.getByText("also in other-task")).toBeTruthy();
  });

  it("shows a truncation line when filesTruncated", () => {
    const r = row({
      slug: "a",
      files: [{ path: "src/app.ts", status: "modified" }],
      filesTruncated: true,
    });
    render(<WorktreePanel {...props(r)} />);
    expect(screen.getByText(/showing the first 1/)).toBeTruthy();
  });

  it("renders nothing extra when files is null", () => {
    const r = row({ slug: "a", files: null });
    render(<WorktreePanel {...props(r)} />);
    expect(screen.queryByText("No changes.")).toBeNull();
    expect(screen.queryByText(/showing the first/)).toBeNull();
  });

  it("says 'No changes.' for an empty files list", () => {
    const r = row({ slug: "a", files: [] });
    render(<WorktreePanel {...props(r)} />);
    expect(screen.getByText("No changes.")).toBeTruthy();
  });
});
