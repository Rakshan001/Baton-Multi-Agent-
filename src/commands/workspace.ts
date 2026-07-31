/**
 * `baton workspace show` + `baton join` — reproduce one hub's folder layout on
 * another machine.
 *
 * The pair exists because Baton's coordination is anchored to repo-relative
 * paths (see src/workspace.ts). `workspace show` emits the layout of the hub you
 * are in; `join` consumes it in an empty folder and clones every repo back to
 * the same relative place, so memory anchors and edit signals refer to the same
 * strings on both machines.
 *
 * Deliberately NOT a second setup path: once the clones land, this hands off to
 * `baton setup --hub`, which already owns git init, the hub .gitignore, kb init
 * and agent wiring.
 */
import { existsSync } from 'node:fs';
import { readdir, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gitTry } from '../util/exec.js';
import { isGitRepo } from '../git.js';
import { findNestedGitRepos } from '../kb/projects.js';
import { setupCmd } from './setup.js';
import { saveHostLink } from '../host-link.js';
import {
  branchOf, cleanManifest, hasEmbeddedCredentials, readManifest, remoteOf, writeManifest,
  WORKSPACE_VERSION, WorkspaceValidationError,
  type WorkspaceManifest, type WorkspaceProject,
} from '../workspace.js';

/* ------------------------------------------------------------------ */
/* Building a manifest from the hub you are standing in                */
/* ------------------------------------------------------------------ */

/** A repo that cannot be described in the manifest, and why. */
export interface SkippedRepo { name: string; why: string }

export interface BuiltManifest {
  manifest: WorkspaceManifest;
  skipped: SkippedRepo[];
}

/**
 * Describe `root` as a manifest. A repo with no `origin` is SKIPPED rather than
 * written with an empty remote: the joiner could not clone it, and an entry that
 * silently produces nothing is worse than one that was never there.
 */
export async function buildManifest(root: string): Promise<BuiltManifest> {
  const nested = await findNestedGitRepos(root);
  const candidates: Array<{ id: string; name: string; path: string; rel: string }> =
    nested.length >= 1
      ? nested.map((r) => ({ id: r.id, name: r.name, path: r.path, rel: relative(root, r.path) }))
      : (await isGitRepo(root))
        ? [{ id: basename(root).toLowerCase(), name: basename(root), path: root, rel: basename(root) }]
        : [];

  if (!candidates.length) {
    throw new WorkspaceValidationError(
      `no git repositories found in ${root} — run this inside a hub (or a repo) that Baton has set up`,
    );
  }

  const projects: WorkspaceProject[] = [];
  const skipped: SkippedRepo[] = [];
  for (const c of candidates) {
    const remote = await remoteOf(c.path);
    if (!remote) {
      skipped.push({ name: c.name, why: 'no `origin` remote — a teammate would have nothing to clone from' });
      continue;
    }
    const branch = await branchOf(c.path);
    projects.push({
      id: c.id,
      remote,
      path: c.rel.replace(/\\/g, '/'),
      ...(branch ? { defaultBranch: branch } : {}),
    });
  }

  if (!projects.length) {
    throw new WorkspaceValidationError(
      'every repository here lacks an `origin` remote, so none of them can be cloned by anyone else',
    );
  }

  return {
    manifest: cleanManifest({
      version: WORKSPACE_VERSION,
      name: basename(root),
      createdAt: new Date().toISOString(),
      projects,
    }),
    skipped,
  };
}

export interface WorkspaceShowOpts {
  /** Also persist to `.baton/workspace.json` (default: print only). */
  write?: boolean;
}

/**
 * Print the manifest as JSON on stdout so it can be redirected to a file and
 * handed over: `baton workspace show > workspace.json`. Notes and warnings go to
 * stderr, so the redirect captures clean JSON.
 */
export async function workspaceShowCmd(path: string | undefined, opts: WorkspaceShowOpts = {}): Promise<void> {
  const root = resolve(path ?? '.');
  const { manifest, skipped } = await buildManifest(root);

  console.log(JSON.stringify(manifest, null, 2));

  for (const s of skipped) console.error(`  ! skipped ${s.name}: ${s.why}`);
  if (opts.write) {
    const written = await writeManifest(root, manifest);
    console.error(`  ✓ also written to ${written}`);
  }
  console.error(
    `\n  ${manifest.projects.length} project(s). Hand this file to a teammate; they run:\n` +
    '      baton join workspace.json <empty-folder>',
  );
}

/* ------------------------------------------------------------------ */
/* Joining                                                             */
/* ------------------------------------------------------------------ */

export type JoinStatus = 'cloned' | 'present' | 'failed';

export interface JoinOutcome {
  id: string;
  /** Repo-relative destination, as written in the manifest. */
  path: string;
  status: JoinStatus;
  detail?: string;
}

/** True when the directory does not exist, or exists and holds nothing. */
async function isEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/**
 * Clone one project into place.
 *
 * Re-running `join` must be safe, because the expected failure here is
 * network/auth on one repo out of five — so an existing checkout of the SAME
 * remote counts as success ('present') and is left completely untouched. An
 * existing directory holding anything else is refused rather than merged into:
 * silently cloning on top of someone's work is unrecoverable.
 */
async function cloneOne(targetRoot: string, p: WorkspaceProject): Promise<JoinOutcome> {
  const dest = join(targetRoot, p.path);
  const base = { id: p.id, path: p.path };

  if (existsSync(dest) && !(await isEmptyDir(dest))) {
    if (await isGitRepo(dest)) {
      const existing = await remoteOf(dest);
      if (existing && existing === p.remote) return { ...base, status: 'present', detail: 'already cloned' };
      return {
        ...base,
        status: 'failed',
        detail: existing
          ? `a different repo is already here (origin ${existing})`
          : 'a git repo with no origin is already here',
      };
    }
    return { ...base, status: 'failed', detail: 'directory exists and is not empty' };
  }

  await mkdir(dirname(dest), { recursive: true });

  // `--` terminates options so a remote can never be read as a flag (the
  // manifest is untrusted; isSafeRemote already refuses a leading '-', this is
  // the second lock). Submodules are deliberately NOT recursed: that would
  // fetch and check out code from remotes the manifest never named.
  const args = ['clone', ...(p.defaultBranch ? ['--branch', p.defaultBranch] : []), '--', p.remote, dest];
  const r = await gitTry(args);
  if (!r.ok) {
    const why = (r.stderr.split('\n').find((l) => l.trim()) ?? 'git clone failed').trim();
    return { ...base, status: 'failed', detail: why.slice(0, 300) };
  }
  return { ...base, status: 'cloned' };
}

export interface JoinOpts {
  /** Skip the `baton setup --hub` hand-off after cloning. */
  setup?: boolean;
  headless?: boolean;
  serve?: boolean;
  yes?: boolean;
  /** Member token, when joining from a host URL rather than a manifest file. */
  token?: string;
  /** Label for this machine in the host's roster. */
  device?: string;
}

/** Does this argument name a host to fetch from, rather than a file to read? */
export function looksLikeHostUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg.trim());
}

/**
 * Fetch the hub's layout from a running host.
 *
 * This is the endpoint Phase 2 deferred on purpose: its response drives
 * `git clone` on this machine, so it could not exist before there was
 * authentication in front of it. The token goes in the Authorization header and
 * never in the URL, which keeps it out of logs and error text.
 */
export async function fetchManifest(url: string, token: string, timeoutMs = 15_000): Promise<WorkspaceManifest> {
  const base = url.trim().replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/api/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new WorkspaceValidationError(`could not reach ${base} (${(e as Error).message}) — is the host running and reachable from here?`);
  }
  if (res.status === 401) {
    throw new WorkspaceValidationError(
      'the host rejected this token. Invites expire if unused (72 h by default) — ask for a fresh one.',
    );
  }
  if (!res.ok) throw new WorkspaceValidationError(`the host replied ${res.status} when asked for its workspace layout`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new WorkspaceValidationError(`${base} did not return JSON — is that really a Baton daemon?`);
  }
  // Validated exactly like a hand-delivered manifest: this arrived over the
  // network and is about to drive `git clone`, so it gets less trust, not more.
  return cleanManifest((body as { manifest?: unknown })?.manifest);
}

/** Clone every project in the manifest. Never throws on a single repo's failure. */
export async function joinWorkspace(m: WorkspaceManifest, targetRoot: string): Promise<JoinOutcome[]> {
  const out: JoinOutcome[] = [];
  for (const p of m.projects) out.push(await cloneOne(targetRoot, p));
  return out;
}

const MARK: Record<JoinStatus, string> = { cloned: '✓', present: '·', failed: '✗' };

export async function joinCmd(source: string, dir: string | undefined, opts: JoinOpts = {}): Promise<void> {
  if (process.platform === 'win32') {
    console.error('baton join is not supported on native Windows — run it inside WSL2.');
    console.error('  (Agent detection and terminals are POSIX-only; see SETUP.md.)');
    process.exitCode = 1;
    return;
  }

  /*
   * Two sources, one command: a handed-over manifest file (Phase 2) or a live
   * host URL plus a member token (the invite flow). The URL form is what makes
   * "one copied command in an empty folder" true — it fetches the layout,
   * clones, and remembers the host, so the joiner types nothing else.
   */
  const fromHost = looksLikeHostUrl(source);
  if (fromHost && !opts.token) {
    console.error('Joining from a host URL needs the token from your invite:');
    console.error(`  baton join ${source} --token baton_…`);
    console.error('  (Ask the hub owner to send you one — they mint it from the Team screen.)');
    process.exitCode = 1;
    return;
  }

  const manifest = fromHost
    ? await fetchManifest(source, opts.token!)
    : await readManifest(resolve(source));
  const targetRoot = resolve(dir ?? '.');

  // A manifest that still carries a token means one leaked into a file that gets
  // passed around. Clone with it (the joiner may genuinely need it), but say so.
  for (const p of manifest.projects) {
    if (hasEmbeddedCredentials(p.remote)) {
      console.error(`  ! ${p.id}: this remote embeds a credential — treat the manifest as a secret and rotate it.`);
    }
  }

  await mkdir(targetRoot, { recursive: true });
  console.log(`joining ${manifest.name ?? 'workspace'} → ${targetRoot}`);
  console.log(`  ${manifest.projects.length} repo(s) to place:\n`);

  const outcomes = await joinWorkspace(manifest, targetRoot);
  for (const o of outcomes) {
    console.log(`  ${MARK[o.status]} ${o.path}${o.detail ? ` — ${o.detail}` : ''}`);
  }

  const failed = outcomes.filter((o) => o.status === 'failed');
  if (failed.length) {
    console.error(`\n✗ ${failed.length} of ${outcomes.length} repo(s) could not be placed.`);
    console.error('  Fix the cause (access, network, or an occupied directory) and re-run the same');
    console.error('  command — repos already cloned are detected and skipped.');
    /*
     * Setup is deliberately NOT run on a partial join. `kb init` would index
     * only the repos that landed and write a knowledge base that looks
     * complete — the "silent partial reads as a clean result" failure this
     * codebase refuses everywhere else.
     */
    console.error('  Baton setup was NOT run: indexing a partial hub would produce a KB that looks complete.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ all ${outcomes.length} repo(s) in place under ${targetRoot}`);

  /*
   * Remember the host, so this machine's claims join the shared picture from
   * the next `baton serve` onward. Written only after every repo landed: a
   * half-joined folder that quietly starts publishing claims about files it
   * does not have would put noise into everyone else's `check_files`.
   */
  if (fromHost) {
    try {
      const path = await saveHostLink(targetRoot, {
        url: source,
        token: opts.token!,
        ...(opts.device ? { device: opts.device } : {}),
      });
      console.log(`  ✓ host remembered (0600 at ${path}) — your file claims will publish while \`baton serve\` runs`);
    } catch (e) {
      // Not fatal: the clones are the hard part and they succeeded. Say what
      // to run rather than failing a join that otherwise worked.
      console.error(`  ! could not save the host link (${(e as Error).message})`);
      console.error(`    Run it yourself:  baton host set ${source} --token <your token>`);
    }
  }

  if (opts.setup === false) {
    console.log('  (--no-setup) finish with:  baton setup ' + targetRoot + ' --hub');
    return;
  }
  console.log('\n→ handing off to `baton setup --hub` ...\n');
  await setupCmd(targetRoot, {
    hub: true,
    yes: true,
    ...(opts.headless ? { headless: true } : { serve: opts.serve ?? true }),
  });
}
