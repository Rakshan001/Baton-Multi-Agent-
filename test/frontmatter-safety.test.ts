/**
 * gray-matter picks its parser from the language suffix on the opening
 * delimiter, and ships a `javascript` engine whose parse is a literal `eval`
 * (node_modules/gray-matter/lib/engines.js). A bare `matter(text)` registers
 * the full default engine set, so `---js` frontmatter EXECUTES as Node code.
 *
 * Both of these were confirmed to execute against the pre-fix code:
 *   - `baton skills import <url>` -> parseSkillMarkdown  (remote markdown)
 *   - a HANDOFF.md committed onto a branch -> readBrief   (pulled markdown)
 *
 * The canary is a global, not a file write: a payload that merely *evaluates*
 * is already a full compromise, so we detect evaluation itself rather than its
 * side effects on disk.
 *
 * Every payload below is a DISTINCT string on purpose. gray-matter caches
 * parses keyed on content, so reusing one payload across tests lets a cache
 * hit fake a pass — that masked this very bug while the tests were being
 * written.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/util/frontmatter.js';
import { parseSkillMarkdown } from '../src/skills/install.js';
import { readBrief, handoffPath } from '../src/handoff/brief.js';

type Canary = { fired?: boolean };
const canary = (): Canary => (globalThis as unknown as { __baton_canary__: Canary }).__baton_canary__;

/** A payload whose evaluation sets the canary. `tag` keeps each one unique so
 *  gray-matter's content-keyed cache can never stand in for a real parse. */
function payload(tag: string): string {
  return [
    '---js',
    `{ baton: 1, tag: "${tag}", x: (globalThis.__baton_canary__.fired = true) ? 1 : 0 }`,
    '---',
    `body ${tag}`,
    '',
  ].join('\n');
}

beforeEach(() => { (globalThis as unknown as { __baton_canary__: Canary }).__baton_canary__ = {}; });
afterEach(() => { delete (globalThis as unknown as { __baton_canary__?: Canary }).__baton_canary__; });

describe('parseFrontmatter', () => {
  it('refuses a ---js payload instead of evaluating it', () => {
    expect(() => parseFrontmatter(payload('direct'))).toThrow(/unsupported frontmatter language/i);
    expect(canary().fired).toBeUndefined();
  });

  it.each(['js', 'javascript', 'coffee', 'coffeescript', 'cson'])(
    'refuses the %s engine under every alias it answers to',
    (lang) => {
      const doc = `---${lang}\n{ a: 1 }\n---\nbody ${lang}\n`;
      expect(() => parseFrontmatter(doc)).toThrow(/unsupported frontmatter language/i);
      expect(canary().fired).toBeUndefined();
    },
  );

  it('still parses ordinary YAML frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: code-review\nbaton: 1\n---\nBody text.\n');
    expect(parsed.data.name).toBe('code-review');
    expect(parsed.data.baton).toBe(1);
    expect(parsed.content.trim()).toBe('Body text.');
  });

  it('still parses a folded multiline YAML description', () => {
    const parsed = parseFrontmatter('---\ndescription: >\n  one\n  two\n---\nx\n');
    expect(String(parsed.data.description).trim()).toBe('one two');
  });

  it('treats a document with no frontmatter as pure body', () => {
    const parsed = parseFrontmatter('# Just a heading\n\nsome text\n');
    expect(parsed.data).toEqual({});
    expect(parsed.content).toContain('# Just a heading');
  });
});

describe('skill import', () => {
  it('does not execute a ---js payload from imported skill markdown', () => {
    const def = parseSkillMarkdown(payload('skill-import'), 'fallback-id');
    expect(canary().fired).toBeUndefined();
    // parseSkillMarkdown swallows parse failures and treats the text as body,
    // so a hostile file degrades to an inert skill rather than throwing.
    expect(def.id).toBe('fallback-id');
  });

  it('still imports a normal skill file', () => {
    const def = parseSkillMarkdown('---\nname: Code Review\ndescription: Reviews code.\n---\nBody.\n', 'fallback');
    expect(def.id).toBe('code-review');
    expect(def.description).toBe('Reviews code.');
  });
});

describe('HANDOFF.md', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-fm-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('does not execute a ---js payload from a committed HANDOFF.md', async () => {
    await writeFile(handoffPath(dir), payload('handoff'), 'utf-8');
    const brief = await readBrief(dir);
    expect(canary().fired).toBeUndefined();
    // readBrief reports "not a brief" — and we learn that WITHOUT having
    // executed the payload to find out.
    expect(brief).toBeNull();
  });

  it('still reads a legitimate HANDOFF.md', async () => {
    const good = '---\nbaton: 1\nslug: my-task\nfrom: claude\nto: any\nstatus: ready\n---\n# Handoff\n';
    await writeFile(handoffPath(dir), good, 'utf-8');
    const brief = await readBrief(dir);
    expect(brief?.meta.slug).toBe('my-task');
    expect(brief?.meta.status).toBe('ready');
  });
});
