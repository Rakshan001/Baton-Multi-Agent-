// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Arrow-key selection for the wizard — the checkbox/radio list people expect
 * from a modern CLI, without a prompts library.
 *
 * The old prompts asked you to type numbers: `Choose — numbers, names, "all" or
 * "none"`. That works, and it is the only thing that works when there is no
 * terminal, but it puts the burden on the reader to map "cursor" onto "2" and
 * to trust they typed the list they meant. Arrow keys and a spacebar show the
 * answer as you build it.
 *
 * Zero new dependencies, like the rest of the CLI: node:tty raw mode and ANSI
 * escapes. A prompts library would be sturdier, but Baton ships five pure-JS
 * dependencies and argues for itself partly on being small enough to audit, and
 * a picker is not worth a subtree.
 *
 * Everything with a decision in it — what a keypress means, what it does to the
 * selection, what appears on screen — is a pure function, so the terminal shell
 * at the bottom stays too thin to hide a bug. See ./setup-prompts.ts, which
 * follows the same split and owns the typed-number fallback.
 */

/** One row. `hint` is the greyed note after the label; it never affects the answer. */
export interface SelectItem {
  key: string;
  label: string;
  hint?: string;
}

export type Key = 'up' | 'down' | 'toggle' | 'all' | 'none' | 'submit' | 'cancel' | 'ignore';

export interface SelectState {
  readonly items: readonly SelectItem[];
  /** true = checkboxes (any number), false = radio (exactly one). */
  readonly multi: boolean;
  readonly cursor: number;
  readonly chosen: readonly string[];
  readonly status: 'active' | 'done' | 'cancelled';
}

const ESC = '\u001b';

/**
 * Opens with the cursor on the recommended option, so Enter — the key everyone
 * reaches for first — takes the recommendation without reading anything.
 */
export function initialState(
  items: readonly SelectItem[],
  multi: boolean,
  chosen: readonly string[],
): SelectState {
  // Defend against a caller recommending something not on the menu: it would
  // otherwise render as "nothing selected" while quietly being the answer.
  const valid = chosen.filter((k) => items.some((i) => i.key === k));
  const first = valid.length ? items.findIndex((i) => i.key === valid[0]) : 0;
  return { items, multi, cursor: Math.max(0, first), chosen: valid, status: 'active' };
}

/**
 * One keystroke → one meaning.
 *
 * Ctrl-C is handled here rather than by a SIGINT handler because raw mode gives
 * the keystroke to the process instead of raising the signal — a picker that
 * ignores it is a picker you cannot get out of. Escape means the same thing;
 * unrecognised sequences (page-up, function keys, a stray paste) are ignored
 * rather than guessed at.
 */
export function decodeKey(seq: string): Key {
  if (seq === '\u0003' || seq === ESC) return 'cancel';
  if (seq === `${ESC}[A` || seq === 'k') return 'up';
  if (seq === `${ESC}[B` || seq === 'j') return 'down';
  if (seq === ' ') return 'toggle';
  if (seq === '\r' || seq === '\n') return 'submit';
  if (seq === 'a') return 'all';
  if (seq === 'n') return 'none';
  return 'ignore';
}

/**
 * One read can carry several keystrokes.
 *
 * Holding an arrow key down, typing quickly, or pasting all deliver a single
 * chunk like "\u001b[B\u001b[B\u001b[B". decodeKey only understands one key,
 * so an unsplit chunk decoded to 'ignore' and the picker sat there looking
 * frozen while the user held a key down.
 *
 * Escape sequences are kept whole; everything else is a character.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== ESC) { keys.push(chunk[i]); continue; }
    // CSI: ESC [ … final byte in @-~. Anything else is a bare ESC.
    const rest = chunk.slice(i);
    const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
    if (csi) { keys.push(csi[0]); i += csi[0].length - 1; continue; }
    const ss3 = /^\u001b O?[A-Za-z]/.exec(rest) ?? /^\u001bO[A-Za-z]/.exec(rest);
    if (ss3) { keys.push(ss3[0]); i += ss3[0].length - 1; continue; }
    keys.push(ESC);
  }
  return keys;
}

/** Pure reducer. Returns the same state, unchanged, once the prompt is over. */
export function applyKey(state: SelectState, key: Key): SelectState {
  if (state.status !== 'active') return state;
  const n = state.items.length;
  if (n === 0) return state;

  switch (key) {
    // Wrapping, because without it the last row is a dead end and people press
    // down twice wondering whether the prompt has hung.
    case 'up':
      return { ...state, cursor: (state.cursor - 1 + n) % n };
    case 'down':
      return { ...state, cursor: (state.cursor + 1) % n };

    case 'toggle': {
      const key_ = state.items[state.cursor].key;
      if (!state.multi) return { ...state, chosen: [key_] };
      return {
        ...state,
        chosen: state.chosen.includes(key_)
          ? state.chosen.filter((k) => k !== key_)
          : [...state.chosen, key_],
      };
    }

    // Meaningless in a radio group, so they do nothing there rather than
    // silently selecting everything.
    case 'all':
      return state.multi ? { ...state, chosen: state.items.map((i) => i.key) } : state;
    case 'none':
      return state.multi ? { ...state, chosen: [] } : state;

    case 'submit':
      // Radio: the cursor IS the answer, so there is no way to submit something
      // nobody pointed at. Checkbox: an empty selection is a real answer.
      return state.multi
        ? { ...state, status: 'done' }
        : { ...state, chosen: [state.items[state.cursor].key], status: 'done' };

    case 'cancel':
      return { ...state, status: 'cancelled' };

    default:
      return state;
  }
}

/** The answer, in menu order — the set is what was chosen; press order is noise. */
export function chosenKeys(state: SelectState): string[] {
  return state.items.filter((i) => state.chosen.includes(i.key)).map((i) => i.key);
}

/**
 * The screen, as lines.
 *
 * The key bindings are spelled out every time: nothing on a terminal announces
 * that space toggles, and a picker whose controls you have to guess is worse
 * than the numbered list it replaced.
 */
export function renderLines(state: SelectState): string[] {
  const on = state.multi ? '◉' : '●';
  const off = state.multi ? '◯' : '○';
  const help = state.multi
    ? '  ↑↓ move · space toggle · a all · n none · enter confirm'
    : '  ↑↓ move · enter confirm';

  const width = Math.max(...state.items.map((i) => i.label.length));
  const rows = state.items.map((item, i) => {
    const pointer = i === state.cursor ? '❯' : ' ';
    const mark = state.chosen.includes(item.key) ? on : off;
    const label = item.hint ? item.label.padEnd(width) : item.label;
    return `${pointer} ${mark} ${label}${item.hint ? `   ${dim(item.hint)}` : ''}`;
  });

  return [dim(help), '', ...rows];
}

/** Grey, but only where grey means something — a pipe gets plain text. */
function dim(text: string): string {
  return process.stdout.isTTY ? `${ESC}[2m${text}${ESC}[0m` : text;
}

/**
 * Run the picker. Returns the chosen keys, or `null` when there is no terminal
 * capable of raw mode — the caller then falls back to the typed-number prompt,
 * so CI, pipes and `nohup` behave exactly as they always have.
 *
 * Cancelling exits 130, the shell's convention for "terminated by SIGINT", and
 * matches what Ctrl-C already does at every other prompt in the wizard.
 */
export interface SelectIO {
  input: SelectInput;
  output: SelectOutput;
}

/** Just enough of a TTY to drive the picker — and to fake one in a test. */
export type SelectInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  iterator(opts: { destroyOnReturn: boolean }): AsyncIterableIterator<unknown>;
};

export type SelectOutput = { isTTY?: boolean; write(chunk: string): unknown };

export async function runSelect(
  question: string,
  items: readonly SelectItem[],
  multi: boolean,
  recommended: readonly string[],
  io: SelectIO = { input: process.stdin, output: process.stdout },
): Promise<string[] | null> {
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  if (items.length === 0) return [];

  let state = initialState(items, multi, recommended);
  let painted = 0;

  const paint = (): void => {
    const lines = renderLines(state);
    // Redraw in place: back up over what we drew last time, clearing as we go,
    // so the list does not march down the scrollback on every keystroke.
    if (painted > 0) output.write(`${ESC}[${painted}A`);
    for (const line of lines) output.write(`${ESC}[2K\r${line}\n`);
    painted = lines.length;
  };

  output.write(`${question}\n`);
  output.write(`${ESC}[?25l`); // hide the cursor; it has nowhere useful to sit
  input.setRawMode(true);
  input.setEncoding('utf8');
  paint();

  // `destroyOnReturn: false` is load-bearing, not a tuning knob.
  //
  // Breaking out of a plain `for await (const c of stream)` calls the
  // iterator's return(), which DESTROYS the stream. stdin is a process-wide
  // singleton, so the first prompt to finish would take stdin with it and every
  // later prompt — the next picker, the skills question, the global-install
  // offer — would fail on a dead stream. That shipped in 0.1.1: the second
  // prompt in a multi-repo setup died with "The operation was aborted", and the
  // two questions after the first picker silently never appeared.
  const keys = input.iterator({ destroyOnReturn: false });

  try {
    outer: for await (const chunk of keys) {
      // One read can hold several keystrokes — see splitKeys.
      for (const key of splitKeys(String(chunk))) {
        state = applyKey(state, decodeKey(key));
        if (state.status !== 'active') break outer;
      }
      paint();
    }
  } finally {
    // Restoring the terminal must happen even if the loop throws: a process
    // that dies in raw mode leaves the user's shell without an echo.
    input.setRawMode(false);
    output.write(`${ESC}[?25h`);
  }

  if (state.status === 'cancelled') {
    output.write('\n  cancelled — nothing was written.\n');
    process.exit(130);
  }

  paint();
  return chosenKeys(state);
}
