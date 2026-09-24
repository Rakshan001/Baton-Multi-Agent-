// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Activity spend card headlines the tokens actually consumed (cache reads
 * apart), says "partial" when some spend has no price, and a task row shows
 * its NEWEST session.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { costLine, headlineValue, newestBySlug, tokenHeadline } from "./Activity";
import type { SessionUsage, UsageTotals } from "../types";

afterEach(cleanup);

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  sessions: 2, turns: 5, inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 5,
  totalTokens: 1035, consumedTokens: 35, estCostUsd: 1.5, unpricedSessions: 0, ...over,
});

describe("tokenHeadline", () => {
  it("headlines consumed tokens when the daemon reports them", () => {
    expect(tokenHeadline(totals())).toEqual({ label: "Tokens used", n: 35 });
  });

  it("falls back to the old total for a daemon older than consumedTokens", () => {
    const old = totals();
    delete old.consumedTokens;
    expect(tokenHeadline(old)).toEqual({ label: "Tokens counted", n: 1035 });
  });

  it("renders a null headline as not counted, never as a digit or a dash", () => {
    const { n } = tokenHeadline(totals({ consumedTokens: null, totalTokens: null }));
    render(<div data-testid="v">{headlineValue(n)}</div>);
    const v = screen.getByTestId("v").textContent ?? "";
    expect(v).toBe("not counted");
  });
});

describe("costLine", () => {
  it("labels the price source and the date the daemon sent", () => {
    expect(costLine(totals(), "2026-01-02")).toBe("≈ $1.50 at API list prices (2026-01-02)");
  });

  it("omits the date for an older daemon that does not send one", () => {
    expect(costLine(totals())).toBe("≈ $1.50 at API list prices");
  });

  it("says partial when some sessions have no price", () => {
    expect(costLine(totals({ unpricedSessions: 2 }))).toContain("partial");
  });

  it("says there is no priced model rather than printing $0.00", () => {
    expect(costLine(totals({ estCostUsd: null, unpricedSessions: 1 }))).toBe("no priced model");
  });
});

describe("newestBySlug", () => {
  it("keeps the first (newest) session per slug from a newest-first list", () => {
    const s = (sessionId: string, slug: string | null) => ({ sessionId, slug }) as SessionUsage;
    const m = newestBySlug([s("new", "a"), s("root", null), s("old", "a"), s("b1", "b")]);
    expect(m.get("a")?.sessionId).toBe("new");
    expect(m.get("b")?.sessionId).toBe("b1");
    expect(m.size).toBe(2);
  });
});
