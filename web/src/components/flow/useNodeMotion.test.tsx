// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reduced motion is decided in JS, not left to the cascade.
 *
 * styles/base.css:62-74 clamps CSS animation and transition durations, which
 * is real but cannot reach a JS-driven animation, React Flow's own
 * transitions, or the decision not to render a moving thing at all. So the
 * node asks `useNodeMotion()` and branches — and these tests prove the
 * answer actually flips, from BOTH of its two inputs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useNodeMotion } from "./useNodeMotion";

/** A matchMedia whose answer we control, with a working change listener. */
function stubMatchMedia(reduce: boolean) {
  const listeners = new Set<() => void>();
  let matches = reduce;
  Object.defineProperty(window, "matchMedia", {
    writable: true, configurable: true,
    value: (query: string) => ({
      get matches() { return query.includes("prefers-reduced-motion") ? matches : false; },
      media: query,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
      addListener: () => {}, removeListener: () => {}, onchange: null,
      dispatchEvent: () => false,
    }),
  });
  return {
    set(next: boolean) { matches = next; for (const fn of [...listeners]) fn(); },
  };
}

function Probe() {
  return <span data-testid="motion">{useNodeMotion() ? "animate" : "still"}</span>;
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-motion");
  vi.restoreAllMocks();
});

describe("useNodeMotion", () => {
  it("animates when neither the OS nor the app asked otherwise", () => {
    stubMatchMedia(false);
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("motion").textContent).toBe("animate");
  });

  it("suppresses motion from the OS setting alone", () => {
    stubMatchMedia(true);
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("motion").textContent).toBe("still");
  });

  it("suppresses motion from Baton's own preference alone", () => {
    // usePrefs.ts:73 stamps this; there is no media query for it, which is
    // the reason the hook carries a MutationObserver.
    stubMatchMedia(false);
    document.documentElement.dataset.motion = "reduce";
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("motion").textContent).toBe("still");
  });

  it("reacts to the OS setting flipping mid-session", () => {
    const mq = stubMatchMedia(false);
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("motion").textContent).toBe("animate");
    act(() => { mq.set(true); });
    expect(getByTestId("motion").textContent).toBe("still");
  });

  it("reacts to the in-app preference flipping mid-session", async () => {
    stubMatchMedia(false);
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("motion").textContent).toBe("animate");
    // MutationObserver callbacks are a microtask, so let one turn elapse.
    await act(async () => {
      document.documentElement.dataset.motion = "reduce";
      await Promise.resolve();
    });
    expect(getByTestId("motion").textContent).toBe("still");
  });
});
