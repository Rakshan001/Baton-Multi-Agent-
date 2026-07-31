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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
const MAX_CUSTOM_AGENTS = 20;
const DETECT_MAX = 80;
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
        if (!prompt) { if (t !== '{prompt}') out.push(t.replaceAll('{prompt}', '')); continue; }
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

function cleanCustomAgent(raw: unknown, issues: string[]): AgentDef | null {
  const r = raw as Partial<Record<'id' | 'label' | 'binary' | 'detect', unknown>> & {
    headless?: { cmd?: unknown; args?: unknown }; interactive?: { cmd?: unknown; args?: unknown };
  };
  const id = typeof r?.id === 'string' ? r.id : '';
  if (!CUSTOM_ID_RE.test(id)) {
    issues.push(`agents.json: '${String(r?.id ?? '(missing id)')}' is not a usable id (lowercase letters, digits, dashes, max 20) — entry skipped`);
    return null;
  }
  const binary = typeof r.binary === 'string' ? r.binary : '';
  if (!CUSTOM_BIN_RE.test(binary)) {
    issues.push(`agents.json (${id}): binary is required and must be a plain command name or path — entry skipped`);
    return null;
  }
  const detectSrc = typeof r.detect === 'string' && r.detect.length > 0 ? r.detect : null;
  if (detectSrc && detectSrc.length > DETECT_MAX) {
    issues.push(`agents.json (${id}): detect regex longer than ${DETECT_MAX} chars — entry skipped`);
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
    const args = cleanArgsTemplate(l.args, `agents.json (${id}) ${which}`, issues);
    if (!args) return undefined;
    const cmd = typeof l.cmd === 'string' && CUSTOM_BIN_RE.test(l.cmd) ? l.cmd : binary;
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
    const def = cleanCustomAgent(entry, issues);
    if (!def) continue;
    if (into[def.id]) {
      issues.push(`custom agent '${def.id}' collides with a built-in — the built-in wins`);
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
