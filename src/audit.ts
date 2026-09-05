import { systemClock } from "./internal/clock.js";
import type { Clock } from "./internal/clock.js";
import type { Assessment } from "./types.js";
import type { Decision } from "./policy/types.js";

/**
 * Watching the shape of your traffic change.
 *
 * Counters tell you what is happening; they do not tell you that it is *unusual*.
 * Bot traffic is not a level, it is an event — a scrape starts, a scanner sweeps a
 * range, someone points a stuffing tool at your login form — and the number that
 * matters is not "12% of requests are bots" but "12% today, 2% for the fortnight
 * before". So this module keeps a short window and a longer baseline, compares them
 * on a schedule, and raises a structured anomaly when the comparison clears a bar you
 * set.
 *
 * Three properties make it safe to leave on:
 *
 * **It costs a handful of increments per request.** No allocation, no timestamp
 * sorting, no history beyond a fixed ring of buckets.
 *
 * **It refuses to speak from a small sample.** Every check has a minimum, because a
 * quiet site at 3am produces ratios like "800% more bots" from four requests, and an
 * alerting system that cries wolf at 3am gets muted, which is worse than not having
 * one.
 *
 * **It has a cooldown.** A spike lasting an hour is one event, not sixty.
 */

/** What an anomaly is worth waking somebody for. */
export type AnomalySeverity = "info" | "warning" | "critical";

export interface TrafficAnomaly {
  /** Stable id of the check that fired, e.g. `"bot-share-spike"`. */
  id: string;
  severity: AnomalySeverity;
  /** One sentence, safe to put in an alert. */
  summary: string;
  /** The measure that moved, e.g. `"bot share"`. */
  metric: string;
  /** Value in the recent window, and in the baseline it was compared against. */
  value: number;
  baseline: number;
  /** `value / baseline`, or `undefined` when the baseline was zero. */
  ratio?: number | undefined;
  at: number;
  window: AuditWindow;
  baselineWindow: AuditWindow;
}

/** Counters for one stretch of time. */
export interface AuditWindow {
  /** Milliseconds the window covers, rounded up to whole buckets. */
  spanMs: number;
  requests: number;
  /** Requests that skipped detection: allowlisted, or an ignored path. */
  bypassed: number;
  bots: number;
  humans: number;
  denials: number;
  challenges: number;
  /**
   * Challenges that were solved in this span.
   *
   * Counted separately from `challenges` because the ratio between them is the one
   * measurement that says whether the mitigations are landing on machines or on people.
   * See {@link challengeSolveRate}.
   */
  challengesSolved: number;
  downgrades: number;
  failures: number;
  /** Requests per minute over the span. */
  rate: number;
  /** Bots as a fraction of the requests detection actually ran on, 0–1. */
  botShare: number;
  /**
   * Solved challenges as a fraction of those issued, 0–1. `undefined` below the sample
   * floor, because a rate over three challenges is not a rate.
   *
   * **High is the bad direction**, which is the opposite of what the name suggests to
   * most people. A proof-of-work challenge is trivial for a browser and trivial for a
   * competent scraper; what it costs is a few seconds of somebody's afternoon. So a
   * solve rate near one does not mean the challenges are working — it means almost
   * everything being challenged can pass, and the population that can pass a browser
   * challenge is overwhelmingly people.
   */
  challengeSolveRate: number | undefined;
}

export interface AuditContext {
  window: AuditWindow;
  baseline: AuditWindow;
  at: number;
  /** The configured floor for a check to speak at all. */
  minSamples: number;
}

export interface AuditCheck {
  id: string;
  /** One line, shown by `describeAudit()` and on the dashboard. */
  description: string;
  /** Returns an anomaly, or `undefined` when nothing is worth saying. */
  evaluate(context: AuditContext): Omit<TrafficAnomaly, "at" | "window" | "baselineWindow"> | undefined;
}

export interface AuditOptions {
  /** The recent stretch being judged. Default 300000 (5 minutes). */
  windowMs?: number;
  /**
   * What it is compared against — the *preceding* stretch, not one containing it.
   * Default 3600000 (1 hour).
   *
   * Ending the baseline where the window begins is what makes a spike visible: a
   * baseline that included the window would be partly made of the thing being
   * measured, and a large enough spike would raise its own bar until it stopped
   * looking like one.
   */
  baselineMs?: number;
  /** How often the comparison runs, ms. Default 60000. */
  intervalMs?: number;
  /** Requests needed in the window before any check may speak. Default 50. */
  minSamples?: number;
  /** Silence per check id after it fires, ms. Default 900000 (15 minutes). */
  cooldownMs?: number;
  /** Replaces the built-in checks entirely. */
  checks?: readonly AuditCheck[];
  /** Appended to the built-in checks. */
  extraChecks?: readonly AuditCheck[];
  clock?: Clock;
}

/** Buckets held in the ring, whatever the spans work out to. Keeps memory flat. */
const MAX_BUCKETS = 512;

interface Bucket {
  at: number;
  requests: number;
  bypassed: number;
  bots: number;
  humans: number;
  denials: number;
  challenges: number;
  challengesSolved: number;
  downgrades: number;
  failures: number;
}

const DENYING = new Set(["block", "drop", "redirect"]);
const MITIGATING = new Set(["challenge", "rate-limit", "delay"]);

export class TrafficAudit {
  readonly checks: readonly AuditCheck[];
  /** Effective spans: the requested ones rounded up to whole buckets. */
  private windowMs: number;
  private baselineMs: number;
  private readonly bucketMs: number;
  private readonly buckets: Bucket[];
  private readonly minSamples: number;
  private readonly cooldownMs: number;
  private readonly lastFired = new Map<string, number>();
  private readonly clock: Clock;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AuditOptions = {}) {
    this.windowMs = Math.max(1000, options.windowMs ?? 300_000);
    this.baselineMs = Math.max(this.windowMs, options.baselineMs ?? 3_600_000);
    this.minSamples = Math.max(1, options.minSamples ?? 50);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 900_000);
    this.clock = options.clock ?? systemClock;
    this.checks = options.checks ?? [...DEFAULT_CHECKS, ...(options.extraChecks ?? [])];

    // Ten buckets to a window, coarsened if that would need more of them than the ring
    // holds. Both spans are then rounded *up* to whole buckets, and the aggregation
    // ranges below snap to bucket boundaries — because a window whose edge falls
    // inside a bucket either loses that bucket's requests or borrows the neighbour's,
    // and an audit that miscounts its own window is not worth having.
    const requested = this.windowMs + this.baselineMs;
    let bucketMs = Math.max(1000, Math.round(this.windowMs / 10));
    if (Math.ceil(requested / bucketMs) + 1 > MAX_BUCKETS) bucketMs = Math.ceil(requested / (MAX_BUCKETS - 1));
    this.bucketMs = bucketMs;
    this.windowMs = Math.max(bucketMs, Math.ceil(this.windowMs / bucketMs) * bucketMs);
    this.baselineMs = Math.max(bucketMs, Math.ceil(this.baselineMs / bucketMs) * bucketMs);

    const count = (this.windowMs + this.baselineMs) / bucketMs + 1;
    this.buckets = Array.from({ length: count }, () => ({ at: 0, requests: 0, bypassed: 0, bots: 0, humans: 0, denials: 0, challenges: 0, challengesSolved: 0, downgrades: 0, failures: 0 }));
  }

  /** Starts the periodic comparison. Unreffed: an audit never keeps a process alive. */
  start(intervalMs: number, onAnomaly: (anomaly: TrafficAnomaly) => void): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      for (const anomaly of this.evaluate()) onAnomaly(anomaly);
    }, Math.max(1000, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  record(assessment: Assessment): void {
    const bucket = this.bucketFor(assessment.facts.timestamp);
    if (bucket === undefined) return;
    bucket.requests++;
    if (assessment.bypass !== undefined) {
      bucket.bypassed++;
      return;
    }
    if (assessment.verdict === "confirmed-bot" || assessment.verdict === "verified-bot" || assessment.verdict === "suspected-bot") bucket.bots++;
    else if (assessment.verdict === "human") bucket.humans++;
    bucket.failures += assessment.failures.length;
  }

  /**
   * A challenge was solved.
   *
   * Recorded here rather than derived from decisions because a solve happens on a
   * *later* request than the challenge that prompted it — usually the next one, from a
   * client that is now carrying a clearance token and will not be challenged again. No
   * amount of looking at decisions finds it.
   */
  recordChallengeSolved(at: number): void {
    const bucket = this.bucketFor(at);
    if (bucket === undefined) return;
    bucket.challengesSolved++;
  }

  recordDecision(decision: Decision, at: number): void {
    const bucket = this.bucketFor(at);
    if (bucket === undefined) return;
    if (DENYING.has(decision.action)) bucket.denials++;
    else if (MITIGATING.has(decision.action)) bucket.challenges++;
    if (decision.downgradedFrom !== undefined) bucket.downgrades++;
  }

  /** The two spans as they stand right now. Also what the dashboard draws. */
  summary(now = this.clock.now()): { window: AuditWindow; baseline: AuditWindow } {
    // The bucket `now` falls in is still filling, so the window ends at its far edge:
    // both ranges are then whole numbers of buckets and nothing is half-counted.
    const end = (Math.floor(now / this.bucketMs) + 1) * this.bucketMs;
    const windowStart = end - this.windowMs;
    return {
      window: this.aggregate(windowStart, end, this.windowMs),
      baseline: this.aggregate(windowStart - this.baselineMs, windowStart, this.baselineMs),
    };
  }

  /**
   * Runs every check. Anomalies come back in the order the checks are configured.
   *
   * Safe to call as often as you like: a check that has fired inside its cooldown is
   * skipped, and a window below `minSamples` produces nothing at all.
   */
  evaluate(now = this.clock.now()): TrafficAnomaly[] {
    const { window, baseline } = this.summary(now);
    const anomalies: TrafficAnomaly[] = [];
    if (window.requests < this.minSamples) return anomalies;

    const context: AuditContext = { window, baseline, at: now, minSamples: this.minSamples };

    for (const check of this.checks) {
      const last = this.lastFired.get(check.id);
      if (last !== undefined && now - last < this.cooldownMs) continue;

      let result: ReturnType<AuditCheck["evaluate"]>;
      try {
        result = check.evaluate(context);
      } catch {
        // A check is caller-supplied code on a timer. One that throws is skipped, not
        // a reason for the audit to stop running.
        continue;
      }
      if (result === undefined) continue;

      this.lastFired.set(check.id, now);
      anomalies.push({ ...result, at: now, window, baselineWindow: baseline });
    }

    return anomalies;
  }

  private bucketFor(timestamp: number): Bucket | undefined {
    const index = Math.floor(timestamp / this.bucketMs);
    const slot = this.buckets[((index % this.buckets.length) + this.buckets.length) % this.buckets.length]!;
    const at = index * this.bucketMs;
    if (slot.at !== at) {
      // The ring has come round: this slot belongs to an older stretch of time and is
      // reset rather than added to.
      slot.at = at;
      slot.requests = 0;
      slot.bypassed = 0;
      slot.bots = 0;
      slot.humans = 0;
      slot.denials = 0;
      slot.challenges = 0;
      slot.challengesSolved = 0;
      slot.downgrades = 0;
      slot.failures = 0;
    }
    return slot;
  }

  private aggregate(from: number, to: number, spanMs: number): AuditWindow {
    const totals = { requests: 0, bypassed: 0, bots: 0, humans: 0, denials: 0, challenges: 0, challengesSolved: 0, downgrades: 0, failures: 0 };
    for (const bucket of this.buckets) {
      if (bucket.at === 0 || bucket.at < from || bucket.at >= to) continue;
      totals.requests += bucket.requests;
      totals.bypassed += bucket.bypassed;
      totals.bots += bucket.bots;
      totals.humans += bucket.humans;
      totals.denials += bucket.denials;
      totals.challenges += bucket.challenges;
      totals.challengesSolved += bucket.challengesSolved;
      totals.downgrades += bucket.downgrades;
      totals.failures += bucket.failures;
    }
    // Measured against everything detection actually looked at — not against
    // bot-plus-human, which would leave out `unknown`, and `unknown` is what ordinary
    // traffic looks like. A share of "bots among requests we classified either way"
    // would read 100% on a site with one bot and a thousand unremarkable visitors.
    const assessed = totals.requests - totals.bypassed;
    return {
      ...totals,
      spanMs,
      rate: totals.requests / (spanMs / 60_000),
      botShare: assessed > 0 ? totals.bots / assessed : 0,
      // Four is not a sample. Below that the ratio swings between 0 and 1 on one
      // person's decision, and a check that fires on that is a check people mute.
      challengeSolveRate: totals.challenges >= 4 ? Math.min(1, totals.challengesSolved / totals.challenges) : undefined,
    };
  }
}

/** `value / baseline`, guarding the zero case that would otherwise be Infinity. */
function ratioOf(value: number, baseline: number): number | undefined {
  return baseline > 0 ? value / baseline : undefined;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * The checks that ship.
 *
 * Each one earns its place by describing a *different* thing going wrong, and each
 * states its floor in the code rather than in a comment. Replace them wholesale with
 * `audit.checks`, or add your own with `audit.extraChecks`.
 */
export const DEFAULT_CHECKS: readonly AuditCheck[] = Object.freeze([
  {
    id: "bot-share-spike",
    description: "The share of traffic classified as automated has risen sharply against the baseline",
    evaluate({ window, baseline }) {
      const ratio = ratioOf(window.botShare, baseline.botShare);
      // A share that doubles is interesting; a share that doubles from 1% to 2% is
      // not, so an absolute floor sits beside the ratio. A baseline of zero has no
      // ratio at all and is the *loudest* case rather than a reason to stay quiet:
      // automation going from none to most of your traffic is the alert.
      if (window.botShare < 0.25) return undefined;
      if (ratio !== undefined && ratio < 2) return undefined;
      return {
        id: "bot-share-spike",
        severity: window.botShare >= 0.6 ? "critical" : "warning",
        metric: "bot share",
        value: window.botShare,
        baseline: baseline.botShare,
        ratio,
        summary:
          `Automated traffic is ${percent(window.botShare)} of assessed requests, against ${percent(baseline.botShare)} in the baseline` +
          `${ratio !== undefined ? ` (${ratio.toFixed(1)}x)` : " — where there was none"}.`,
      };
    },
  },
  {
    id: "traffic-spike",
    description: "Request volume is far above the baseline rate",
    evaluate({ window, baseline }) {
      const ratio = ratioOf(window.rate, baseline.rate);
      if (ratio === undefined || ratio < 3 || window.rate < 10) return undefined;
      return {
        id: "traffic-spike",
        severity: ratio >= 10 ? "critical" : "warning",
        metric: "requests per minute",
        value: window.rate,
        baseline: baseline.rate,
        ratio,
        summary: `Traffic is ${window.rate.toFixed(0)} requests a minute, against a baseline of ${baseline.rate.toFixed(1)} (${ratio.toFixed(1)}x).`,
      };
    },
  },
  {
    id: "denial-spike",
    description: "A much larger share of requests is being denied than usual",
    evaluate({ window, baseline }) {
      const share = window.requests > 0 ? window.denials / window.requests : 0;
      const baseShare = baseline.requests > 0 ? baseline.denials / baseline.requests : 0;
      const ratio = ratioOf(share, baseShare);
      if (window.denials < 10 || share < 0.05) return undefined;
      // A denial rate that appears from nothing is the more alarming case, so a zero
      // baseline fires rather than being skipped for want of a ratio.
      if (ratio !== undefined && ratio < 3) return undefined;
      return {
        id: "denial-spike",
        severity: "warning",
        metric: "denial rate",
        value: share,
        baseline: baseShare,
        ratio,
        summary: `${window.denials} request(s) denied — ${percent(share)} of traffic, against ${percent(baseShare)} in the baseline. Check that they are all really bots.`,
      };
    },
  },
  {
    id: "guard-stop-spike",
    description: "The safety guard is refusing far more rules than usual",
    evaluate({ window, baseline }) {
      const share = window.requests > 0 ? window.downgrades / window.requests : 0;
      const baseShare = baseline.requests > 0 ? baseline.downgrades / baseline.requests : 0;
      const ratio = ratioOf(share, baseShare);
      if (window.downgrades < 10 || share < 0.05) return undefined;
      if (ratio !== undefined && ratio < 3) return undefined;
      return {
        id: "guard-stop-spike",
        severity: "warning",
        metric: "guard stops",
        value: share,
        baseline: baseShare,
        ratio,
        // This one is about the policy rather than about the traffic, and it is the
        // most useful thing in the list: the guard is doing its job, and the rules are
        // asking for more than their evidence supports.
        summary: `The guard stopped ${window.downgrades} terminal action(s) — ${percent(share)} of traffic. Your rules are asking to deny requests the evidence does not prove.`,
      };
    },
  },
  {
    id: "challenge-solve-rate",
    description: "Nearly everything being challenged is passing, which means people are being challenged",
    evaluate({ window }) {
      const rate = window.challengeSolveRate;
      if (rate === undefined || window.challenges < 20) return undefined;
      if (rate < 0.85) return undefined;
      return {
        id: "challenge-solve-rate",
        severity: "warning",
        metric: "challenge solve rate",
        value: rate,
        baseline: 0.85,
        ratio: undefined,
        /**
         * The check the rest of this file was missing, and the one closest to the
         * library's own thesis.
         *
         * Everything else here watches whether the *traffic* changed shape. This
         * watches whether the mitigation is landing on the right population — and a
         * high number is the bad direction, which is the opposite of what the name
         * suggests. A proof-of-work challenge is trivial for a browser and trivial for
         * a competent scraper; what it actually costs is a few seconds of somebody's
         * afternoon. So when nearly everything challenged goes on to pass, the
         * challenges are not filtering bots out, they are taxing people — and nothing
         * else on this dashboard would ever have said so, because from every other
         * angle a challenge that gets solved looks like a challenge that worked.
         */
        summary: `${percent(rate)} of challenges are being solved (${window.challengesSolved} of ${window.challenges}). A challenge is easy for a browser and easy for a competent scraper, so a rate this high means it is mostly landing on people. Raise the threshold that issues it, or narrow the rule.`,
      };
    },
  },
  {
    id: "human-share-drop",
    description: "Traffic that reads as human has fallen away against the baseline",
    evaluate({ window, baseline }) {
      const share = window.requests > 0 ? window.humans / window.requests : 0;
      const baseShare = baseline.requests > 0 ? baseline.humans / baseline.requests : 0;
      if (baseShare < 0.2 || share >= baseShare * 0.5) return undefined;
      return {
        id: "human-share-drop",
        severity: "warning",
        metric: "human share",
        value: share,
        baseline: baseShare,
        ratio: ratioOf(share, baseShare),
        // Either the traffic changed or the detection did, and knowing which is worth
        // being woken for: the second means something is now misreading real people.
        summary: `Only ${percent(share)} of traffic reads as human, against ${percent(baseShare)} in the baseline. Either your traffic changed or your detection did.`,
      };
    },
  },
  {
    id: "detector-failures",
    description: "Detectors are erroring or timing out on a meaningful share of requests",
    evaluate({ window }) {
      const share = window.requests > 0 ? window.failures / window.requests : 0;
      if (share < 0.01 || window.failures < 5) return undefined;
      return {
        id: "detector-failures",
        severity: share >= 0.1 ? "critical" : "warning",
        metric: "detector failure rate",
        value: share,
        baseline: 0,
        summary: `Detectors failed on ${percent(share)} of requests (${window.failures} failure(s)). Detection is degraded — usually a resolver or a store, not the traffic.`,
      };
    },
  },
]);
