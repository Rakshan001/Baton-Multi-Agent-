// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — resolve a skill from a GitHub repo

   A skill worth having is rarely one markdown file. The ones people
   actually share ship a `references/` folder, a `scripts/` folder and
   a data directory, and a bare SKILL.md pulled out of that tree is a
   skill that tells the agent to run a script which is not there.

   So: given anything a person might paste — a repo URL, a folder URL,
   a blob URL, or the whole `npx skills add … --skill …` line copied
   out of a README — work out which directory holds the skill, then
   fetch that directory.

   Deliberately network-free except through the `fetchText` argument.
   Everything that decides WHAT to fetch is a pure function, so the
   parsing and the path-picking are unit-tested without a socket.
   ============================================================ */

/** How the caller fetches text. Injected so this module stays testable and so
 *  the SSRF/redirect/size guards live in one place (install.ts) rather than two. */
export type FetchText = (url: string, max: number) => Promise<string>;

/** A skill directory found in a repo tree. */
export interface SkillCandidate {
  /** Shortcut it would get: the directory name (or the repo name at the root). */
  id: string;
  /** Repo-relative directory holding SKILL.md; '' when SKILL.md is at the root. */
  dir: string;
}

export interface RemoteSkillFile {
  /** Path relative to the skill directory: 'SKILL.md', 'references/x.md', 'scripts/y.py'. */
  rel: string;
  content: string;
}

export interface RemoteSkill {
  id: string;
  files: RemoteSkillFile[];
  /** Files deliberately left behind, with the reason — reported, never silent. */
  skipped: string[];
  /** Human-readable origin, e.g. 'github.com/owner/repo@main'. */
  origin: string;
}

export interface GitHubRef {
  owner: string;
  repo: string;
  /** Branch/tag/sha when the URL named one; the repo's default branch otherwise. */
  ref?: string;
  /** Repo-relative path the URL pointed at, if any. */
  path?: string;
}

/* ---- limits ------------------------------------------------------ */

/** A skill is a skill, not a repo checkout. These bound the worst case a
 *  pasted URL can cost: a 200-file, 8MB tree is already far past generous. */
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
/** Per asset. SKILL.md itself is held to the much tighter MAX_IMPORT_BYTES. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** Parallel downloads. Enough to hide latency, far short of rude to a host. */
const FETCH_CONCURRENCY = 8;

/** Binary formats a text-only store would corrupt. Skipped and reported rather
 *  than written as mojibake that fails mysteriously at run time. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|avi|mkv|wav|ogg|webm|ttf|otf|woff2?|eot|so|dylib|dll|exe|bin|wasm|db|sqlite3?|pyc|class|jar)$/i;

/** Directories that are never part of a skill's payload. */
const SKIP_DIR = /(^|\/)(\.git|node_modules|__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache|dist|build|screenshots?|\.github)(\/|$)/i;

/* ---- parsing (pure) ---------------------------------------------- */

/**
 * Pull a URL — and an optional skill name — out of whatever the user pasted.
 *
 * People copy the whole install line out of a README rather than hunting for
 * the URL inside it, so `npx skills add https://github.com/o/r --skill foo`
 * must work as well as the bare URL. Any command wrapper is fine; only the URL
 * and a `--skill`-ish flag are read.
 */
export function parseSkillSource(input: string): { url: string; skill?: string } | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  const url = /https?:\/\/[^\s'"`<>]+/.exec(text)?.[0];
  if (!url) return null;
  const skill = /(?:--skill|--name|-s)[=\s]+["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text)?.[1];
  return {
    // Trailing punctuation is what you get when a URL is quoted mid-sentence.
    url: url.replace(/[.,;:)\]}]+$/, ''),
    ...(skill ? { skill } : {}),
  };
}

/**
 * Recognise the GitHub URL shapes people actually paste.
 *
 * Returns null for anything else — including raw.githubusercontent.com, which
 * is already a direct file and goes down the plain single-file import path.
 */
export function parseGitHubUrl(url: string): GitHubRef | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const seg = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (seg.length < 2) return null;
  const [owner, rawRepo, kind, ref, ...rest] = seg;
  const repo = rawRepo.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  // /owner/repo/tree/<ref>/<path> and /owner/repo/blob/<ref>/<path>
  if ((kind === 'tree' || kind === 'blob') && ref) {
    return { owner, repo, ref, path: rest.join('/') || undefined };
  }
  return { owner, repo };
}

/**
 * Every skill directory in a repo tree, best candidate first.
 *
 * A repo often carries the same skills twice — the canonical `.claude/skills/`
 * copy and a packaging copy under `cli/assets/` or `dist/`. Deduping by id and
 * preferring the canonical copy is what stops "7 skills" reading as "13".
 */
export function findSkillCandidates(paths: string[], want?: string): SkillCandidate[] {
  const byId = new Map<string, SkillCandidate>();
  const rank = (dir: string): number => {
    if (/(^|\/)\.claude\/skills\//.test(`${dir}/`)) return 0;   // canonical
    if (/(^|\/)skills\//.test(`${dir}/`)) return 1;
    if (/(^|\/)(cli|dist|build|assets|packages?)(\/|$)/i.test(dir)) return 3; // packaging copy
    return 2;
  };
  for (const p of paths) {
    if (!/(^|\/)SKILL\.md$/i.test(p)) continue;
    if (SKIP_DIR.test(p)) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const id = dir ? dir.slice(dir.lastIndexOf('/') + 1) : '';
    const key = id || '(root)';
    const prev = byId.get(key);
    if (!prev || rank(dir) < rank(prev.dir)) byId.set(key, { id, dir });
  }
  const all = [...byId.values()].sort((a, b) => rank(a.dir) - rank(b.dir) || a.id.localeCompare(b.id));
  if (!want) return all;
  const slug = want.toLowerCase();
  const exact = all.filter((c) => c.id.toLowerCase() === slug);
  return exact.length ? exact : all;
}

/** Files belonging to one skill directory, in the order they should be fetched. */
export function filesForSkill(paths: string[], dir: string): string[] {
  const prefix = dir ? `${dir}/` : '';
  const mine = paths.filter((p) => p.startsWith(prefix) && !SKIP_DIR.test(p.slice(prefix.length)));
  // SKILL.md first: if a cap is hit, the one indispensable file is already in.
  return mine.sort((a, b) => {
    const am = /(^|\/)SKILL\.md$/i.test(a) ? 0 : 1;
    const bm = /(^|\/)SKILL\.md$/i.test(b) ? 0 : 1;
    return am - bm || a.localeCompare(b);
  });
}

/* ---- fetching ---------------------------------------------------- */

interface TreeEntry { path: string; type: string; size?: number }

/**
 * Resolve and download one skill directory from GitHub.
 *
 * One API call lists the tree; the files themselves come from
 * raw.githubusercontent.com, which is not subject to the API's unauthenticated
 * hourly limit. Anything oversized, binary or past the caps is skipped and
 * named in `skipped` — a skill that arrives missing a file should say so, not
 * install quietly and misbehave later.
 */
export async function fetchGitHubSkill(
  ref: GitHubRef,
  want: string | undefined,
  fetchText: FetchText,
  mainFileMax: number,
): Promise<{ skill: RemoteSkill } | { choices: SkillCandidate[] }> {
  const branch = ref.ref ?? (await defaultBranch(ref, fetchText));
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  let tree: TreeEntry[];
  try {
    const body = JSON.parse(await fetchText(api, MAX_SKILL_TOTAL_BYTES)) as { tree?: TreeEntry[]; message?: string };
    if (!body.tree) throw new Error(body.message || 'no file list in the response');
    tree = body.tree;
  } catch (e) {
    throw new Error(`couldn't list ${ref.owner}/${ref.repo}@${branch}: ${(e as Error).message}`);
  }
  const blobs = tree.filter((t) => t.type === 'blob').map((t) => t.path);

  // A path in the URL is the user pointing at the skill; honour it over guessing.
  const urlDir = ref.path ? ref.path.replace(/\/SKILL\.md$/i, '') : undefined;
  let candidates = findSkillCandidates(blobs, want);
  if (urlDir) {
    const pointed = candidates.filter((c) => c.dir === urlDir);
    if (pointed.length) candidates = pointed;
  }
  if (!candidates.length) throw new Error(`no SKILL.md found in ${ref.owner}/${ref.repo}@${branch}`);
  // Several skills and nothing said which: the caller asks rather than guesses.
  if (candidates.length > 1) return { choices: candidates };

  const chosen = candidates[0];
  const id = chosen.id || ref.repo;
  const sizeOf = new Map(tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.size ?? 0]));
  const skipped: string[] = [];

  // Every cap decision happens here, from the sizes the tree already gave us —
  // before a single byte is fetched. That keeps the budget exact (no racing
  // counter) AND lets the downloads run concurrently, which is the difference
  // between a 30-second add and a 5-second one on a 70-file skill.
  const wanted: { rel: string; path: string; cap: number }[] = [];
  let total = 0;
  for (const path of filesForSkill(blobs, chosen.dir)) {
    const rel = chosen.dir ? path.slice(chosen.dir.length + 1) : path;
    const isMain = /^SKILL\.md$/i.test(rel);
    if (BINARY_EXT.test(rel)) { skipped.push(`${rel} (binary)`); continue; }
    const size = sizeOf.get(path) ?? 0;
    const cap = isMain ? mainFileMax : MAX_ASSET_BYTES;
    if (size > cap) { skipped.push(`${rel} (${Math.round(size / 1024)}KB)`); continue; }
    if (wanted.length >= MAX_SKILL_FILES) { skipped.push(`${rel} (over ${MAX_SKILL_FILES} files)`); continue; }
    if (total + size > MAX_SKILL_TOTAL_BYTES) { skipped.push(`${rel} (over the ${MAX_SKILL_TOTAL_BYTES / 1024 / 1024}MB budget)`); continue; }
    wanted.push({ rel, path, cap });
    total += size;
  }

  const rawUrl = (path: string) =>
    `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;

  const fetched = new Array<RemoteSkillFile | null>(wanted.length).fill(null);
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= wanted.length) return;
      const { rel, path, cap } = wanted[i];
      try {
        const content = await fetchText(rawUrl(path), cap);
        // A binary that slipped past the extension list — never store mojibake.
        if (content.includes('\0')) { failures.push(`${rel} (binary)`); continue; }
        fetched[i] = { rel, content };
      } catch (e) {
        // One unreadable asset must not cost the whole skill — unless it is THE file.
        if (/^SKILL\.md$/i.test(rel)) throw e;
        failures.push(`${rel} (${(e as Error).message})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, wanted.length) }, worker));

  const files = fetched.filter((f): f is RemoteSkillFile => f !== null);
  // Keep the reported order stable regardless of which worker finished first.
  skipped.push(...failures.sort());
  if (!files.some((f) => /^SKILL\.md$/i.test(f.rel))) throw new Error(`${chosen.dir || ref.repo} has no readable SKILL.md`);
  return { skill: { id, files, skipped, origin: `github.com/${ref.owner}/${ref.repo}@${branch}` } };
}

/** The repo's default branch, so a bare repo URL works without naming one. */
async function defaultBranch(ref: GitHubRef, fetchText: FetchText): Promise<string> {
  try {
    const body = JSON.parse(await fetchText(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, 512 * 1024)) as { default_branch?: string };
    return body.default_branch || 'main';
  } catch {
    return 'main'; // the overwhelmingly common case; a wrong guess fails loudly at the tree call
  }
}
