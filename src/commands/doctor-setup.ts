// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton doctor` setup checks: is this machine and this repo wired the way the
 * rest of Baton assumes? Node, git, a daemon for this repo, agent MCP configs
 * that point at it with the right token, the Claude hooks, the dashboard build,
 * graphify, `.baton` ownership, tmux.
 *
 * Read-only, and loopback only: the one probe that leaves the process is the
 * daemon's own `/api/meta` on 127.0.0.1. It never calls `getMcpToken` (that
 * CREATES the token file) and only ever merges hooks into a clone. Tokens are
 * compared, never printed.
 */
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeVersionError } from '../util/node-preflight.js';
import { git } from '../util/exec.js';
import { listDaemonRecords, verifyDaemon } from '../daemons.js';
import { mcpTargetFor } from '../agents/connect.js';
import { hooksFile, withBatonHooks } from './hooks.js';
import { detectGraphify, installHint } from '../kb/graphify.js';
import { kbFile } from '../kb/state.js';
import { batonDir, trustedBatonDir } from '../store.js';
import { detectTmux } from '../util/tmux.js';

export type SetupLevel = 'ok' | 'warn' | 'fail';

export interface SetupItem {
  /** Stable check id, for callers and tests. */
  id: string;
  level: SetupLevel;
  /** One line. Never carries a token. */
  detail: string;
  /** The command that fixes it, when there is one. */
  fix?: string;
}

const GIT_MIN: [number, number] = [2, 17];
/** The daemon's graphify proxy URL; group 2 is the port, 3 the token. */
const GRAPHIFY_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/mcp\/g\/([0-9a-f]{32})\//;
/** The same, un-anchored, for scanning a config file's raw text. */
const GRAPHIFY_URL_ANY = new RegExp(GRAPHIFY_URL.source.slice(1), 'g');
const RECONNECT = 're-run `baton kb init`, or use dashboard → Agents → Connect';

const item = (id: string, level: SetupLevel, detail: string, fix?: string): SetupItem =>
  ({ id, level, detail, ...(fix ? { fix } : {}) });

function checkNode(): SetupItem {
  const v = process.versions.node;
  const err = nodeVersionError(v);
  return err ? item('node', 'fail', err.split('\n')[0]) : item('node', 'ok', `Node ${v}`);
}

async function checkGit(): Promise<SetupItem> {
  let out: string;
  try {
    out = await git(['--version']);
  } catch {
    return item('git', 'fail', 'git not found on PATH', 'install git');
  }
  const m = /(\d+)\.(\d+)/.exec(out);
  const [maj, min] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  const old = maj < GIT_MIN[0] || (maj === GIT_MIN[0] && min < GIT_MIN[1]);
  return old
    ? item('git', 'fail', `${out} — Baton needs git ${GIT_MIN.join('.')} or newer`, 'upgrade git')
    : item('git', 'ok', out);
}

/** Ports of the verified-live daemons serving this root, plus whether any record was stale. */
async function daemonPorts(root: string): Promise<{ live: number[]; stale: number }> {
  // realpath, like liveDaemonFor: a record written as /private/tmp/x serves /tmp/x.
  const real = (p: string) => realpath(p).catch(() => resolve(p));
  const want = await real(root);
  const recs = await listDaemonRecords();
  const roots = await Promise.all(recs.map((r) => real(r.root)));
  const mine = recs.filter((_, i) => roots[i] === want);
  const status = await Promise.all(mine.map((r) => verifyDaemon(r)));
  return { live: mine.filter((_, i) => status[i] === 'live').map((r) => r.port), stale: status.filter((s) => s === 'stale').length };
}

function checkDaemon(d: { live: number[]; stale: number }): SetupItem {
  if (d.live.length) return item('daemon', 'ok', `daemon running on :${d.live.join(', :')}`);
  if (d.stale) return item('daemon', 'warn', `no live daemon for this repo (${d.stale} stale record${d.stale === 1 ? '' : 's'})`, 'baton daemon clean');
  return item('daemon', 'warn', 'no daemon running for this repo', 'baton serve');
}

/** Every graphify proxy URL a JSON MCP config names, in any of the three shapes Baton writes. */
function graphifyUrls(cfg: unknown): string[] {
  const servers = (cfg as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const urls: string[] = [];
  for (const def of Object.values(servers)) {
    const d = def as { url?: unknown; httpUrl?: unknown; args?: unknown } | null;
    if (!d) continue;
    if (typeof d.url === 'string') urls.push(d.url);
    if (typeof d.httpUrl === 'string') urls.push(d.httpUrl);
    if (Array.isArray(d.args)) {
      const i = d.args.indexOf('mcp-bridge');
      if (i >= 0 && typeof d.args[i + 1] === 'string') urls.push(d.args[i + 1] as string);
    }
  }
  return urls.filter((u) => GRAPHIFY_URL.test(u));
}

async function checkMcp(root: string, live: number[]): Promise<SetupItem[]> {
  // A raw read: getMcpToken would mint the file as a side effect.
  const token = await readFile(join(batonDir(root), 'mcp-token'), 'utf-8').then((t) => t.trim(), () => null);
  const out: SetupItem[] = [];
  const wired: string[] = [];
  /** Judge one agent's graphify URLs against this repo's token and live daemon. */
  const judge = (agent: string, path: string, urls: string[]): void => {
    if (!urls.length) return; // no graphify entry: no KB yet, or connect wrote baton only
    const where = `${agent} (${path})`;
    const hits = urls.map((u) => GRAPHIFY_URL.exec(u)!);
    if (hits.some((m) => m[3] !== token)) {
      out.push(item('mcp', 'fail', token
        ? `${where}: graphify token does not match .baton/mcp-token — every graph query is refused`
        : `${where}: names a graphify token but .baton/mcp-token is missing`, RECONNECT));
      return;
    }
    const off = [...new Set(hits.map((m) => Number(m[2])))].filter((p) => !live.includes(p));
    if (off.length && live.length) {
      out.push(item('mcp', 'fail', `${where}: points at :${off.join(', :')} but this repo's daemon is on :${live.join(', :')}`, RECONNECT));
    } else if (off.length) {
      out.push(item('mcp', 'warn', `${where}: nothing serves this repo on :${off.join(', :')}`, 'baton serve'));
    } else {
      wired.push(agent);
    }
  };
  for (const agent of ['claude', 'cursor', 'antigravity', 'codex', 'gemini']) {
    const target = mcpTargetFor(agent, root);
    if (!target) continue;
    let raw: string;
    try { raw = await readFile(target.path, 'utf-8'); } catch { continue; } // not configured for this agent
    if (target.scope === 'global') {
      // Shared by every repo on the machine (and TOML for Codex): scan the text,
      // and judge only the entries that carry THIS repo's token.
      const mine = [...raw.matchAll(GRAPHIFY_URL_ANY)].map((m) => m[0]).filter((u) => token && u.includes(`/mcp/g/${token}/`));
      judge(agent, target.path, mine);
      continue;
    }
    let cfg: unknown;
    try { cfg = JSON.parse(raw); } catch {
      out.push(item('mcp', 'warn', `${target.path} is not valid JSON — ${agent} gets no MCP servers`));
      continue;
    }
    judge(agent, target.path, graphifyUrls(cfg));
  }
  if (!out.length) {
    out.push(item('mcp', 'ok', wired.length ? `graphify wired for ${wired.join(', ')}` : 'no graphify servers configured — nothing to check'));
  }
  return out;
}

/** True when this settings file already holds every Baton hook. Merges into a clone, never the file. */
async function hasAllHooks(file: string): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(file, 'utf-8')) as Parameters<typeof withBatonHooks>[0];
    return withBatonHooks(structuredClone(settings)) === 0;
  } catch {
    return false;
  }
}

async function checkHooks(root: string): Promise<SetupItem | null> {
  // Only judged where Claude is in use: a missing hook elsewhere is not a finding.
  if (!existsSync(join(root, '.mcp.json')) && !existsSync(join(homedir(), '.claude'))) return null;
  // `root` is already the Baton root that `hooks install --project` resolves to.
  const files = [await hooksFile('claude', {}), join(root, '.claude', 'settings.json')];
  const found = await Promise.all(files.map(hasAllHooks));
  const i = found.indexOf(true);
  return i >= 0
    ? item('hooks', 'ok', `Claude hooks installed (${files[i]})`)
    : item('hooks', 'warn', 'Claude hooks missing — no handoff brief on stop, no edit guard', 'baton hooks install claude');
}

function checkDashboard(): SetupItem {
  const index = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
  return existsSync(index)
    ? item('dashboard', 'ok', 'dashboard built')
    : item('dashboard', 'warn', 'dashboard not built — `baton serve` answers the API only', 'npm run build --prefix web');
}

async function checkGraphify(root: string): Promise<SetupItem> {
  const d = await detectGraphify();
  if (d.ok) return item('graphify', 'ok', `graphify ${d.version ?? ''}`.trim());
  // Only a failure when this repo has a KB that needs it.
  return item('graphify', existsSync(kbFile(root)) ? 'fail' : 'warn', 'graphify not found — no code graph', installHint(d));
}

/**
 * `.baton` ownership. Fires only when the root fell back to the git root, since
 * resolution skips an untrusted `.baton` on its way up.
 */
async function checkBatonDir(root: string): Promise<SetupItem | null> {
  const dir = batonDir(root);
  try {
    if (await trustedBatonDir(root)) return item('baton-dir', 'ok', `${dir} is yours`);
    const st = await stat(dir);
    if (!st.isDirectory()) return item('baton-dir', 'fail', `${dir} is not a directory`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return item('baton-dir', 'fail', `${dir} is owned by uid ${st.uid}, not you — Baton ignores it`, `chown -R "$(id -un)" "${dir}"`);
    }
    return item('baton-dir', 'fail', `${dir} is world-writable — Baton ignores it`, `chmod o-w "${dir}"`);
  } catch {
    return null; // no .baton yet: nothing to judge
  }
}

async function checkTmux(): Promise<SetupItem> {
  return (await detectTmux())
    ? item('tmux', 'ok', 'tmux found')
    : item('tmux', 'warn', 'tmux not found — headless agents cannot be started');
}

/** Every setup check, run concurrently. */
export async function setupChecks(root: string): Promise<SetupItem[]> {
  const ports = daemonPorts(root);
  const [gitItem, daemon, mcp, hooks, graphify, baton, tmux] = await Promise.all([
    checkGit(),
    ports.then(checkDaemon),
    ports.then((d) => checkMcp(root, d.live)),
    checkHooks(root),
    checkGraphify(root),
    checkBatonDir(root),
    checkTmux(),
  ]);
  return [checkNode(), gitItem, daemon, ...mcp, ...(hooks ? [hooks] : []), checkDashboard(), graphify, ...(baton ? [baton] : []), tmux];
}

const GLYPH: Record<SetupLevel, string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** Print the setup section; any failure makes doctor exit 1. */
export function printSetup(items: SetupItem[]): void {
  console.log('Setup:\n');
  for (const i of items) {
    console.log(`  ${GLYPH[i.level]} ${i.detail}`);
    if (i.fix) console.log(`      → ${i.fix}`);
  }
  if (items.some((i) => i.level === 'fail')) process.exitCode = 1;
}
