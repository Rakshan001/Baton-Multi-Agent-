/**
 * Knowledge-base export / import / git-sharing. One artifact layout feeds all
 * three paths (tarball download, tarball import, committed kb/ directory), so
 * a teammate can pick up a fully built KB without re-indexing — and the import
 * staleness check tells them exactly how far behind it is.
 *
 * Layout:
 *   kb-manifest.json                       (relativized kb.json + git HEAD)
 *   merged-graph.json                      (multi-project only)
 *   CODEBASE.md                            (root index, multi-project only)
 *   projects/<id>/graph.json
 *   projects/<id>/manifest.json            (graphify's own, if present)
 *   projects/<id>/GRAPH_REPORT.md          (if present)
 *   projects/<id>/.graphify_labels.json    (if present)
 *   projects/<id>/CODEBASE.md              (if present)
 */
import { execa } from 'execa';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { gitTry, probeBinary } from '../util/exec.js';
import { BATON_VERSION } from '../version.js';
import { readStats } from './graphify.js';
import { graphPathFor, loadKb, mergedGraphFile, saveKb, type KbProject, type KbState } from './state.js';

export interface KbManifest {
  batonVersion: string;
  createdAt: string;
  gitHead: string | null;
  projects: Array<{ id: string; name: string; relPath: string }>;
  merged: boolean;
}

/** Per-project files worth sharing (graphify's cache/ and graph.html stay local). */
const PROJECT_ARTIFACTS = ['graph.json', 'manifest.json', 'GRAPH_REPORT.md', '.graphify_labels.json'] as const;

export async function detectTar(): Promise<boolean> {
  return probeBinary('tar');
}

export async function buildManifest(root: string, state: KbState): Promise<KbManifest> {
  const head = await gitTry(['rev-parse', 'HEAD'], root);
  return {
    batonVersion: BATON_VERSION,
    createdAt: new Date().toISOString(),
    gitHead: head.ok ? head.stdout : null,
    projects: [...state.projects]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p) => ({ id: p.id, name: p.name, relPath: relative(root, p.path) || '.' })),
    merged: !!state.mergedGraphPath,
  };
}

/** Stage all shareable artifacts into destDir using the canonical layout. */
export async function collectKbArtifacts(root: string, state: KbState, destDir: string): Promise<KbManifest> {
  const manifest = await buildManifest(root, state);
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, 'kb-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  for (const p of state.projects) {
    const outDir = join(destDir, 'projects', p.id);
    await mkdir(outDir, { recursive: true });
    const graphifyOut = dirname(p.graphPath);
    for (const name of PROJECT_ARTIFACTS) {
      const src = join(graphifyOut, name);
      if (existsSync(src)) await cp(src, join(outDir, name));
    }
    const codebase = join(p.path, 'CODEBASE.md');
    if (existsSync(codebase)) await cp(codebase, join(outDir, 'CODEBASE.md'));
  }
  if (state.mergedGraphPath && existsSync(state.mergedGraphPath)) {
    await cp(state.mergedGraphPath, join(destDir, 'merged-graph.json'));
  }
  const rootIndex = join(root, 'CODEBASE.md');
  if (state.projects.length > 1 && existsSync(rootIndex)) {
    await cp(rootIndex, join(destDir, 'CODEBASE.md'));
  }
  return manifest;
}

export async function exportKb(root: string, state: KbState, outFile: string): Promise<{ file: string; bytes: number }> {
  if (!(await detectTar())) throw new Error('tar not found on PATH — required for kb export');
  const staging = await mkdtemp(join(tmpdir(), 'baton-kb-'));
  try {
    await collectKbArtifacts(root, state, staging);
    const out = isAbsolute(outFile) ? outFile : resolve(process.cwd(), outFile);
    await execa('tar', ['-czf', out, '-C', staging, '.'], { timeout: 120_000 });
    const st = await stat(out);
    return { file: out, bytes: st.size };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** For HTTP: stage, then stream `tar -czf -`. Caller must rm the staging dir when done. */
export async function stageForExport(root: string, state: KbState): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'baton-kb-'));
  await collectKbArtifacts(root, state, staging);
  return staging;
}

export interface ImportProjectResult {
  id: string;
  status: 'ok' | 'path-missing' | 'invalid-graph';
}
export interface ImportResult {
  projects: ImportProjectResult[];
  gitHead: string | null;
  commitsBehind: number | null;
  warnings: string[];
}

/** Re-anchor manifest projects onto this repo. Pure-testable. Throws on traversal. */
export function reanchorProjects(root: string, manifest: KbManifest): Array<{ project: KbProject; relPath: string; exists: boolean }> {
  return manifest.projects.map((m) => {
    const abs = resolve(root, m.relPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`manifest path escapes the repo: ${m.relPath}`);
    }
    return {
      project: { id: m.id, name: m.name, path: abs, graphPath: graphPathFor(abs) },
      relPath: m.relPath,
      exists: existsSync(abs),
    };
  });
}

async function isValidGraph(file: string): Promise<boolean> {
  const stats = await readStats(file);
  return stats !== null && stats.nodes > 0;
}

/** Import from a .tar.gz pack OR a kb/ directory (the committed share layout). */
export async function importKb(root: string, source: string): Promise<ImportResult> {
  const srcStat = await stat(source).catch(() => null);
  if (!srcStat) throw new Error(`no such file or directory: ${source}`);
  const fromDir = srcStat.isDirectory();
  if (!fromDir && !(await detectTar())) throw new Error('tar not found on PATH — required for kb import');
  const tmp = join(root, '.baton', 'kb-import-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const warnings: string[] = [];
  try {
    if (fromDir) {
      await cp(source, tmp, { recursive: true });
    } else {
      // A pack is untrusted input ("import someone else's KB"): refuse member
      // paths that could escape the staging dir before extracting (tar-slip).
      const { stdout: listing } = await execa('tar', ['-tzf', source], { timeout: 120_000 });
      const bad = listing.split('\n').find((m) => m.startsWith('/') || m.split('/').includes('..'));
      if (bad) throw new Error(`refusing to import: pack contains an unsafe path (${bad})`);
      await execa('tar', ['-xzf', source, '-C', tmp], { timeout: 120_000 });
    }
    const manifestFile = join(tmp, 'kb-manifest.json');
    if (!existsSync(manifestFile)) throw new Error('not a baton KB pack (kb-manifest.json missing)');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf-8')) as KbManifest;
    if (!Array.isArray(manifest.projects) || !manifest.projects.length) {
      throw new Error('KB pack has no projects');
    }

    const anchored = reanchorProjects(root, manifest);
    const results: ImportProjectResult[] = [];
    const imported: KbProject[] = [];

    for (const { project, exists } of anchored) {
      // The manifest is untrusted too: a crafted id must not escape the
      // staging dir via join(tmp, 'projects', id). Block ONLY path traversal —
      // legit ids (basename/relative-path slugs) may contain spaces, '@', or
      // unicode (see kb/projects.ts), so don't restrict the charset.
      const id = project.id;
      if (!id.trim() || /[\\/]/.test(id) || id === '.' || id === '..') {
        results.push({ id, status: 'invalid-graph' });
        warnings.push(`project '${id}': unsafe project id — skipped`);
        continue;
      }
      if (!exists) {
        results.push({ id: project.id, status: 'path-missing' });
        warnings.push(`project '${project.id}': path ${relative(root, project.path) || '.'} does not exist here — skipped`);
        continue;
      }
      const src = join(tmp, 'projects', project.id);
      const graphSrc = join(src, 'graph.json');
      if (!(await isValidGraph(graphSrc))) {
        results.push({ id: project.id, status: 'invalid-graph' });
        warnings.push(`project '${project.id}': graph.json missing or empty — skipped`);
        continue;
      }
      const graphifyOut = dirname(project.graphPath);
      await mkdir(graphifyOut, { recursive: true });
      for (const name of PROJECT_ARTIFACTS) {
        const f = join(src, name);
        if (existsSync(f)) await cp(f, join(graphifyOut, name));
      }
      const cb = join(src, 'CODEBASE.md');
      if (existsSync(cb)) await cp(cb, join(project.path, 'CODEBASE.md'));
      results.push({ id: project.id, status: 'ok' });
      imported.push(project);
    }

    if (!imported.length) throw new Error(`no projects could be imported: ${warnings.join('; ')}`);

    // Preserve local settings (share mode) across imports — the pack replaces
    // graphs and projects, not this repo's sharing preference.
    const previous = await loadKb(root);
    const state: KbState = {
      root,
      projects: imported,
      mergedGraphPath: null,
      lastBuiltAt: manifest.createdAt ?? null,
      share: previous?.share ?? false,
    };
    if (manifest.merged && existsSync(join(tmp, 'merged-graph.json'))) {
      const dest = mergedGraphFile(root);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(tmp, 'merged-graph.json'), dest);
      state.mergedGraphPath = dest;
    }
    if (existsSync(join(tmp, 'CODEBASE.md')) && imported.length > 1) {
      await cp(join(tmp, 'CODEBASE.md'), join(root, 'CODEBASE.md'));
    }
    await saveKb(root, state);
    if (state.share) await writeShareDir(root, state);

    // Staleness: how far has this repo moved since the pack was built?
    let commitsBehind: number | null = null;
    if (manifest.gitHead) {
      const behind = await gitTry(['rev-list', '--count', `${manifest.gitHead}..HEAD`], root);
      if (behind.ok) commitsBehind = Number(behind.stdout) || 0;
      else warnings.push(`pack was built at ${manifest.gitHead.slice(0, 7)}, which is not in this repo's history`);
    }
    return { projects: results, gitHead: manifest.gitHead, commitsBehind, warnings };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Git-share mode: mirror the artifact layout into a committed kb/ directory. */
export async function writeShareDir(root: string, state: KbState): Promise<string> {
  const dir = join(root, 'kb');
  await rm(dir, { recursive: true, force: true });
  await collectKbArtifacts(root, state, dir);
  await writeFile(
    join(dir, 'README.md'),
    [
      '# Shared knowledge base (generated by `baton kb`)',
      '',
      'Committed so teammates and agents get the code graph without re-indexing.',
      'After cloning this repo:',
      '',
      '```',
      'baton kb import kb/     # adopt the shared graphs locally',
      'baton kb rebuild        # then refresh to your current HEAD (incremental)',
      '```',
      '',
      'This folder is regenerated by `baton kb rebuild` while share mode is on',
      '(`baton kb share on|off`). Do not edit by hand.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return dir;
}
