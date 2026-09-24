// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The diff overlay tells the truth about what it shows: a rename is drawn as
 * `R old → new`, and a diff the daemon cut at its cap says so instead of
 * passing for the whole thing.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffViewer, FILE_STATUS } from "./Diff";
import { BatonAPI } from "../lib/api";
import type { DiffFile } from "../types";

const renamed: DiffFile = { path: "src/moved.ts", oldPath: "src/keep.ts", status: "renamed", hunks: [], add: 0, del: 0, lang: "ts" };

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const open = () => render(<DiffViewer slug="a" onClose={() => {}} onHandoff={() => {}} writeEnabled={false} />);

describe("DiffViewer", () => {
  it("draws a rename as R old → new", async () => {
    vi.spyOn(BatonAPI, "getDiff").mockResolvedValue({ files: [renamed], truncated: false });
    open();
    expect((await screen.findAllByText("src/keep.ts → src/moved.ts")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("R").length).toBeGreaterThan(0);
    expect(screen.queryByText(/too large to show in full/)).toBeNull();
  });

  it("says when the diff was truncated, and marks the count as a floor", async () => {
    vi.spyOn(BatonAPI, "getDiff").mockResolvedValue({ files: [renamed], truncated: true });
    open();
    expect(await screen.findByText(/too large to show in full \(over about 5 MB/)).toBeTruthy();
    expect(screen.getByText("1+ changed files")).toBeTruthy();
  });

  it("explains an empty pane for a file too large to display, without the global banner", async () => {
    const big: DiffFile = { path: "dump.json", status: "added", hunks: [], add: 0, del: 0, lang: "json", tooLarge: true };
    vi.spyOn(BatonAPI, "getDiff").mockResolvedValue({ files: [big], truncated: false });
    open();
    expect(await screen.findByText(/this file is too large/i)).toBeTruthy();
    expect(screen.queryByText(/too large to show in full/)).toBeNull();
    expect(screen.getByText("1 changed file")).toBeTruthy();
  });

  it("defaults kind to 'task' and calls getDiff(slug, 'task')", async () => {
    const getDiff = vi.spyOn(BatonAPI, "getDiff").mockResolvedValue({ files: [], truncated: false });
    render(<DiffViewer slug="orbit~abc" onClose={() => {}} onHandoff={() => {}} writeEnabled={false} />);
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith("orbit~abc", "task"));
  });

  it("passes a non-task kind through to getDiff, for a taskless worktree's diff (C2)", async () => {
    const getDiff = vi.spyOn(BatonAPI, "getDiff").mockResolvedValue({ files: [], truncated: false });
    render(<DiffViewer slug="orbit~abc" kind="main" onClose={() => {}} onHandoff={() => {}} writeEnabled={false} />);
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith("orbit~abc", "main"));
  });

  it("exports FILE_STATUS so other panels reuse the same glyphs", () => {
    expect(FILE_STATUS.added.glyph).toBe("A");
    expect(FILE_STATUS.modified.glyph).toBe("M");
    expect(FILE_STATUS.deleted.glyph).toBe("D");
    expect(FILE_STATUS.renamed.glyph).toBe("R");
  });
});
