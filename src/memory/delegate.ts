// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Agent-assisted consolidation — Baton does not buy tokens, it delegates.
 *
 * `consolidate.ts` is the zero-LLM default and can only ever retire an exact
 * duplicate. This module is the optional second pass: it hands the fact store
 * to the user's OWN coding agent, under their own credentials, and asks it to
 * reorganise what is already there.
 *
 * ## The single rule
 *
 * **The model may REORGANISE, never ORIGINATE.**
 *
 * A fact this store serves is read by every future session as truth. One
 * invented sentence — a plausible adjective, a number that is off by an order
 * of magnitude — is not a bad answer that a person shrugs at and re-asks; it is
 * a permanent false belief that later sessions cite back at each other. So the
 * rule is enforced in `validateDelegateResponse`, MECHANICALLY, and never by
 * asking the model nicely. Assume the prompt was ignored and the agent returned
 * whatever it liked: the validator is the entire safety property.
 *
 * ## What the validator actually checks
 *
 * Every CONTENT WORD of a produced fact must appear in a fact that produced
 * fact CITES. Not "mostly", not "above a threshold" — every one.
 *
 * This is deliberately crude, and it is deliberately not tunable. A similarity
 * threshold would make a float the security boundary, and someone would raise
 * it by 0.05 to get a nicer merge through. Token containment has no dial. It
 * rejects legitimate paraphrases, and that is the accepted trade: the model
 * must reuse the source's words rather than reword them. A rejected merge costs
 * a merge; an accepted invention costs the store's credibility.
 *
 * Numbers are content. "1.8GB" and "12GB" are different tokens and cannot stand
 * in for each other, which is exactly the substitution a summarising model makes
 * most readily.
 *
 * ## Purity
 *
 * Everything above `runDelegatePass` is pure — no I/O, no clock, no network, no
 * randomness. `contentWords`, `planDelegatePass` and `validateDelegateResponse`
 * take their time and their ledger as arguments, so every escape attempt is a
 * unit test rather than a fixture. The effects (read the ledger, launch the
 * agent, append what it spent) live only in `runDelegatePass`, and the launcher
 * is INJECTED — this module never spawns a process itself, which is what makes
 * it impossible for a test to start one.
 *
 * Baton adds no permission-bypass flag to the agent it launches, here or
 * anywhere. The job is routed like any other work so it lands on an idle or
 * cheaper agent rather than competing with the one the user is talking to.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fenceUntrusted, sanitizeUntrusted } from '../handoff/untrusted.js';
import { BUILTIN_ROUTING, suggestRoute, type RouteSuggestion, type RoutingConfig } from '../routing.js';
import { FACT_MAX_CHARS, type MemoryFact } from '../memory.js';
import type { SupersedeOp } from './consolidate.js';

export type { SupersedeOp };

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Three independent marks, because "distinguishable at every read" has to hold
 * for readers that see only ONE field. The dashboard renders `fact`; a journal
 * line carries `id`; an attribution view shows `author`. Any one of them alone
 * has to give the answer, so all three are stamped and `isMachineGenerated`
 * accepts whichever the caller happens to have.
 */
export const MACHINE_ID_PREFIX = 'mc-';
export const MACHINE_AUTHOR = 'baton-machine';
export const MACHINE_FACT_PREFIX = '[machine-consolidated]';

/** Baton stamps these; the model never gets to. See `buildProduced`. */
export interface ProducedFact {
  id: string;
  /** Already carries `MACHINE_FACT_PREFIX`. */
  fact: string;
  /** Ids in the job's inputs this text is derived from. Never empty. */
  cites: string[];
  origin: 'machine';
  /**
   * Which agent/model produced it, for the person deciding whether to keep it —
   * `null` when that was never recorded. A fact FILE carries no generator, so a
   * produced fact read back off disk has none, and the `baton-machine` author
   * constant that used to stand in named no agent and no model while looking
   * like attribution. Absent is the honest answer; do not fill it in.
   */
  generator: string | null;
  author: typeof MACHINE_AUTHOR;
}

/**
 * Does this look machine-generated? Any single stamped field is enough — a read
 * path that only has the id must still be able to tell.
 */
export function isMachineGenerated(f: { id?: string; author?: string; fact?: string }): boolean {
  return (
    (typeof f.id === 'string' && f.id.startsWith(MACHINE_ID_PREFIX)) ||
    f.author === MACHINE_AUTHOR ||
    (typeof f.fact === 'string' && f.fact.startsWith(MACHINE_FACT_PREFIX))
  );
}

// ---------------------------------------------------------------------------
// Operations — mirroring ConsolidateOp, so a caller applies both the same way
// ---------------------------------------------------------------------------

/** Add a machine-generated fact. Reversible: dropping the id undoes it. */
export interface ProposeOp {
  op: 'propose';
  fact: ProducedFact;
  reason: string;
}

/**
 * `SupersedeOp` is imported rather than redeclared on purpose: the two passes
 * must retire a fact by the exact same operation, or the caller grows a second
 * apply path and only one of them stays reversible.
 *
 * There is deliberately no delete and no edit. The strongest thing this pass
 * can ask for is "retire A, its successor is B" — both facts still exist, and
 * the journal entry names the pair.
 */
export type DelegateOp = ProposeOp | SupersedeOp;

// ---------------------------------------------------------------------------
// Content words — the definition the whole safety property rests on
// ---------------------------------------------------------------------------

/**
 * Words that carry no claim: articles, coordinators, copulas, the commonest
 * prepositions. Closed and small ON PURPOSE — every word added here is a word
 * the model may then introduce for free, so the list grows only for words that
 * cannot change what a sentence asserts.
 *
 * Negations are conspicuously ABSENT. "not", "never", "no" and "cannot" invert
 * a claim, so they are content: "graphify does not leak" may not be derived
 * from "graphify leaks".
 */
export const DELEGATE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the',
  'and', 'or',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'into', 'by', 'as',
  'is', 'are', 'was', 'were', 'be', 'been',
  'it', 'its', 'this', 'that', 'these', 'those', 'there',
]);

/**
 * Characters kept INSIDE a token, so that `1.8gb`, `src/memory.ts` and
 * `--write` survive as single tokens. Splitting them would let "1.8GB" and
 * "12GB" share the token `8`/`1` and quietly become interchangeable, which is
 * the exact substitution this check exists to catch.
 */
const TOKEN_SPLIT = /[^\p{L}\p{N}._/+-]+/gu;

/**
 * Comparison operators, rewritten as tokens the split can carry.
 *
 * `!=` `<` `>` are not in {@link TOKEN_SPLIT}'s keep-set, so they were
 * separators: "version != 18" and "version = 18" reduced to the same tokens
 * and the second could be produced from the first with nothing untraceable in
 * it. An operator is a claim, so it has to survive as a word.
 *
 * Arrows go FIRST and become nothing. `->` ends in `>` and would otherwise be
 * read as a greater-than, rejecting faithful prose — a connector is not a
 * comparison.
 */
const OPERATOR_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[-=]{1,2}>|<[-=]{1,2}/gu, ' '],
  [/!=|≠|<>/gu, ' op.ne '],
  [/>=|≥/gu, ' op.gte '],
  [/<=|≤/gu, ' op.lte '],
  [/={1,2}/gu, ' op.eq '],
  [/</gu, ' op.lt '],
  [/>/gu, ' op.gt '],
];

/** Replace each comparison with a token. The `op.` prefix cannot collide with
 *  prose: a dot survives the split, so `op.ne` is one token and no English
 *  word is spelled that way. */
function operatorWords(text: string): string {
  let out = text;
  for (const [re, word] of OPERATOR_WORDS) out = out.replace(re, word);
  return out;
}
const TRIM_EDGES = /^[._/+-]+|[._/+-]+$/gu;

/**
 * The tokens that count as evidence.
 *
 * Case-folded (casing is not a claim), invisible characters stripped via the
 * shared `sanitizeUntrusted` (a zero-width space inside a word would otherwise
 * let `in​vented` pass as two fragments), punctuation dropped, stopwords
 * dropped. Everything left — including every number — must be traceable.
 *
 * Pure. Same string in, same array out, forever.
 */
export function contentWords(text: string): string[] {
  // NFKC first, then drop combining marks. Both are canonicalisation, and both
  // are load-bearing: a variation selector or combining accent is invisible (or
  // attached) when RENDERED but is not a token character, so it SPLITS a token.
  // "4\uFE0F8" reads as one number and used to tokenise as "4" and "8" — two
  // tokens a model could source separately from different facts, making the
  // rendered claim and the validated tokens different documents. Normalising
  // makes what a person sees and what the validator checks the same string.
  const clean = operatorWords(sanitizeUntrusted(String(text))
    .normalize('NFKC')
    // U+2212 MINUS renders as a minus and is not touched by NFKC, so a claim
    // written with the typographic sign must fold onto the ASCII one or the
    // two spellings of the same measurement stop matching each other.
    .replace(/\u2212/gu, '-')
    // A SPACING diacritic (U+037A, and the ´ ¨ ¯ ¸ ˘ family) renders as a mark
    // hanging off its neighbour but decomposes to SPACE + combining mark, so
    // dropping the mark alone left the space behind and SPLIT the word the
    // reader sees. "4ͺ0" reads as forty and validated as "4" and "0" — two
    // tokens a model could source from two different facts, which is the seam
    // a merge is allowed to have. Remove the pair together, before the general
    // strip turns it into a bare separator.
    .replace(/ \p{M}+/gu, '')
    // Lower-case BEFORE the general strip, not after: `İ` lower-cases to
    // `i` + COMBINING DOT ABOVE, so a strip that has already run leaves a mark
    // behind and splits the word in half.
    .toLowerCase()
    .replace(/\p{M}+/gu, ''));
  const out: string[] = [];
  for (const raw of clean.split(TOKEN_SPLIT)) {
    const w = raw.replace(TRIM_EDGES, '');
    if (!w || DELEGATE_STOPWORDS.has(w)) continue;
    // A leading minus on a NUMBER is part of the measurement, not punctuation
    // to be trimmed: "-1.8gb" and "1.8gb" are opposite readings, and erasing
    // the sign let a saving be restated as a cost with every word traceable.
    // Restored only in front of a digit, so a list dash or a hyphenated word
    // is trimmed exactly as before.
    out.push(raw.startsWith('-') && /^\d/u.test(w) ? `-${w}` : w);
  }
  return out;
}

/** The shortest run of words that counts as reused phrasing rather than reused vocabulary. */
export const MIN_SPAN = 2;

/**
 * Can this word sequence be built entirely from contiguous RUNS of the sources?
 *
 * This is what makes containment a test of the CLAIM rather than of the
 * vocabulary, and it is the difference between the two things the feature must
 * tell apart:
 *
 *   - **Merging** two facts is joining spans: "indexing the whole repo" +
 *     "uses 1.8GB of RAM" + "takes 40 seconds". Every run is contiguous in a
 *     fact that is cited, so it passes. That is the whole point of the feature.
 *   - **Originating** is recombining at the word level: reordering one fact's
 *     own words to assert the opposite ("binds to 127.0.0.1 … refuses a public
 *     interface" -> "binds to a public interface … refuses 127.0.0.1"), or
 *     mixing tokens from two facts into a sentence neither makes. Both need at
 *     least one run of a SINGLE word to stitch the seam, and both now fail.
 *
 * `MIN_SPAN` is why: allowing one-word runs makes any permutation coverable,
 * which is exactly the bag-of-words test this replaced.
 *
 * A produced fact shorter than MIN_SPAN is covered by the token check alone.
 * Pure; O(n²) over a fact's content words, which are bounded by MAX_FACT_CHARS.
 */
export function coveredBySpans(words: readonly string[], sources: readonly (readonly string[])[]): boolean {
  if (words.length < MIN_SPAN) return true;

  // Index each source by first word rather than materialising every run of it.
  // The obvious version — enumerate all runs into a Set — is O(len²) strings
  // per source and made validation take ten seconds on a 220-word fact, which
  // would have been a denial of service on the validator itself.
  const at = new Map<string, { s: number; i: number }[]>();
  sources.forEach((src, s) => {
    for (let i = 0; i < src.length; i++) {
      const slot = at.get(src[i]);
      if (slot) slot.push({ s, i });
      else at.set(src[i], [{ s, i }]);
    }
  });

  // State is (position, which source the LAST span came from), because
  // consecutive spans must come from DIFFERENT cited facts.
  //
  // That constraint is what stops the subtlest origination there is: deleting
  // one word mid-sentence. "graphify does not leak memory" -> "graphify does
  // leak memory" leaves two runs that are each contiguous in the source, so a
  // plain span cover accepts it and supersedes the true fact with its
  // opposite. Requiring the next span to come from a different fact means that
  // within any one fact you must reuse an unbroken run — you may join facts,
  // you may not edit one. Joining two facts is the merge this feature exists
  // for; skipping a word inside one is not a merge.
  const seen = new Set<string>();
  let frontier: { at: number; last: number }[] = [{ at: 0, last: -1 }];
  while (frontier.length) {
    const next: { at: number; last: number }[] = [];
    for (const state of frontier) {
      if (state.at === words.length) return true;
      for (const { s, i: p } of at.get(words[state.at]) ?? []) {
        if (s === state.last) continue;          // same fact twice in a row
        const src = sources[s];
        let k = 0;
        while (state.at + k < words.length && p + k < src.length
               && words[state.at + k] === src[p + k]) {
          k++;
          if (k < MIN_SPAN) continue;
          const key = `${state.at + k}:${s}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ at: state.at + k, last: s });
        }
      }
    }
    frontier = next;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Configuration — off unless someone said the word
// ---------------------------------------------------------------------------

export interface DelegateConfig {
  /** OFF unless explicitly, literally `true`. */
  enabled: boolean;
  /** Runs allowed in the trailing window. */
  maxRunsPerDay: number;
  /** Minimum gap between two launches. */
  minIntervalMs: number;
  /** How many facts one job may carry. */
  maxFactsPerJob: number;
  /** Spend allowed in the trailing window, in USD. */
  maxUsdPerDay: number;
  /** The trailing window both caps are measured over. */
  windowMs: number;
}

export const DELEGATE_DEFAULTS: DelegateConfig = Object.freeze({
  enabled: false,
  maxRunsPerDay: 4,
  minIntervalMs: 60 * 60 * 1000,
  maxFactsPerJob: 60,
  maxUsdPerDay: 0.5,
  windowMs: 24 * 60 * 60 * 1000,
});

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/**
 * Read a config blob that may have come from anywhere. `enabled` is true only
 * for the boolean `true` — a truthy `"false"` or a leftover `1` from a hand-
 * edited file must not start an agent on somebody's account.
 */
export function resolveDelegateConfig(raw: unknown): DelegateConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    maxRunsPerDay: num(o.maxRunsPerDay, DELEGATE_DEFAULTS.maxRunsPerDay, 0, 100),
    minIntervalMs: num(o.minIntervalMs, DELEGATE_DEFAULTS.minIntervalMs, 0, 7 * 24 * 3600_000),
    maxFactsPerJob: num(o.maxFactsPerJob, DELEGATE_DEFAULTS.maxFactsPerJob, 1, 500),
    maxUsdPerDay: num(o.maxUsdPerDay, DELEGATE_DEFAULTS.maxUsdPerDay, 0, 1000),
    windowMs: num(o.windowMs, DELEGATE_DEFAULTS.windowMs, 60_000, 30 * 24 * 3600_000),
  };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface DelegateInput { id: string; fact: string }

export interface DelegateJob {
  /** Agent the router picked. Baton launches it as the user, with no extra flags. */
  agent: string;
  model: string | null;
  route: RouteSuggestion;
  inputs: DelegateInput[];
  /** The raw input block, BEFORE fencing — exposed so a caller can measure it. */
  factsBlock: string;
  /** The whole prompt. The facts appear in it exactly once, inside one fence. */
  prompt: string;
  requestedAt: number;
}

export interface DelegateLedgerEntry { at: number; costUsd: number }
export interface DelegateLedger { runs: DelegateLedgerEntry[] }

export interface DelegatePlan {
  launch: boolean;
  reason: string;
  job: DelegateJob | null;
}

/**
 * Ids that are not ids. `__proto__` in a lookup key is the classic way to make
 * a validator agree with itself about a fact that does not exist; the answer is
 * to use a `Map` (below) AND to refuse the name outright, because a fact whose
 * id is `constructor` is going to break something downstream even if it breaks
 * nothing here.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Short and boring on purpose: the router scores task text for severity, and
 * this is genuinely a small, mechanical job that belongs on a cheap tier.
 */
const DELEGATE_TASK_TEXT = 'merge duplicate memory facts; reuse existing wording only';

/** The instructions. They are a convenience, not a control — see the validator. */
const INSTRUCTIONS = [
  'You are reorganising an existing knowledge base. Merge facts that say the',
  'same thing and drop nothing else.',
  '',
  'Reply with JSON only:',
  '  {"facts":[{"fact":"...","cites":["id",...],"supersedes":["id",...]}]}',
  '',
  'Every word you write must already appear in a fact you cite. Do not add',
  'adjectives, do not change a number, do not summarise in your own words.',
  '`supersedes` may only name ids you also cite. Anything else is discarded',
  'automatically without being read.',
].join('\n');

function renderFacts(inputs: DelegateInput[]): string {
  return inputs.map((i) => `${i.id}: ${i.fact}`).join('\n');
}

/**
 * Decide whether to run, and build the job if so. Pure: `now` and the ledger
 * arrive as arguments, so the rate limiter is testable without waiting for
 * anything.
 */
export function planDelegatePass(args: {
  facts: MemoryFact[];
  config: DelegateConfig;
  ledger: DelegateLedger;
  now: number;
  routing?: RoutingConfig;
  /**
   * Agents that already have work. Passed IN rather than looked up, so this
   * function stays pure — the caller reads the roster, which is where liveness
   * already lives. This is the "idle" half of routing the job like other work:
   * the whole point of delegating is not to compete with the agent the user is
   * currently talking to.
   */
  busy?: readonly string[];
}): DelegatePlan {
  const { config, ledger, now } = args;
  const no = (reason: string): DelegatePlan => ({ launch: false, reason, job: null });

  if (!config.enabled) return no('agent-assisted consolidation is disabled');

  const recent = ledger.runs.filter((r) => Number.isFinite(r.at) && now - r.at < config.windowMs);
  const last = recent.reduce((max, r) => Math.max(max, r.at), -Infinity);
  if (Number.isFinite(last) && now - last < config.minIntervalMs) {
    return no(`too soon — minimum interval is ${Math.round(config.minIntervalMs / 60000)} min`);
  }
  if (recent.length >= config.maxRunsPerDay) {
    return no(`daily run cap reached (${recent.length}/${config.maxRunsPerDay})`);
  }
  const spent = recent.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
  if (spent >= config.maxUsdPerDay) {
    return no(`daily spend cap reached ($${spent.toFixed(3)} of $${config.maxUsdPerDay})`);
  }

  // Oldest first: the facts most likely to have been restated since. Id breaks
  // a tie so the same store always yields the same job.
  const usable = args.facts
    .filter((f) => f && typeof f.id === 'string' && !RESERVED_IDS.has(f.id) && typeof f.fact === 'string')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, config.maxFactsPerJob);

  if (usable.length < 2) return no('not enough facts to reorganise');

  const route = suggestRoute(DELEGATE_TASK_TEXT, args.routing ?? BUILTIN_ROUTING);
  /*
   * Cheapest first, then the router's own recommendation. A downshift is the
   * router saying "this could go somewhere cheaper", and a memory merge is
   * exactly the kind of small mechanical job it exists for.
   *
   * Then skip whatever is busy. If everything is busy the router's own
   * recommendation still wins — refusing to consolidate because every agent is
   * occupied would mean the pass never runs on the machines that need it most.
   */
  const candidates = [...(route.downshift?.chain ?? []), ...route.chain];
  const busy = new Set(args.busy ?? []);
  const pick = candidates.find((c) => !busy.has(c.agent)) ?? null;
  const agent = pick?.agent ?? route.agent;
  const model = pick?.model ?? route.model ?? null;

  const inputs: DelegateInput[] = usable.map((f) => ({ id: f.id, fact: f.fact }));
  const factsBlock = renderFacts(inputs);

  return {
    launch: true,
    reason: 'ready',
    job: {
      agent,
      model,
      route,
      inputs,
      factsBlock,
      // ONE fence, from the shared helper. These sentences were written by
      // other agents, and a fact is an injection path straight into the store
      // every future session trusts. A second, hand-rolled fence here would be
      // a second thing to keep correct, and the weaker of the two would win.
      prompt: `${INSTRUCTIONS}\n\n${fenceUntrusted('memory.facts', factsBlock)}\n`,
      requestedAt: now,
    },
  };
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export type RejectionReason =
  | 'unparseable'
  | 'bad-shape'
  | 'reserved-id'
  | 'no-citation'
  | 'self-citation'
  | 'unknown-citation'
  | 'supersede-not-cited'
  | 'empty-fact'
  | 'oversized-fact'
  | 'untraceable-token'
  | 'untraceable-claim';

export interface DelegateRejection {
  /** Index in the response's `facts` array; -1 for a whole-response problem. */
  index: number;
  reason: RejectionReason;
  detail: string;
}

export interface DelegateValidation {
  ops: DelegateOp[];
  rejections: DelegateRejection[];
}

/**
 * How many facts one response may produce. A pass that returns four hundred new
 * facts has not consolidated anything; it has doubled the store.
 */
export const MAX_PRODUCED = 64;

/** How much of a reply is even looked at. Bounds the rejection list too. */
export const MAX_RESPONSE_ITEMS = 1000;

/** Strip a markdown code fence an agent wrapped its JSON in. Nothing more —
 *  a truncated body stays truncated, and stays unparseable. */
function unwrap(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

function producedId(text: string, cites: string[]): string {
  const h = createHash('sha256').update(`${text}\x00${[...cites].sort().join(',')}`).digest('hex');
  return `${MACHINE_ID_PREFIX}${h.slice(0, 12)}`;
}

/**
 * Turn an agent's reply into operations, rejecting everything that is not a
 * pure reorganisation of the job's own inputs.
 *
 * Pure. No clock, no I/O, no randomness — the produced id is a hash of the
 * text and its citations, so the same reply always yields the same ops.
 *
 * A malformed, truncated or wrong-shaped reply yields NO operations. That is
 * the same outcome as a reply that said nothing: nothing changes.
 */
export function validateDelegateResponse(raw: string, job: Pick<DelegateJob, 'inputs' | 'agent' | 'model'>): DelegateValidation {
  const ops: DelegateOp[] = [];
  const rejections: DelegateRejection[] = [];
  const reject = (index: number, reason: RejectionReason, detail: string): void => {
    rejections.push({ index, reason, detail });
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrap(String(raw ?? '')));
  } catch (e) {
    reject(-1, 'unparseable', `response is not JSON: ${(e as Error).message}`);
    return { ops, rejections };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reject(-1, 'bad-shape', 'response is not a JSON object');
    return { ops, rejections };
  }
  const items = (parsed as Record<string, unknown>).facts;
  if (!Array.isArray(items)) {
    reject(-1, 'bad-shape', 'response has no `facts` array');
    return { ops, rejections };
  }

  // Map, never a plain object: an id of `__proto__` must be an ordinary miss,
  // not a hit on Object.prototype. (It is also refused by name below — both,
  // because either alone is one refactor away from being the only one.)
  const sources = new Map<string, Set<string>>();
  /** Each source's words IN ORDER, for the span check. The Set above loses order. */
  const sourceWords = new Map<string, string[]>();
  for (const input of job.inputs) {
    const words = contentWords(input.fact);
    sources.set(input.id, new Set(words));
    sourceWords.set(input.id, words);
  }

  const generator = job.model ? `${job.agent}:${job.model}` : job.agent;
  const seen = new Set<string>();

  for (let index = 0; index < items.length && index < MAX_RESPONSE_ITEMS; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      reject(index, 'bad-shape', 'entry is not an object');
      continue;
    }
    const rec = item as Record<string, unknown>;
    const text = rec.fact;
    const cites = rec.cites;
    const supersedes = rec.supersedes === undefined ? [] : rec.supersedes;
    if (typeof text !== 'string' || !Array.isArray(cites) || !Array.isArray(supersedes)) {
      reject(index, 'bad-shape', 'entry needs a string `fact`, an array `cites` and an optional array `supersedes`');
      continue;
    }
    if (!cites.every((c) => typeof c === 'string') || !supersedes.every((s) => typeof s === 'string')) {
      reject(index, 'bad-shape', 'ids must be strings');
      continue;
    }
    // Deduped: a fact named twice is still ONE fact. The span check below
    // forbids two CONSECUTIVE spans from the same cited fact — enforced by
    // position in this list — so a repeated id handed the model two sources
    // with identical contents and a free seam between them. That is enough to
    // delete a negation mid-sentence and supersede the truth with its opposite.
    const citeIds = [...new Set(cites as string[])];
    const supersedeIds = supersedes as string[];

    // Before anything reads the text: `coveredBySpans` is quadratic in a
    // produced fact's word count, and nothing else bounds that count. One
    // 20 000-word "fact" in a reply cost 35 SECONDS of span search — a denial
    // of service on the validator itself, which is the thing that runs before
    // an untrusted reply is believed. A fact this long could never be saved
    // (`FACT_MAX_CHARS`), so it is refused before it is searched.
    if (text.length > FACT_MAX_CHARS) {
      reject(index, 'oversized-fact', `fact is ${text.length} chars (max ${FACT_MAX_CHARS})`);
      continue;
    }

    const claimedId = typeof rec.id === 'string' ? rec.id : null;
    const reserved = [claimedId, ...citeIds, ...supersedeIds].find((id) => id !== null && RESERVED_IDS.has(id));
    if (reserved !== undefined) {
      reject(index, 'reserved-id', `\`${reserved}\` is not a usable id`);
      continue;
    }

    if (!citeIds.length) {
      reject(index, 'no-citation', 'a produced fact must name the facts it derives from');
      continue;
    }
    // A fact that cites itself is its own evidence, which is how a model
    // launders an invention into the store.
    if (claimedId && citeIds.includes(claimedId)) {
      reject(index, 'self-citation', `\`${claimedId}\` cites itself`);
      continue;
    }
    const unknown = citeIds.filter((id) => !sources.has(id));
    if (unknown.length) {
      reject(index, 'unknown-citation', `cites ids not in this job: ${unknown.join(', ')}`);
      continue;
    }
    const notCited = supersedeIds.filter((id) => !citeIds.includes(id));
    if (notCited.length) {
      reject(index, 'supersede-not-cited', `would retire facts it does not derive from: ${notCited.join(', ')}`);
      continue;
    }

    const words = contentWords(text);
    if (!words.length) {
      reject(index, 'empty-fact', 'no content words — nothing is being asserted');
      continue;
    }

    // THE CHECK. Union of the CITED facts only: a word that exists elsewhere in
    // the job but not in this fact's own sources is still an origination, and
    // is the shape a confident model produces most often.
    const allowed = new Set<string>();
    for (const id of citeIds) for (const w of sources.get(id)!) allowed.add(w);
    const untraceable = [...new Set(words.filter((w) => !allowed.has(w)))];
    if (untraceable.length) {
      reject(index, 'untraceable-token', `not traceable to cited facts: ${untraceable.join(', ')}`);
      continue;
    }

    // THE SECOND CHECK, and the one that makes the first mean anything.
    //
    // Token containment alone is a BAG-OF-WORDS test — no notion of order — so
    // a model could reorder a fact's own words to assert the opposite of what
    // it said, or stitch tokens from two cited facts into a sentence neither
    // makes, and then supersede the true fact behind the forgery. All of that
    // was accepted before this check existed. See `coveredBySpans`.
    if (!coveredBySpans(words, citeIds.map((id) => sourceWords.get(id)!))) {
      reject(index, 'untraceable-claim',
        'every word is traceable but the claim is not — this rearranges the cited facts '
        + 'rather than reusing their phrasing');
      continue;
    }

    const id = producedId(text, citeIds);
    if (seen.has(id)) continue;               // the same merge proposed twice
    if (seen.size >= MAX_PRODUCED) break;
    seen.add(id);

    const produced: ProducedFact = {
      id,
      // Baton prepends the mark; the model never supplies it. A reply that
      // included it would have failed the token check a few lines above, which
      // is the point — the provenance stamp cannot be forged into a fact.
      fact: `${MACHINE_FACT_PREFIX} ${sanitizeUntrusted(text).trim()}`,
      cites: citeIds,
      origin: 'machine',
      generator,
      author: MACHINE_AUTHOR,
    };
    ops.push({
      op: 'propose',
      fact: produced,
      reason: `machine-consolidated from ${citeIds.join(', ')}`,
    });
    // After the propose, so a caller applying the list in order never names a
    // successor that does not exist yet.
    for (const target of supersedeIds) {
      ops.push({
        op: 'supersede',
        id: target,
        supersededBy: id,
        reason: 'merged into a machine-consolidated fact (original retired, not deleted)',
      });
    }
  }

  return { ops, rejections };
}

// ---------------------------------------------------------------------------
// The edge: the only part that touches a disk, a clock or an agent
// ---------------------------------------------------------------------------

export interface DelegateSpend {
  at: number;
  ok: boolean;
  agent: string;
  model: string | null;
  inputFacts: number;
  promptChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * `null` when the line never recorded one — a ledger written by an older
   * build has no `costUsd`, and this is read back by JSON.parse, not produced
   * fresh. Declared non-nullable it asserted a measurement that was never
   * taken, and the dashboard rendered the `undefined` that arrived under it.
   */
  costUsd: number | null;
  durationMs: number;
  produced: number;
  rejected: number;
  error?: string;
}

/** What an injected launcher hands back. Text is whatever the agent printed. */
export interface DelegateResponse {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    model?: string;
  };
}

export interface DelegateRunResult {
  launched: boolean;
  reason: string;
  ops: DelegateOp[];
  rejections: DelegateRejection[];
  spend: DelegateSpend | null;
}

export function delegateLedgerPath(root: string): string {
  return join(root, '.baton', 'memory-delegate.jsonl');
}

/**
 * Every run this pass has made, newest last. A line that does not parse is
 * skipped rather than fatal: a truncated ledger must not become a reason to
 * stop rate-limiting.
 */
export async function readDelegateLedger(root: string): Promise<DelegateLedger> {
  let text: string;
  try {
    text = await readFile(delegateLedgerPath(root), 'utf8');
  } catch {
    return { runs: [] };
  }
  const runs: DelegateLedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.at === 'number' && Number.isFinite(rec.at)) {
        runs.push({ at: rec.at, costUsd: typeof rec.costUsd === 'number' ? rec.costUsd : 0 });
      }
    } catch { /* a half-written line is not a reason to lose the rest */ }
  }
  return { runs };
}

async function appendSpend(root: string, spend: DelegateSpend): Promise<void> {
  const file = delegateLedgerPath(root);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(spend)}\n`, 'utf8');
}

/**
 * Why an agent pass cannot have happened, stated once so every surface says the
 * same thing.
 *
 * `runDelegatePass` needs an injected `launch`, and NOTHING in Baton supplies
 * one: no daemon hook, no CLI command, no route. Nothing applies a `ProposeOp`
 * either, so a produced fact has no way of reaching the store. The setting is
 * therefore a recorded preference — real, persisted, and honoured the moment a
 * launcher ships — and not, today, an authorisation that spends anything.
 *
 * That distinction is worth a constant because it is the one a user is deciding
 * about. A screen that reads "this launches an agent on your account" while no
 * such wiring exists teaches people to disbelieve the warning, and the same
 * words have to still be there, and be true, on the day one does exist.
 *
 * When a launcher lands it must land behind the approval `baton dispatch`
 * already requires — a human starting it — never as a side effect of a POST.
 * Move this constant then; do not quietly delete the sentence it replaces.
 */
export const DELEGATE_NO_LAUNCHER =
  'No agent pass can run: enabling this records your consent, and nothing in Baton launches an '
  + 'agent against the memory store yet. Mechanical consolidation still runs.';

/**
 * Run one pass.
 *
 * `launch` is REQUIRED and injected: this module owns no spawn, which is what
 * makes it impossible for a test — or a caller that forgot to check the setting
 * — to start a process from here. The caller wires it to the user's own agent
 * CLI, under the user's own credentials, with no permission-bypass flag.
 *
 * The attempt is recorded whether or not the agent succeeded. A crashing agent
 * that left no ledger entry would be retried on the next tick, forever, which
 * is the one failure mode that spends real money.
 */
export async function runDelegatePass(args: {
  root: string;
  facts: MemoryFact[];
  config?: DelegateConfig;
  routing?: RoutingConfig;
  now?: () => number;
  launch: (job: DelegateJob) => Promise<DelegateResponse>;
}): Promise<DelegateRunResult> {
  const config = args.config ?? DELEGATE_DEFAULTS;
  const now = args.now ?? (() => Date.now());
  const idle: DelegateRunResult = { launched: false, reason: '', ops: [], rejections: [], spend: null };

  // Checked before ANY read: the default configuration must produce no work of
  // any kind, not merely no launch.
  if (!config.enabled) return { ...idle, reason: 'agent-assisted consolidation is disabled' };

  const ledger = await readDelegateLedger(args.root);
  const plan = planDelegatePass({ facts: args.facts, config, ledger, now: now(), routing: args.routing });
  if (!plan.launch || !plan.job) return { ...idle, reason: plan.reason };

  const job = plan.job;
  const startedAt = now();
  let response: DelegateResponse | null = null;
  let error: string | undefined;
  try {
    response = await args.launch(job);
  } catch (e) {
    error = (e as Error).message;
  }

  const usage = response?.usage ?? {};
  const result = response
    ? validateDelegateResponse(response.text, job)
    : { ops: [] as DelegateOp[], rejections: [] as DelegateRejection[] };

  const spend: DelegateSpend = {
    at: startedAt,
    ok: !error,
    agent: job.agent,
    model: usage.model ?? job.model,
    inputFacts: job.inputs.length,
    promptChars: job.prompt.length,
    inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
    outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
    // Null, not 0: a launcher that reports no cost has told us NOTHING, and
    // `$0.000` on the dashboard is reserved for a run that really was free.
    // The daily cap already treats a non-finite cost as 0 when summing, so the
    // arithmetic is unchanged — only the claim the record makes about itself.
    costUsd: typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : null,
    durationMs: Math.max(0, now() - startedAt),
    produced: result.ops.filter((o) => o.op === 'propose').length,
    rejected: result.rejections.length,
    ...(error ? { error } : {}),
  };
  await appendSpend(args.root, spend);

  return { launched: true, reason: error ?? 'ok', ops: result.ops, rejections: result.rejections, spend };
}

/* ---- the setting, persisted -----------------------------------------------
   `resolveDelegateConfig` decides what a config blob MEANS; these two decide
   where it lives. Kept here rather than in memory.ts so the strict `enabled`
   rule and its storage cannot drift apart: every read goes back through
   resolveDelegateConfig, so a hand-edited `"yes"` is still off. */

/** Per-repo, gitignored with the rest of `.baton/memory/`. */
export function delegateSettingPath(root: string): string {
  return join(root, '.baton', 'memory', 'delegate.json');
}

/**
 * The saved setting, merged with the caps.
 *
 * Fails closed in every direction: no file, unreadable file, corrupt JSON, or
 * a truthy-but-not-true `enabled` all read as OFF. An unreadable setting must
 * never be mistaken for consent to spend somebody's money.
 */
export async function loadDelegateSetting(root: string): Promise<DelegateConfig> {
  try {
    return resolveDelegateConfig(JSON.parse(await readFile(delegateSettingPath(root), 'utf8')));
  } catch {
    return resolveDelegateConfig(undefined);
  }
}

/** Record an explicit choice. Only `enabled` is settable; caps are config. */
export async function saveDelegateSetting(root: string, enabled: boolean): Promise<DelegateConfig> {
  const file = delegateSettingPath(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ enabled: enabled === true }, null, 2)}\n`, 'utf8');
  return loadDelegateSetting(root);
}

/**
 * The most recent run in full, for the receipt the dashboard shows.
 *
 * `readDelegateLedger` deliberately narrows each line to `{at, costUsd}` — all
 * rate limiting needs. This keeps the whole record instead, and tolerates the
 * same half-written last line for the same reason.
 */
export async function lastDelegateRun(root: string): Promise<DelegateSpend | null> {
  let text: string;
  try {
    text = await readFile(delegateLedgerPath(root), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Partial<DelegateSpend>;
      if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue;
      // Normalised, not cast: every field below is read off a line this build
      // did not necessarily write, so an absent measurement becomes `null`
      // rather than riding out as `undefined` under a type promising a number.
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      return {
        ...rec,
        at: rec.at,
        costUsd: num(rec.costUsd),
        inputTokens: num(rec.inputTokens),
        outputTokens: num(rec.outputTokens),
      } as DelegateSpend;
    } catch { /* a truncated tail is not a reason to report no runs */ }
  }
  return null;
}
