import { pathMatches, statelessPattern } from "../internal/pattern.js";
import { weightOf } from "../evidence.js";
import type { Assessment } from "../types.js";
import type { MatchSpec } from "./types.js";

/** Normalises `T | readonly T[] | undefined` into a set, or `undefined` for "no constraint". */
function toSet<T>(value: T | readonly T[] | undefined): Set<T> | undefined {
  if (value === undefined) return undefined;
  return new Set(Array.isArray(value) ? (value as readonly T[]) : [value as T]);
}

/**
 * Compiles a {@link MatchSpec} into a predicate.
 *
 * Compiling once at policy-construction time rather than interpreting the spec per
 * request keeps rule evaluation to a handful of set lookups, which matters when the
 * policy is consulted on every request to the site.
 */
export function compileMatch(spec: MatchSpec): (assessment: Assessment) => boolean {
  const verdicts = toSet(spec.verdict);
  const classes = toSet(spec.botClass);
  const identities = toSet(spec.identity);
  const categories = toSet(spec.category);
  const methods = spec.method === undefined ? undefined : toSet((Array.isArray(spec.method) ? spec.method : [spec.method]).map((method) => method.toUpperCase()));
  const detectors = toSet(spec.detector);
  // Normalised once, here, for the same reason everything else in this function is:
  // a `g` or `y` flag makes `test` stateful, and a rule that alternates between
  // matching and not matching on identical requests blocks a bot, serves it, blocks
  // it again. See `statelessPattern`.
  const paths =
    spec.path === undefined
      ? undefined
      : ((Array.isArray(spec.path) ? spec.path : [spec.path]) as readonly (string | RegExp)[]).map(statelessPattern);

  return (assessment: Assessment): boolean => {
    if (verdicts && !verdicts.has(assessment.verdict)) return false;
    if (classes && !classes.has(assessment.botClass)) return false;
    if (spec.certain !== undefined && assessment.certain !== spec.certain) return false;
    if (spec.minScore !== undefined && assessment.score < spec.minScore) return false;
    if (spec.maxScore !== undefined && assessment.score > spec.maxScore) return false;
    if (spec.minPriorConfirmations !== undefined && assessment.actor.priorConfirmations < spec.minPriorConfirmations) return false;
    if (spec.minUnsolvedChallenges !== undefined && assessment.actor.unsolvedChallenges < spec.minUnsolvedChallenges) return false;
    if (methods && !methods.has(assessment.facts.method.toUpperCase())) return false;

    if (identities) {
      const claimed = collectIdentities(assessment);
      let hit = false;
      for (const identity of identities) {
        if (claimed.has(identity)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    if (categories) {
      let hit = false;
      for (const item of assessment.evidence) {
        const category = item.metadata?.["category"];
        if (typeof category === "string" && categories.has(category as never)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    if (detectors) {
      let hit = false;
      for (const item of [...assessment.evidence, ...assessment.humanEvidence]) {
        if (detectors.has(item.detector)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    if (paths && !pathMatches(paths, assessment.facts.path)) return false;

    return true;
  };
}

function collectIdentities(assessment: Assessment): Set<string> {
  const identities = new Set<string>();
  if (assessment.identity !== undefined) identities.add(assessment.identity);
  for (const item of assessment.evidence) {
    if (item.identity !== undefined) identities.add(item.identity);
  }
  return identities;
}

/**
 * Counts independent `strong`-or-better bot signals.
 *
 * "Independent" is approximated as "from different detectors", which is imperfect —
 * `header-integrity` and `accept-signature` both read the same header block and are
 * correlated — but it is a real bar that a single misfiring check cannot clear on its
 * own. Used by the `balanced` guard, where it is the difference between "the score
 * got high" and "several different things went wrong".
 */
export function independentStrongSignals(assessment: Assessment): number {
  const detectors = new Set<string>();
  for (const item of assessment.evidence) {
    if (item.certainty === "strong" || item.certainty === "certain" || weightOf(item) >= 0.6) detectors.add(item.detector);
  }
  return detectors.size;
}
