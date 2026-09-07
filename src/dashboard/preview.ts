import { Policy } from "../policy/policy.js";
import type { DashboardEntry, PolicyPreview } from "./types.js";
import type { Assessment, Evidence } from "../types.js";
import type { ActionName, Rule } from "../policy/types.js";
import type { GuardSettings } from "../policy/policy.js";

/** Samples returned with a preview. Enough to see the shape of a change, few enough to read. */
const MAX_SAMPLES = 25;

/**
 * "What would this rule set have done to the traffic I just watched?"
 *
 * This is the `replay` command's question, asked about the last few minutes instead of
 * about a log file, and answered before the change is applied rather than after. The
 * reason it can be answered at all is that {@link Policy.decide} is **pure**: it reads
 * an assessment and returns a decision, touching no state, no store and no network. So
 * a candidate policy can be run over the retained window as many times as somebody
 * cares to edit it, and nothing about the running system moves.
 *
 * **What is faithful, and what is not.** Rule *matching* is exact: every field the
 * matcher reads — verdict, class, identity, category, certainty, score, path, method,
 * detector, prior confirmations — travels on the feed entry, so a rule matches here
 * exactly when it would have matched then. The safety guard is exact too, for the same
 * reason. What a preview cannot tell you is what the *action* would have done: a
 * challenge might have been solved, a rate limit might not have been reached, a custom
 * handler would have run code this does not run. It answers "which rule, and which
 * action", which is the question an edit is about.
 */
export function previewPolicy(entries: readonly DashboardEntry[], live: Policy, candidate: Policy, warnings: string[] = []): PolicyPreview {
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const ruleHits = new Map<string, number>();
  const samples: PolicyPreview["samples"] = [];
  let changed = 0;
  let newDenials = 0;
  let evaluated = 0;

  for (const rule of candidate.ruleIds) ruleHits.set(rule, 0);

  for (const entry of entries) {
    // A bypassed request never reached the policy and would not reach a candidate
    // either; counting it as "unchanged" would quietly inflate the denominator.
    if (entry.bypass !== undefined) continue;
    evaluated++;

    const assessment = assessmentFromEntry(entry);
    const previous = live.decide(assessment);
    const next = candidate.decide(assessment);

    before[previous.action] = (before[previous.action] ?? 0) + 1;
    after[next.action] = (after[next.action] ?? 0) + 1;
    ruleHits.set(next.rule, (ruleHits.get(next.rule) ?? 0) + 1);

    if (next.action !== previous.action) {
      changed++;
      if (isDenial(next.action) && !isDenial(previous.action)) newDenials++;
      if (samples.length < MAX_SAMPLES) {
        samples.push({
          path: entry.path,
          verdict: entry.verdict,
          userAgent: entry.userAgent,
          from: previous.action,
          to: next.action,
          fromRule: previous.rule,
          toRule: next.rule,
        });
      }
    }
  }

  return {
    evaluated,
    changed,
    before,
    after,
    ruleHits: [...ruleHits].map(([rule, hits]) => ({ rule, hits })),
    samples,
    warnings,
    newDenials,
  };
}

function isDenial(action: ActionName): boolean {
  return action === "block" || action === "drop" || action === "redirect";
}

/**
 * Rebuilds enough of an {@link Assessment} for the policy to decide about it.
 *
 * Deliberately built from the feed entry rather than from a retained assessment
 * object. Keeping the real assessments alive would mean holding every request's full
 * header set — cookies included — in memory for as long as the ring is long, to
 * support a feature that only reads a dozen fields. The entry already carries those
 * dozen fields, so the preview costs nothing extra and the headers stay where they
 * were already redacted.
 */
export function assessmentFromEntry(entry: DashboardEntry): Assessment {
  const evidence: Evidence[] = [];
  const humanEvidence: Evidence[] = [];

  for (const item of entry.evidence) {
    const rebuilt: Evidence = {
      detector: item.detector,
      summary: item.summary,
      direction: item.direction,
      certainty: item.certainty,
      ...(item.weight !== undefined ? { weight: item.weight } : {}),
      ...(item.identity !== undefined ? { identity: item.identity } : {}),
      ...(item.family !== undefined ? { family: item.family } : {}),
      // `category` is read off metadata by the matcher, so it has to go back there.
      ...(item.category !== undefined ? { metadata: { category: item.category } } : {}),
    };
    (item.direction === "human" ? humanEvidence : evidence).push(rebuilt);
  }

  return {
    requestId: entry.requestId,
    verdict: entry.verdict,
    botClass: entry.botClass,
    ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
    score: entry.score,
    confidence: entry.certain ? 1 : entry.score / 100,
    certain: entry.certain,
    evidence,
    humanEvidence,
    actor: {
      key: entry.actor,
      requests: entry.actorStats.requests,
      distinctPaths: entry.actorStats.distinctPaths, distinctQueries: 0, queriesSaturated: false, methodsSeen: ["GET"], responses: 0, misses: 0,
      firstSeen: entry.actorStats.firstSeen,
      lastSeen: entry.at,
      ...(entry.actorStats.sinceLastMs !== undefined ? { sinceLastMs: entry.actorStats.sinceLastMs } : {}),
      priorConfirmations: entry.actorStats.priorConfirmations,
      unsolvedChallenges: 0,
      cleared: entry.actorStats.cleared,
    },
    durationMs: entry.durationMs,
    failures: [],
    facts: {
      method: entry.method,
      path: entry.path,
      query: entry.query,
      headers: {},
      headerOrder: [],
      ip: entry.actor,
      timestamp: entry.at,
      ...(entry.protocol === "http" || entry.protocol === "https" ? { protocol: entry.protocol } : {}),
      ...(entry.httpVersion !== undefined ? { httpVersion: entry.httpVersion } : {}),
    },
  };
}

/**
 * Builds a candidate policy with the live policy's guard settings.
 *
 * The guard is copied rather than accepted from the caller, and that is the point: a
 * preview — and the apply that may follow it — changes which rules exist and never how
 * far one may go. Somebody editing rules in a browser cannot turn `strict` into
 * `aggressive` by adding a field to the JSON, because the field is not read.
 */
export function candidatePolicy(rules: readonly Rule[], live: Policy, guard: Partial<GuardSettings> = {}): Policy {
  const described = live.describe();
  const candidate = new Policy({
    rules,
    defaultAction: described.defaultAction,
    falsePositivePolicy: described.falsePositivePolicy,
    fallbackAction: described.fallbackAction,
    terminalScoreThreshold: described.terminalScoreThreshold,
  });
  // A guard the caller wants to try, validated by the same method the running policy
  // would validate it with — so a preview cannot describe a guard the server would
  // refuse to accept, which would be the worst kind of preview.
  candidate.replaceGuard(guard);
  return candidate;
}
