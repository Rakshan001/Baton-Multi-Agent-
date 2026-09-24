// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mechanical consolidation of the fact store — the zero-LLM default.
 *
 * This is what runs for every user whether or not they ever open Settings, so
 * it has to be useful on its own and, more importantly, incapable of losing
 * knowledge. Three rules carry that weight:
 *
 *   1. **Facts in, OPERATIONS out.** Nothing here reads or writes a file. The
 *      caller performs the writes, which is what makes every decision below a
 *      unit test rather than a fixture directory.
 *   2. **Supersede, never delete, never rewrite.** The only write this pass can
 *      ask for names two ids. There is deliberately no field in which a merged
 *      sentence could travel: a pass that edits text is a pass that can change
 *      meaning, and every later session reads these sentences as truth.
 *   3. **Contradiction is a signal for a person.** Two facts that disagree are
 *      reported, never resolved. Picking one mechanically is how a store starts
 *      asserting things nobody wrote.
 *
 * What counts as a duplicate is deliberately the SAME test `saveMemory` already
 * applies at write time (same fingerprint, bodies confirmed similar) — a second
 * opinion about what "the same fact" means would drift from the first, and the
 * copy that runs unattended over the whole store is the one that must not.
 */
import { SUPERSEDE_MIN_SIMILARITY, type MemoryFact } from '../memory.js';

/** Retire `id`, recording its successor. Mirrors `JournalEntry`, so a caller
 *  hands it almost straight to the archive path. */
export interface SupersedeOp {
  op: 'supersede';
  id: string;
  supersededBy: string;
  reason: string;
}

/** Something a human has to look at. No write is implied, ever. */
export interface ReportOp {
  op: 'report';
  kind: 'contradiction';
  /** Both facts, sorted by id so the plan does not depend on input order. */
  ids: string[];
  reason: string;
}

export type ConsolidateOp = SupersedeOp | ReportOp;

export interface ConsolidateOptions {
  /**
   * When the pass began (epoch ms). A fact written after this instant is left
   * strictly alone — an agent is mid-thought about it, and a background pass
   * that retires a fact someone is still writing is a race with a person.
   */
  startedAt: number;
}

/** Two facts that disagree only by a negation still read as ~the same sentence,
 *  so the bar is a shade below what a merge would need. */
const CONTRADICTION_MIN_SIMILARITY = 0.6;

/** Words whose presence flips a claim. Apostrophes are stripped before the
 *  match, so `don't` arrives here as `dont`. */
const NEGATIONS = new Set([
  'not', 'never', 'cannot', 'cant', 'dont', 'doesnt', 'didnt', 'isnt', 'arent',
  'wasnt', 'werent', 'wont', 'shouldnt', 'wouldnt', 'couldnt', 'without', 'none', 'nor', 'no',
]);

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/**
 * How many disagreements one pass hands over. A pass that returns ten thousand
 * of them has reported nothing a person will read, and it is a store-wide
 * quality problem rather than a list of tickets. Merge-blocking is NOT capped —
 * see the group loop, which checks every mergeable pair exhaustively.
 */
export const MAX_CONTRADICTION_REPORTS = 50;

/** Crude plural fold, so `serves`/`serve` are one word. Deliberately not a real
 *  stemmer: this only has to make two phrasings of one sentence line up. */
function stem(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** Everything the sentence CLAIMS: stemmed words, minus the negations (which
 *  polarity handles separately) and minus bare numbers (which values do). */
function claimWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length <= 2 || NEGATIONS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function isNegated(text: string): boolean {
  const words = text.toLowerCase().replace(/['’]/g, '').split(/[^a-z]+/);
  return words.some((w) => NEGATIONS.has(w));
}

function numbersIn(text: string): string[] {
  return [...new Set(text.match(NUMBER_RE) ?? [])].sort();
}

/**
 * Is jaccard(a, b) at least `t`?
 *
 * Answering the question instead of computing the number lets it stop early:
 * a pair needs `ceil(t·(|a|+|b|)/(1+t))` shared words, so once the words left
 * to check cannot reach that count the pair is decided. Most pairs in a real
 * store are unrelated and fall out after two or three lookups, which is what
 * keeps the whole-store scan below the pass's budget at the 500-fact cap.
 */
function similarEnough(a: Set<string>, b: Set<string>, t: number): boolean {
  if (!a.size || !b.size) return false;
  // The epsilon keeps a ratio that is exactly `t` on paper from being pushed
  // to the next integer by binary rounding (0.6 is not representable).
  const need = Math.ceil((t * (a.size + b.size)) / (1 + t) - 1e-9);
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  let left = small.size;
  for (const w of small) {
    if (big.has(w)) inter++;
    left--;
    if (inter >= need) return true;
    if (inter + left < need) return false;
  }
  return inter >= need;
}

/**
 * The words `factSimilarity` compares (memory.ts): lowercased, punctuation to
 * space, anything longer than two characters. Duplicated here ONLY so the sets
 * can be built once per fact instead of once per comparison — a group of 250
 * near-identical facts is 31k comparisons, and re-tokenising the same sentence
 * that many times is where the pass's whole budget went. The equivalence to
 * `factSimilarity` is asserted in the test, so a change to the shared notion of
 * similarity fails loudly here instead of drifting.
 */
export function sigWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
}

/** Jaccard over prepared sets — the number `factSimilarity` returns. Exported
 *  with `sigWords` so the test can prove the two agree, digit for digit. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const w of small) if (big.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Prepared {
  fact: MemoryFact;
  at: number;
  /** Tokens for the duplicate test — the same ones `factSimilarity` uses. */
  sig: Set<string>;
  /** Tokens for the contradiction test: stemmed, negations and numbers removed. */
  claim: Set<string>;
  negated: boolean;
  numbers: string;
  local: boolean;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/**
 * May `winner` retire `loser`? Only when the loser is the older of the two.
 * Facts saved in the same second are ordinary — an agent recording what it
 * learned writes several at once — and comparing timestamps alone would leave
 * those pairs duplicated forever, so an exact tie falls back to the id. That is
 * the order the group is already sorted in, so the choice is the same on every
 * run.
 */
function supersedable(winner: Prepared, loser: Prepared): boolean {
  return winner.at !== loser.at ? winner.at > loser.at : winner.fact.id < loser.fact.id;
}

/**
 * Plan the pass. Pure: same facts and same `startedAt` give the same
 * operations, in the same order, whatever order the facts arrived in.
 *
 * Idempotent in the sense that matters — apply the plan (the superseded facts
 * leave the live store) and a second run asks for no further writes. Reports
 * persist by design: nothing was written, so the disagreement is still open and
 * still a person's to settle.
 */
export function consolidateFacts(facts: MemoryFact[], opts: ConsolidateOptions): ConsolidateOp[] {
  const prepared: Prepared[] = [];
  for (const f of facts) {
    const at = Date.parse(f.createdAt);
    // Unparseable timestamp → cannot show it is older than the pass, so it is
    // not this pass's business.
    if (!Number.isFinite(at) || at > opts.startedAt) continue;
    prepared.push({
      fact: f,
      at,
      sig: sigWords(f.fact),
      claim: claimWords(f.fact),
      negated: isNegated(f.fact),
      numbers: numbersIn(f.fact).join(','),
      local: f.localOnly === true || f.area === 'local',
    });
  }

  /*
   * Two separate things, deliberately.
   *
   * `blocked` is the safety mechanism: a pair in here can never be merged, and
   * it is never capped, sampled or truncated — a contradiction the pass failed
   * to notice is a contradiction the pass resolves by picking one, which is the
   * outcome this whole module exists to prevent.
   *
   * `reports` is the human-facing half, and it IS capped. Ten thousand tickets
   * report nothing anyone will read.
   */
  const blocked = new Set<string>();
  const reported = new Map<string, ReportOp>();
  const flag = (a: Prepared, b: Prepared, reason: string): void => {
    const key = pairKey(a.fact.id, b.fact.id);
    blocked.add(key);
    if (reported.size >= MAX_CONTRADICTION_REPORTS || reported.has(key)) return;
    reported.set(key, { op: 'report', kind: 'contradiction', ids: [a.fact.id, b.fact.id].sort(), reason });
  };

  // Fingerprint groups: the merge candidates, and the only place a differing
  // VALUE is worth reporting (elsewhere two facts with different numbers are
  // usually just two facts).
  const groups = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const fp = p.fact.fingerprint || '';
    if (!fp) continue;
    const bucket = groups.get(fp);
    if (bucket) bucket.push(p);
    else groups.set(fp, [p]);
  }

  const ops: SupersedeOp[] = [];
  for (const fp of [...groups.keys()].sort()) {
    const members = groups.get(fp)!;
    if (members.length < 2) continue;
    // Newest first; id breaks a tie so the plan cannot depend on input order.
    members.sort((a, b) => b.at - a.at || (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0));

    /*
     * Every pair that could MERGE is checked for disagreement here, exhaustively
     * — this is the check that stops a contradiction being resolved by a
     * machine, so it is never sampled, capped or skipped. Two shapes count:
     *
     *   - opposite polarity ("X holds" / "X does not hold");
     *   - the same claim carrying different numbers. "Recall serves at most 12
     *     facts" and "…at most 20 facts" are indistinguishable to the
     *     fingerprint (tokens that short drop out) and merging them would
     *     silently pick a value nobody chose.
     */
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]];
        if (a.negated !== b.negated && similarEnough(a.claim, b.claim, CONTRADICTION_MIN_SIMILARITY)) {
          flag(a, b, 'contradiction: one fact negates the other — a human decides which holds');
        } else if (a.numbers !== b.numbers && similarEnough(a.sig, b.sig, SUPERSEDE_MIN_SIMILARITY)) {
          flag(a, b, `contradiction: same claim, different values (${a.numbers || 'none'} vs ${b.numbers || 'none'})`);
        }
      }
    }

    const taken = new Set<string>();
    for (const head of members) {
      if (taken.has(head.fact.id)) continue;
      const cluster = [head];
      taken.add(head.fact.id);
      for (const other of members) {
        if (taken.has(other.fact.id)) continue;
        // Blocked against ANY fact already in the cluster, not just the head:
        // two facts that disagree with each other must not both retire into a
        // third, because the survivor carries one of their claims and the
        // disagreement is then settled by machine through the back door.
        if (cluster.some((c) => blocked.has(pairKey(c.fact.id, other.fact.id)))) continue;
        if (!similarEnough(head.sig, other.sig, SUPERSEDE_MIN_SIMILARITY)) continue;
        taken.add(other.fact.id);
        cluster.push(other);
      }
      if (cluster.length < 2) continue;

      /*
       * The survivor is the newest fact that is SHARED. Letting a local-only
       * fact win would retire the tracked copy, and the tracked copy is the one
       * every other clone reads — the merge would show up elsewhere as a fact
       * that vanished. When only local facts are in play, the newest wins.
       */
      const winner = cluster.find((c) => !c.local) ?? cluster[0];
      for (const loser of cluster) {
        if (loser === winner) continue;
        if (!supersedable(winner, loser)) continue;    // never retire newer knowledge
        if (!loser.local && winner.local) continue;    // never retire shared knowledge for local
        const sim = similarity(loser.sig, winner.sig);
        ops.push({
          op: 'supersede',
          id: loser.fact.id,
          supersededBy: winner.fact.id,
          reason: `duplicate knowledge, superseded by a newer fact (similarity ${sim.toFixed(2)})`,
        });
      }
    }
  }

  /*
   * Negated twins that no merge would ever have considered: "X holds" and "X
   * does not hold" rarely open with the same six words, so they land in
   * different fingerprint groups and only a whole-store scan finds them. This
   * half is REPORTING, nothing more — the blocking decision was made above —
   * which is why it may stop at a cap. Polarity splits the scan (a negated x
   * plain sweep, not every pair) and `similarEnough` drops most of what is
   * left after two or three word lookups.
   *
   * The cap is for the reader, not only the CPU: a store where thousands of
   * pairs disagree does not need thousands of tickets, it needs the first
   * handful looked at. Sorted inputs make the truncation deterministic.
   */
  const byId = (a: Prepared, b: Prepared) => (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0);
  const negated = prepared.filter((p) => p.negated).sort(byId);
  const plain = prepared.filter((p) => !p.negated).sort(byId);
  scan: for (const n of negated) {
    for (const p of plain) {
      if (reported.size >= MAX_CONTRADICTION_REPORTS) break scan;
      // Jaccard can never exceed the size ratio — the cheapest possible skip.
      const ratio = Math.min(n.claim.size, p.claim.size) / Math.max(n.claim.size, p.claim.size, 1);
      if (ratio < CONTRADICTION_MIN_SIMILARITY) continue;
      if (similarEnough(n.claim, p.claim, CONTRADICTION_MIN_SIMILARITY)) {
        flag(n, p, 'contradiction: one fact negates the other — a human decides which holds');
      }
    }
  }

  ops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reports = [...reported.values()].sort((a, b) =>
    a.ids.join() < b.ids.join() ? -1 : a.ids.join() > b.ids.join() ? 1 : 0);
  return [...ops, ...reports];
}
