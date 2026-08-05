/**
 * Single source of truth for every agent CLI Baton knows how to talk to:
 * how to detect it in the process table, which binary to probe, and how to
 * invoke it headlessly (print mode) or interactively (TUI) — including how
 * each CLI accepts a model override.
 *
 * spawn.ts, terminals.ts, agents.ts and routing.ts all derive their agent
 * lists from here; adding an agent is a one-file change — or no change at
 * all: `~/.baton/agents.json` (bottom of this file) teaches Baton a new CLI
 * without a release.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface HeadlessLauncher {
  cmd: string;
  /** argv after the binary for a one-shot print-mode run. */
  args: (prompt: string, model?: string) => string[];
}

export interface InteractiveLauncher {
  cmd: string;
  /** argv after the binary; `prompt` seeds the TUI when the CLI supports it. */
  args: (prompt?: string, model?: string) => string[];
}

export interface AgentDef {
  id: string;
  label: string;
  /** Binary probed for availability (PATH check). */
  binary: string;
  /** Matched against `ps` command lines for local agent detection. */
  detect: RegExp;
  headless?: HeadlessLauncher;
  interactive?: InteractiveLauncher;
  /** Set only on entries from a project's `.baton/agents.json`. Those arrive
   *  with the code rather than from the person running Baton, so every surface
   *  that offers to LAUNCH one says where it came from. */
  fromProject?: true;
}

const modelFlag = (flag: string, model?: string): string[] => (model ? [flag, model] : []);

/**
 * A prompt in a POSITIONAL argv slot that starts with '-' would be parsed by
 * the agent CLI as a flag (`--dangerously-skip-permissions` as a "prompt"
 * would defeat Baton's no-bypass-flags invariant). A leading space keeps it
 * plain text to every CLI's parser — and is invisible to the model. Prompts
 * following a flag (-p/-i/exec's -m) are consumed as that flag's value and
 * don't need this.
 */
const positional = (p?: string): string[] => (p ? [p.startsWith('-') ? ` ${p}` : p] : []);

export const AGENTS: Record<string, AgentDef> = {
  claude: {
    id: 'claude', label: 'Claude Code', binary: 'claude',
    detect: /(^|\/|\s)claude(\s|$)/,
    headless: { cmd: 'claude', args: (p, m) => [...modelFlag('--model', m), '-p', p] },
    interactive: { cmd: 'claude', args: (p, m) => [...modelFlag('--model', m), ...positional(p)] },
  },
  codex: {
    id: 'codex', label: 'Codex CLI', binary: 'codex',
    detect: /(^|\/|\s)codex(\s|$)/,
    headless: { cmd: 'codex', args: (p, m) => ['exec', ...modelFlag('-m', m), ...positional(p)] },
    interactive: { cmd: 'codex', args: (p, m) => [...modelFlag('-m', m), ...positional(p)] },
  },
  cursor: {
    id: 'cursor', label: 'Cursor Agent', binary: 'cursor-agent',
    detect: /cursor-agent/,
    // `cursor` opens the IDE; Cursor's terminal agent is the separate cursor-agent CLI.
    interactive: { cmd: 'cursor-agent', args: (p, m) => [...modelFlag('--model', m), ...positional(p)] },
  },
  gemini: {
    id: 'gemini', label: 'Gemini CLI', binary: 'gemini',
    detect: /(^|\/|\s)gemini(\s|$)/,
    headless: { cmd: 'gemini', args: (p, m) => [...modelFlag('-m', m), '-p', p] },
    interactive: { cmd: 'gemini', args: (p, m) => [...modelFlag('-m', m), ...(p ? ['-i', p] : [])] },
  },
  antigravity: {
    id: 'antigravity', label: 'Antigravity', binary: 'agy',
    // The CLI is `agy`; the IDE runs as Antigravity.app (Electron + helpers).
    // Detection-only for now: launcher flags are inherited-from-gemini per the
    // migration docs but unverified on a real install — don't guess spawn args.
    detect: /(^|\/|\s)agy(\s|$)|antigravity/i,
  },
  aider: {
    id: 'aider', label: 'Aider', binary: 'aider',
    detect: /(^|\/|\s)aider(\s|$)/,
    // Aider speaks local models directly (e.g. --model ollama/qwen2.5-coder).
    interactive: { cmd: 'aider', args: (_p, m) => [...modelFlag('--model', m)] },
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', binary: 'opencode',
    detect: /(^|\/|\s)opencode(\s|$)/,
    interactive: { cmd: 'opencode', args: (_p, m) => [...modelFlag('--model', m)] },
  },
  openclaw: {
    id: 'openclaw', label: 'OpenClaw', binary: 'openclaw',
    // Detection-only for now (the antigravity precedent above): presence in
    // the roster and process table first; launcher flags land only once they
    // have been verified against a real install, because claiming untested
    // flags is worse than not launching.
    detect: /(^|\/|\s)openclaw(\s|$)/,
  },
};

/* ------------------------------------------------------------------ */
/* Custom agents — ~/.baton/agents.json                                */
/*                                                                     */
/* The escape hatch for agent number nine: teach Baton a new CLI       */
/* without a Baton release. Owner-authored local config, so it is      */
/* trusted the way env vars and CLI flags are — but it is still        */
/* VALIDATED, because a typo that half-loads should say so in          */
/* `baton doctor` rather than corrupt the roster silently. Argv        */
/* arrays only; nothing here ever passes through a shell (exec.ts).    */
/* ------------------------------------------------------------------ */

/** Problems found loading agents.json — `baton doctor` reports these. */
export const CUSTOM_AGENT_ISSUES: string[] = [];
/** Ids that actually loaded, in file order. */
export const CUSTOM_AGENT_IDS: string[] = [];

export function customAgentsPath(): string {
  // Env override exists for tests (the module loads once per process). Trusted.
  return process.env.BATON_AGENTS_FILE || join(homedir(), '.baton', 'agents.json');
}

const CUSTOM_ID_RE = /^[a-z][a-z0-9-]{0,19}$/;
const CUSTOM_BIN_RE = /^[A-Za-z0-9._/-]{1,120}$/;
/**
 * The same, minus every way to name a file INSIDE the repo: no `/`, no leading
 * dot or dash — a bare PATH command only.
 *
 * `~/.baton/agents.json` is written by the person running Baton, so a path
 * there is theirs and allowed. A project's `.baton/agents.json` arrives with
 * the CODE: it is committed, shared, and lands on your disk from a clone, a
 * PR branch, or a `git pull` you did not read. The roster probes every known
 * binary with `<bin> --version` on a poll, so a repo-relative `./scripts/x`
 * would be a zero-click execution of a file the repo itself ships. A bare
 * name can only ever select something already installed on the machine.
 */
const PROJECT_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/** Where a custom entry came from — the trust boundary, not decoration. */
export type AgentScope = 'global' | 'project';
const MAX_CUSTOM_AGENTS = 20;
const DETECT_MAX = 80;

/**
 * A project `detect` pattern may not nest a quantifier inside a quantifier.
 *
 * The round that added PROJECT_BIN_RE closed the path where a cloned repo ran
 * its own binaries, but left `detect` free — and it is compiled with
 * `new RegExp` and run in-process against every line of `ps -axo command=` on
 * the status-poll path, with no timeout. `((\w|\s)+)+X` is twelve characters
 * and never returns against a realistic command line: the single-threaded
 * daemon simply stops, on the first poll after a clone, with nothing opted in.
 *
 * The rule is deliberately narrow rather than a general catastrophic-backtracking
 * analysis, which is not decidable here: a REPEATED group whose body itself
 * contains a repeat, another group, or an alternation is rejected (see
 * bodyRepeats for why alternation belongs on that list — `(a|aa)+` blows up
 * without nesting anything). Real detection patterns look like
 * `(^|/|\s)agy(\s|$)` and quantify no group at all, so none of this reaches
 * them.
 *
 * `~/.baton/agents.json` keeps the unrestricted form: you wrote that file
 * yourself, the same split that governs `binary`.
 */
export function nestsQuantifier(src: string): boolean {
  const stack: number[] = [];
  // Parens inside a character class are LITERAL — `[(]` opens nothing and `[)]`
  // closes nothing. Without tracking the class, a pattern containing either
  // popped or pushed the stack wrongly and every paren after it was paired
  // against the wrong partner, so the scan silently stopped describing the
  // pattern it was reading. Skipping class interiors keeps the pairing honest.
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }        // an escaped paren is a literal
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push(i); continue; }
    if (c !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;         // unbalanced; `new RegExp` will reject it
    // `includes('')` is TRUE for every string, so the `?? ''` fallback used to
    // read a group at the very END of a pattern as repeated — and `(\s|$)` is
    // how nearly every real detect pattern finishes. It stayed invisible only
    // because such a body contained no quantifier to find; the moment
    // alternation joined the list it started rejecting the legitimate shape.
    const next = src[i + 1];
    if (next === undefined || !'+*{'.includes(next)) continue;  // the group does not repeat
    const body = src.slice(start + 1, i);
    // A repeat or group in the body is the blow-up shape — but only outside a
    // character class: `[+*]` is a literal plus, not a quantifier.
    if (bodyRepeats(body)) return true;
  }
  return false;
}

/**
 * Does this REPEATED group's body contain a quantifier, a nested group, or an
 * alternation (ignoring character-class interiors, where all of those are
 * literals)?
 *
 * Alternation is in the list because of overlapping branches. `(a|aa)+$` is
 * eight characters, contains no nested quantifier and no nested group, and
 * takes ~180 ms on a 28-character subject — doubling per character after that,
 * so a 45-character command line is hours of a wedged single-threaded daemon.
 * It is the same catastrophic class, the same trigger (a cloned repo's
 * `.baton/agents.json`), and the same target (`ps -axo command=` on the poll
 * path), and an earlier version of this rule waved it through while its
 * comment asserted `(a|b)+` was "fine — it is linear". That is true of `(a|b)+`
 * and false of the family it admits, and the two cannot be told apart without
 * deciding branch overlap. So a repeated group may not alternate at all.
 *
 * This costs nothing real: detection patterns look like `(^|/|\s)agy(\s|$)`,
 * where the groups alternate but are never repeated, so this never runs on
 * them. `~/.baton/agents.json` keeps the unrestricted form.
 */
function bodyRepeats(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if ('+*{(|'.includes(c)) return true;
  }
  return false;
}
const ARG_MAX = 200;
const ARGS_MAX = 32;

/**
 * JSON cannot hold a function, so custom launcher args are a TEMPLATE array:
 * `"{prompt}"` substitutes the prompt (with the same leading-space guard as
 * `positional` above), and any token containing `"{model}"` is dropped when no
 * model was asked for — which is why the docs say `--model={model}`, one
 * token, rather than a two-token flag pair that would leave a dangling flag.
 */
function templateArgs(tpl: string[]): (prompt?: string, model?: string) => string[] {
  return (prompt?: string, model?: string) => {
    const out: string[] = [];
    for (const t of tpl) {
      if (t.includes('{model}')) {
        if (model) out.push(t.replaceAll('{model}', model));
        continue;
      }
      if (t.includes('{prompt}')) {
        // undefined = no prompt AT ALL (an interactive launch) — drop the
        // token, like positional() above. An empty STRING substitutes: the
        // headless contract always passes a string, and dropping the token
        // for '' would leave a flag-pair template like ['-p','{prompt}']
        // with a dangling '-p' — built-ins keep the argv shape ('-p','').
        if (prompt === undefined) { if (t !== '{prompt}') out.push(t.replaceAll('{prompt}', '')); continue; }
        const p = t.replaceAll('{prompt}', prompt);
        out.push(t === '{prompt}' && p.startsWith('-') ? ` ${p}` : p);
        continue;
      }
      out.push(t);
    }
    return out;
  };
}

function cleanArgsTemplate(raw: unknown, where: string, issues: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length > ARGS_MAX || raw.some((a) => typeof a !== 'string' || a.length > ARG_MAX)) {
    issues.push(`${where}: args must be an array of up to ${ARGS_MAX} strings — entry skipped`);
    return null;
  }
  const tpl = raw as string[];
  // A token holding BOTH placeholders is a trap: {model} tokens are dropped
  // whole when no model is set, which would silently discard the prompt too —
  // recreating the exact TUI-under-a-pipe hang the {prompt} guard exists for.
  if (tpl.some((a) => a.includes('{model}') && a.includes('{prompt}'))) {
    issues.push(`${where}: a token must not mix {model} and {prompt} (the whole token is dropped when no model is set, prompt included) — launcher skipped`);
    return null;
  }
  return tpl;
}

function cleanCustomAgent(raw: unknown, issues: string[], scope: AgentScope = 'global'): AgentDef | null {
  const r = raw as Partial<Record<'id' | 'label' | 'binary' | 'detect', unknown>> & {
    headless?: { cmd?: unknown; args?: unknown }; interactive?: { cmd?: unknown; args?: unknown };
  };
  const id = typeof r?.id === 'string' ? r.id : '';
  if (!CUSTOM_ID_RE.test(id)) {
    issues.push(`agents.json: '${String(r?.id ?? '(missing id)')}' is not a usable id (lowercase letters, digits, dashes, max 20) — entry skipped`);
    return null;
  }
  const binRe = scope === 'project' ? PROJECT_BIN_RE : CUSTOM_BIN_RE;
  const binHelp = scope === 'project'
    ? 'must be an installed command name — a project file may not point at a path, because it arrives with the code'
    : 'must be a plain command name or path';
  const binary = typeof r.binary === 'string' ? r.binary : '';
  if (!binRe.test(binary)) {
    issues.push(`agents.json (${id}): binary is required and ${binHelp} — entry skipped`);
    return null;
  }
  const detectSrc = typeof r.detect === 'string' && r.detect.length > 0 ? r.detect : null;
  if (detectSrc && detectSrc.length > DETECT_MAX) {
    issues.push(`agents.json (${id}): detect regex longer than ${DETECT_MAX} chars — entry skipped`);
    return null;
  }
  if (detectSrc && scope === 'project' && nestsQuantifier(detectSrc)) {
    issues.push(
      `agents.json (${id}): detect nests a quantifier inside a repeated group, which can hang the daemon `
      + `matching it against the process list — entry skipped`,
    );
    return null;
  }
  let detect: RegExp;
  try {
    // Default detection is the binary name in a word boundary, same shape as
    // every built-in — most entries never need to write a regex at all.
    detect = detectSrc ? new RegExp(detectSrc) : new RegExp(`(^|\\/|\\s)${binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  } catch {
    issues.push(`agents.json (${id}): detect is not a valid regex — entry skipped`);
    return null;
  }
  // Loose on purpose: a template launcher takes an optional prompt, which
  // structurally satisfies both the headless and the interactive slot.
  const launcher = (which: 'headless' | 'interactive'): { cmd: string; args: (prompt?: string, model?: string) => string[] } | undefined => {
    const l = r[which];
    if (!l) return undefined;
    /*
     * A PROJECT file may describe an agent; it may never say how to RUN one.
     *
     * The earlier round stopped `binary` from naming a path, so a repo could no
     * longer run a file it ships. It left the argv template free, and that is
     * the same hole through a different door: `cmd` only has to be an installed
     * command NAME, and `sh` is installed everywhere — so
     * `{cmd: 'sh', args: ['-c', '<anything>']}` in a cloned repo's
     * .baton/agents.json is arbitrary code execution, needing nothing but for
     * someone to pick that agent in the Launch dialog. No denylist of
     * interpreters closes that; there is always another one.
     *
     * Detection still works, which is what a repo legitimately needs — the
     * antigravity and openclaw built-ins are detection-only and useful. To make
     * a custom agent launchable, put the launcher in ~/.baton/agents.json,
     * which you wrote yourself. That is the same split that governs `binary`.
     */
    if (scope === 'project') {
      issues.push(
        `agents.json (${id}): ${which} mode dropped — a project file may describe an agent but never how to run one `
        + `(add the launcher to ~/.baton/agents.json, which arrives from you rather than with the code)`,
      );
      return undefined;
    }
    const args = cleanArgsTemplate(l.args, `agents.json (${id}) ${which}`, issues);
    if (!args) return undefined;
    // Only ~/.baton reaches here now. A launcher cmd is spawned directly, so it
    // still faces the same rule as `binary`; an unusable one falls back to the
    // binary rather than dropping the mode, since this file's author is you.
    if (typeof l.cmd === 'string' && !binRe.test(l.cmd)) {
      return { cmd: binary, args: templateArgs(args) };
    }
    const cmd = typeof l.cmd === 'string' ? l.cmd : binary;
    return { cmd, args: templateArgs(args) };
  };
  const headless = launcher('headless');
  const interactive = launcher('interactive');
  // A headless launcher whose template never mentions the prompt would launch
  // the agent WITHOUT its instructions — a TUI under a pipe, hanging a
  // `baton start` forever. Judged on the template, not a sample expansion.
  const headlessUsesPrompt = Array.isArray(r.headless?.args)
    && (r.headless.args as unknown[]).some((t) => typeof t === 'string' && t.includes('{prompt}'));
  if (headless && !headlessUsesPrompt) {
    issues.push(`agents.json (${id}): headless args never use {prompt} — headless mode dropped`);
  }
  return {
    id,
    label: (typeof r.label === 'string' && r.label.trim() ? r.label.trim() : id).slice(0, 40),
    binary,
    detect,
    ...(scope === 'project' ? { fromProject: true as const } : {}),
    ...(headless && headlessUsesPrompt ? { headless } : {}),
    ...(interactive ? { interactive } : {}),
  };
}

/**
 * Load custom agents from `file` into `into`, reporting problems to `issues`.
 * Exported with explicit sinks so tests can drive it against temp files; the
 * module-load call below is the only production caller. Built-ins win every
 * collision — a config file must not be able to redefine how `claude` runs.
 */
export function loadCustomAgents(
  file: string,
  into: Record<string, AgentDef>,
  issues: string[],
  scope: AgentScope = 'global',
): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return []; // absent is the normal case, not a problem
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push(`${file} is not valid JSON — no custom agents loaded`);
    return [];
  }
  const list = (parsed as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) {
    issues.push(`${file} must be { "agents": [ ... ] } — no custom agents loaded`);
    return [];
  }
  const added: string[] = [];
  for (const entry of list) {
    if (added.length >= MAX_CUSTOM_AGENTS) {
      issues.push(`${file}: more than ${MAX_CUSTOM_AGENTS} custom agents — the rest are ignored`);
      break;
    }
    const def = cleanCustomAgent(entry, issues, scope);
    if (!def) continue;
    if (into[def.id]) {
      // "Existing", not "built-in": a project file can also collide with a
      // ~/.baton custom. Earlier layers always win — config adds agents, it
      // never redefines one.
      issues.push(`custom agent '${def.id}' collides with an existing agent — the existing definition wins`);
      continue;
    }
    into[def.id] = def;
    added.push(def.id);
  }
  return added;
}

CUSTOM_AGENT_IDS.push(...loadCustomAgents(customAgentsPath(), AGENTS, CUSTOM_AGENT_ISSUES));

// AFTER the custom merge, so every consumer that derives from this module —
// spawn, terminals, detection, routing — sees custom agents as first-class.
export const KNOWN_AGENT_IDS = Object.keys(AGENTS);

/* ------------------------------------------------------------------ */
/* Per-project agents — <root>/.baton/agents.json                      */
/*                                                                     */
/* The same format as the machine-global file, scoped to one project:  */
/* an agent only that repo's team uses does not belong in ~/.baton on  */
/* every machine. The VALIDATOR is stricter, though, and deliberately: */
/* this file is committed, so it arrives from clones and PR branches   */
/* rather than from the person running Baton. Project entries may name */
/* an installed command, never a path — see PROJECT_BIN_RE. Layering   */
/* is additive and                                                     */
/* earlier-wins — built-ins, then ~/.baton, then the project file —    */
/* because config exists to ADD agents, never to redefine one.         */
/*                                                                     */
/* Loaded on demand and stat-cached (mtime+ino, the members.json       */
/* idiom) because detection sits on the daemon's poll path: the file   */
/* is re-read only when it actually changed, and edits take effect     */
/* without a daemon restart — unlike the global file, which loads at   */
/* module init.                                                        */
/* ------------------------------------------------------------------ */

export function projectAgentsPath(root: string): string {
  return join(root, '.baton', 'agents.json');
}

export interface ProjectAgents {
  /** Ids that loaded from this project's file, in file order. */
  ids: string[];
  defs: Record<string, AgentDef>;
  issues: string[];
}

const NO_PROJECT_AGENTS: ProjectAgents = { ids: [], defs: {}, issues: [] };
const projectCache = new Map<string, { mtimeMs: number; ino: number; view: ProjectAgents }>();

export function loadProjectAgents(root: string): ProjectAgents {
  const key = resolve(root);
  let st: { mtimeMs: number; ino: number };
  try {
    st = statSync(projectAgentsPath(root));
  } catch {
    projectCache.delete(key);
    return NO_PROJECT_AGENTS; // absent is the normal case, not a problem
  }
  const hit = projectCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.view;
  // Loading into a COPY of the merged global registry makes the existing
  // collision check refuse built-ins and ~/.baton customs alike.
  const into: Record<string, AgentDef> = { ...AGENTS };
  const issues: string[] = [];
  const ids = loadCustomAgents(projectAgentsPath(root), into, issues, 'project');
  const defs: Record<string, AgentDef> = {};
  for (const id of ids) defs[id] = into[id]!;
  const view: ProjectAgents = { ids, defs, issues };
  projectCache.set(key, { mtimeMs: st.mtimeMs, ino: st.ino, view });
  return view;
}

/** The registry as seen from `root`: built-ins + ~/.baton + the project file.
 *  Without a root (or without a project file) this IS the global registry —
 *  same object, so rootless consumers lose nothing. */
export function agentsFor(root?: string): Record<string, AgentDef> {
  if (!root) return AGENTS;
  const proj = loadProjectAgents(root);
  if (!proj.ids.length) return AGENTS;
  return { ...AGENTS, ...proj.defs };
}

export function knownAgentIdsFor(root?: string): string[] {
  return Object.keys(agentsFor(root));
}
