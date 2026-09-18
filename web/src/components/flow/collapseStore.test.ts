// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Collapse state survives a reload" is half of what makes collapse worth
 * having: a canvas you have to re-tidy on every refresh is one you stop
 * tidying. So the round trip is pinned, and so is the behaviour on a stored
 * value that is not the shape this build expects — localStorage is
 * user-writable, survives upgrades, and is the first place an older Baton's
 * format turns up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collapseStorageKey, readCollapsed, writeCollapsed } from "./collapseStore";

/**
 * This project's jsdom environment ships no Storage implementation (vitest 4
 * leaves `globalThis.localStorage` undefined), and lib/storage.ts's `ls`
 * helper swallows the resulting throw — so without a stub these tests would
 * pass vacuously, asserting that nothing round-trips through nothing. The
 * stub is the smallest thing with Storage's semantics that matter here:
 * string keys, string values, and `null` for absent.
 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

beforeEach(() => localStorage.clear());

describe("collapse state survives a reload", () => {
  it("round-trips a set of group ids", () => {
    writeCollapsed("orbit", new Set(["grp:auth:1", "grp:perf:2"]));
    expect(readCollapsed("orbit")).toEqual(new Set(["grp:auth:1", "grp:perf:2"]));
  });

  it("round-trips the empty set as 'nothing collapsed'", () => {
    writeCollapsed("orbit", new Set(["grp:auth:1"]));
    writeCollapsed("orbit", new Set());
    expect(readCollapsed("orbit")).toEqual(new Set());
  });

  it("stores a stable value for the same set, whatever order it was built in", () => {
    // Sorted on the way out, so a round trip cannot depend on Set insertion
    // order and two identical states cannot look like two different ones.
    writeCollapsed("orbit", new Set(["grp:b:1", "grp:a:1"]));
    const first = localStorage.getItem(collapseStorageKey("orbit"));
    writeCollapsed("orbit", new Set(["grp:a:1", "grp:b:1"]));
    expect(localStorage.getItem(collapseStorageKey("orbit"))).toBe(first);
  });

  it("keeps two projects apart", () => {
    // Group ids are `grp:<planId>:<phase>` and two repos can easily both have
    // a plan called `auth`; one shared key would collapse a phase in a project
    // nobody was looking at.
    writeCollapsed("orbit", new Set(["grp:auth:1"]));
    writeCollapsed("atlas", new Set(["grp:auth:2"]));
    expect(readCollapsed("orbit")).toEqual(new Set(["grp:auth:1"]));
    expect(readCollapsed("atlas")).toEqual(new Set(["grp:auth:2"]));
  });

  it("reads an unknown project as nothing collapsed", () => {
    expect(readCollapsed("never-seen")).toEqual(new Set());
  });

  it("reads a malformed stored value as nothing collapsed rather than throwing", () => {
    // Anything but "everything expanded" here could leave somebody looking at
    // a canvas they cannot see out of, with no idea why.
    for (const junk of ['{"collapsed":true}', '"grp:auth:1"', "17", "null", "not json at all"]) {
      localStorage.setItem(collapseStorageKey("orbit"), junk);
      expect(readCollapsed("orbit")).toEqual(new Set());
    }
  });

  it("keeps only the strings out of a mixed array", () => {
    localStorage.setItem(collapseStorageKey("orbit"), JSON.stringify(["grp:auth:1", 4, null, { a: 1 }]));
    expect(readCollapsed("orbit")).toEqual(new Set(["grp:auth:1"]));
  });
});
