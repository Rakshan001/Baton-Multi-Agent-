// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-by-one MCP wiring for each agent CLI: detect whether an agent's MCP
 * config already points at Baton, and (on request) write it.
 *
 * Scope rules (decided with the user): project-level config files live inside
 * the repo and are safe to write automatically; global files in $HOME are
 * only written after an explicit confirm (the caller passes confirmGlobal).
 *
 * Supported wiring:
 *   claude      → <repo>/.mcp.json                 (project, JSON)
 *   cursor      → <repo>/.cursor/mcp.json          (project, JSON)
 *   antigravity → <repo>/.agents/mcp_config.json   (project, JSON)
 *   gemini      → ~/.gemini/settings.json          (global,  JSON)
 *   codex       → ~/.codex/config.toml             (global,  TOML)
 *   aider, opencode → no standard MCP config  (unsupported — surfaced as such)
 *
 * Writes are non-destructive: JSON files keep every existing key and merge our
 * servers into `mcpServers`; the TOML file only gets server blocks it lacks.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KbState } from '../kb/state.js';
import { mcpServers, mcpServersAntigravity, mcpServersCodex, mcpServersGemini, type McpOpts, type McpServerDef } from '../kb/mcp.js';
import { escapeRegExp } from '../util/regex.js';

export type McpScope = 'project' | 'global';

export interface AgentMcpTarget {
  agent: string;
  scope: McpScope;
  format: 'json' | 'toml';
  path: string;
}

export interface McpStatus {
  agent: string;
  /** false for agents with no MCP config Baton knows how to write (aider, opencode). */
  supported: boolean;
  scope: McpScope | null;
  path: string | null;
  /** config file present on disk */
  exists: boolean;
  /** the `baton` coordination server is already wired in that file */
  connected: boolean;
}

export interface ConnectResult {
  agent: string;
  scope: McpScope;
  path: string;
  /** true → file written; false → global write needs confirmation (see preview) */
  wrote: boolean;
  needsConfirm: boolean;
  /** server names that are now (or would be) wired */
  servers: string[];
  /** full proposed file content when needsConfirm (so the UI can show it) */
  preview?: string;
}

export class McpUnsupportedError extends Error {
  constructor(agent: string) {
    super(`'${agent}' has no MCP config Baton can wire automatically`);
    this.name = 'McpUnsupportedError';
  }
}

/** The existing config file is present but unparseable — we refuse to overwrite it. */
export class McpConfigParseError extends Error {
  constructor(path: string) {
    super(`${path} exists but isn't valid JSON — fix it by hand first, then connect (Baton won't overwrite a file it can't parse)`);
    this.name = 'McpConfigParseError';
  }
}

/** Where an agent's MCP config lives, or null if Baton can't wire it. */
export function mcpTargetFor(agent: string, root: string, home = homedir()): AgentMcpTarget | null {
  switch (agent) {
    case 'claude':
      return { agent, scope: 'project', format: 'json', path: join(root, '.mcp.json') };
    case 'cursor':
      return { agent, scope: 'project', format: 'json', path: join(root, '.cursor', 'mcp.json') };
    // Antigravity reads a project file at .agents/mcp_config.json and a global
    // one at ~/.gemini/config/mcp_config.json. Project-scoped is the safe half
    // (inside the repo, no confirm needed) and is what the IDE prefers.
    case 'antigravity':
      return { agent, scope: 'project', format: 'json', path: join(root, '.agents', 'mcp_config.json') };
    case 'gemini':
      return { agent, scope: 'global', format: 'json', path: join(home, '.gemini', 'settings.json') };
    case 'codex':
      return { agent, scope: 'global', format: 'toml', path: join(home, '.codex', 'config.toml') };
    default:
      return null; // aider, opencode — no standard MCP config file to write
  }
}

/** The servers Baton wires: graphify graphs (when the KB exists) + the coordination server. */
export function serversForState(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServers(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Gemini variant of serversForState: graphify entries use httpUrl form. */
export function serversForStateGemini(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersGemini(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Codex variant: graphify entries use `baton mcp-bridge <url>` (command+args only). */
export function serversForStateCodex(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersCodex(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Antigravity variant: bridged graphify entries — see mcpServersAntigravity for why. */
export function serversForStateAntigravity(state: KbState | null, opts?: McpOpts): Record<string, McpServerDef> {
  if (state && !opts) throw new Error('mcpOpts required when a KB exists');
  if (state && opts) return mcpServersAntigravity(state, opts);
  return { baton: { command: 'baton', args: ['mcp'] } };
}

/** Agents whose graphify entries need a non-default shape; everything else
 *  gets serversForState (the `{type:'http', url}` form Claude/Cursor take). */
const SERVERS_FOR_AGENT: Record<string, (s: KbState | null, o?: McpOpts) => Record<string, McpServerDef>> = {
  gemini: serversForStateGemini,
  codex: serversForStateCodex,
  antigravity: serversForStateAntigravity,
};

/* ------------------------------------------------------------------ */
/* Pure render/merge helpers (unit-tested)                             */
/* ------------------------------------------------------------------ */

/** Matches a TOML `[mcp_servers.<name>]` table in either quoted or bare-key form. */
function tomlTableRe(name: string): RegExp {
  const q = escapeRegExp(name);
  return new RegExp(`\\[mcp_servers\\.(?:"${q}"|${q})\\]`);
}

/** TOML basic-string with `"` and `\` escaped (raw concatenation would emit invalid TOML). */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Does this config text already wire the `baton` server? */
export function isConnected(format: 'json' | 'toml', text: string): boolean {
  if (format === 'toml') return tomlTableRe('baton').test(text);
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return !!parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'baton');
  } catch {
    return false;
  }
}

/**
 * Merge our servers into an existing JSON config string, preserving all other
 * keys. Throws McpConfigParseError if the file is non-empty but unparseable —
 * the caller must NOT overwrite a config it can't understand (data loss).
 */
export function mergeJsonConfig(existing: string, servers: Record<string, McpServerDef>, path = 'the config file'): string {
  let obj: Record<string, unknown> = {};
  if (existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new McpConfigParseError(path);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    else throw new McpConfigParseError(path); // a JSON array/scalar is not a config object — refuse rather than clobber
  }
  const prior = (obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : {}) as Record<string, unknown>;
  obj.mcpServers = { ...prior, ...servers };
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Append any missing `[mcp_servers."name"]` blocks to a TOML config string.
 * Recognises both quoted and bare-key existing tables (so we never duplicate a
 * server the user wired as `[mcp_servers.baton]`), and escapes all values.
 */
export function mergeTomlConfig(existing: string, servers: Record<string, McpServerDef>): string {
  const blocks: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (tomlTableRe(name).test(existing)) continue;
    let block: string[];
    if ('httpUrl' in def) {
      block = [`[mcp_servers.${tomlStr(name)}]`, `httpUrl = ${tomlStr(def.httpUrl)}`, ''];
    } else if ('url' in def) {
      block = [`[mcp_servers.${tomlStr(name)}]`, `url = ${tomlStr(def.url)}`, ''];
    } else {
      block = [`[mcp_servers.${tomlStr(name)}]`, `command = ${tomlStr(def.command)}`,
               `args = [${def.args.map(tomlStr).join(', ')}]`, ''];
    }
    blocks.push(...block);
  }
  if (!blocks.length) return existing.endsWith('\n') || !existing ? existing : existing + '\n';
  const base = existing.trim() ? existing.replace(/\n*$/, '\n\n') : '';
  return base + blocks.join('\n').trimEnd() + '\n';
}

/* ------------------------------------------------------------------ */
/* Status + write                                                      */
/* ------------------------------------------------------------------ */

export async function readMcpStatus(agent: string, root: string, home = homedir()): Promise<McpStatus> {
  const target = mcpTargetFor(agent, root, home);
  if (!target) return { agent, supported: false, scope: null, path: null, exists: false, connected: false };
  const exists = existsSync(target.path);
  let connected = false;
  if (exists) {
    try {
      connected = isConnected(target.format, await readFile(target.path, 'utf-8'));
    } catch {
      connected = false;
    }
  }
  return { agent, supported: true, scope: target.scope, path: target.path, exists, connected };
}

export async function connectAgentMcp(
  agent: string,
  root: string,
  state: KbState | null,
  opts: { confirmGlobal?: boolean; mcpOpts?: McpOpts } = {},
  home = homedir(),
): Promise<ConnectResult> {
  const target = mcpTargetFor(agent, root, home);
  if (!target) throw new McpUnsupportedError(agent);
  const servers = SERVERS_FOR_AGENT[agent] ? SERVERS_FOR_AGENT[agent](state, opts.mcpOpts) : serversForState(state, opts.mcpOpts);
  const serverNames = Object.keys(servers);

  const existing = existsSync(target.path) ? await readFile(target.path, 'utf-8') : '';
  const next = target.format === 'json'
    ? mergeJsonConfig(existing, servers, target.path)
    : mergeTomlConfig(existing, servers);

  // Global files live outside the repo — never touch them without a confirm.
  if (target.scope === 'global' && !opts.confirmGlobal) {
    return { agent, scope: target.scope, path: target.path, wrote: false, needsConfirm: true, servers: serverNames, preview: next };
  }

  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, next, 'utf-8');
  return { agent, scope: target.scope, path: target.path, wrote: true, needsConfirm: false, servers: serverNames };
}

export type AgentConnectStatus =
  | 'connected'      // written just now
  | 'already'        // the baton server was already wired
  | 'needs-confirm'  // a global ($HOME) file — rerun with confirmGlobal
  | 'unsupported'    // aider/opencode — no standard MCP config
  | 'parse-error';   // existing file is unparseable — left untouched

export interface AgentConnectOutcome {
  agent: string;
  status: AgentConnectStatus;
  scope: McpScope | null;
  path: string | null;
  /**
   * Whether the agent's session-start instruction file now tells it to call
   * `orient`. Reported separately from `status` because the two can disagree:
   * an agent can be wired to the MCP server and still be unbindable, and an
   * agent whose MCP config is a global file awaiting confirmation can still
   * have its project-level instruction written.
   */
  orient: OrientBindStatus;
  orientPath: string | null;
  /** Backup of a pre-existing instruction file, when one was modified. */
  orientBackup?: string;
}

/**
 * Wire a batch of agents to the `baton` coordination MCP server in one call —
 * the one-command "every agent can now see the others" step. Passes state=null
 * so it writes the stdio `baton mcp` server (no running daemon required); an
 * existing graphify KB config is merged, never clobbered. Never throws: each
 * agent's outcome (including unsupported / parse-error) is returned so the
 * caller can report the whole batch.
 */
export async function connectAgents(
  root: string,
  agents: string[],
  opts: { confirmGlobal?: boolean; bindOrient?: boolean } = {},
  home = homedir(),
): Promise<AgentConnectOutcome[]> {
  const out: AgentConnectOutcome[] = [];
  for (const agent of agents) {
    /* Binding runs for EVERY agent, including ones with no MCP config Baton can
       write. `orient` is a project-level markdown instruction, so an agent that
       cannot be wired automatically can still be told where to start — and an
       agent Baton cannot bind either is reported as such rather than skipped. */
    const bound = opts.bindOrient === false
      ? { agent, status: 'unbound' as OrientBindStatus, path: null, backup: null }
      : await bindOrient(agent, root);
    const orient = {
      orient: bound.status, orientPath: bound.path,
      ...(bound.backup ? { orientBackup: bound.backup } : {}),
    };

    const target = mcpTargetFor(agent, root, home);
    if (!target) {
      out.push({ agent, status: 'unsupported', scope: null, path: null, ...orient });
      continue;
    }
    try {
      const status = await readMcpStatus(agent, root, home);
      if (status.connected) {
        out.push({ agent, status: 'already', scope: target.scope, path: target.path, ...orient });
        continue;
      }
      const r = await connectAgentMcp(agent, root, null, { confirmGlobal: opts.confirmGlobal }, home);
      out.push({ agent, status: r.wrote ? 'connected' : 'needs-confirm', scope: target.scope, path: target.path, ...orient });
    } catch (e) {
      if (e instanceof McpConfigParseError) {
        out.push({ agent, status: 'parse-error', scope: target.scope, path: target.path, ...orient });
      } else {
        throw e;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Binding an agent to orient()

   `orient()` already returns a budgeted brief — project memory, recent work,
   structure. The gap is that only some clients ever call it. The MCP server
   carries an `instructions` field saying to call it first, and that is not
   enough on its own: not every client surfaces it, so an agent from another
   vendor can join a repo knowing nothing while the brief sits there unread.

   So the instruction also goes in the file that agent actually reads at session
   start. Which means writing into files the USER owns, and the three rules that
   follow from that are the whole design:

     - MERGE, never overwrite. Clobbering someone's CLAUDE.md loses work Baton
       did not create and cannot restore.
     - Remove EXACTLY what was added. A disconnect that takes a neighbouring
       line with it is worse than one that does nothing.
     - Say when an agent cannot be bound. A silent skip reads as success.
   --------------------------------------------------------------------------- */

/** Delimiters, so unbind can find precisely what bind wrote. HTML comments
 *  because every one of these files is markdown, and they render as nothing. */
export const ORIENT_START = '<!-- baton:orient:start -->';
/**
 * The line that marks a block as BATON'S, rather than as any marker pair.
 *
 * The markers alone are not identity. Baton's own block invites the reader to
 * "delete the block (both marker comments included) to remove it", so a team
 * runbook quoting that recipe contains a real, correctly-formed pair — and
 * pairing by position deleted THEIR span, left Baton's block installed, and
 * reported success. Membership has to be decided by content.
 */
export const BLOCK_SIGNATURE = 'Added by Baton.';

export const ORIENT_END = '<!-- baton:orient:end -->';

/**
 * The file each agent reads at session start.
 *
 * Several agents share `AGENTS.md` deliberately — it is the convention they
 * converged on, and one file bound once is better than three saying the same
 * thing. Agents absent from this map are UNBINDABLE and reported as such:
 * `aider` takes its conventions from an explicit `--read` flag rather than a
 * file it finds on its own, so there is nothing here to write.
 */
const ORIENT_FILES: Record<string, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  cursor: 'AGENTS.md',
  antigravity: 'AGENTS.md',
  opencode: 'AGENTS.md',
  gemini: 'GEMINI.md',
};

/** An agent id is a KEY here, never a path segment — but ids can reach us from
 *  a repo's own `.baton/agents.json`, which arrives by `git pull`, so the shape
 *  is checked rather than trusted. */
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export interface OrientTarget { agent: string; file: string; path: string }

/** Where this agent's session-start instruction lives, or null if none exists. */
export function orientTargetFor(agent: string, root: string): OrientTarget | null {
  if (!SAFE_AGENT_ID.test(agent)) return null;
  if (!Object.hasOwn(ORIENT_FILES, agent)) return null;
  const file = ORIENT_FILES[agent]!;
  return { agent, file, path: join(root, file) };
}

/**
 * The instruction itself.
 *
 * Deliberately short and free of anything that changes between runs — a block
 * carrying a timestamp or a version would rewrite the user's file on every
 * connect and show up as a diff in their repo for no reason.
 */
export function orientBlock(): string {
  return [
    ORIENT_START,
    '## Baton — start here',
    '',
    'At the start of a session in this repo, call the `orient` MCP tool before',
    'exploring. It returns a budgeted brief: what this project is, the decisions',
    'and gotchas already recorded, what shipped recently, and where things live.',
    '',
    'Then `recall_memory` before you go looking, and `check_files` before editing',
    'a file others may be in. Other agents are working here too.',
    '',
    `${BLOCK_SIGNATURE} Edit freely outside this block; delete the block (both marker`,
    'comments included) to remove it. Re-running `baton connect` restores it.',
    ORIENT_END,
  ].join('\n');
}

export type OrientBindStatus =
  | 'bound'    // written (file created, or the block appended)
  | 'updated'  // an older Baton block was refreshed in place
  | 'already'  // the current block was already there; nothing written
  | 'unbound'  // no instruction file Baton knows how to write for this agent
  | 'failed';  // the path exists but could not be read or written

export interface OrientBindResult {
  agent: string;
  status: OrientBindStatus;
  path: string | null;
  /** Copy of the user's file as it was, when Baton modified one it did not
   *  create. Null when there was nothing to lose. */
  backup: string | null;
  error?: string;
}

/** Both markers, in order — anything less is not a block Baton wrote. */
/**
 * The span Baton wrote, or null.
 *
 * Pairs the end marker with the NEAREST PRECEDING start, not the first start in
 * the file. Those differ exactly when the user has written the start marker in
 * their own prose above Baton's block — documenting it, quoting it, explaining
 * their conventions — and the difference is destructive: pairing their mention
 * with Baton's terminator removes every paragraph in between, in a file Baton
 * did not create, while `disconnect` reports success.
 *
 * Verified before the fix against the real CLI: a five-line CLAUDE.md whose
 * third line mentioned the marker came back truncated mid-sentence.
 *
 * A start with no end after it is still not a block — that is prose, and is
 * left alone.
 */
function blockRange(text: string): { start: number; end: number } | null {
  // Every well-formed pair, then the LAST one that is actually Baton's. Last,
  // because bind appends: a user's quoted copy sits above the block Baton
  // maintains. A pair without the signature is somebody else's text and is
  // left exactly where it is.
  let best: { start: number; end: number } | null = null;
  let from = 0;
  for (;;) {
    const start = text.indexOf(ORIENT_START, from);
    if (start === -1) break;
    const end = text.indexOf(ORIENT_END, start + ORIENT_START.length);
    if (end === -1) break;
    // A nested start means the outer one is prose introducing this pair.
    const nested = text.indexOf(ORIENT_START, start + ORIENT_START.length);
    const realStart = nested !== -1 && nested < end ? nested : start;
    const range = { start: realStart, end: end + ORIENT_END.length };
    if (text.slice(range.start, range.end).includes(BLOCK_SIGNATURE)) best = range;
    from = range.end;
  }
  return best;
}

/** Write the session-start instruction into the file this agent reads. */
export async function bindOrient(agent: string, root: string): Promise<OrientBindResult> {
  const target = orientTargetFor(agent, root);
  if (!target) return { agent, status: 'unbound', path: null, backup: null };

  const block = orientBlock();
  try {
    const existed = existsSync(target.path);
    const before = existed ? await readFile(target.path, 'utf-8') : '';

    const at = blockRange(before);
    let next: string;
    let status: OrientBindStatus;
    if (at) {
      next = before.slice(0, at.start) + block + before.slice(at.end);
      status = next === before ? 'already' : 'updated';
    } else {
      // Appended, never prepended: the user's own first line is the one they
      // wrote, and Baton's housekeeping does not belong above it.
      const head = before.length && !before.endsWith('\n') ? `${before}\n` : before;
      next = `${head}${head ? '\n' : ''}${block}\n`;
      status = 'bound';
    }
    if (status === 'already') return { agent, status, path: target.path, backup: null };

    // Only when there was something of the user's to lose. Taken before the
    // write, so a crash mid-write still leaves the original recoverable.
    let backup: string | null = null;
    if (existed) {
      backup = `${target.path}.baton-bak`;
      await writeFile(backup, before, 'utf-8');
    }
    await writeFile(target.path, next, 'utf-8');
    return { agent, status, path: target.path, backup };
  } catch (e) {
    // A path that cannot be read or written is left exactly as it is. Baton
    // never removes something in its way to make room.
    return { agent, status: 'failed', path: target.path, backup: null, error: (e as Error).message };
  }
}

export type OrientUnbindStatus =
  | 'unbound'  // the block was removed, or there is no file Baton could bind
  | 'absent'   // the file has no block Baton wrote — left untouched
  | 'failed';

export interface OrientUnbindResult {
  agent: string; status: OrientUnbindStatus; path: string | null;
  /** Where the file was copied before anything was removed from it. */
  backup?: string | null;
  error?: string;
}

/** Remove exactly the block bind wrote, and nothing adjacent to it. */
export async function unbindOrient(agent: string, root: string): Promise<OrientUnbindResult> {
  const target = orientTargetFor(agent, root);
  if (!target) return { agent, status: 'unbound', path: null };

  try {
    if (!existsSync(target.path)) return { agent, status: 'absent', path: target.path };
    const before = await readFile(target.path, 'utf-8');
    const at = blockRange(before);
    // A start marker with no end is prose that happens to mention it, not a
    // block. Treating it as one would delete the rest of the user's file.
    if (!at) return { agent, status: 'absent', path: target.path };

    // Remove exactly what the append introduced, so the file is restored byte
    // for byte rather than keeping the block's footprint — or losing a line to
    // it. bindOrient writes `<head>\n` + `\n` + block + `\n`, so its footprint
    // is ONE blank line before and ONE newline after. `\n+` on the tail was a
    // character too greedy: a user who wrote notes below the block lost the
    // blank line separating them, which is the opposite of "removes exactly
    // what was added".
    const head = before.slice(0, at.start).replace(/\n+$/, '\n');
    const tail = before.slice(at.end).replace(/^\n/, '');
    const rest = (head.trim() ? head : '') + tail;

    // Nothing of the user's left: Baton created this file, so it removes it
    // rather than leaving an empty one behind.
    // bind backs the file up before writing; removal is at least as destructive,
    // and until now it took none — so a mistake here was unrecoverable.
    const backup = `${target.path}.baton-bak`;
    await writeFile(backup, before, 'utf-8');

    if (!rest.trim()) await rm(target.path, { force: true });
    else await writeFile(target.path, rest, 'utf-8');
    return { agent, status: 'unbound', path: target.path, backup };
  } catch (e) {
    return { agent, status: 'failed', path: target.path, error: (e as Error).message };
  }
}

/**
 * Unbind every agent, so `connect`'s writes into the user's own files are
 * reversible by a command rather than by hand-editing CLAUDE.md.
 *
 * Defaults to the same roster `connect` defaults to. Anything narrower leaves
 * behind exactly what connect wrote, which is the failure that makes people
 * stop trusting an uninstall.
 */
export const DEFAULT_ORIENT_AGENTS = ['claude', 'cursor', 'codex', 'gemini'];

export async function disconnectOrient(
  root: string,
  agents: readonly string[] = DEFAULT_ORIENT_AGENTS,
): Promise<OrientUnbindResult[]> {
  const out: OrientUnbindResult[] = [];
  // Sequential on purpose: several agents share AGENTS.md, and two concurrent
  // read-modify-writes of one file would race to drop each other's edit.
  for (const agent of agents) out.push(await unbindOrient(agent, root));
  return out;
}
