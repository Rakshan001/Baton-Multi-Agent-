// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The name a connected agent is shown under, honest about how Baton learned it.
 * A guess from a process name says so; an unidentified session is never
 * dressed up as a known agent.
 */
import { getAgent } from "./registry";
import type { AgentId, PresenceSession } from "../types";

export const SET_AGENT_HINT = "set BATON_AGENT=<name>";

export function presenceLabel(s: PresenceSession): { text: string; tip?: string; hint?: string } {
  if (!s.agent || s.agentSource === "none") {
    return { text: "Unknown agent", tip: "Baton couldn't tell which agent this is", hint: SET_AGENT_HINT };
  }
  const name = getAgent(s.agent as AgentId).short;
  if (s.agentSource === "ancestry-inferred") {
    return {
      text: `${name} (inferred)`,
      tip: "Guessed from the process name, so this agent can't approve reviews — set BATON_AGENT to confirm it",
    };
  }
  return { text: name };
}
