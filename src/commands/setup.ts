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
import { basename, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { gitTry } from '../util/exec.js';
import { isGitRepo } from '../git.js';
import { detectProjects, findNestedGitRepos, PROJECT_MARKERS, type SubProject } from '../kb/projects.js';
import { askChoice, kbInitCmd } from './kb.js';

/** Options shared with `kb init`, plus the setup-mode flags. */
export interface SetupOpts {
  hub?: boolean;
  individual?: boolean;
  yes?: boolean;
  mcp?: boolean;
  docs?: boolean;
  share?: boolean;
  local?: boolean;
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

/** Non-Claude agents query the graph over MCP via these one-liners (Claude is auto-wired). */
function printOtherAgentMcp(): void {
  console.log('\n  Let Codex / Gemini / Cursor query the graph (which servers exist + how to navigate):');
  console.log('    baton kb mcp --agent codex     # prints Codex MCP config');
  console.log('    baton kb mcp --agent gemini    # Gemini');
  console.log('    baton kb mcp --agent cursor    # Cursor');
  console.log('  (Claude Code is wired automatically via .mcp.json.)');
}

export async function setupCmd(path: string | undefined, opts: SetupOpts = {}): Promise<void> {
  const root = resolve(path ?? '.');
  const t = await classifyTarget(root);

  switch (t.kind) {
    case 'single-repo':
      console.log(`✓ ${basename(t.root)} is a git repo — setting up Baton here.`);
      return kbInitCmd(t.root, kbOpts(opts));

    case 'single-subrepo':
      console.log(`found one git repo (${t.repo.name}) under ${basename(root)} — setting it up.`);
      return kbInitCmd(t.repo.path, kbOpts(opts));

    case 'bare-project': {
      console.log(`${basename(root)} has project files but is not a git repo.`);
      const go = opts.yes || opts.hub
        ? 'yes'
        : await askChoice('Initialize a git repo here and set up Baton?',
            [{ key: 'yes', label: 'Yes — git init here, then set up' }, { key: 'no', label: 'Cancel' }], 'yes');
      if (go !== 'yes') return void console.log('cancelled.');
      await gitInit(root);
      return kbInitCmd(root, kbOpts(opts));
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
  await ensureHubGitignore(root, repos);
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
  const port = await nextFreePort(7077, new Set());
  console.log('\n✓ centralized hub ready. Next:');
  console.log(`    cd ${root} && baton serve -p ${port} --write   →  http://localhost:${port}`);
  printOtherAgentMcp();
}

/** Per-repo setup: run kb init inside each repo; suggest a port per repo. */
async function setupIndividual(repos: SubProject[], opts: SetupOpts): Promise<void> {
  const used = new Set<number>();
  for (const r of repos) {
    console.log(`\n=== ${r.name} ===`);
    await kbInitCmd(r.path, kbOpts(opts));
    const port = await nextFreePort(7077, used); // skip ports already taken by a running daemon
    console.log(`    serve: cd ${r.path} && baton serve -p ${port} --write`);
  }
  console.log('\n✓ all repos set up. Add each port as a connection in one dashboard (top-left → Add connection…).');
  printOtherAgentMcp();
}

async function gitInit(root: string): Promise<void> {
  const r = await gitTry(['init', '-q'], root);
  if (!r.ok) throw new Error(`git init failed in ${root}: ${r.stderr}`);
}

/**
 * Hub root only hosts .baton/ + the merged KB — keep the embedded sub-repos and
 * generated artifacts untracked. Idempotent (skips lines already present).
 */
async function ensureHubGitignore(root: string, repos: SubProject[]): Promise<void> {
  const file = join(root, '.gitignore');
  const want = [
    ...repos.map((r) => `${relative(root, r.path)}/`),
    'node_modules/', '.baton/', 'graphify-out/', '.DS_Store',
  ];
  const current = existsSync(file) ? await readFile(file, 'utf-8') : '';
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = want.filter((w) => !have.has(w));
  if (missing.length === 0) return;
  const block = `${current.trimEnd()}\n\n# baton hub: keep sub-repos + generated files untracked\n${missing.join('\n')}\n`.replace(/^\n+/, '');
  await writeFile(file, block, 'utf-8');
}
