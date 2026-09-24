// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { connectionForFleetPort, fleetBaseUrl, isLoopbackPortUrl, type Connection } from "./connections";

describe("fleetBaseUrl", () => {
  it("is always loopback plus the port — never a filesystem path", () => {
    expect(fleetBaseUrl(7078)).toBe("http://127.0.0.1:7078");
    expect(fleetBaseUrl(7078)).not.toContain("/Users");
    expect(fleetBaseUrl(7078)).not.toContain("baton-vault");
  });

  it("refuses a non-port so a hostile fleet row cannot mint a URL", () => {
    expect(() => fleetBaseUrl(0)).toThrow(/invalid port/);
    expect(() => fleetBaseUrl(12.5)).toThrow(/invalid port/);
  });

  it("does not treat a filesystem path as a loopback URL", () => {
    expect(isLoopbackPortUrl("/Users/me/baton-vault", 7078)).toBe(false);
    expect(isLoopbackPortUrl("http://evil.example:7078", 7078)).toBe(false);
  });
});

describe("connectionForFleetPort", () => {
  const saved: Connection[] = [
    { id: "default", name: "This daemon", baseUrl: "" },
    { id: "vault", name: "vault", baseUrl: "http://127.0.0.1:7078" },
  ];

  it("reuses a saved connection with the same port", () => {
    expect(connectionForFleetPort(7078, saved)?.id).toBe("vault");
  });

  it("reuses localhost as the same loopback port, not a new URL", () => {
    const local: Connection[] = [
      { id: "default", name: "This daemon", baseUrl: "" },
      { id: "other", name: "other", baseUrl: "http://localhost:7078" },
    ];
    expect(connectionForFleetPort(7078, local)?.id).toBe("other");
  });

  it("maps the self row onto the default (same-origin) connection", () => {
    expect(connectionForFleetPort(7077, saved, { self: true })?.id).toBe("default");
  });

  it("does not invent a default match for some other live daemon", () => {
    expect(connectionForFleetPort(7079, saved)).toBeUndefined();
  });
});
