/**
 * Single source of truth for every agent CLI Baton knows how to talk to:
 * how to detect it in the process table, which binary to probe, and how to
 * invoke it headlessly (print mode) or interactively (TUI) — including how
 * each CLI accepts a model override.
 *
 * spawn.ts, terminals.ts, agents.ts and routing.ts all derive their agent
 * lists from here; adding an agent is a one-file change.
 */

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

export const AGENTS: Record<string, AgentDef> = {
  claude: {
    id: 'claude', label: 'Claude Code', binary: 'claude',
    detect: /(^|\/|\s)claude(\s|$)/,
    headless: { cmd: 'claude', args: (p, m) => [...modelFlag('--model', m), '-p', p] },
    interactive: { cmd: 'claude', args: (p, m) => [...modelFlag('--model', m), ...(p ? [p] : [])] },
  },
  codex: {
    id: 'codex', label: 'Codex CLI', binary: 'codex',
    detect: /(^|\/|\s)codex(\s|$)/,
    headless: { cmd: 'codex', args: (p, m) => ['exec', ...modelFlag('-m', m), p] },
    interactive: { cmd: 'codex', args: (p, m) => [...modelFlag('-m', m), ...(p ? [p] : [])] },
  },
  cursor: {
    id: 'cursor', label: 'Cursor Agent', binary: 'cursor-agent',
    detect: /cursor-agent/,
    // `cursor` opens the IDE; Cursor's terminal agent is the separate cursor-agent CLI.
    interactive: { cmd: 'cursor-agent', args: (p, m) => [...modelFlag('--model', m), ...(p ? [p] : [])] },
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
};

export const KNOWN_AGENT_IDS = Object.keys(AGENTS);
