// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The demo's resume prompt is a RECORDING of the daemon's, not a rebuild of it.
 *
 * `src/handoff/resume.ts` states the rule: the prompt is served pre-built so no
 * client assembles one, because `web/` cannot import `src/` and a browser-side
 * fence would be a second implementation of a security primitive. Demo mode
 * calls no daemon, so it cannot be served anything — it has to carry a fixture.
 *
 * The fixture it carries is one verbatim output of `resumePromptFor`, with the
 * two per-brief values left as placeholders. That is the difference this test
 * exists to hold: a recording can go stale, an implementation can go WRONG, and
 * only one of the two can be pinned. Change the fence, the preamble, or a word
 * of Baton's own instruction, and this fails with the exact string to paste
 * back into web/src/lib/demoHandoff.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resumePromptFor, type BriefEntry } from '../src/handoff/resume.js';
import { FENCE_PREAMBLE, START_MARK, END_MARK } from '../src/handoff/untrusted.js';
import { DEMO_BRIEF_BODY, demoResumePrompt } from '../web/src/lib/demoHandoff.js';

/** What the daemon would serve for a demo brief, built the one real way. */
const daemonPrompt = (slug: string, cwd: string): string =>
  resumePromptFor({ slug, cwd, body: DEMO_BRIEF_BODY } as BriefEntry);

describe('demo resume prompt', () => {
  it('is byte-identical to what the daemon builds for the same brief', () => {
    expect(demoResumePrompt('sess-cursor-demo', '/repo')).toBe(daemonPrompt('sess-cursor-demo', '/repo'));
  });

  it('holds for every brief the demo panel shows, not just the first', () => {
    for (const slug of ['sess-docs-demo', 'sess-release-demo']) {
      expect(demoResumePrompt(slug, '/repo'), `${slug} drifted`).toBe(daemonPrompt(slug, '/repo'));
    }
  });

  it('still shows a real fence, so the demo teaches the right shape', () => {
    const p = demoResumePrompt('sess-cursor-demo', '/repo');
    expect(p).toContain(`${START_MARK} handoff sess-cursor-demo>>>`);
    expect(p.trimEnd().endsWith(END_MARK), 'nothing may follow the terminator').toBe(true);
    for (const line of FENCE_PREAMBLE) expect(p).toContain(line);
  });
});

describe('the browser holds no second fence implementation', () => {
  it('never re-declares the markers or the preamble in api.ts', async () => {
    const src = await readFile(new URL('../web/src/lib/api.ts', import.meta.url), 'utf-8');
    expect(src, 'the demo must use the recorded prompt, not rebuild one').not.toContain(START_MARK);
    expect(src).not.toContain(END_MARK);
    for (const line of FENCE_PREAMBLE) expect(src, 'preamble copy found in api.ts').not.toContain(line);
  });

  it('keeps the recording in the one file the pin above watches', async () => {
    const src = await readFile(new URL('../web/src/lib/demoHandoff.ts', import.meta.url), 'utf-8');
    expect(src).toContain(START_MARK);
  });
});
