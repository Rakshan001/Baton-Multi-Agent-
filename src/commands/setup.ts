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
import { detectGraphify, graphifyInstallCommand, installHint, type GraphifyDetection } from '../kb/graphify.js';
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

type UseMode = 'dashboard' | 'headless';

/** Dashboard vs headless: --serve / --headless flags win, else ask (default dashboard). */
async function chooseUseMode(opts: SetupOpts): Promise<UseMode> {
  if (opts.serve) return 'dashboard';
  if (opts.headless) return 'headless';
  return askChoice(
    '\nHow will agents use this knowledge base?',
    [
      { key: 'dashboard', label: 'With the dashboard — realtime UI on localhost (baton serve)' },
      { key: 'headless', label: 'Headless — agents read it over MCP, no dashboard' },
    ],
    'dashboard',
  );
}

/** Closing next-steps for a single-root setup (single repo or hub), per chosen mode. */
async function finishSingle(root: string, opts: SetupOpts, headline: string, agents: string[]): Promise<void> {
  if ((await chooseUseMode(opts)) === 'dashboard') {
    const port = await nextFreePort(7077, new Set());
    console.log(`\n✓ ${headline}. Open the dashboard:`);
    console.log(`    cd ${root} && baton serve -p ${port} --write   →  http://localhost:${port}`);
  } else {
    console.log(`\n✓ ${headline}. Agents read it over MCP — no dashboard needed.`);
    console.log('    (Run `baton serve` here anytime to open the dashboard.)');
  }
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
  return { graphify, agents };
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
      label: `${AGENTS[id]?.label ?? id}${installed.includes(id) ? '  (found on PATH)' : ''}`,
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
  | { kind: 'deferred'; line: string }
  | { kind: 'offer'; cmd: string; args: string[]; line: string };

/**
 * Pure half of the graphify step, so the policy above is testable without
 * spawning an installer to find out whether it would have.
 */
export function graphifyStep(detection: GraphifyDetection, opts: SetupOpts): GraphifyStep {
  if (detection.ok) return { kind: 'already' };

  const command = graphifyInstallCommand(detection);
  // No uv and no pipx. The remaining route is bare `pip`, which we will not run
  // on someone's behalf — see graphifyInstallCommand.
  if (!command) return { kind: 'no-installer', hint: installHint(detection) };

  const line = `${command.cmd} ${command.args.join(' ')}`;
  return mayInstallSoftware(opts)
    ? { kind: 'offer', cmd: command.cmd, args: command.args, line }
    : { kind: 'deferred', line };
}

/**
 * Offer to install graphify. Never blocks: the knowledge graph is one feature,
 * and worktrees, the dashboard, handoff, memory and coordination all work
 * without it. Someone who declines gets a working Baton, not a dead end.
 */
async function offerGraphify(detection: GraphifyDetection, opts: SetupOpts): Promise<void> {
  const step = graphifyStep(detection, opts);
  if (step.kind === 'already') return; // do not ask about what is already here

  console.log('\n  The knowledge graph needs the `graphify` CLI (Python).');

  if (step.kind === 'no-installer') {
    console.log(`    Install it yourself when convenient: ${step.hint}`);
    console.log('    Everything else works without it.');
    return;
  }
  if (step.kind === 'deferred') {
    console.log(`    Not installed under --yes (it installs software). Later: ${step.line}`);
    return;
  }
  if (!(await askYesNo(`    Install it now with \`${step.line}\`?`, true))) {
    console.log(`    Skipped — the graph stays off. Later: ${step.line}`);
    return;
  }

  try {
    await execa(step.cmd, step.args, { stdio: 'inherit', timeout: 5 * 60_000 });
    console.log('    ✓ graphify installed — run `baton reindex` to build the graph.');
  } catch (e) {
    // Offline, behind a proxy, a broken Python — none of it is Baton's problem
    // to solve, and none of it should cost the user the setup they came for.
    console.log(`    ! install failed: ${(e as Error).message.split('\n')[0]}`);
    console.log(`      Setup continues without the graph. Try later: ${step.line}`);
  }
}

/** Offer the bundled skill catalog. Failure here never fails the setup. */
async function offerSkills(root: string, opts: SetupOpts): Promise<void> {
  let bundled: string[];
  try {
    bundled = (await listSkillStatus(root)).filter((s) => s.source === 'bundled').map((s) => s.id);
  } catch {
    return; // no catalog on disk (an unusual install) — silently skip
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

  const agents = await chooseAgents(opts, scan.agents);
  const configured = await configureTarget(t, root, opts, agents);
  if (!configured) return; // the user cancelled at the git-init prompt

  // Closing steps, once per run rather than once per repo: both touch the
  // machine, not the project, so repeating them for each repo of a hub would
  // ask the same question three times and install the same thing three times.
  await offerGraphify(scan.graphify, opts);
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
): Promise<string | null> {
  switch (t.kind) {
    case 'single-repo':
      console.log(`\n✓ ${basename(t.root)} is a git repo — setting up Baton here.`);
      await kbInitCmd(t.root, kbOpts(opts));
      await finishSingle(t.root, opts, `${basename(t.root)} is ready`, agents);
      return t.root;

    case 'single-subrepo':
      console.log(`\nfound one git repo (${t.repo.name}) under ${basename(root)} — setting it up.`);
      await kbInitCmd(t.repo.path, kbOpts(opts));
      await finishSingle(t.repo.path, opts, `${t.repo.name} is ready`, agents);
      return t.repo.path;

    case 'bare-project': {
      console.log(`\n${basename(root)} has project files but is not a git repo.`);
      const go = opts.yes || opts.hub
        ? 'yes'
        : await askChoice('Initialize a git repo here and set up Baton?',
            [{ key: 'yes', label: 'Yes — git init here, then set up' }, { key: 'no', label: 'Cancel' }], 'yes');
      if (go !== 'yes') {
        console.log('cancelled.');
        return null;
      }
      await gitInit(root);
      await kbInitCmd(root, kbOpts(opts));
      await finishSingle(root, opts, `${basename(root)} is ready`, agents);
      return root;
    }

    case 'multi-repo': {
      console.log(`\nfound ${t.repos.length} separate git repos under ${basename(root)}:`);
      for (const r of t.repos) console.log(`  • ${r.name}`);
      const mode = opts.hub ? 'hub' : opts.individual ? 'individual'
        : await askChoice(
            '\nThese look like one project across several servers. How should Baton set them up?',
            [
              { key: 'hub', label: 'Centralized hub — one merged graph + one dashboard for all (recommended)' },
              { key: 'individual', label: 'Individually — each repo gets its own Baton setup' },
            ],
            'hub',
          );
      if (mode === 'hub') {
        await setupHub(root, t.repos, opts, agents);
        return root;
      }
      await setupIndividual(t.repos, opts, agents);
      // Skills install into ONE project's catalog; for individual mode the
      // first repo is the only defensible choice, and they all share the
      // bundled catalog anyway.
      return t.repos[0]?.path ?? root;
    }
  }
}

/** Centralized hub: make the container root a git repo, then one kb init (merged graph). */
async function setupHub(root: string, repos: SubProject[], opts: SetupOpts, agents: string[]): Promise<void> {
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
  await kbInitCmd(root, kbOpts(opts));
  return finishSingle(root, opts, 'centralized hub ready', agents);
}

/** Per-repo setup: run kb init inside each repo; suggest a port per repo. */
async function setupIndividual(repos: SubProject[], opts: SetupOpts, agents: string[]): Promise<void> {
  const used = new Set<number>();
  const built: { path: string; port: number }[] = [];
  for (const r of repos) {
    console.log(`\n=== ${r.name} ===`);
    await kbInitCmd(r.path, kbOpts(opts));
    built.push({ path: r.path, port: await nextFreePort(7077, used) }); // skip taken ports
  }
  if ((await chooseUseMode(opts)) === 'dashboard') {
    console.log('\n✓ all repos set up. Start each daemon, then add the ports as connections (top-left → Add connection…):');
    for (const b of built) console.log(`    cd ${b.path} && baton serve -p ${b.port} --write`);
  } else {
    console.log('\n✓ all repos set up. Agents read each repo’s KB over MCP — no dashboard needed.');
  }
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
