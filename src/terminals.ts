/**
 * Interactive agent terminals: each session is a tmux session (named
 * `baton-<repoHash>-<slug>`) running the agent's interactive CLI inside the
 * task's worktree. The daemon drives tmux through one long-lived control-mode
 * client per session (`tmux -C attach-session`): pane output arrives as
 * `%output` notifications, keystrokes go back as `send-keys -H <hex…>`
 * commands on the control client's stdin (hex = injection-proof).
 *
 * Why tmux and not node-pty: the daemon stays zero-dependency, and sessions
 * survive daemon restarts — tmux owns the PTY, baton just reattaches.
 * Session-backend concept adapted from handler.dev (MIT) — tmux-hosted
 * terminals with capture-pane scrollback restore. No code vendored; see NOTICE.
 *
 * Safety: agents run with the user's own CLI auth and DEFAULT permission
 * settings — Baton never adds permission-bypass flags.
 */
import { execa, type ResultPromise } from 'execa';
import { gitRoot } from './git.js';
import { getTask } from './store.js';
import { probeBinary } from './util/exec.js';
import { detectTmux, repoPrefix, sessionNameFor, slugFromSession, tmux, tmuxTry } from './util/tmux.js';
import { bus } from './events.js';
import { hasHeadlessRun } from './spawn.js';

// Session naming + tmux exec live in util/tmux.js so spawn.ts and rm.ts can
// coordinate cross-process through the same deterministic names.
export { detectTmux, repoPrefix, sessionNameFor, slugFromSession };

export interface InteractiveLauncher {
  cmd: string;
  /** argv after the binary; `prompt` seeds the TUI when the CLI supports it. */
  args: (prompt?: string) => string[];
}

/** Interactive (TUI) invocations per agent. Unlike spawn.ts these keep stdin. */
export const INTERACTIVE_LAUNCHERS: Record<string, InteractiveLauncher> = {
  claude: { cmd: 'claude', args: (p) => (p ? [p] : []) },
  codex: { cmd: 'codex', args: (p) => (p ? [p] : []) },
  gemini: { cmd: 'gemini', args: (p) => (p ? ['-i', p] : []) },
  // `cursor` opens the IDE; Cursor's terminal agent is the separate cursor-agent CLI.
  cursor: { cmd: 'cursor-agent', args: (p) => (p ? [p] : []) },
  aider: { cmd: 'aider', args: () => [] },
  opencode: { cmd: 'opencode', args: () => [] },
};

export const INTERACTIVE_AGENTS = Object.keys(INTERACTIVE_LAUNCHERS);

export class TerminalRunningError extends Error {
  constructor(slug: string, agent: string) {
    super(`a ${agent} terminal is already open for '${slug}'`);
    this.name = 'TerminalRunningError';
  }
}

export class TerminalUnavailableError extends Error {
  constructor() {
    super('tmux is required for interactive terminals and was not found on PATH');
    this.name = 'TerminalUnavailableError';
  }
}

export class HeadlessConflictError extends Error {
  constructor(slug: string) {
    super(`a headless run is already active for '${slug}' — stop it before opening a terminal`);
    this.name = 'HeadlessConflictError';
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** POSIX single-quote escaping — safe on every tmux version's shell-command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell-command string tmux runs in the new session's pane. */
export function buildSessionCommand(launcher: InteractiveLauncher, prompt?: string): string {
  return [launcher.cmd, ...launcher.args(prompt).map(shQuote)].join(' ');
}

/** Keystroke bytes → `send-keys -H` hex arguments. */
export function toHexArgs(buf: Buffer): string[] {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0'));
}

/**
 * tmux control mode escapes pane output: backslash as `\\`, everything
 * non-printable (and bytes >126) as octal `\ooo`. Reverse it into raw bytes.
 */
export function unescapeControlOutput(escaped: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped.charCodeAt(i);
    if (c === 0x5c /* \ */ && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next === '\\') {
        bytes.push(0x5c);
        i += 1;
        continue;
      }
      const oct = escaped.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
    }
    if (c < 0x80) bytes.push(c);
    else for (const b of Buffer.from(escaped[i], 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes);
}

export type ControlLine =
  | { kind: 'output'; pane: string; data: string }
  | { kind: 'exit' }
  | { kind: 'error'; text: string }
  | { kind: 'other' };

export function parseControlLine(line: string): ControlLine {
  const om = line.match(/^%output %(\d+) (.*)$/s);
  if (om) return { kind: 'output', pane: om[1], data: om[2] };
  if (line === '%exit' || line.startsWith('%exit ')) return { kind: 'exit' };
  if (line.startsWith('%error')) return { kind: 'error', text: line };
  return { kind: 'other' };
}

/** Byte-capped scrollback ring so late joiners get recent screen state. */
export class ScrollbackRing {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly cap = 256 * 1024) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.cap && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

export interface TerminalInfo {
  slug: string;
  agent: string;
  sessionName: string;
  startedAt: string;
}

interface TerminalSession extends TerminalInfo {
  control: ResultPromise;
  scrollback: ScrollbackRing;
  exited: boolean;
}

const terminals = new Map<string, TerminalSession>();

export function hasTerminal(slug: string): boolean {
  return terminals.has(slug);
}

export function listTerminals(): TerminalInfo[] {
  return [...terminals.values()].map(({ slug, agent, sessionName, startedAt }) => ({
    slug, agent, sessionName, startedAt,
  }));
}

export function getScrollback(slug: string): Buffer | null {
  return terminals.get(slug)?.scrollback.snapshot() ?? null;
}

/* ------------------------------------------------------------------ */
/* Control client: one per session, owns output + input                */
/* ------------------------------------------------------------------ */

const FLUSH_MS = 16;

function attachControl(session: TerminalSession): void {
  // -d detaches any stale client (e.g. a control client orphaned by a killed
  // daemon). An orphan that stops draining output wedges the whole tmux
  // server, hanging every tmux command on the machine — never leave one attached.
  const child = execa('tmux', ['-C', 'attach-session', '-d', '-t', session.sessionName], {
    buffer: false,
    stdin: 'pipe',
    env: { ...process.env },
  });
  session.control = child;

  let lineBuf = '';
  let pending: Buffer[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    if (!pending.length) return;
    const data = Buffer.concat(pending);
    pending = [];
    session.scrollback.push(data);
    bus.publish({ type: 'terminal.output', slug: session.slug, data: data.toString('base64') });
  };

  child.stdout?.on('data', (d: Buffer) => {
    lineBuf += d.toString('utf8');
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const parsed = parseControlLine(line);
      if (parsed.kind === 'output') {
        pending.push(unescapeControlOutput(parsed.data));
        flushTimer ??= setTimeout(flush, FLUSH_MS);
      }
    }
  });

  void child.catch(() => undefined).finally(() => {
    if (flushTimer) clearTimeout(flushTimer);
    flush();
    void onControlExit(session);
  });
}

/** Control client died: session over (normal) or hiccup (reattach once). */
async function onControlExit(session: TerminalSession): Promise<void> {
  if (session.exited || terminals.get(session.slug) !== session) return;
  if (await tmuxTry(['has-session', '-t', session.sessionName])) {
    attachControl(session); // tmux session is alive — control client hiccuped
    return;
  }
  session.exited = true;
  terminals.delete(session.slug);
  bus.publish({ type: 'terminal.exited', slug: session.slug, agent: session.agent });
}

/* ------------------------------------------------------------------ */
/* Lifecycle API                                                       */
/* ------------------------------------------------------------------ */

export interface CreateTerminalOpts {
  agent?: string;
  prompt?: string;
  cols?: number;
  rows?: number;
}

export async function createTerminal(
  slug: string,
  opts: CreateTerminalOpts = {},
  root?: string,
): Promise<TerminalInfo> {
  if (!(await detectTmux())) throw new TerminalUnavailableError();
  const repoRoot = root ?? (await gitRoot());
  const task = await getTask(repoRoot, slug);
  if (!task) throw new Error(`No task '${slug}'`);
  const agent = opts.agent ?? 'claude';
  const launcher = INTERACTIVE_LAUNCHERS[agent];
  if (!launcher) throw new Error(`'${agent}' has no interactive launcher — supported: ${INTERACTIVE_AGENTS.join(', ')}`);
  if (hasHeadlessRun(slug)) throw new HeadlessConflictError(slug);

  const sessionName = sessionNameFor(repoRoot, slug);
  if (terminals.has(slug)) throw new TerminalRunningError(slug, terminals.get(slug)!.agent);
  if (await tmuxTry(['has-session', '-t', sessionName])) {
    // Daemon restarted while the session lived on — adopt it instead of failing.
    const adopted = await adoptSession(repoRoot, sessionName);
    if (adopted) throw new TerminalRunningError(slug, adopted.agent);
  }

  if (!(await probeBinary(launcher.cmd, ['--version']))) {
    throw new Error(`'${launcher.cmd}' is not installed or not on PATH`);
  }

  const cols = clampDim(opts.cols, 80, 20, 500);
  const rows = clampDim(opts.rows, 24, 5, 200);
  await tmux([
    'new-session', '-d',
    '-s', sessionName,
    '-c', task.worktreePath,
    '-x', String(cols), '-y', String(rows),
    buildSessionCommand(launcher, opts.prompt),
  ]);
  await tmuxTry(['set-option', '-t', sessionName, 'status', 'off']);
  await tmuxTry(['set-option', '-t', sessionName, 'history-limit', '5000']);
  await tmuxTry(['set-option', '-t', sessionName, 'window-size', 'manual']);
  await tmuxTry(['set-environment', '-t', sessionName, 'BATON_AGENT', agent]);

  const session: TerminalSession = {
    slug, agent, sessionName,
    startedAt: new Date().toISOString(),
    control: undefined as unknown as ResultPromise,
    scrollback: new ScrollbackRing(),
    exited: false,
  };
  terminals.set(slug, session);
  attachControl(session);
  bus.publish({ type: 'terminal.started', slug, agent });
  return { slug, agent, sessionName, startedAt: session.startedAt };
}

function clampDim(v: number | undefined, dflt: number, min: number, max: number): number {
  if (!v || !Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, Math.round(v)));
}

const INPUT_CAP = 8 * 1024;

export function writeInput(slug: string, bytes: Buffer): boolean {
  const session = terminals.get(slug);
  if (!session || session.exited || bytes.length === 0) return false;
  const stdin = session.control.stdin;
  if (!stdin || stdin.destroyed) return false;
  const hex = toHexArgs(bytes.subarray(0, INPUT_CAP));
  stdin.write(`send-keys -t ${session.sessionName} -H ${hex.join(' ')}\n`);
  return true;
}

export async function resizeTerminal(slug: string, cols: number, rows: number): Promise<boolean> {
  const session = terminals.get(slug);
  if (!session || session.exited) return false;
  return tmuxTry([
    'resize-window', '-t', session.sessionName,
    '-x', String(clampDim(cols, 80, 20, 500)),
    '-y', String(clampDim(rows, 24, 5, 200)),
  ]);
}

export async function killTerminal(slug: string): Promise<boolean> {
  const session = terminals.get(slug);
  if (!session) return false;
  session.exited = true;
  terminals.delete(slug);
  await tmuxTry(['kill-session', '-t', session.sessionName]);
  session.control?.kill('SIGTERM');
  bus.publish({ type: 'terminal.exited', slug: session.slug, agent: session.agent });
  return true;
}

/* ------------------------------------------------------------------ */
/* Daemon restart: adopt tmux sessions that outlived the old process   */
/* ------------------------------------------------------------------ */

async function adoptSession(root: string, sessionName: string): Promise<TerminalSession | null> {
  const slug = slugFromSession(root, sessionName);
  if (!slug || terminals.has(slug)) return terminals.get(slug ?? '') ?? null;

  let agent = 'claude';
  try {
    const { stdout } = await tmux(['show-environment', '-t', sessionName, 'BATON_AGENT']);
    const m = stdout.match(/^BATON_AGENT=(\S+)/m);
    if (m) agent = m[1];
  } catch { /* default stands */ }

  const session: TerminalSession = {
    slug, agent, sessionName,
    startedAt: new Date().toISOString(),
    control: undefined as unknown as ResultPromise,
    scrollback: new ScrollbackRing(),
    exited: false,
  };
  // Seed scrollback with the current screen + recent history so reconnecting
  // viewers see where the agent is, not a blank pane (handler.dev's trick).
  try {
    const { stdout } = await tmux(['capture-pane', '-p', '-e', '-q', '-t', sessionName, '-S', '-2000']);
    if (stdout) session.scrollback.push(Buffer.from(stdout.replace(/\n/g, '\r\n') + '\r\n', 'utf8'));
  } catch { /* scrollback is best-effort */ }

  terminals.set(slug, session);
  attachControl(session);
  bus.publish({ type: 'terminal.started', slug, agent });
  return session;
}

/** Rebuild the in-memory map from tmux sessions this repo's daemon owns. */
export async function reattachOrphans(root: string): Promise<TerminalInfo[]> {
  if (!(await detectTmux())) return [];
  let names: string[] = [];
  try {
    const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}']);
    names = stdout.split('\n').filter(Boolean);
  } catch {
    return []; // no tmux server running → no sessions
  }
  const prefix = repoPrefix(root);
  const adopted: TerminalInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const slug = slugFromSession(root, name)!;
    if (terminals.has(slug)) continue;
    const s = await adoptSession(root, name);
    if (s) adopted.push({ slug: s.slug, agent: s.agent, sessionName: s.sessionName, startedAt: s.startedAt });
  }
  return adopted;
}
