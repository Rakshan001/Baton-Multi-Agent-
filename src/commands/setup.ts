// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton setup [path]` — the friendly front door. Classifies the target folder
 * and routes to the right setup, so a folder that holds several *separate* git
 * repos (one project spread across servers) can be wired up as ONE centralized
 * hub (merged cross-project graph, one dashboard) or individually — without the
 * user hand-running `git init` + `.gitignore` + `kb init`.
 *
 * `baton kb init` stays the low-level command this reuses (src/commands/kb.ts).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { execa } from 'execa';
import { gitTry } from '../util/exec.js';
import { isGitRepo } from '../git.js';
import { detectProjects, findNestedGitRepos, PROJECT_MARKERS, type SubProject } from '../kb/projects.js';
import { askChoice, kbInitCmd } from './kb.js';
import { connectAgents, type AgentConnectOutcome } from '../agents/connect.js';
import { DEFAULT_CONNECT_AGENTS } from './connect.js';
import { askMultiSelect, askYesNo, shouldOfferGlobalInstall } from './setup-prompts.js';
import { detectGraphify, graphifyInstallCommand, installHint, uvInstallCommand, uvScriptInstall, uvScriptHint, type GraphifyDetection, type InstallerShell } from '../kb/graphify.js';
import { agentInstalled } from '../agents/roster.js';
import { AGENTS } from '../agents/registry.js';
import { installSkillEverywhere, listSkillStatus, isUserSkill } from '../skills/install.js';
import { PACKAGE_NAME } from '../version.js';

/** Options shared with `kb init`, plus the setup-mode flags. */
export interface SetupOpts {
  hub?: boolean;
  individual?: boolean;
  yes?: boolean;
  mcp?: boolean;
  docs?: boolean;
  share?: boolean;
  local?: boolean;
  /** Force the dashboard path (skip the prompt). */
  serve?: boolean;
  /** Force the headless / MCP-only path (skip the prompt). */
  headless?: boolean;
  /** Comma-separated agent ids to wire, skipping the prompt (`--agents claude,codex`). */
  agents?: string;
}

/**
 * What `--yes` means here, stated once because the rest of the file depends on
 * it: accept every default that touches THIS PROJECT, and never install
 * software. An unattended run is exactly where a surprise `uv tool install` or
 * `npm i -g` is least welcome, so those steps report themselves and move on
 * rather than taking their recommended answer.
 */

/**
 * The closing message, returned as data so a test can hold it to its promise.
 *
 * Setup used to ask which of these two facts to print — "how will agents use
 * this knowledge base: with the dashboard, or headless over MCP?" — as though
 * the answer switched machinery on and off. It never did. The answer reached
 * exactly one console.log branch; the graph, the KB, the MCP servers, the git
 * hooks, the skills and the agent wiring all ran either way, and the headless
 * branch's own second line invited you to run `baton serve` whenever you felt
 * like it. So the question charged the reader a decision and, worse, implied
 * they were giving something up by taking it.
 *
 * The dashboard is a viewer, not a mode. Both lines are true at once, so both
 * are printed and the question is gone.
 */
export function closingLines(root: string, headline: string, port: number, graphOk: boolean): string[] {
  const what = graphOk ? headline : `${headline} (without the knowledge graph)`;
  return [
    `\n✓ ${what}.`,
    '    Your agents can read it over MCP already — there is nothing else to start.',
    '    To watch them work, open the dashboard:',
    `      cd ${root} && baton serve -p ${port} --write   →  http://localhost:${port}`,
  ];
}

/**
 * `npm i batonhq` is the reflex, and it is the wrong move: npm reconciles the
 * host project's entire dependency tree, so a repo with native modules
 * recompiles them — and a node-gyp backtrace with `batonhq` in the command line
 * reads, to the person staring at it, exactly like Baton's fault. Baton is a
 * CLI; no code in a project ever imports it.
 *
 * Takes the parsed package.json rather than a path: it is arbitrary user input,
 * and a malformed one must not throw and take a finished setup down with it.
 */
export function batonAsDependency(pkg: unknown): string | null {
  if (typeof pkg !== 'object' || pkg === null) return null;
  const rec = pkg as Record<string, unknown>;
  const listedIn = (field: string): boolean => {
    const deps = rec[field];
    return typeof deps === 'object' && deps !== null && PACKAGE_NAME in deps;
  };
  if (!listedIn('dependencies') && !listedIn('devDependencies')) return null;
  return [
    `\n  ! ${PACKAGE_NAME} is listed in this project's package.json.`,
    '    Baton is a command-line tool, not a library — no code here imports it.',
    '    Kept as a dependency, every `npm install` in this project rebuilds it and',
    '    everything alongside it, native modules included. That is a long detour',
    '    for a CLI, and when one of those rebuilds fails it looks like Baton broke.',
    '',
    `    Remove it:  npm remove ${PACKAGE_NAME}`,
    `    Then run:   npx ${PACKAGE_NAME} <command>     — no install at all`,
    "                npm i -g " + PACKAGE_NAME + "          — puts `baton` on your PATH",
  ].join('\n');
}

/** Closing next-steps for a single-root setup (single repo or hub). */
async function finishSingle(root: string, opts: SetupOpts, headline: string, agents: string[], graphOk: boolean): Promise<void> {
  const port = await nextFreePort(7077, new Set());
  for (const line of closingLines(root, headline, port, graphOk)) console.log(line);
  await connectAllAgents(root, opts, agents);
}

/** Forwarded to kbInitCmd (strip the setup-only flags). */
function kbOpts(o: SetupOpts) {
  return { mcp: o.mcp, docs: o.docs, share: o.share, local: o.local };
}

export type Target =
  | { kind: 'single-repo'; root: string }
  | { kind: 'multi-repo'; root: string; repos: SubProject[] }
  | { kind: 'single-subrepo'; root: string; repo: SubProject }
  | { kind: 'bare-project'; root: string }
  | { kind: 'empty'; root: string };

/**
 * Decide how a folder should be set up. Pure-ish (only reads the filesystem +
 * `git rev-parse`), so it is unit-testable without side effects.
 */
export async function classifyTarget(absPath: string): Promise<Target> {
  // Nested git repos are discovered independently of a root marker, so a
  // container holding several repos AND a shared root package.json is still a
  // hub. This also keeps an already-`git init`-ed hub as multi-repo on re-run.
  const gitRepos = await findNestedGitRepos(absPath);

  if (gitRepos.length >= 2) return { kind: 'multi-repo', root: absPath, repos: gitRepos };

  // Otherwise, the container being a git repo means a normal single project
  // (a monorepo has no nested .git dirs, so it lands here, not in multi-repo).
  if (await isGitRepo(absPath)) return { kind: 'single-repo', root: absPath };

  if (gitRepos.length === 1) return { kind: 'single-subrepo', root: absPath, repo: gitRepos[0] };

  const nested = (await detectProjects(absPath)).filter((p) => p.path !== absPath);
  const hasMarkers = PROJECT_MARKERS.some((m) => existsSync(join(absPath, m))) || nested.length > 0;
  return hasMarkers ? { kind: 'bare-project', root: absPath } : { kind: 'empty', root: absPath };
}

/** True if a TCP port is bindable on loopback (i.e. free right now). */
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** First free port at/after `start`, skipping `used` (so callers don't double-assign). */
async function nextFreePort(start: number, used: Set<number>): Promise<number> {
  let p = start;
  while (used.has(p) || !(await portFree(p))) p++;
  used.add(p);
  return p;
}

const CONNECT_LINE: Record<AgentConnectOutcome['status'], (o: AgentConnectOutcome) => string> = {
  connected: (o) => `    ✓ ${o.agent} — wired for coordination`,
  already: (o) => `    · ${o.agent} — already connected`,
  'needs-confirm': (o) => `    ! ${o.agent} — needs a global write (rerun below)`,
  unsupported: (o) => `    – ${o.agent} — start it in the worktree manually`,
  'parse-error': (o) => `    ✗ ${o.agent} — config unparseable; left untouched`,
};

/**
 * What this machine can offer, printed once before anything is written.
 *
 * A wizard that starts by asking questions makes the user guess what it already
 * knows. Showing the scan first means every later prompt is read against
 * visible facts — "install graphify?" lands differently when the line above
 * says it is missing.
 */
async function preflight(root: string): Promise<{ graphify: GraphifyDetection; agents: string[]; presence: Record<string, AgentPresence> }> {
  console.log('\n  Baton — coordination hub for multiple AI coding agents\n');
  console.log(`  Scanning ${root} …`);

  const [graphify, isRepo, ...found] = await Promise.all([
    detectGraphify(),
    isGitRepo(root),
    ...DEFAULT_CONNECT_AGENTS.map((id) => detectAgentPresence(id, root)),
  ] as const);
  const presence: Record<string, AgentPresence> = {};
  DEFAULT_CONNECT_AGENTS.forEach((id, i) => { presence[id] = found[i]; });
  const agents = DEFAULT_CONNECT_AGENTS.filter((id) => presence[id] !== 'none');

  console.log(`    ${isRepo ? '✓ git repo' : '· not a git repo yet'}`);
  console.log(`    ✓ node ${process.versions.node}`);
  console.log(
    graphify.ok
      ? `    ✓ knowledge graph ${graphify.version ?? ''}`.trimEnd()
      : '    · knowledge graph — not set up yet (optional)',
  );
  console.log(agents.length ? `    ✓ agents found: ${agents.join(', ')}` : '    · no agents detected yet — you can still wire them');

  // Said during the scan, before a single file is written: if they installed
  // Baton the wrong way, that is the thing to fix first.
  const misinstalled = batonAsDependency(await readPackageJson(root));
  if (misinstalled) console.log(misinstalled);

  return { graphify, agents, presence };
}

/** The host project's package.json, or null if absent/unreadable/not JSON. */
async function readPackageJson(root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    return null; // no package.json, unreadable, or invalid JSON — all the same here
  }
}

/**
 * Which agents to wire. Recommends the ones actually found on PATH, because a
 * list of four when you use one is a list you have to think about. With none
 * installed there is nothing to narrow to, so the full set is offered — the
 * config is then already right whenever the first agent shows up.
 */
async function chooseAgents(opts: SetupOpts, presence: Record<string, AgentPresence>): Promise<string[]> {
  if (opts.agents !== undefined) {
    return opts.agents.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const detected = DEFAULT_CONNECT_AGENTS.filter((id) => presence[id] !== 'none');
  const recommended = detected.length ? detected : [...DEFAULT_CONNECT_AGENTS];
  if (opts.yes) return recommended;

  return askMultiSelect(
    '\n  Which agents should Baton wire up?',
    DEFAULT_CONNECT_AGENTS.map((id) => ({
      key: id,
      label: AGENTS[id]?.label ?? id,
      // The note belongs beside the row, not inside its name — and it reports
      // HOW the agent was found, because an editor install is a real install.
      hint: agentPresenceHint(presence[id] ?? 'none', AGENTS[id]?.binary ?? id, AGENT_HOME_DIR[id]),
    })),
    recommended,
  );
}

/**
 * May this run install software on the machine?
 *
 * `--yes` accepts every default that touches THIS PROJECT, and installs
 * nothing. --yes is what CI, Dockerfiles and provisioning scripts run, which is
 * exactly where fetching a Python package or writing a global npm prefix is
 * least wanted and least visible. Anyone who wants the install can answer the
 * prompt, or run the one-line command printed in its place.
 */
export function mayInstallSoftware(opts: { yes?: boolean }): boolean {
  return !opts.yes;
}

/** What the graphify step should do, decided before anything is printed. */
export type GraphifyStep =
  | { kind: 'already' }
  | { kind: 'no-installer'; hint: string }
  | { kind: 'deferred'; line: string; then?: string }
  | { kind: 'offer'; cmd: string; args: string[]; line: string }
  /** Nothing installed, but a package manager can install uv, which installs graphify. */
  | { kind: 'bootstrap-uv'; cmd: string; args: string[]; line: string; then: string }
  /** Not even a package manager: offer Astral's installer script, interactively only. */
  | { kind: 'script-uv'; url: string; shell: InstallerShell; hint: string; then: string };

/**
 * The list shown before "hub, or individually?".
 *
 * It printed `basename(path)`, which is not unique. A real Flutter project
 * scanned as five repos of which two pairs shared a name, at different depths,
 * with nothing on screen to tell them apart — and that list is exactly what
 * someone reads to decide whether to merge them all into one knowledge graph.
 *
 * A colliding name gets its path relative to the scanned root; the rest stay
 * short, so the ordinary case reads no differently than it did.
 */
/**
 * How an agent was found — and the answer must not be "installed / not
 * installed", because that is not the question the wizard is asking.
 *
 * The probe used to be `agentInstalled`, which looks for the agent's binary.
 * For Cursor that binary is `cursor-agent`, a separate terminal CLI: someone
 * running the Cursor *editor* has no such file, and got told Cursor was not
 * installed while it sat open in front of them. Wiring an agent means writing
 * an MCP entry, which needs no CLI at all — so the editor's own config
 * directory counts, and says so.
 */
export type AgentPresence = 'cli' | 'config' | 'none';

/** Where each agent keeps its own settings, relative to the user's home. */
const AGENT_HOME_DIR: Record<string, string> = {
  claude: '.claude',
  cursor: '.cursor',
  codex: '.codex',
  gemini: '.gemini',
};

export function agentPresenceHint(presence: AgentPresence, binary: string, home?: string): string {
  if (presence === 'cli') return `${binary} on your PATH`;
  // Naming the directory keeps this honest for both halves: Cursor is an editor,
  // Codex and Gemini are CLIs whose config can exist without the binary.
  if (presence === 'config') return home ? `config found in ~/${home}` : 'config found on this machine';
  return 'not detected — wiring it now still works';
}

/** CLI first, then the agent's own config directory. */
export async function detectAgentPresence(id: string, root?: string): Promise<AgentPresence> {
  if (await agentInstalled(id, root)) return 'cli';
  const dir = AGENT_HOME_DIR[id];
  if (dir && existsSync(join(homedir(), dir))) return 'config';
  return 'none';
}

/**
 * Which of the discovered repos the hub should cover.
 *
 * "All of them, or each on its own" was the only offer, and neither is the
 * common shape: a folder of five repos is usually three that belong together
 * and two that do not. Everything is ticked, so Enter still means what it
 * always did.
 */
async function chooseHubRepos(
  repos: SubProject[],
  labels: string[],
  opts: SetupOpts,
): Promise<SubProject[]> {
  if (opts.yes) return repos;
  // Keyed by path: two repos can share a name, which is the whole reason
  // describeRepos exists.
  const picked = await askMultiSelect(
    '\n  Which repos should the hub cover?',
    repos.map((r, i) => ({ key: r.path, label: labels[i] ?? r.name })),
    repos.map((r) => r.path),
  );
  return repos.filter((r) => picked.includes(r.path));
}

/**
 * What was left out of a hub, and how to add it later.
 *
 * A hub over five repos when you wanted three used to mean answering
 * "individually" and setting up five. Now the repos are a checkbox list — and
 * unchecking one must not quietly cause work to happen to it, so what was
 * skipped is stated rather than left to be inferred from silence.
 */
export function excludedRepoNote(all: readonly string[], chosen: readonly string[]): string | null {
  const left = all.filter((r) => !chosen.includes(r));
  if (!left.length) return null;
  return [
    `  Not included, and nothing was written in them: ${left.join(', ')}`,
    '    Add one later by running `baton setup --hub` again from this folder.',
  ].join('\n');
}

export function describeRepos(root: string, repos: readonly SubProject[]): string[] {
  const count = new Map<string, number>();
  for (const r of repos) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return repos.map((r) => {
    if ((count.get(r.name) ?? 0) < 2) return r.name;
    // relative() is '' when the root IS the repo, and a root cannot collide
    // with anything below it — fall back to the name rather than an empty line.
    return relative(root, r.path) || r.name;
  });
}

/**
 * Pure half of the graphify step, so the policy above is testable without
 * spawning an installer to find out whether it would have.
 */
export function graphifyStep(
  detection: GraphifyDetection,
  opts: SetupOpts,
  /** A real terminal on both ends. The script rung needs it: askYesNo returns
   *  its fallback on EOF, so with stdin redirected a default-yes prompt is not
   *  consent — it is Baton running a remote script on nobody's say-so. */
  interactive: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): GraphifyStep {
  if (detection.ok) return { kind: 'already' };

  // uv or pipx is here: one command and we are done.
  const direct = graphifyInstallCommand(detection);
  if (direct) {
    const line = `${direct.cmd} ${direct.args.join(' ')}`;
    return mayInstallSoftware(opts)
      ? { kind: 'offer', cmd: direct.cmd, args: direct.args, line }
      : { kind: 'deferred', line };
  }

  // Neither is here. Bare `pip` is still refused — see graphifyInstallCommand —
  // but a package manager can install uv, and uv brings its own Python, so the
  // machine needs no system Python at all. Two argv commands, no shell.
  const uv = uvInstallCommand(detection);
  if (!uv) {
    // No package manager either. Astral's own installer is the last route, and
    // it is a remote script — so it is offered ONLY where a human can read the
    // URL and decline. Under --yes there is nobody to ask, and it stays a hint.
    const script = uvScriptInstall(detection);
    if (script && mayInstallSoftware(opts) && interactive) {
      return {
        kind: 'script-uv', url: script.url, shell: script.shell,
        hint: uvScriptHint(script), then: 'uv tool install graphifyy',
      };
    }
    return { kind: 'no-installer', hint: installHint(detection) };
  }

  const line = `${uv.cmd} ${uv.args.join(' ')}`;
  const then = 'uv tool install graphifyy';
  return mayInstallSoftware(opts)
    ? { kind: 'bootstrap-uv', cmd: uv.cmd, args: uv.args, line, then }
    : { kind: 'deferred', line, then };
}

/**
 * Offer to install graphify, and report whether it is usable afterwards.
 *
 * This runs BEFORE anything is written, which is the whole point: `kb init`
 * refuses outright without graphify (src/commands/kb.ts), so an offer made
 * after it would arrive too late to save the run — the user would have already
 * watched the knowledge base fail.
 *
 * Never blocks. Declining costs the knowledge graph and nothing else: worktrees,
 * tasks, edit signals, memory, handoff and the dashboard are all graph-free.
 */
async function offerGraphify(detection: GraphifyDetection, opts: SetupOpts): Promise<boolean> {
  const step = graphifyStep(detection, opts);
  if (step.kind === 'already') return true; // do not ask about what is already here

  console.log('\n  The knowledge graph maps your code so agents can navigate it');
  console.log('  instead of reading every file. It is optional.');

  if (step.kind === 'no-installer') {
    console.log(`    To set it up later, run: ${step.hint}`);
    console.log('    Everything else works without it.');
    return false;
  }
  if (step.kind === 'deferred') {
    const later = step.then ? `${step.line}, then ${step.then}` : step.line;
    console.log(`    Not set up under --yes (it installs software). Later: ${later}`);
    return false;
  }

  // Nothing installed at all, but a package manager can bootstrap the chain.
  if (step.kind === 'bootstrap-uv') {
    console.log(`    Baton would set it up with \`${step.cmd}\`, in two steps:`);
    console.log(`      ${step.line}`);
    console.log(`      ${step.then}`);
    console.log('    It brings its own Python, so nothing else is installed.');
    if (!(await askYesNo('    Set up the knowledge graph now?', true))) {
      console.log(`    Skipped — no knowledge graph. Later: ${step.line}, then ${step.then}`);
      return false;
    }
    // Quiet, because the probe below is what decides. A package manager can
    // fail the request and still leave the machine correct: winget answers
    // "no applicable upgrade" when uv is ALREADY installed, and reporting that
    // as a dead end is how a yes could not work on a machine that had uv.
    const ranOk = await runInstall(step.cmd, step.args, step.line, { quiet: true });

    // Re-probe rather than trusting the exit code, in both directions: a
    // package manager can succeed while putting uv somewhere this process's
    // PATH cannot see, and it can fail while uv sits there already.
    const afterUv = await detectGraphify();
    if (afterUv.ok) { console.log('    ✓ knowledge graph ready.'); return true; }
    if (!afterUv.uv) {
      if (!ranOk) {
        console.log(`    ! could not install uv with \`${step.cmd}\`.`);
        console.log(`      Setup continues without the graph. Try later: ${step.line}, then ${step.then}`);
        return false;
      }
      console.log('    ✓ set up, but not visible on PATH from here.');
      console.log(`      Open a new shell, then run: ${step.then}`);
      return false;
    }
    if (!(await runInstall('uv', ['tool', 'install', 'graphifyy'], step.then))) return false;
    return await confirmGraphify(step.then);
  }
  // No package manager at all. Astral's installer is the only route left, so
  // the URL goes on screen and the person decides.
  if (step.kind === 'script-uv') {
    console.log('    There is no package manager on this machine to set it up with.');
    console.log(`    Baton would download and run the official installer: ${step.url}`);
    console.log('    It brings its own Python, so nothing else is installed.');
    if (!(await askYesNo('    Set up the knowledge graph now?', true))) {
      console.log(`    Skipped — no knowledge graph. Later: ${step.hint}, then ${step.then}`);
      return false;
    }
    const ranOk = await runUvInstallerScript(step.url, step.shell);

    // Same re-probe as the package-manager path: the script can succeed while
    // putting uv where this process's PATH cannot see it — and uv may already
    // be present even when the script itself did not finish.
    const afterUv = await detectGraphify();
    if (afterUv.ok) { console.log('    ✓ knowledge graph ready.'); return true; }
    if (!afterUv.uv) {
      if (!ranOk) return false; // runUvInstallerScript has already said why
      console.log('    ✓ set up, but not visible on PATH from here.');
      console.log(`      Open a new shell, then run: ${step.then}`);
      return false;
    }
    if (!(await runInstall('uv', ['tool', 'install', 'graphifyy'], step.then))) return false;
    return await confirmGraphify(step.then);
  }

  console.log(`    One command sets it up: ${step.line}`);
  if (!(await askYesNo('    Set up the knowledge graph now?', true))) {
    console.log(`    Skipped — no knowledge graph. Later: ${step.line}`);
    return false;
  }

  if (!(await runInstall(step.cmd, step.args, step.line))) return false;
  return await confirmGraphify(step.line);
}

/**
 * Run one installer. `false` means it failed and said so.
 *
 * Offline, behind a proxy, a broken Python, a locked package manager — none of
 * it is Baton's problem to solve, and none of it should cost the user the setup
 * they came for. So a failure is reported and the run continues.
 */
/** Astral's installer is ~50KB; this is a bound, not a measurement. */
const MAX_INSTALLER_BYTES = 512 * 1024;

/**
 * A sanity check on what came back, NOT a security boundary — real trust here
 * is HTTPS plus the user having read the URL. What it is actually for is the
 * captive portal and the error page: a hotel wifi login screen must never be
 * handed to an interpreter. A shell script announces itself with a shebang;
 * PowerShell has no such marker, so there the meaningful test is that this is
 * not markup.
 */
export function looksLikeInstaller(body: string, shell: InstallerShell): boolean {
  const head = body.trimStart();
  if (!head || head.startsWith('<')) return false; // HTML/XML: a portal or an error
  return shell === 'powershell' ? true : head.startsWith('#!');
}

/**
 * Download Astral's uv installer and run it.
 *
 * Written to a file and run as `sh <file>` rather than piped through a shell:
 * argv only, so nothing in the response can be read as a shell metacharacter,
 * and the bytes that execute are bytes we could point at afterwards. It is
 * still a remote script, and it runs only after an explicit yes to a prompt
 * that named the URL.
 *
 * The shape check is a sanity guard, not a security boundary — a captive-portal
 * login page or an error body must never reach `sh`. Real trust here comes from
 * HTTPS and from the user having read the URL.
 */
async function runUvInstallerScript(url: string, shell: InstallerShell): Promise<boolean> {
  let dir: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!res.ok) {
      console.log(`    ! could not download the installer (HTTP ${res.status}). Nothing was run.`);
      return false;
    }
    // Redirects are followed, and a redirect chain can leave HTTPS. TLS is the
    // ONLY integrity guarantee this download has — there is no signature to
    // check — so a chain that ends on plain HTTP is a downgrade, and the bytes
    // that arrive are whatever the network decided to hand back.
    if (!res.url.startsWith('https://')) {
      console.log(`    ! the download was redirected off HTTPS (${res.url}). Nothing was run.`);
      return false;
    }
    // Checked BEFORE reading: res.text() buffers the whole response, so a size
    // check afterwards has already paid the memory. A server can lie about the
    // header, but this URL is a pinned HTTPS constant — anyone able to lie here
    // already controls the host, and buffering is then the least of it. So the
    // cheap honest-case guard, not a streaming reader.
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_INSTALLER_BYTES) {
      console.log(`    ! the installer download is unexpectedly large (${declared} bytes). Nothing was run.`);
      return false;
    }
    const body = await res.text();
    if (!looksLikeInstaller(body, shell) || body.length > MAX_INSTALLER_BYTES) {
      console.log('    ! that download does not look like the installer. Nothing was run.');
      console.log(`      Check ${url} in a browser before trying again.`);
      return false;
    }
    dir = await mkdtemp(join(tmpdir(), 'baton-uv-'));
    const ps = shell === 'powershell';
    const file = join(dir, ps ? 'install.ps1' : 'install.sh');
    await writeFile(file, body, { mode: 0o700 });
    // -NoProfile so a user's profile script is not dragged into this, and
    // -File so the path is an argument rather than something PowerShell parses.
    // Bypass is required because a freshly downloaded script is unsigned; it is
    // scoped to this one process invocation and changes no machine policy.
    await execa(
      ps ? 'powershell' : 'sh',
      ps ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file],
      { stdio: 'inherit', timeout: 10 * 60_000 },
    );
    return true;
  } catch (e) {
    console.log(`    ! install failed: ${(e as Error).message.split('\n')[0]}`);
    console.log(`      Setup continues without the graph. Try later: curl -LsSf ${url} | sh`);
    return false;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * winget's exit code for "the package is already installed and there is no
 * newer version" — APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE.
 *
 * Not an error to us. It is the state we were trying to reach, reported as a
 * failure because winget was asked to upgrade and had nothing to upgrade.
 */
export const WINGET_NO_UPGRADE = 0x8A15002B; // 2316632107

/**
 * Did the installer leave the machine in the state we wanted, whatever it
 * thought of the request?
 *
 * Normalised to unsigned first. 0x8A15002B is above 2^31, so anything that
 * round-trips it through a signed 32-bit int hands back -1978335189 — the same
 * code wearing a minus sign. execa reported the positive form on the machine
 * this was found on; the normalisation is so a different Node or platform
 * cannot quietly turn a benign exit back into a fatal one.
 */
export function isBenignInstallerExit(code: number | undefined): boolean {
  if (code === undefined) return false;
  const unsigned = code < 0 ? code >>> 0 : code;
  return unsigned === 0 || unsigned === WINGET_NO_UPGRADE;
}

/**
 * Run one installer.
 *
 * `quiet` suppresses the failure report for callers that are going to PROBE
 * afterwards and decide for themselves. That is not politeness: a caller which
 * re-probes can discover the tool is present anyway, and printing "install
 * failed, setup continues without the graph" immediately before installing the
 * graph would be a lie told in the right order.
 *
 * Offline, behind a proxy, a broken Python, a locked package manager — none of
 * it is Baton's problem to solve, and none of it should cost the user the setup
 * they came for. So a failure is reported and the run continues.
 */
async function runInstall(
  cmd: string, args: string[], line: string, opts: { quiet?: boolean } = {},
): Promise<boolean> {
  try {
    await execa(cmd, args, { stdio: 'inherit', timeout: 10 * 60_000 });
    return true;
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode;
    if (isBenignInstallerExit(code)) return true; // already installed; nothing to do
    if (!opts.quiet) {
      console.log(`    ! install failed: ${(e as Error).message.split('\n')[0]}`);
      console.log(`      Setup continues without the graph. Try later: ${line}`);
    }
    return false;
  }
}

/**
 * Trust the probe, not the exit code: `uv tool install` succeeds while placing
 * the binary in ~/.local/bin, which is on PATH here only because ensureBinPath()
 * appended it — and on a stripped PATH it still may not be. Claiming a graph we
 * cannot actually run would fail later, less legibly.
 */
async function confirmGraphify(line: string): Promise<boolean> {
  if ((await detectGraphify()).ok) {
    console.log('    ✓ knowledge graph ready.');
    return true;
  }
  console.log('    ✓ set up, but not visible on PATH from here.');
  console.log(`      Open a new shell and run \`baton kb init\` to finish the graph. (${line})`);
  return false;
}

/**
 * `kb init`, unless graphify is absent — in which case say precisely what is
 * being skipped and what still works, rather than letting kb init print its own
 * failure into the middle of a setup that then claims success.
 */
async function initKnowledgeBase(target: string, opts: SetupOpts, graphOk: boolean): Promise<void> {
  if (graphOk) {
    await kbInitCmd(target, kbOpts(opts));
    return;
  }
  console.log('\n  · Knowledge graph skipped.');
  console.log('    Everything else is set up: worktrees, tasks, edit signals, memory,');
  console.log('    handoff and the dashboard all work without the graph.');
  console.log('    Once it is set up, finish with:  baton kb init');
}

/**
 * Offer the skill catalog — Baton's bundled skills AND the user's own library.
 *
 * The library half is the point: skills uploaded in one project live in
 * ~/.baton/skills, and this is the moment a brand-new project either inherits
 * them or silently does not. It used to filter to `source === 'bundled'`, so
 * setting up project #2 quietly offered Baton's skills and none of the user's.
 */
/**
 * The skills ticked by default at setup.
 *
 * Everything used to be ticked, which was a fair default at twelve and a bad one
 * at thirty-three: pressing Enter installed the whole catalog into every agent,
 * including thirteen frontend design skills someone writing a Go service will
 * never open. A skill an agent loads but does not need is not free — it is
 * surface area in the agent's config and one more thing to scroll past.
 *
 * These two are the floor rather than a taste: `bug-fix` is the pipeline for the
 * thing every project eventually needs, and `lean-code` is the restraint that
 * keeps the rest of the catalog from being over-applied. Everything else is one
 * keypress away in the same list, and `baton skills install <id>` afterwards.
 */
export const RECOMMENDED_SKILLS = ['bug-fix', 'lean-code'] as const;

/**
 * Pre-ticked rows: the recommended pair, and only the ones actually present.
 * Filtering against the catalog keeps a renamed or removed skill from silently
 * pre-selecting nothing while the list still claims a recommendation.
 */
export function recommendedSkillIds(available: readonly { id: string }[]): string[] {
  const have = new Set(available.map((s) => s.id));
  return RECOMMENDED_SKILLS.filter((id) => have.has(id));
}

async function offerSkills(root: string, opts: SetupOpts): Promise<void> {
  let bundled: { id: string; name: string; description: string }[];
  let mine: { id: string; name: string; description: string }[] = [];
  try {
    const all = await listSkillStatus(root);
    bundled = all.filter((s) => s.source === 'bundled');
    mine = all.filter((s) => isUserSkill(s.source));
  } catch (e) {
    // Never silently: this used to `return` with nothing printed, so a broken
    // catalog cost the user all twelve skills while setup still ended in a tick
    // — the same green-over-half-done failure the knowledge-graph step had.
    console.log(`\n  ! could not read the skills catalog (${(e as Error).message.split('\n')[0]})`);
    console.log('    No skills were installed. `baton skills list` shows what should be there.');
    return;
  }
  // The user's own skills come FIRST: on a new project they are the ones the
  // person is looking for, and the ones they would notice missing.
  const offered = [...mine, ...bundled];
  if (!offered.length) return;

  const recommended = recommendedSkillIds(offered);

  // Say what is ticked and that the rest are right here — a short default with
  // no explanation reads as "Baton only has two skills".
  const label = mine.length
    ? `\n  Install skills into your agents? (${mine.length} of yours, ${bundled.length} from Baton)`
      + `\n  ${recommended.length} recommended and ticked — space to add any of the others`
    : `\n  Install bundled skills into your agents? (${bundled.length} available)`
      + `\n  ${recommended.length} recommended and ticked — space to add any of the others`;

  // --yes gets the same pair rather than the whole catalog: nobody is present to
  // untick, so the unattended path is exactly where installing thirty-three
  // skills into every agent does the most damage.
  const chosen = opts.yes
    ? recommended
    : await askMultiSelect(
        label,
        offered.map((s) => ({
          key: s.id,
          label: s.name,
          hint: shorten(mine.some((m) => m.id === s.id) ? `(yours) ${s.description}` : s.description),
        })),
        recommended,
      );

  if (!chosen.length) {
    console.log('    None installed — `baton skills list` shows them whenever you want.');
    return;
  }

  let installed = 0;
  for (const id of chosen) {
    // One unsupported agent or unwritable dir must not cost the other skills.
    try {
      await installSkillEverywhere(root, id);
      installed++;
    } catch { /* reported in the count below */ }
  }
  console.log(`    ✓ installed ${installed}/${chosen.length} skills`);
  if (installed < offered.length) {
    console.log(`      ${offered.length - installed} more available — \`baton skills install <id>\`, or see them with \`baton skills list\``);
  }
  if (installed < chosen.length) console.log('      (the rest need an agent with a skills directory — `baton skills list`)');
}

/** One short line beside a skill name; the full text is `baton skills list`. */
function shorten(text: string, max = 52): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Where `baton` resolves on PATH right now, or null. */
async function batonOnPath(): Promise<string | null> {
  try {
    const { stdout } = await execa(process.platform === 'win32' ? 'where' : 'which', ['baton'], { timeout: 5_000 });
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Close an `npx` run by offering the global install, so the next command can be
 * `baton new "…"` instead of `npx batonhq new "…"`. Skipped entirely for an
 * already-installed binary, and under --yes, which never installs software.
 */
async function offerGlobalInstall(opts: SetupOpts): Promise<void> {
  if (!mayInstallSoftware(opts)) return;
  if (!shouldOfferGlobalInstall(process.env, process.argv[1], await batonOnPath())) return;

  console.log('\n  You ran this through npx, so `baton` is not on your PATH yet.');
  if (!(await askYesNo(`  Install it globally now (npm i -g ${PACKAGE_NAME})?`, true))) {
    console.log(`    Skipped — every command also works as \`npx ${PACKAGE_NAME} <command>\`.`);
    return;
  }

  try {
    await execa('npm', ['install', '-g', PACKAGE_NAME], { stdio: 'inherit', timeout: 10 * 60_000 });
    console.log('    ✓ installed — `baton` is on your PATH.');
  } catch {
    // Overwhelmingly a permissions error on a root-owned npm prefix. The raw
    // npm output above says EACCES and little else, so say what to do about it.
    console.log('    ! global install failed — usually a permissions problem with the npm prefix.');
    console.log(`      Run it yourself:        npm install -g ${PACKAGE_NAME}`);
    console.log('      or use a user prefix:   npm config set prefix ~/.npm-global');
    console.log(`      or skip it entirely:    npx ${PACKAGE_NAME} <command>`);
  }
}

/**
 * Wire every agent to the `baton` coordination MCP server so they can see each
 * other's edits/tasks. Project-scoped (claude/cursor) write now; global
 * (codex/gemini) need --yes. Best-effort — never blocks a finished setup.
 */
async function connectAllAgents(root: string, opts: SetupOpts, agents: string[]): Promise<void> {
  if (!agents.length) {
    console.log('\n  No agents wired (you chose none) — `baton connect` does it later.');
    return;
  }
  try {
    const outcomes = await connectAgents(root, agents, { confirmGlobal: opts.yes });
    console.log('\n  Agents wired to Baton coordination (they can now see each other):');
    for (const o of outcomes) console.log(CONNECT_LINE[o.status](o));
    const deferred = outcomes.filter((o) => o.status === 'needs-confirm');
    if (deferred.length) {
      console.log(`    → finish the global ones: baton connect --agents ${deferred.map((o) => o.agent).join(',')} --yes`);
    }
    console.log('  (Graph/KB queries are separate: `baton kb mcp --agent <name>` or the dashboard.)');
  } catch (e) {
    console.log(`\n  ! could not auto-wire agents (${(e as Error).message}) — run \`baton connect\` when ready.`);
  }
}

export async function setupCmd(path: string | undefined, opts: SetupOpts = {}): Promise<void> {
  const root = resolve(path ?? '.');
  const scan = await preflight(root);
  const t = await classifyTarget(root);

  // Nothing to do — say so before asking a single question about how to do it.
  if (t.kind === 'empty') {
    console.error(`\nNothing to set up in ${root}.`);
    console.error('  Run inside a git repo, or in a folder that contains one or more git repos.');
    process.exitCode = 1;
    return;
  }

  // Before anything is written: `kb init` refuses without graphify, so an offer
  // made after it would arrive too late to rescue the run.
  const graphOk = await offerGraphify(scan.graphify, opts);

  const agents = await chooseAgents(opts, scan.presence);
  const configured = await configureTarget(t, root, opts, agents, graphOk);
  if (!configured) return; // the user cancelled at the git-init prompt

  // Closing step, once per run rather than once per repo: skills install into a
  // catalog every repo of a hub shares, so repeating it would ask three times.
  await offerSkills(configured, opts);
  await offerGlobalInstall(opts);
  console.log('');
}

/**
 * Run the setup that suits this target. Returns the configured root, or null if
 * cancelled.
 *
 * `empty` is excluded rather than handled: setupCmd has already reported it and
 * set an exit code, and taking it out of the union here is what lets the
 * compiler prove this switch is exhaustive — so a future Target variant is a
 * build error rather than a silent fall-through returning undefined.
 */
async function configureTarget(
  t: Exclude<Target, { kind: 'empty' }>,
  root: string,
  opts: SetupOpts,
  agents: string[],
  graphOk: boolean,
): Promise<string | null> {
  switch (t.kind) {
    case 'single-repo':
      console.log(`\n✓ ${basename(t.root)} is a git repo — setting up Baton here.`);
      await initKnowledgeBase(t.root, opts, graphOk);
      await finishSingle(t.root, opts, `${basename(t.root)} is ready`, agents, graphOk);
      return t.root;

    case 'single-subrepo':
      console.log(`\nfound one git repo (${t.repo.name}) under ${basename(root)} — setting it up.`);
      await initKnowledgeBase(t.repo.path, opts, graphOk);
      await finishSingle(t.repo.path, opts, `${t.repo.name} is ready`, agents, graphOk);
      return t.repo.path;

    case 'bare-project': {
      console.log(`\n${basename(root)} has project files but is not a git repo.`);
      const go = opts.yes || opts.hub
        ? 'yes'
        : await askChoice('Initialize a git repo here and set up Baton?',
            [
              { key: 'yes', label: 'Yes, git init here', hint: 'Baton needs a repo to track worktrees and edits' },
              { key: 'no', label: 'Cancel', hint: 'nothing has been written yet' },
            ], 'yes');
      if (go !== 'yes') {
        console.log('cancelled.');
        return null;
      }
      await gitInit(root);
      await initKnowledgeBase(root, opts, graphOk);
      await finishSingle(root, opts, `${basename(root)} is ready`, agents, graphOk);
      return root;
    }

    case 'multi-repo': {
      // One label list for the listing, the picker and the excluded note: they
      // must agree, and describeRepos disambiguates against the set it is given.
      const labels = describeRepos(root, t.repos);
      console.log(`\nfound ${t.repos.length} separate git repos under ${basename(root)}:`);
      for (const line of labels) console.log(`  • ${line}`);
      const mode = opts.hub ? 'hub' : opts.individual ? 'individual'
        : await askChoice(
            '\nThese look like one project across several servers. How should Baton set them up?',
            [
              { key: 'hub', label: 'Centralized hub', hint: 'one merged graph + one dashboard — recommended' },
              { key: 'individual', label: 'Individually', hint: 'a separate knowledge base per repo' },
            ],
            'hub',
          );
      if (mode === 'hub') {
        const chosen = await chooseHubRepos(t.repos, labels, opts);
        if (!chosen.length) {
          console.log('\n  No repos selected — nothing was written.');
          return null;
        }
        await setupHub(root, chosen, opts, agents, graphOk);
        const byPath = new Map(t.repos.map((r, i) => [r.path, labels[i]]));
        const note = excludedRepoNote(labels, chosen.map((r) => byPath.get(r.path) ?? r.name));
        if (note) console.log(`\n${note}`);
        return root;
      }
      await setupIndividual(t.repos, opts, agents, graphOk);
      // Skills install into ONE project's catalog; for individual mode the
      // first repo is the only defensible choice, and they all share the
      // bundled catalog anyway.
      return t.repos[0]?.path ?? root;
    }
  }
}

/** Centralized hub: make the container root a git repo, then one kb init (merged graph). */
async function setupHub(root: string, repos: SubProject[], opts: SetupOpts, agents: string[], graphOk: boolean): Promise<void> {
  if (!(await isGitRepo(root))) {
    console.log('\n→ git init (hub root) ...');
    await gitInit(root);
  }
  await ensureHubGitignore(root);
  // Give the daemon a HEAD to read (currentBranch tolerates an unborn HEAD too,
  // but a real commit keeps `git status` and tooling happy). Best-effort.
  if (!(await gitTry(['rev-parse', '--verify', 'HEAD'], root)).ok) {
    const c = await gitTry(['commit', '--allow-empty', '-m', 'baton hub: initial commit'], root);
    if (!c.ok && /user\.(name|email)|who you are/i.test(c.stderr)) {
      console.log('  ! no git identity — set one to enable commits:');
      console.log('      git config user.email you@example.com && git config user.name "You"');
    }
  }
  await initKnowledgeBase(root, opts, graphOk);
  return finishSingle(root, opts, 'centralized hub ready', agents, graphOk);
}

/** Per-repo setup: run kb init inside each repo; suggest a port per repo. */
async function setupIndividual(repos: SubProject[], opts: SetupOpts, agents: string[], graphOk: boolean): Promise<void> {
  const used = new Set<number>();
  const built: { path: string; port: number }[] = [];
  for (const r of repos) {
    console.log(`\n=== ${r.name} ===`);
    await initKnowledgeBase(r.path, opts, graphOk);
    built.push({ path: r.path, port: await nextFreePort(7077, used) }); // skip taken ports
  }
  console.log('\n✓ all repos set up. Agents read each repo’s KB over MCP already.');
  console.log('  To watch them, start each daemon and add the ports as connections (top-left → Add connection…):');
  for (const b of built) console.log(`    cd ${b.path} && baton serve -p ${b.port} --write`);
  for (const b of built) {
    console.log(`\n  [${basename(b.path)}]`);
    await connectAllAgents(b.path, opts, agents);
  }
}

async function gitInit(root: string): Promise<void> {
  const r = await gitTry(['init', '-q'], root);
  if (!r.ok) throw new Error(`git init failed in ${root}: ${r.stderr}`);
}

/**
 * The hub root is almost always an existing folder full of the user's own files
 * — the embedded sub-repos, plus loose docs/READMEs/notes. This git repo exists
 * ONLY for Baton's coordination scaffolding; it must not claim any of those as
 * tracked content (otherwise every unrelated file shows up as "untracked" noise).
 * So: ignore everything by default, then un-ignore just what Baton manages — the
 * shareable `kb/` directory (present only in --share mode) and this file itself.
 * `.baton/` stays ignored (per-machine local state). Idempotent.
 */
async function ensureHubGitignore(root: string): Promise<void> {
  const file = join(root, '.gitignore');
  const desired =
    [
      '# Baton hub root — this git repo exists only for Baton coordination,',
      "# not to version your project files. Everything is ignored by default;",
      '# Baton un-ignores only the paths it manages (the shareable KB).',
      '/*',
      '!/.gitignore',
      '!/kb/',
    ].join('\n') + '\n';
  const current = existsSync(file) ? await readFile(file, 'utf-8') : '';
  if (current === desired) return;
  await writeFile(file, desired, 'utf-8');
}
