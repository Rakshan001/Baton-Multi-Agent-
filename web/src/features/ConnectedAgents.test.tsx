// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Connected-agents panel names each session as honestly as Baton knows it,
 * says when this OS can't detect agents at all, and shows its demo rows in demo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedAgentsSection } from "./Activity";
import { BatonAPI } from "../lib/api";
import type { PresenceSession } from "../types";

const demoWas = BatonAPI.demo;
afterEach(() => { cleanup(); vi.restoreAllMocks(); BatonAPI.demo = demoWas; });

const row = (slug: string, agent: string | null, agentSource: PresenceSession["agentSource"]): PresenceSession =>
  ({ slug, agent, root: null, lastSeen: new Date().toISOString(), live: true, agentSource });

describe("ConnectedAgentsSection", () => {
  it("labels strict, inferred and unknown sessions", async () => {
    BatonAPI.demo = false;
    vi.spyOn(BatonAPI, "getSessions").mockResolvedValue([
      row("a", "claude", "env"), row("b", "cursor", "ancestry-inferred"), row("c", null, "none"),
    ]);
    render(<ConnectedAgentsSection />);
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("Cursor (inferred)").getAttribute("data-tip")).toMatch(/approve reviews/);
    expect(screen.getByText("Unknown agent")).toBeTruthy();
    expect(screen.getByText("set BATON_AGENT=<name>")).toBeTruthy();
    expect(screen.queryByText(/Agent detection unavailable/)).toBeNull();
    expect(screen.queryByText("demo")).toBeNull();
  });

  it("says when agent detection is unavailable on this OS", async () => {
    BatonAPI.demo = false;
    vi.spyOn(BatonAPI, "getSessions").mockResolvedValue([row("a", null, "none")]);
    render(<ConnectedAgentsSection agentDetection="unavailable" />);
    expect(await screen.findByText(/Agent detection unavailable on this OS/)).toBeTruthy();
  });

  it("shows three labelled fixture rows in demo mode", async () => {
    BatonAPI.demo = true;
    render(<ConnectedAgentsSection />);
    expect(await screen.findByText("Claude", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Cursor (inferred)")).toBeTruthy();
    expect(screen.getByText("Unknown agent")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
  });
});
