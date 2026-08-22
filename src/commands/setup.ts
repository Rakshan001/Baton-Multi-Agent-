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
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execa } from 'execa';
import { gitTry } from '../util/exec.js';
import { isGitRepo } from '../git.js';
import { detectProjects, findNestedGitRepos, PROJECT_MARKERS, type SubProject } from '../kb/projects.js';
import { askChoice, kbInitCmd } from './kb.js';
import { connectAgents, type AgentConnectOutcome } from '../agents/connect.js';
import { DEFAULT_CONNECT_AGENTS } from './connect.js';
import { askMultiSelect, askYesNo, shouldOfferGlobalInstall } from './setup-prompts.js';
import { detectGraphify, graphifyInstallCommand, installHint, uvInstallCommand, type GraphifyDetection } from '../kb/graphify.js';
import { agentInstalled } from '../agents/roster.js';
import { AGENTS } from '../agents/registry.js';
import { installSkillEverywhere, listSkillStatus } from '../skills/install.js';
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
async function preflight(root: string): Promise<{ graphify: GraphifyDetection; agents: string[] }> {
  console.log('\n  Baton — coordination hub for multiple AI coding agents\n');
  console.log(`  Scanning ${root} …`);

  const [graphify, isRepo, ...installed] = await Promise.all([
    detectGraphify(),
    isGitRepo(root),
    ...DEFAULT_CONNECT_AGENTS.map((id) => agentInstalled(id, root)),
  ] as const);
  const agents = DEFAULT_CONNECT_AGENTS.filter((_, i) => installed[i]);

  console.log(`    ${isRepo ? '✓ git repo' : '· not a git repo yet'}`);
  console.log(`    ✓ node ${process.versions.node}`);
  console.log(
    graphify.ok
      ? `    ✓ graphify ${graphify.version ?? ''}`.trimEnd()
      : '    ✗ graphify — the knowledge graph stays off until it is installed',
  );
  console.log(agents.length ? `    ✓ agents on PATH: ${agents.join(', ')}` : '    · no agent CLIs found on PATH yet');

  // Said during the scan, before a single file is written: if they installed
  // Baton the wrong way, that is the thing to fix first.
  const misinstalled = batonAsDependency(await readPackageJson(root));
  if (misinstalled) console.log(misinstalled);

  return { graphify, agents };
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
async function chooseAgents(opts: SetupOpts, installed: string[]): Promise<string[]> {
  if (opts.agents !== undefined) {
    return opts.agents.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const recommended = installed.length ? installed : [...DEFAULT_CONNECT_AGENTS];
  if (opts.yes) return recommended;

  return askMultiSelect(
    '\n  Which agents should Baton wire up?',
    DEFAULT_CONNECT_AGENTS.map((id) => ({
      key: id,
      label: AGENTS[id]?.label ?? id,
      // The note belongs beside the row, not inside its name: "not installed"
      // is a fact about your machine, and wiring one up now is still useful —
      // the config is waiting the day you install it.
      hint: installed.includes(id) ? 'found on your PATH' : 'not installed — wiring it now still works',
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
  | { kind: 'bootstrap-uv'; cmd: string; args: string[]; line: string; then: string };

/**
 * Pure half of the graphify step, so the policy above is testable without
 * spawning an installer to find out whether it would have.
 */
export function graphifyStep(detection: GraphifyDetection, opts: SetupOpts): GraphifyStep {
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
  if (!uv) return { kind: 'no-installer', hint: installHint(detection) };

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

  console.log('\n  The knowledge graph needs the `graphify` CLI (Python).');

  if (step.kind === 'no-installer') {
    console.log(`    Install it yourself when convenient: ${step.hint}`);
    console.log('    Everything else works without it.');
    return false;
  }
  if (step.kind === 'deferred') {
    const later = step.then ? `${step.line}, then ${step.then}` : step.line;
    console.log(`    Not installed under --yes (it installs software). Later: ${later}`);
    return false;
  }

  // Nothing installed at all, but a package manager can bootstrap the chain.
  if (step.kind === 'bootstrap-uv') {
    console.log(`    uv is not installed either, but \`${step.cmd}\` can install it.`);
    console.log(`    Two commands: \`${step.line}\`, then \`${step.then}\`.`);
    console.log('    uv brings its own Python, so nothing else has to be installed.');
    if (!(await askYesNo('    Install both now?', true))) {
      console.log(`    Skipped — the graph stays off. Later: ${step.line}, then ${step.then}`);
      return false;
    }
    if (!(await runInstall(step.cmd, step.args, step.line))) return false;

    // Re-probe rather than trusting the exit code: a package manager can
    // succeed while putting uv somewhere this process's PATH cannot see.
    const afterUv = await detectGraphify();
    if (afterUv.ok) { console.log('    ✓ graphify installed.'); return true; }
    if (!afterUv.uv) {
      console.log('    ✓ uv installed, but not visible on PATH from here.');
      console.log(`      Open a new shell, then run: ${step.then}`);
      return false;
    }
    if (!(await runInstall('uv', ['tool', 'install', 'graphifyy'], step.then))) return false;
    return await confirmGraphify(step.then);
  }
  if (!(await askYesNo(`    Install it now with \`${step.line}\`?`, true))) {
    console.log(`    Skipped — the graph stays off. Later: ${step.line}`);
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
async function runInstall(cmd: string, args: string[], line: string): Promise<boolean> {
  try {
    await execa(cmd, args, { stdio: 'inherit', timeout: 10 * 60_000 });
    return true;
  } catch (e) {
    console.log(`    ! install failed: ${(e as Error).message.split('\n')[0]}`);
    console.log(`      Setup continues without the graph. Try later: ${line}`);
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
    console.log('    ✓ graphify installed.');
    return true;
  }
  console.log('    ✓ installed, but not visible on PATH from here.');
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
  console.log('\n  · Knowledge base skipped — it needs the graphify CLI.');
  console.log('    Everything else is set up: worktrees, tasks, edit signals, memory,');
  console.log('    handoff and the dashboard all work without the graph.');
  console.log('    Once graphify is installed, finish with:  baton kb init');
}

/** Offer the bundled skill catalog. Failure here never fails the setup. */
async function offerSkills(root: string, opts: SetupOpts): Promise<void> {
  let bundled: string[];
  try {
    bundled = (await listSkillStatus(root)).filter((s) => s.source === 'bundled').map((s) => s.id);
  } catch (e) {
    // Never silently: this used to `return` with nothing printed, so a broken
    // catalog cost the user all twelve skills while setup still ended in a tick
    // — the same green-over-half-done failure the knowledge-graph step had.
    console.log(`\n  ! could not read the skills catalog (${(e as Error).message.split('\n')[0]})`);
    console.log('    No skills were installed. `baton skills list` shows what should be there.');
    return;
  }
  if (!bundled.length) return;

  if (!opts.yes && !(await askYesNo(`\n  Install ${bundled.length} bundled skills into your agents?`, true))) {
    console.log('    Skipped — `baton skills list` shows them whenever you want.');
    return;
  }

  let installed = 0;
  for (const id of bundled) {
    // One unsupported agent or unwritable dir must not cost the other skills.
    try {
      await installSkillEverywhere(root, id);
      installed++;
    } catch { /* reported in the count below */ }
  }
  console.log(`    ✓ installed ${installed}/${bundled.length} skills`);
  if (installed < bundled.length) console.log('      (the rest need an agent with a skills directory — `baton skills list`)');
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

  const agents = await chooseAgents(opts, scan.agents);
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
      console.log(`\nfound ${t.repos.length} separate git repos under ${basename(root)}:`);
      for (const r of t.repos) console.log(`  • ${r.name}`);
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
        await setupHub(root, t.repos, opts, agents, graphOk);
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
