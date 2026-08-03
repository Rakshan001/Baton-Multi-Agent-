/**
 * The anti-capture gate: which classes of "learning" must never become a
 * durable fact.
 *
 * Baton already answers "is this fact still TRUE?" — every fact is anchored to
 * file hashes and re-checked on read (memory.ts). This module answers the
 * question that comes before it: "should this ever have been saved at all?"
 * Some knowledge is false the moment the environment moves, and anchoring
 * cannot police it because it was never about the code.
 *
 * The four classes come from NousResearch/hermes-agent (MIT), whose background
 * reviewer carries the same list as a prompt instruction, with the rationale
 * that matters most:
 *
 *   "Negative claims about tools or features ... harden into refusals the agent
 *    cites against itself for months after the actual problem was fixed."
 *
 * Two deliberate design choices:
 *
 * 1. **The gate matches PHRASING, not topic.** Every rejected shape has a
 *    durable rewrite — "the X tool is broken" is junk, "X fails on <input>;
 *    use Y instead" is a real gotcha. So a rejection is always one rephrase
 *    away from a save, and the message says which rephrase.
 * 2. **Evidence and remedy are both waivers, for the two classes where they
 *    mean something.** A claim anchored to explicit files is about THIS repo
 *    and staleness will police it; a claim carrying its fix is the durable half
 *    Hermes tells you to keep. A session narrative or a self-resolved flake has
 *    no durable half, so nothing waives those.
 *
 * Pure and synchronous — no I/O, no state, safe to call on every write.
 */

export type UndurableKind = 'environment' | 'tool-disparagement' | 'transient' | 'narrative';

export interface UndurableFinding {
  kind: UndurableKind;
  /** The phrase that tripped the rule, so the agent can see what to rewrite. */
  matched: string;
  /** What to save instead — a refusal without this is just an obstacle. */
  instead: string;
}

interface Rule {
  kind: UndurableKind;
  re: RegExp;
}

/**
 * Can a waiver rescue this class? A property of the CLASS, never of a single
 * pattern — which is why it lives here and not on each row. Both waivers move
 * together for the same reason:
 *
 * - Explicit file anchors: the claim is then about this repo's code, checkable,
 *   and subject to the staleness sweep. Only EXPLICIT anchors that RESOLVE
 *   count (see memory.ts) — a filename mentioned in passing is not an assertion
 *   that the fact is about that file, and a path that does not exist hashes to
 *   '' forever, so honouring it would exempt the fact from the very check the
 *   waiver rests on.
 * - A stated fix: converts a bare failure into the half worth keeping.
 *
 * A narrative or a self-resolved flake has no durable half however it is
 * worded, so neither waiver reaches them.
 */
const WAIVABLE: Record<UndurableKind, boolean> = {
  environment: true,
  'tool-disparagement': true,
  transient: false,
  narrative: false,
};

/*
 * Patterns are deliberately narrow. A false accept leaves us exactly where we
 * are today; a false reject costs a real fact, so every rule targets a shape
 * whose durable rewrite is obvious. All are linear (bounded classes, no nested
 * quantifiers) — they run on every save, on agent-supplied text.
 */
const RULES: Rule[] = [
  // 1. Environment-dependent failures. The user can fix these; they are not
  //    rules about the code. Keep the install/config step, drop the symptom.
  { kind: 'environment', re: /\bcommand not found\b/ },
  { kind: 'environment', re: /\bno such file or directory\b/ },
  { kind: 'environment', re: /\bcannot find module\b|\bmodule not found\b/ },
  { kind: 'environment', re: /\bpermission denied\b/ },
  { kind: 'environment', re: /\benoent\b/ },
  { kind: 'environment', re: /\b(not|isn't|aren't|wasn't|weren't) installed\b|\bis uninstalled\b/ },
  { kind: 'environment', re: /\b(not (on|in)|missing from) (the )?path\b/ },
  { kind: 'environment', re: /\b(is|are|was|were) unconfigured\b/ },
  // The leading `[a-z_]*` is load-bearing: the common form is a namespaced env
  // var (`ANTHROPIC_API_KEY`), where a plain `\bapi[_ ]?key` never matches
  // because the preceding underscore is a word character.
  { kind: 'environment', re: /\b[a-z_]*(api[ _-]?key|credentials?|token|env(ironment)? var(iable)?)s? (is |are |was |were )?(not set|unset|missing|not configured)\b/ },

  // 2. Standalone negative capability claims. Hermes's word is "standalone" —
  //    with a remedy or an anchor this is a gotcha; without either it is a
  //    grudge the next agent inherits.
  { kind: 'tool-disparagement', re: /\b(is|are|was|were) broken\b/ },
  { kind: 'tool-disparagement', re: /\b(does not|doesn't|do not|don't|didn't|did not) work\b/ },
  { kind: 'tool-disparagement', re: /\b(is|are) (unusable|useless|pointless|unreliable)\b/ },
  { kind: 'tool-disparagement', re: /\bnever works\b|\bfails every time\b/ },
  // Deliberately NOT here: `cannot be used`. It reads as disparagement but is
  // overwhelmingly used for real constraints — ".refs/ cannot be used from
  // src", "EventSource cannot be used with an Authorization header" are both
  // this repo's own conventions. It was the one rule measured to false-reject
  // beliefs we actually hold, and the grudge shape it aimed at is already
  // covered by `unusable`/`useless` above.

  // 3. Errors that resolved themselves. If the retry worked, the retry is the
  //    lesson — the original failure is noise. Nothing waives this: there is no
  //    version of "it passed the second time" worth serving to a future agent.
  //    Note this does NOT catch "test X is flaky under load", which is a real,
  //    durable gotcha — only the self-resolution phrasing trips.
  { kind: 'transient', re: /\b(passed|worked|succeeded) on (the )?(second|third|next|another|re)[- ]?(try|run|attempt)\b/ },
  { kind: 'transient', re: /\b(second|third|next|another) (try|run|attempt) (worked|passed|succeeded)\b/ },
  { kind: 'transient', re: /\b(worked|passed|succeeded) (after|on) (a |the )?retr(y|ying|ies)\b/ },
  { kind: 'transient', re: /\bresolved (itself|after a re-?run)\b|\bself[- ]resolved\b/ },
  { kind: 'transient', re: /\b(went away|cleared|sorted itself out) on its own\b/ },
  { kind: 'transient', re: /\bretr(y|ying) (fixed|solved) it\b/ },
  { kind: 'transient', re: /\b(passed|worked) when (i|we) ran it again\b/ },

  // 4. One-off session narratives. Memory is read by the NEXT agent, for whom
  //    "this session" names a session they were never in. Nothing waives it.
  { kind: 'narrative', re: /\b(in|during|earlier in) this (session|conversation|task)\b/ },
  { kind: 'narrative', re: /\bthis (session|conversation|task),? (i|we)\b/ },
  { kind: 'narrative', re: /\b(i|we) spent (this|the) (session|task|conversation)\b/ },
  { kind: 'narrative', re: /\bthis conversation (started|began)\b/ },
  { kind: 'narrative', re: /\btoday (i|we) (fixed|added|implemented|ran|changed|pushed|reviewed|traced|investigated|debugged|wrote|tested|looked at)\b/ },
  { kind: 'narrative', re: /\b(i|we) just (fixed|added|implemented|ran|changed|pushed|reviewed|traced|investigated|debugged|wrote|tested|looked at)\b/ },
];

/*
 * Does the fact carry its own fix? Generous by design — the gate exists to
 * catch the BARE claim — but generosity has to stop short of words that merely
 * LOOK like remedies, which is why the hints come in two shapes.
 *
 * Both are checked against the text with the SYMPTOM SPAN REMOVED, which is
 * what lets `set` appear at all: "the API key is not set" must not waive itself
 * on the word inside its own complaint, while "…is not set — set it in .env"
 * must.
 */

/** Unambiguous: these words have no non-remedy reading worth worrying about. */
const REMEDY_PHRASE = /\b(instead|workarounds?|work around|fall ?back|falls back|switch(?:ing)? to|the fix|fixed by|remedy|re-?run|re-?install|configure[ds]?|upgrade|downgrade)\b/;

/**
 * Ambiguous verbs, which waive ONLY when they take a plausible object. Bare
 * `\brun\b` / `\bset\b` / `\binstall\b` / `\bexport\b` were measured waiving
 * facts that state no remedy at all: "affects every user of the export path",
 * "we set aside a day for it", "not installed on a fresh install of this repo".
 * Each is the noun, not the imperative — and each silently let a standalone
 * grudge through, the exact shape this gate exists to catch.
 */
const REMEDY_ACTION =
  /\b(?:re-?)?(?:run|set|install|export|enable|start|add)\s+(?:(?:it|them|this|that|the|a|an|your|our|with|via|using|up|npm|pnpm|yarn|pip|brew|apt|cargo|node|docker)\b|[a-z][\w.-]*=)/;

const INSTEAD: Record<UndurableKind, string> = {
  environment: 'save the FIX (the install/config step), not the symptom — or pass `files` to anchor it to the code it is about',
  'tool-disparagement':
    'a bare "X is broken" hardens into a refusal the next agent cites for months after the cause is fixed — '
    + 'save the specific behaviour plus the workaround, or pass `files` to anchor it',
  transient: 'an error that resolved on retry is not durable — if the retry is the lesson, save the retry rule instead',
  narrative: 'a session narrative is not a fact — save the rule you want the NEXT agent to know, with no reference to this session',
};

/** How much of the tripping phrase to quote back (it is agent-written prose). */
const MATCH_QUOTE_CHARS = 60;

/**
 * Fold away the things that change how text LOOKS but not what it claims:
 * markdown emphasis, curly quotes, line breaks, case.
 *
 * Code spans and fenced blocks are dropped entirely, because a quoted error
 * message is evidence for a claim, not the claim itself — "graphify prints
 * `command not found` when the CLI is missing, so we fall back to AST-only" is
 * durable knowledge that happens to contain a banned phrase inside backticks.
 *
 * URLs go too. A link is a citation, never an assertion, and its path segments
 * are English words: "the tool is broken — see example.com/run for details"
 * used to waive itself on a `run` that was part of an address.
 *
 * Exported for tests: the normalizer is where most false positives would be
 * born, so it is worth pinning on its own.
 */
export function normalizeForMatch(fact: string): string {
  return fact
    .replace(/```[\s\S]*?```/g, ' ')        // fenced blocks (unterminated fence stays — we cannot tell what is quoted)
    .replace(/`[^`]*`/g, ' ')               // inline code spans
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')  // URLs — citations, not claims
    .replace(/[‘’ʼ]/g, "'")  // curly apostrophes → straight
    .replace(/[“”]/g, '"')
    .replace(/[*_~]+/g, '')                 // markdown emphasis
    .toLowerCase()
    .replace(/\s+/g, ' ')                   // newlines/indentation inside a phrase
    .trim();
}

/**
 * Classify a fact as one of the never-durable shapes, or null when it is fine
 * to store. First match wins — the message only needs to name one thing to fix.
 */
export function classifyDurability(
  fact: string,
  opts: { anchored?: boolean } = {},
): UndurableFinding | null {
  const text = normalizeForMatch(fact);
  if (!text) return null;
  for (const rule of RULES) {
    const waivable = WAIVABLE[rule.kind];
    if (waivable && opts.anchored) continue;
    const hit = rule.re.exec(text);
    if (!hit) continue;
    // The remedy must live OUTSIDE the complaint. Testing the whole string lets
    // a symptom waive itself on its own words — "the key is not set" contains
    // `set`, "is not installed" contains `install` — which silently disabled
    // the entire environment class.
    if (waivable) {
      const rest = `${text.slice(0, hit.index)} ${text.slice(hit.index + hit[0].length)}`;
      if (REMEDY_PHRASE.test(rest) || REMEDY_ACTION.test(rest)) continue;
    }
    return { kind: rule.kind, matched: hit[0].slice(0, MATCH_QUOTE_CHARS), instead: INSTEAD[rule.kind] };
  }
  return null;
}
