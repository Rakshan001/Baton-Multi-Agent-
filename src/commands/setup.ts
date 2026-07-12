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
import { gitTry } from '../util/exec.js';
import { isGitRepo } from '../git.js';
import { detectProjects, findNestedGitRepos, PROJECT_MARKERS, type SubProject } from '../kb/projects.js';
import { askChoice, kbInitCmd } from './kb.js';
import { connectAgents, type AgentConnectOutcome } from '../agents/connect.js';
import { DEFAULT_CONNECT_AGENTS } from './connect.js';

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
}

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
async function finishSingle(root: string, opts: SetupOpts, headline: string): Promise<void> {
  if ((await chooseUseMode(opts)) === 'dashboard') {
    const port = await nextFreePort(7077, new Set());
    console.log(`\n✓ ${headline}. Open the dashboard:`);
    console.log(`    cd ${root} && baton serve -p ${port} --write   →  http://localhost:${port}`);
  } else {
    console.log(`\n✓ ${headline}. Agents read it over MCP — no dashboard needed.`);
    console.log('    (Run `baton serve` here anytime to open the dashboard.)');
  }
  await connectAllAgents(root, opts);
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
 * Wire every agent to the `baton` coordination MCP server so they can see each
 * other's edits/tasks. Project-scoped (claude/cursor) write now; global
 * (codex/gemini) need --yes. Best-effort — never blocks a finished setup.
 */
async function connectAllAgents(root: string, opts: SetupOpts): Promise<void> {
  try {
    const outcomes = await connectAgents(root, DEFAULT_CONNECT_AGENTS, { confirmGlobal: opts.yes });
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
  const t = await classifyTarget(root);

  switch (t.kind) {
    case 'single-repo':
      console.log(`✓ ${basename(t.root)} is a git repo — setting up Baton here.`);
      await kbInitCmd(t.root, kbOpts(opts));
      return finishSingle(t.root, opts, `${basename(t.root)} is ready`);

    case 'single-subrepo':
      console.log(`found one git repo (${t.repo.name}) under ${basename(root)} — setting it up.`);
      await kbInitCmd(t.repo.path, kbOpts(opts));
      return finishSingle(t.repo.path, opts, `${t.repo.name} is ready`);

    case 'bare-project': {
      console.log(`${basename(root)} has project files but is not a git repo.`);
      const go = opts.yes || opts.hub
        ? 'yes'
        : await askChoice('Initialize a git repo here and set up Baton?',
            [{ key: 'yes', label: 'Yes — git init here, then set up' }, { key: 'no', label: 'Cancel' }], 'yes');
      if (go !== 'yes') return void console.log('cancelled.');
      await gitInit(root);
      await kbInitCmd(root, kbOpts(opts));
      return finishSingle(root, opts, `${basename(root)} is ready`);
    }

    case 'multi-repo': {
      console.log(`found ${t.repos.length} separate git repos under ${basename(root)}:`);
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
      return mode === 'hub' ? setupHub(root, t.repos, opts) : setupIndividual(t.repos, opts);
    }

    case 'empty':
      console.error(`Nothing to set up in ${root}.`);
      console.error('  Run inside a git repo, or in a folder that contains one or more git repos.');
      process.exitCode = 1;
      return;
  }
}

/** Centralized hub: make the container root a git repo, then one kb init (merged graph). */
async function setupHub(root: string, repos: SubProject[], opts: SetupOpts): Promise<void> {
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
  return finishSingle(root, opts, 'centralized hub ready');
}

/** Per-repo setup: run kb init inside each repo; suggest a port per repo. */
async function setupIndividual(repos: SubProject[], opts: SetupOpts): Promise<void> {
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
    await connectAllAgents(b.path, opts);
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
