// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** A connected agent's name says how sure Baton is of it (phase 7 §7). */
import { describe, expect, it } from "vitest";
import { presenceLabel } from "./presenceLabel";
import type { PresenceSession } from "../types";

const row = (agent: string | null, agentSource?: PresenceSession["agentSource"]): PresenceSession =>
  ({ slug: "s", agent, root: null, lastSeen: new Date().toISOString(), live: true, agentSource });

describe("presenceLabel", () => {
  it.each(["env", "ancestry", "client", null, undefined] as const)("names a %s-sourced agent plainly", (src) => {
    expect(presenceLabel(row("claude", src))).toEqual({ text: "Claude" });
  });

  it("marks a process-name guess as inferred and says why it matters", () => {
    const l = presenceLabel(row("cursor", "ancestry-inferred"));
    expect(l.text).toBe("Cursor (inferred)");
    expect(l.tip).toMatch(/process name/);
    expect(l.tip).toMatch(/approve reviews/);
  });

  it("gives Cursor no special noun", () => {
    expect(presenceLabel(row("cursor", "client")).text).toBe("Cursor");
  });

  it("calls an unidentified session unknown and says how to fix it", () => {
    const l = presenceLabel(row(null, "none"));
    expect(l.text).toBe("Unknown agent");
    expect(l.hint).toBe("set BATON_AGENT=<name>");
  });

  it("treats a pre-phase-7 row with no agent as unknown", () => {
    expect(presenceLabel(row(null, null)).text).toBe("Unknown agent");
  });

  it("falls back to the raw id for an agent the registry doesn't know", () => {
    expect(presenceLabel(row("zed", "env")).text).toBe("zed");
  });
});
