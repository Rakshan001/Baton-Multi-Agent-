// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool sets — named, composable groups of MCP tools, resolved from
 * CONFIGURATION alone.
 *
 * A `tools/list` handshake is a fixed context tax on every agent session
 * (measured and budgeted in test/mcp-wire-budget.test.ts). Not every session
 * needs every tool, so a session should be able to say which group it wants —
 * `core` for coordination, `handoff` for the relay — and pay for that.
 *
 * Two rules this file exists to enforce:
 *
 *   - Resolution is a pure function of its arguments. No filesystem, no clock,
 *     no reading of Baton's own state. A client that caches `tools/list` at
 *     connect and ignores `notifications/tools/list_changed` would never see a
 *     tool that appeared later, so a set that depended on whether a handoff
 *     happens to exist would silently differ per client.
 *   - An unknown name is refused, loudly, naming what IS valid. Resolving a
 *     typo to the empty set presents as a broken Baton rather than as a typo.
 *
 * This is the resolver only — nothing here is wired into `startMcpServer` yet.
 * The wiring carries a compatibility question (what an already-connected client
 * sees when the set changes) that deserves its own review, so it is deliberately
 * a separate change. Until then the server serves every tool, which is exactly
 * what `resolveToolSet(undefined)` returns.
 *
 * Design borrowed from hermes-agent (MIT, Nous Research), `toolsets.py`: named
 * groups that may include one another, resolved to a flat set of tool names.
 * Reimplemented for Baton — no code copied. Attribution per NOTICE.
 */
import { TOOL_HELP } from './mcp-help.js';

/** Marks a member as an include of another GROUP rather than a tool name. */
const GROUP_REF = '@';

/** Every tool the server serves today — and the default when nothing is set. */
export const ALL_TOOLS: readonly string[] = Object.keys(TOOL_HELP);

/** Group name → members: tool names, and `@other` to include another group. */
export type ToolSetDefinitions = Readonly<Record<string, readonly string[]>>;

/**
 * The shipped groups. Two is enough to prove the shape; a taxonomy nobody asked
 * for is a taxonomy somebody has to maintain.
 *
 *   core    — the floor for any session: know the project, remember what was
 *             learned, and do not collide with another agent.
 *   handoff — core plus the relay, because a brief picked up without the
 *             coordination floor is a file drop, not a handoff.
 */
export const TOOL_SETS: ToolSetDefinitions = {
  core: ['orient', 'recall_memory', 'save_memory', 'check_files', 'touch_files', 'report_progress'],
  handoff: ['@core', 'save_progress', 'create_handoff', 'next_handoff', 'resolve_handoff'],
};

/** A name in the configuration that does not exist. Refused, never ignored. */
export class ToolSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSetError';
  }
}

export type ResolvedToolSet = {
  /** Tool names, de-duplicated, in the order the configuration first names them. */
  tools: string[];
  /**
   * Cycles found while expanding, e.g. `core -> handoff -> core`. A cycle is a
   * configuration mistake, but unlike a typo it has a well-defined answer — so
   * it terminates and is reported here rather than thrown or looped on.
   */
  cycles: string[];
};

export type ResolveOptions = {
  /** Group definitions. Defaults to the shipped `TOOL_SETS`. */
  sets?: ToolSetDefinitions;
  /** Every tool the server can serve. Defaults to Baton's own tool list. */
  all?: readonly string[];
};

/**
 * Resolve a configured selection of tool-set names to the tools to serve.
 *
 * `undefined`, `''` or `[]` means "not configured", which resolves to every
 * tool — an unconfigured Baton must behave exactly as it does with no tool sets
 * at all. Anything else must name a group that exists.
 */
export function resolveToolSet(
  selection: string | readonly string[] | undefined,
  options: ResolveOptions = {},
): ResolvedToolSet {
  const sets = options.sets ?? TOOL_SETS;
  const all = options.all ?? ALL_TOOLS;

  const wanted = (typeof selection === 'string' ? [selection] : selection ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  if (wanted.length === 0) return { tools: [...all], cycles: [] };

  const tools: string[] = [];
  const cycles: string[] = [];
  const done = new Set<string>();

  const expand = (group: string, path: string[]): void => {
    if (path.includes(group)) {
      // Terminate and say where, rather than recurse forever.
      cycles.push([...path, group].join(' -> '));
      return;
    }
    if (done.has(group)) return;                       // already flattened, not a cycle
    const members = ownMembers(sets, group);
    if (!members) throw unknownName(group, 'tool set', Object.keys(sets));
    // `ToolSetDefinitions` says these are strings in an array; the CONFIGURATION
    // this resolves is text somebody wrote in a file, which TypeScript never
    // saw. `{"core": "orient"}` is the mistake anyone makes once, and iterating
    // a string resolves it to its LETTERS; `{"core": 5}` and a null member
    // reached `for…of` and `.startsWith` and threw a raw TypeError — the same
    // shape, and the same broken promise, as `resolveToolSet('constructor')`.
    if (!Array.isArray(members)) throw malformedGroup(group, 'a list of tool names');
    done.add(group);
    for (const member of members) {
      if (typeof member !== 'string') throw malformedGroup(group, `every member to be a tool name, found ${member === null ? 'null' : typeof member}`);
      if (member.startsWith(GROUP_REF)) {
        expand(member.slice(GROUP_REF.length), [...path, group]);
        continue;
      }
      // A member that names no tool is the same defect class as an unknown
      // group: silently serving one fewer tool is how a session goes subtly
      // wrong, and there is no reading of a typo that is safe to guess at.
      if (!all.includes(member)) throw unknownName(member, 'tool', all);
      if (!tools.includes(member)) tools.push(member);
    }
  };

  for (const group of wanted) expand(group, []);
  return { tools, cycles };
}

/**
 * A group's members, or null if no such group is DEFINED.
 *
 * The name is caller-supplied text going into object-key position, and a plain
 * `{}` inherits from `Object.prototype` — so `sets['constructor']` finds a
 * function and `sets['toString']` finds another, both truthy and neither a list
 * of members. Left unchecked that is a raw `TypeError` where the contract
 * promises a loud, named refusal, which is the same defect class the rest of
 * this repo guards against (`src/skills/lint.ts`, `src/memory/delegate.ts`).
 * Own properties only, so an inherited key is an ordinary miss and a group
 * genuinely NAMED `constructor` still resolves — it is just a string.
 */
function ownMembers(sets: ToolSetDefinitions, group: string): readonly string[] | null {
  if (!Object.prototype.hasOwnProperty.call(sets, group)) return null;
  return sets[group] ?? null;
}

function unknownName(name: string, kind: string, valid: readonly string[]): ToolSetError {
  const known = valid.length ? valid.join(', ') : '<none defined>';
  return new ToolSetError(`unknown ${kind} '${name}'. Valid: ${known}`);
}

/** A group that exists but is not shaped like one. Named, like a typo is. */
function malformedGroup(group: string, expected: string): ToolSetError {
  return new ToolSetError(`tool set '${group}' is malformed: expected ${expected}`);
}
