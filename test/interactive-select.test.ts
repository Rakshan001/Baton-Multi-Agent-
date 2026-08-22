// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The arrow-key picker, tested where the rules live rather than through a
 * terminal. Raw mode is the one part that cannot be unit-tested, so it is kept
 * to a shell thin enough to read in one sitting; everything with a decision in
 * it — what a keypress means, what it does to the selection, what ends up on
 * screen — is a pure function and is pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeKey, applyKey, renderLines, initialState, chosenKeys,
  type SelectItem,
} from '../src/commands/interactive-select.js';

const ESC = '\u001b';
const CTRL_C = '\u0003';

const ITEMS: SelectItem[] = [
  { key: 'claude', label: 'Claude Code', hint: 'found on your PATH' },
  { key: 'cursor', label: 'Cursor Agent' },
  { key: 'codex', label: 'Codex CLI' },
];

const multi = (chosen: string[] = ['claude']) => initialState(ITEMS, true, chosen);
const single = (chosen: string[] = ['cursor']) => initialState(ITEMS, false, chosen);

describe('decodeKey', () => {
  it('reads the arrow keys', () => {
    expect(decodeKey(`${ESC}[A`)).toBe('up');
    expect(decodeKey(`${ESC}[B`)).toBe('down');
  });

  it('accepts vim keys, because people who use them use them everywhere', () => {
    expect(decodeKey('k')).toBe('up');
    expect(decodeKey('j')).toBe('down');
  });

  it('reads space, enter and the shortcuts', () => {
    expect(decodeKey(' ')).toBe('toggle');
    expect(decodeKey('\r')).toBe('submit');
    expect(decodeKey('\n')).toBe('submit');
    expect(decodeKey('a')).toBe('all');
    expect(decodeKey('n')).toBe('none');
  });

  // Ctrl-C in raw mode does not raise SIGINT — the process owns the keystroke,
  // so a picker that ignores it is a picker you cannot escape.
  it('treats Ctrl-C and Escape as cancel', () => {
    expect(decodeKey(CTRL_C)).toBe('cancel');
    expect(decodeKey(ESC)).toBe('cancel');
  });

  it('ignores anything it does not recognise rather than guessing', () => {
    expect(decodeKey('z')).toBe('ignore');
    expect(decodeKey(`${ESC}[5~`)).toBe('ignore');
  });
});

describe('applyKey — moving', () => {
  it('moves down', () => {
    expect(applyKey(multi(), 'down').cursor).toBe(1);
  });

  // Wrapping matters more than it sounds: without it the last item is a dead
  // end and people press down twice, wondering if the prompt has hung.
  it('wraps past the end', () => {
    let s = multi();
    s = applyKey(applyKey(applyKey(s, 'down'), 'down'), 'down');
    expect(s.cursor).toBe(0);
  });

  it('wraps backwards off the top', () => {
    expect(applyKey(multi(), 'up').cursor).toBe(ITEMS.length - 1);
  });
});

describe('applyKey — multi-select', () => {
  it('space toggles the item under the cursor on', () => {
    const s = applyKey(applyKey(multi(), 'down'), 'toggle');
    expect(chosenKeys(s)).toEqual(['claude', 'cursor']);
  });

  it('space toggles an already-chosen item back off', () => {
    expect(chosenKeys(applyKey(multi(['claude']), 'toggle'))).toEqual([]);
  });

  it('returns keys in menu order, not the order they were pressed', () => {
    let s = multi([]);
    s = applyKey(applyKey(s, 'down'), 'down');  // cursor → codex
    s = applyKey(s, 'toggle');
    s = applyKey(applyKey(s, 'up'), 'up');      // cursor → claude
    s = applyKey(s, 'toggle');
    expect(chosenKeys(s)).toEqual(['claude', 'codex']);
  });

  it('"a" takes everything and "n" clears it', () => {
    expect(chosenKeys(applyKey(multi([]), 'all'))).toEqual(['claude', 'cursor', 'codex']);
    expect(chosenKeys(applyKey(multi(['claude', 'cursor']), 'none'))).toEqual([]);
  });

  it('lets you submit an empty selection — "none" is a real answer here', () => {
    const s = applyKey(applyKey(multi(['claude']), 'none'), 'submit');
    expect(s.status).toBe('done');
    expect(chosenKeys(s)).toEqual([]);
  });
});

describe('applyKey — single-select', () => {
  // The cursor opens on the recommended option so that Enter, the key everyone
  // presses first, takes the recommendation.
  it('opens on the recommended option, so Enter takes it', () => {
    const s = applyKey(single(['cursor']), 'submit');
    expect(s.status).toBe('done');
    expect(chosenKeys(s)).toEqual(['cursor']);
  });

  // A radio group has no "none": submitting takes whatever the cursor is on,
  // so there is no way to end up with an answer nobody chose.
  it('submit takes the item under the cursor, not the preselected one', () => {
    const s = applyKey(applyKey(single(['cursor']), 'down'), 'submit');
    expect(chosenKeys(s)).toEqual(['codex']);
  });

  it('space picks exactly one, replacing the previous', () => {
    const s = applyKey(applyKey(single(['claude']), 'down'), 'toggle');
    expect(chosenKeys(s)).toEqual(['cursor']);
  });

  it('ignores "all" and "none", which have no meaning in a radio group', () => {
    expect(chosenKeys(applyKey(single(['claude']), 'all'))).toEqual(['claude']);
    expect(chosenKeys(applyKey(single(['claude']), 'none'))).toEqual(['claude']);
  });
});

describe('applyKey — cancelling', () => {
  it('marks the state cancelled', () => {
    expect(applyKey(multi(), 'cancel').status).toBe('cancelled');
  });

  it('changes nothing once it is over', () => {
    const done = applyKey(multi(), 'submit');
    expect(applyKey(done, 'down')).toEqual(done);
  });
});

describe('renderLines', () => {
  it('marks the cursor row and only that row', () => {
    const lines = renderLines(multi());
    expect(lines.filter((l) => l.includes('❯'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('❯'))).toContain('Claude Code');
  });

  it('shows chosen and unchosen differently', () => {
    const out = renderLines(multi(['claude'])).join('\n');
    expect(out).toContain('◉');
    expect(out).toContain('◯');
  });

  it('uses radio marks for a single-select, never checkboxes', () => {
    const out = renderLines(single(['cursor'])).join('\n');
    expect(out).not.toContain('◉');
    expect(out).toContain('●');
  });

  it('shows the hint next to the option it belongs to', () => {
    expect(renderLines(multi()).find((l) => l.includes('Claude Code'))).toContain('found on your PATH');
  });

  // The keys are not discoverable — nothing on a terminal says "space toggles".
  it('spells out the keys, including the ones only multi-select has', () => {
    const help = renderLines(multi()).join('\n');
    expect(help).toMatch(/space/i);
    expect(help).toMatch(/enter/i);
    expect(help).toMatch(/\ba\b/);
  });

  it('does not advertise space-to-toggle in a single-select', () => {
    expect(renderLines(single()).join('\n')).not.toMatch(/toggle/i);
  });
});
