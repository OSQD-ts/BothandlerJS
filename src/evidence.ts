import { CERTAINTY_WEIGHT } from "./types.js";
import type { BotClass, Certainty, Evidence, Verdict } from "./types.js";

/**
 * Turning a pile of observations into one conclusion.
 *
 * The rule that makes this library's guarantee meaningful lives in
 * {@link combineEvidence}: **`certain` evidence and probabilistic evidence never mix
 * into the same number.** Certainty short-circuits to a proven verdict; everything
 * else accumulates into a score that is explicitly labelled as a judgement call.
 *
 * A design that summed them — "certain is worth 100 points, strong is worth 60, block
 * at 100" — would look equivalent and be quietly catastrophic, because two unrelated
 * suspicions on an unusual but real browser would eventually reach 100 too. Points
 * do not compose into proof.
 */

const CERTAINTY_RANK: Record<Certainty, number> = { certain: 3, strong: 2, moderate: 1, weak: 0 };

/**
 * Which proven conclusion wins when several `certain` observations fire at once.
 * Higher wins.
 *
 * Two orderings here are load-bearing and easy to get backwards.
 *
 * A **self-contradiction outranks everything**: if a client both verified as
 * Googlebot and announced itself as headless Chrome, the honest reading is that
 * something is wrong, not that it is Googlebot.
 *
 * A **confirmed identity outranks a bare declaration**. Every verified crawler also
 * self-identifies — that is how we knew what to verify — so `self-identified` and
 * `crawler-verification` both fire on the same request. If `declared-bot` won that
 * tie, a DNS-confirmed Googlebot would come back as a generic `confirmed-bot`, an
 * "allow verified crawlers" rule would never match, and the first symptom would be
 * your search traffic quietly disappearing.
 */
const CLASS_PRIORITY: Record<BotClass, number> = {
  impersonator: 6,
  scanner: 5,
  automation: 4,
  scraper: 3,
  "http-client": 2,
  "verified-bot": 1,
  "declared-bot": 0,
  human: -1,
  unknown: -2,
};

export interface CombineOptions {
  /**
   * Score at or above which an unproven request is called `suspected-bot`. Default 60.
   * Raising it makes the library quieter, never safer — nothing here blocks.
   */
  suspectThreshold: number;
  /**
   * Rejects `certain` evidence that carries no `deterministicBasis`. On by default
   * outside production: it is the guard that stops the certainty tier from quietly
   * eroding into "signals we feel strongly about", which is how a
   * no-false-positive promise dies.
   */
  strictEvidence: boolean;
  /** Called instead of throwing when `strictEvidence` finds a problem. */
  onEvidenceViolation?: ((message: string, evidence: Evidence) => void) | undefined;
}

export interface CombinedEvidence {
  verdict: Verdict;
  botClass: BotClass;
  identity?: string | undefined;
  score: number;
  confidence: number;
  certain: boolean;
  botEvidence: Evidence[];
  humanEvidence: Evidence[];
}

/** Effective weight of a piece of evidence: its own, clamped, or its tier's default. */
export function weightOf(item: Evidence): number {
  const weight = item.weight ?? CERTAINTY_WEIGHT[item.certainty];
  if (!Number.isFinite(weight)) return CERTAINTY_WEIGHT[item.certainty];
  return Math.min(1, Math.max(0, weight));
}

/** Strongest first: certainty tier, then weight. Stable, so detector order breaks ties. */
export function sortEvidence(items: Evidence[]): Evidence[] {
  return [...items].sort((a, b) => {
    const rank = CERTAINTY_RANK[b.certainty] - CERTAINTY_RANK[a.certainty];
    return rank !== 0 ? rank : weightOf(b) - weightOf(a);
  });
}

/**
 * Noisy-OR: the probability that *at least one* of these independent signals is
 * telling the truth. Chosen over a sum because it is bounded at 1 without clamping
 * and because it has the right shape — many weak signals genuinely do add up to
 * something, but they approach certainty asymptotically and never reach it.
 *
 * The independence assumption is a simplification, and where it is most obviously
 * wrong — several detectors reporting one stripping proxy — it is corrected before
 * the weights get here: see {@link Evidence.family} and `independentWeights`. What
 * remains is mild optimism about correlations nobody has named, which is tolerable
 * precisely because this number cannot get anyone blocked.
 */
export function noisyOr(weights: readonly number[]): number {
  let remaining = 1;
  for (const weight of weights) remaining *= 1 - weight;
  return 1 - remaining;
}

/**
 * One weight per independent cause.
 *
 * Noisy-OR is only sound over signals that are actually independent, and several of
 * this library's detectors are not: they read overlapping properties of the same
 * request and fire together whenever one circumstance is true. The circumstance that
 * matters most is a **stripping intermediary** — a corporate proxy, a carrier
 * transcoder, a privacy extension — because it makes four absence-based detectors
 * speak at once about one person who did nothing but open a laptop at work.
 *
 * Evidence that names a {@link Evidence.family} is therefore collapsed to its
 * strongest member before scoring. Everything without a family keeps its own weight,
 * so this narrows the score only where the correlation is real and asserted by the
 * detector that produced it.
 *
 * It cannot change any *proven* verdict: the certain path never reaches this code.
 */
function independentWeights(items: readonly Evidence[]): number[] {
  let families: Map<string, number> | undefined;
  const weights: number[] = [];

  for (const item of items) {
    const weight = weightOf(item);
    if (item.family === undefined) {
      weights.push(weight);
      continue;
    }
    families ??= new Map<string, number>();
    const current = families.get(item.family);
    if (current === undefined || weight > current) families.set(item.family, weight);
  }

  if (families !== undefined) for (const weight of families.values()) weights.push(weight);
  return weights;
}

export function combineEvidence(items: readonly Evidence[], options: CombineOptions): CombinedEvidence {
  const botEvidence: Evidence[] = [];
  const humanEvidence: Evidence[] = [];

  for (const item of items) {
    if (options.strictEvidence && item.certainty === "certain" && !item.deterministicBasis) {
      const message = `Detector "${item.detector}" produced \`certain\` evidence with no \`deterministicBasis\`. Certain evidence must state why it admits no benign explanation; if you cannot state one, the correct tier is "strong".`;
      if (options.onEvidenceViolation) options.onEvidenceViolation(message, item);
      else throw new Error(message);
    }
    (item.direction === "bot" ? botEvidence : humanEvidence).push(item);
  }

  const sortedBot = sortEvidence(botEvidence);
  const sortedHuman = sortEvidence(humanEvidence);

  const certainBot = sortedBot.filter((item) => item.certainty === "certain");
  const certainHuman = sortedHuman.filter((item) => item.certainty === "certain");

  // ---- Proven path. No score is consulted; there is nothing to weigh. ----
  if (certainBot.length > 0) {
    const decisive = pickDecisive(certainBot);
    const botClass = decisive.botClass ?? "unknown";
    return {
      verdict: botClass === "verified-bot" ? "verified-bot" : "confirmed-bot",
      botClass: botClass === "unknown" ? "declared-bot" : botClass,
      identity: decisive.identity,
      // A proven bot still reports a score, for dashboards that chart one. It is
      // 100 by definition and plays no part in any decision.
      score: 100,
      confidence: 1,
      certain: true,
      botEvidence: sortedBot,
      humanEvidence: sortedHuman,
    };
  }

  if (certainHuman.length > 0) {
    return {
      verdict: "human",
      botClass: "human",
      identity: certainHuman[0]!.identity,
      score: 0,
      confidence: 1,
      certain: true,
      botEvidence: sortedBot,
      humanEvidence: sortedHuman,
    };
  }

  // ---- Probabilistic path. Everything below is explicitly a judgement call. ----
  const pBot = noisyOr(independentWeights(sortedBot));
  const pHuman = noisyOr(independentWeights(sortedHuman));
  // Human evidence discounts rather than cancels: a real interaction on a page does
  // not prove the *next* request from that IP came from the same person.
  const combined = pBot * (1 - pHuman);
  // Capped at 99. Enough independent signals drive the noisy-OR to 1 in floating
  // point, and a probabilistic assessment reporting a flat 100 would be
  // indistinguishable on a dashboard from a proven one. 100 means proof, and only
  // the certain path is allowed to produce it.
  const score = Math.min(99, Math.round(combined * 100));

  const verdict: Verdict = score >= options.suspectThreshold ? "suspected-bot" : pHuman > pBot && pHuman >= 0.5 ? "human" : "unknown";

  const named = sortedBot.find((item) => item.botClass !== undefined && item.botClass !== "unknown");

  return {
    verdict,
    botClass: verdict === "suspected-bot" ? (named?.botClass ?? "unknown") : verdict === "human" ? "human" : "unknown",
    identity: named?.identity,
    score,
    confidence: verdict === "suspected-bot" ? combined : Math.max(pHuman, 1 - pBot),
    certain: false,
    botEvidence: sortedBot,
    humanEvidence: sortedHuman,
  };
}

function pickDecisive(certain: readonly Evidence[]): Evidence {
  let best = certain[0]!;
  let bestPriority = CLASS_PRIORITY[best.botClass ?? "unknown"];
  for (const item of certain) {
    const priority = CLASS_PRIORITY[item.botClass ?? "unknown"];
    if (priority > bestPriority) {
      best = item;
      bestPriority = priority;
    }
  }
  return best;
}
