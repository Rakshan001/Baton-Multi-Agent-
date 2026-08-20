// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The wizard's decisions, kept apart from its typing.
 *
 * `askChoice` (./kb.ts) covers "pick one of these". Setting Baton up needs two
 * more shapes — "pick any of these" and "yes or no" — plus the judgement calls
 * that surround them. Everything with a rule in it is a pure function here, so
 * the terminal wrappers stay too thin to hide a bug, and so the edge cases can
 * be tested without a TTY.
 *
 * Zero-dependency, like the rest of the CLI: node:readline, nothing else.
 */

/** The env vars npm exports into a script or `npx` child. */
export interface NpmEnv {
  npm_command?: string;
  npm_config_user_agent?: string;
}

/**
 * One line of input — or `null` when there is no terminal to ask.
 *
 * `null` rather than a thrown error, because every caller's answer to "we
 * cannot ask" is the same: take the default and keep going. A setup that
 * blocks on stdin is a setup that hangs forever in CI, in a pipe, and under
 * `nohup` — the three places nobody is watching to notice.
 */
async function readLine(question: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // readline owns SIGINT while it holds the terminal, so without this handler
  // Ctrl-C at a prompt does nothing at all and the wizard just sits there.
  // 130 is the shell's conventional "terminated by SIGINT".
  rl.on('SIGINT', () => {
    rl.close();
    process.stdout.write('\n  cancelled — nothing was written.\n');
    process.exit(130);
  });
  try {
    return await rl.question(question);
  } catch {
    return null; // stdin ended mid-prompt (EOF, or piped input that ran out)
  } finally {
    rl.close();
  }
}

/**
 * A yes/no question with a recommended answer, shown as the capitalised one.
 * Anything unrecognised re-asks rather than being read as a no — "sure" must
 * never turn into a decline.
 */
export async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const raw = await readLine(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `);
    if (raw === null) return fallback;
    const answer = raw.trim().toLowerCase();
    if (!answer) return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('  please answer y or n.');
  }
}

/**
 * "Pick any of these" — the shape `askChoice` cannot express. Numbers, names,
 * `all`, `none`, or Enter for the recommendation; anything else re-asks with a
 * reminder of the accepted forms.
 */
export async function askMultiSelect(
  question: string,
  options: ReadonlyArray<{ key: string; label: string }>,
  fallback: readonly string[],
): Promise<string[]> {
  const keys = options.map((o) => o.key);
  const menu = options.map((o, i) => `  ${i + 1}) ${o.label}`).join('\n');
  const recommended = fallback.length ? fallback.join(', ') : 'none';
  for (;;) {
    const raw = await readLine(`${question}\n${menu}\n  Choose — numbers, names, "all" or "none" (default ${recommended}): `);
    if (raw === null) return [...fallback];
    const picked = parseMultiSelect(raw, keys, fallback);
    if (picked) return picked;
    console.log('  didn\'t catch that — try "1,3", a name like "codex", "all", or "none".');
  }
}

/**
 * Parse a multi-select answer.
 *
 * Returns the chosen keys in MENU order (the set is the answer; typing order is
 * noise), `[]` for an explicit "none", the fallback for an empty answer, and
 * `null` when any part of the input was not understood — which the caller turns
 * into a re-ask.
 *
 * Partial credit is deliberately not given: honouring the "1" in "1,9" would
 * quietly act on a subset the user never picked, and nothing on screen would
 * reveal it. Asking again costs one line and cannot be wrong.
 */
export function parseMultiSelect(
  input: string,
  keys: readonly string[],
  fallback: readonly string[],
): string[] | null {
  const answer = input.trim().toLowerCase();
  // A fresh array every time: callers must never be able to mutate the
  // defaults out from under the next prompt.
  if (!answer) return [...fallback];
  if (answer === 'all') return [...keys];
  if (answer === 'none') return [];

  const chosen = new Set<string>();
  for (const token of answer.split(/[\s,]+/).filter(Boolean)) {
    // "all"/"none" are whole-answer words. Mixed into a list they express a
    // contradiction ("everything, and also claude"), so re-ask rather than
    // pick an interpretation.
    if (token === 'all' || token === 'none') return null;

    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1; // menus are 1-based; 0 and negatives fall out here
      if (index < 0 || index >= keys.length) return null;
      chosen.add(keys[index]);
      continue;
    }

    const key = keys.find((k) => k.toLowerCase() === token);
    if (!key) return null;
    chosen.add(key);
  }

  if (chosen.size === 0) return null;
  return keys.filter((k) => chosen.has(k));
}

/**
 * Is this process an `npx batonhq …` run rather than an installed binary?
 *
 * `npm_config_user_agent` is set for every npm script, so it can never be the
 * signal. `npm_command === 'exec'` is what npx sets; the `_npx` cache path is
 * the fallback for shells that strip the environment.
 */
export function isNpxRun(env: NpmEnv, argv1: string | undefined): boolean {
  if (env.npm_command === 'exec') return true;
  return isNpxPath(argv1);
}

/** True for a path inside npm's `_npx` cache, on either path separator. */
function isNpxPath(path: string | undefined): boolean {
  if (!path) return false;
  return /[\\/]_npx[\\/]/.test(path);
}

/**
 * Whether to close the wizard by offering `npm i -g batonhq`.
 *
 * Only for npx runs — outside npx the user already installed Baton somehow, and
 * offering to install it again reads as a tool that does not know its own
 * state. The subtlety is `batonOnPath`: npx puts its package's bin on PATH for
 * the child process, so a plain `which baton` always finds something. A hit
 * inside the `_npx` cache is that shim, and it disappears when the command
 * ends — so it is not an install, and the offer still stands.
 */
export function shouldOfferGlobalInstall(
  env: NpmEnv,
  argv1: string | undefined,
  batonOnPath: string | null,
): boolean {
  if (!isNpxRun(env, argv1)) return false;
  if (batonOnPath && !isNpxPath(batonOnPath)) return false;
  return true;
}
