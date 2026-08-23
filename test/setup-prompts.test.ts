// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The wizard's decisions, separated from its typing.
 *
 * `npx batonhq setup` is the first thing a stranger runs, so its edge cases are
 * the product's first impression: a pipe with no TTY, a typo, `all`, Ctrl-C,
 * a second run over a repo already set up. Each of those is a decision, and
 * every decision lives here as a pure function precisely so it can be tested
 * without a terminal — the readline wrappers around them hold no logic worth
 * getting wrong.
 */
import { describe, it, expect } from 'vitest';
import { parseMultiSelect, shouldOfferGlobalInstall, isNpxRun } from '../src/commands/setup-prompts.js';

const AGENTS = ['claude', 'cursor', 'codex', 'gemini'] as const;
const DEFAULTS = ['claude', 'cursor'] as const;

const parse = (input: string) => parseMultiSelect(input, AGENTS, DEFAULTS);

describe('parseMultiSelect', () => {
  it('takes the recommended default when the user just presses Enter', () => {
    expect(parse('')).toEqual(['claude', 'cursor']);
  });

  it('treats whitespace as Enter', () => {
    expect(parse('   ')).toEqual(['claude', 'cursor']);
  });

  it('selects a single item by number', () => {
    expect(parse('3')).toEqual(['codex']);
  });

  it('selects several by comma-separated numbers', () => {
    expect(parse('1,3')).toEqual(['claude', 'codex']);
  });

  it('accepts spaces instead of commas, because people type both', () => {
    expect(parse('1 3')).toEqual(['claude', 'codex']);
  });

  it('accepts a comma-space mixture', () => {
    expect(parse('1, 3,4')).toEqual(['claude', 'codex', 'gemini']);
  });

  it('selects by name as well as by number', () => {
    expect(parse('codex')).toEqual(['codex']);
  });

  it('ignores case in names', () => {
    expect(parse('Codex,GEMINI')).toEqual(['codex', 'gemini']);
  });

  it('mixes names and numbers', () => {
    expect(parse('claude,4')).toEqual(['claude', 'gemini']);
  });

  it('understands "all"', () => {
    expect(parse('all')).toEqual(['claude', 'cursor', 'codex', 'gemini']);
  });

  it('understands "none", which is not the same as pressing Enter', () => {
    // Enter means "give me the recommendation"; none means "wire nothing".
    // Collapsing the two would silently connect agents someone declined.
    expect(parse('none')).toEqual([]);
  });

  it('returns results in menu order, not the order they were typed', () => {
    // Determinism: the set chosen is the answer, the typing order is noise.
    expect(parse('4,1')).toEqual(['claude', 'gemini']);
  });

  it('collapses a repeated choice instead of acting on it twice', () => {
    expect(parse('1,1,claude')).toEqual(['claude']);
  });

  it('re-asks when a number is out of range rather than dropping it', () => {
    // Silently honouring "1" from "1,9" would connect a subset the user never
    // chose, and they would have no way to notice.
    expect(parse('1,9')).toBeNull();
  });

  it('re-asks on an unknown name', () => {
    expect(parse('claude,emacs')).toBeNull();
  });

  it('re-asks on outright garbage', () => {
    expect(parse('?!')).toBeNull();
  });

  it('re-asks on zero, which is never a menu position', () => {
    expect(parse('0')).toBeNull();
  });

  it('re-asks on a negative number', () => {
    expect(parse('-1')).toBeNull();
  });

  it('does not treat "all" or "none" as names when combined', () => {
    // "all,claude" is a contradiction in intent; better to ask again than guess.
    expect(parse('all,claude')).toBeNull();
  });

  it('never returns the caller-supplied default array itself', () => {
    // A caller that mutates the result must not corrupt the defaults for the
    // next prompt — this has bitten every codebase that returned a constant.
    const result = parse('');
    expect(result).not.toBe(DEFAULTS);
  });
});

describe('isNpxRun', () => {
  it('detects npx by the command npm exports', () => {
    expect(isNpxRun({ npm_command: 'exec' }, '/somewhere/cli.js')).toBe(true);
  });

  it('detects npx by its cache path when the env is stripped', () => {
    expect(isNpxRun({}, '/Users/x/.npm/_npx/a1b2/node_modules/batonhq/dist/cli.js')).toBe(true);
  });

  it('detects the Windows form of that cache path', () => {
    expect(isNpxRun({}, 'C:\\Users\\x\\AppData\\npm-cache\\_npx\\a1\\node_modules\\batonhq\\dist\\cli.js')).toBe(true);
  });

  it('is false for a normal global install', () => {
    expect(isNpxRun({}, '/usr/local/lib/node_modules/batonhq/dist/cli.js')).toBe(false);
  });

  it('is false for `npm run` inside the repo, which also sets npm_ vars', () => {
    // npm_config_user_agent is set for every npm script, so it can never be the
    // signal; npm_command is 'run-script' here, not 'exec'.
    expect(isNpxRun({ npm_command: 'run-script', npm_config_user_agent: 'npm/11.0.0' }, '/repo/dist/cli.js')).toBe(false);
  });

  it('is false when there is no argv path at all', () => {
    expect(isNpxRun({}, undefined)).toBe(false);
  });
});

describe('shouldOfferGlobalInstall', () => {
  it('offers when run through npx with no installed baton', () => {
    expect(shouldOfferGlobalInstall({ npm_command: 'exec' }, '/x/_npx/1/node_modules/batonhq/dist/cli.js', null)).toBe(true);
  });

  it('stays quiet when baton is already on PATH for real', () => {
    // Offering an install to someone who installed it already is noise that
    // makes the tool look like it does not know its own state.
    expect(
      shouldOfferGlobalInstall({ npm_command: 'exec' }, '/x/_npx/1/node_modules/batonhq/dist/cli.js', '/usr/local/bin/baton'),
    ).toBe(false);
  });

  it('still offers when the only baton on PATH is npx\'s own temporary shim', () => {
    // npx puts the package's bin on PATH for the child, so a naive `which baton`
    // always finds one — and the offer would never appear for the exact users
    // who need it.
    expect(
      shouldOfferGlobalInstall({ npm_command: 'exec' }, '/x/_npx/1/node_modules/batonhq/dist/cli.js', '/Users/x/.npm/_npx/a1b2/node_modules/.bin/baton'),
    ).toBe(true);
  });

  it('never offers outside npx, since the user already installed it somehow', () => {
    expect(shouldOfferGlobalInstall({}, '/usr/local/lib/node_modules/batonhq/dist/cli.js', null)).toBe(false);
  });
});
