/**
 * The one place Baton parses YAML frontmatter.
 *
 * gray-matter picks its parser from the language suffix on the opening
 * delimiter and ships engines for `javascript` (a literal `eval`), `coffee`
 * and `cson`. A bare `matter(text)` registers that whole set, so a document
 * opening with `---js` EXECUTES as Node code in-process, with the daemon's
 * privileges. That is remote code execution on two real paths:
 *
 *   - `baton skills import <url>` — parseSkillMarkdown on remote markdown.
 *   - a `HANDOFF.md` committed onto a branch — readBrief/resume parse it when
 *     you take, resume, or auto-snapshot that worktree. Nothing gitignores
 *     HANDOFF.md, and `baton pass` commits it, so it travels with a clone.
 *
 * A try/catch is NOT a defense: eval runs before anything throws, and a
 * well-formed payload never throws at all.
 *
 * Frontmatter is DATA. Baton only ever writes YAML (`matter.stringify` always
 * emits a bare `---`), so no caller needs an executable engine — denying them
 * costs nothing and closes the hole. This lives in `util/` for the same reason
 * `util/exec.ts` owns git and `util/origin.ts` owns the CSRF gate: one choke
 * point, so a future `matter()` call can't quietly reintroduce the sink.
 *
 * Note `language: 'yaml'` alone would NOT be enough — it sets only the
 * default, and an explicit `---js` suffix still overrides it. Denying the
 * engines is the part that actually works.
 */
import matter from 'gray-matter';

/** Frontmatter languages Baton refuses to interpret. `js`/`coffee`/`cson` are
 *  gray-matter aliases, so each must be denied under every name it answers to
 *  (lib/engine.js aliases js -> javascript, coffee|coffeescript|cson -> coffee). */
const EXECUTABLE_LANGUAGES = ['js', 'javascript', 'coffee', 'coffeescript', 'cson'] as const;

function denied(): never {
  throw new Error('unsupported frontmatter language: only YAML frontmatter is allowed');
}

const DENY = { parse: denied, stringify: denied };

const ENGINES = Object.fromEntries(EXECUTABLE_LANGUAGES.map((l) => [l, DENY]));

export interface Frontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Parse `text` as YAML frontmatter + body. Throws on a document that asks for
 * an executable language, rather than running it.
 *
 * Callers that treat unparseable input as a plain body (parseSkillMarkdown) or
 * as "not a brief" (readBrief) already wrap this in try/catch — a hostile
 * document degrades to inert text there, which is the outcome we want.
 */
export function parseFrontmatter(text: string): Frontmatter {
  // Passing `engines` also disables gray-matter's internal parse cache, which
  // is fine here — and worth knowing, since that cache is keyed on content and
  // can otherwise mask a repeated parse.
  const parsed = matter(text, { engines: ENGINES });
  return { data: parsed.data as Record<string, unknown>, content: parsed.content };
}
