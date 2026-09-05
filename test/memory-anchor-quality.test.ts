// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { anchorsForDecision } from '../src/handoff/session-brief.js';

/**
 * The anchor-quality bug, measured on this repo on 2026-09-05: recall_memory
 * returned 3 fresh facts out of 12. Three of the withheld facts carried the
 * SAME three anchors -- .gitignore, AGENTS.md, CODEBASE.md -- because capture
 * anchored every fact to whatever files were dirty in the session. Unrelated
 * desktop work touched .gitignore and invalidated all three at once.
 *
 * An evidence anchor is a CLAIM: "if this file changes, re-check this fact".
 * Claiming a file the fact says nothing about is not weak evidence, it is
 * false evidence -- and `baton memory gc` (src/memory.ts:1155) DELETES facts
 * whose anchors changed, so the false claim is also destructive.
 */
describe('anchorsForDecision — a fact may only claim evidence it has', () => {
  const session = ['.gitignore', 'AGENTS.md', 'CODEBASE.md', 'src/auth/token.ts'];

  it('anchors to a file the decision names', () => {
    expect(anchorsForDecision('kept the 5-min skew in src/auth/token.ts — mobile clients need it', session))
      .toEqual(['src/auth/token.ts']);
  });

  it('anchors to a file named by basename alone', () => {
    expect(anchorsForDecision('token.ts keeps the 5-min clock skew for mobile clients', session))
      .toEqual(['src/auth/token.ts']);
  });

  it('claims NOTHING when the decision names no file', () => {
    // The regression from this repo: a fact about test timing must never end up
    // anchored to .gitignore just because .gitignore happened to be dirty.
    expect(anchorsForDecision('the full test suite is timing-sensitive on a loaded machine', session))
      .toEqual([]);
  });

  it('never falls back to the session file set', () => {
    for (const d of ['we decided to keep both backends', 'ask once on first run and persist the answer']) {
      expect(anchorsForDecision(d, session), d).toEqual([]);
    }
  });

  it('keeps every file the decision names, not just the first', () => {
    expect(anchorsForDecision('moved the guard from src/auth/token.ts into CODEBASE.md conventions', session))
      .toEqual(['CODEBASE.md', 'src/auth/token.ts']);
  });

  it('is deterministic — same input, same order', () => {
    const d = 'moved the guard from src/auth/token.ts into CODEBASE.md conventions';
    expect(anchorsForDecision(d, session)).toEqual(anchorsForDecision(d, [...session].reverse()));
  });

  it('does not match a filename embedded in a longer word', () => {
    // "mytoken.ts" is not token.ts; a substring match would claim the wrong file.
    expect(anchorsForDecision('mytoken.tsx handling was left alone', session)).toEqual([]);
  });

  it('handles an empty session file set and an empty decision', () => {
    expect(anchorsForDecision('src/auth/token.ts changed', [])).toEqual([]);
    expect(anchorsForDecision('', session)).toEqual([]);
  });
});
