// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoll } from "./usePoll";

describe("usePoll identity deps", () => {
  it("drops cached data when deps change so a connection switch cannot show the previous daemon", async () => {
    const { result, rerender } = renderHook(
      ({ id }) => usePoll(async () => id, { interval: 60_000, deps: [id] }),
      { initialProps: { id: "repo-a" } },
    );
    await waitFor(() => expect(result.current.data).toBe("repo-a"));
    rerender({ id: "repo-b" });
    expect(result.current.data).toBe(null);
    await waitFor(() => expect(result.current.data).toBe("repo-b"));
  });

  it("keeps cached data when only the poll interval changes", async () => {
    const { result, rerender } = renderHook(
      ({ interval }) => usePoll(async () => "same", { interval, deps: ["id"] }),
      { initialProps: { interval: 2_000 } },
    );
    await waitFor(() => expect(result.current.data).toBe("same"));
    rerender({ interval: 30_000 });
    expect(result.current.data).toBe("same");
  });
});
