import type { ActionName, Decision } from "./policy/types.js";
import type { Assessment, BotClass, BypassReason, Verdict } from "./types.js";

/**
 * Counters for the things an operator needs to see.
 *
 * Always on, because the cost is a handful of integer increments and the alternative
 * — bot detection you cannot observe — is how a policy quietly starts turning people
 * away without anyone noticing. Everything here is a monotonic counter or a
 * histogram, so it survives being scraped at any interval and never needs locking.
 *
 * The two series worth alerting on are `downgrades` and `verdict{verdict="human"}`.
 * A rising downgrade count means your rules are asking for terminal actions the
 * evidence does not support; a falling human count means something changed about
 * either your traffic or your detection, and you want to know which.
 */

import { BOT_CLASSES, VERDICTS } from "./types.js";
import { ACTION_NAMES as ACTIONS } from "./policy/types.js";

/** Upper bounds in milliseconds. The last bucket is unbounded. */
export const DURATION_BUCKETS_MS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100];

/**
 * Upper bounds for the probabilistic score histogram.
 *
 * Ten buckets of ten points, which is the whole range: `combine()` caps a
 * probabilistic score at 99 and gives every proven assessment a flat 100, so nothing
 * ever lands past the last bound and there is no `+Inf` overflow to think about.
 * Proven requests are counted separately in {@link MetricsSnapshot.proven} rather than
 * piled into the top bucket — their score plays no part in any decision, and including
 * them would put a spike at the right-hand edge that means nothing.
 */
export const SCORE_BUCKETS: readonly number[] = [9, 19, 29, 39, 49, 59, 69, 79, 89, 99];

export interface MetricsSnapshot {
  /** Requests assessed, including those that bypassed detection. */
  requests: number;
  /** Requests that skipped detection, by reason. */
  bypassed: Record<BypassReason, number>;
  verdicts: Record<Verdict, number>;
  botClasses: Record<BotClass, number>;
  actions: Record<ActionName, number>;
  /** Terminal actions the safety guard replaced with something recoverable. */
  downgrades: number;
  /** Assessments resting on at least one piece of proven evidence. */
  proven: number;
  /** How often each detector produced evidence. */
  detectorFirings: Record<string, number>;
  /** How often each detector threw or timed out. */
  detectorFailures: Record<string, number>;
  /**
   * Time spent inside each detector, when `metrics.perDetectorTiming` is on.
   *
   * Empty otherwise, and empty is the default: timing every detector means two clock
   * reads per detector per request, which on a twenty-detector set is forty syscalls
   * or so on the hot path to measure work that is usually a few microseconds. Worth
   * paying while you tune; not worth paying forever.
   */
  detectorTimings: Record<string, { count: number; totalMs: number; maxMs: number }>;
  challenges: { issued: number; solved: number; rejected: number };
  /**
   * How suspicion is distributed across the traffic that was scored.
   *
   * The counters behind the one chart that answers "how close does ordinary traffic
   * run to the line?" — asked of the whole run rather than of the few hundred
   * requests a dashboard happens to still be holding. Certain assessments are
   * excluded; see {@link SCORE_BUCKETS}.
   */
  scores: {
    count: number;
    totalScore: number;
    /** Cumulative counts, aligned with {@link SCORE_BUCKETS}. Prometheus wants them that way. */
    buckets: number[];
  };
  duration: {
    count: number;
    totalMs: number;
    maxMs: number;
    /** Cumulative counts, aligned with {@link DURATION_BUCKETS_MS} plus a final `+Inf`. */
    buckets: number[];
  };
  /** Actors currently held in the registry. A gauge, not a counter. */
  actorsTracked: number;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const record = {} as Record<K, number>;
  for (const key of keys) record[key] = 0;
  return record;
}

export interface MetricsOptions {
  /** Record per-detector durations. Off by default; see {@link MetricsSnapshot.detectorTimings}. */
  perDetectorTiming?: boolean;
}

export class Metrics {
  /** Whether the engine should bother timing individual detectors. Read on the hot path. */
  readonly perDetectorTiming: boolean;

  private requests = 0;
  private readonly bypassed: Record<BypassReason, number> = { allowlist: 0, "ignored-path": 0 };
  private readonly verdicts = zeroed(VERDICTS);
  private readonly botClasses = zeroed(BOT_CLASSES);
  private readonly actions = zeroed(ACTIONS);
  private downgrades = 0;
  private proven = 0;
  private readonly detectorFirings = new Map<string, number>();
  private readonly detectorFailures = new Map<string, number>();
  private readonly detectorTimings = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private challengesIssued = 0;
  private challengesSolved = 0;
  private challengesRejected = 0;
  private scoreCount = 0;
  private scoreTotal = 0;
  private readonly scoreBuckets = new Float64Array(SCORE_BUCKETS.length);
  private durationCount = 0;
  private durationTotal = 0;
  private durationMax = 0;
  private readonly durationBuckets = new Float64Array(DURATION_BUCKETS_MS.length + 1);

  constructor(options: MetricsOptions = {}) {
    this.perDetectorTiming = options.perDetectorTiming === true;
  }

  recordAssessment(assessment: Assessment): void {
    this.requests++;
    if (assessment.bypass !== undefined) {
      this.bypassed[assessment.bypass]++;
      return;
    }

    this.verdicts[assessment.verdict]++;
    this.botClasses[assessment.botClass]++;
    if (assessment.certain) {
      this.proven++;
    } else {
      // Ten even buckets, so the arithmetic is a divide rather than the linear scan
      // the duration bounds need. `min` guards a score of 100 arriving from anywhere
      // other than the proven path.
      this.scoreCount++;
      this.scoreTotal += assessment.score;
      this.scoreBuckets[Math.min(SCORE_BUCKETS.length - 1, Math.max(0, Math.floor(assessment.score / 10)))]!++;
    }

    for (const item of assessment.evidence) bump(this.detectorFirings, item.detector);
    for (const item of assessment.humanEvidence) bump(this.detectorFirings, item.detector);
    for (const failure of assessment.failures) bump(this.detectorFailures, failure.detector);

    const ms = assessment.durationMs;
    this.durationCount++;
    this.durationTotal += ms;
    if (ms > this.durationMax) this.durationMax = ms;
    // Linear scan over eleven bounds beats a binary search at this size. The counts
    // are kept per bucket and made cumulative in `snapshot()`, where the Prometheus
    // rendering wants them.
    let bucket = DURATION_BUCKETS_MS.length;
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      if (ms <= DURATION_BUCKETS_MS[i]!) {
        bucket = i;
        break;
      }
    }
    this.durationBuckets[bucket]!++;
  }

  /** One detector's duration, in milliseconds. Called only when {@link perDetectorTiming} is on. */
  recordDetectorTiming(detector: string, ms: number): void {
    const existing = this.detectorTimings.get(detector);
    if (existing === undefined) {
      this.detectorTimings.set(detector, { count: 1, totalMs: ms, maxMs: ms });
      return;
    }
    existing.count++;
    existing.totalMs += ms;
    if (ms > existing.maxMs) existing.maxMs = ms;
  }

  recordDecision(decision: Decision): void {
    this.actions[decision.action]++;
    if (decision.downgradedFrom !== undefined) this.downgrades++;
  }

  recordChallenge(event: "issued" | "solved" | "rejected"): void {
    if (event === "issued") this.challengesIssued++;
    else if (event === "solved") this.challengesSolved++;
    else this.challengesRejected++;
  }

  snapshot(actorsTracked: number): MetricsSnapshot {
    return {
      requests: this.requests,
      bypassed: { ...this.bypassed },
      verdicts: { ...this.verdicts },
      botClasses: { ...this.botClasses },
      actions: { ...this.actions },
      downgrades: this.downgrades,
      proven: this.proven,
      detectorFirings: Object.fromEntries(this.detectorFirings),
      detectorFailures: Object.fromEntries(this.detectorFailures),
      detectorTimings: Object.fromEntries([...this.detectorTimings].map(([id, timing]) => [id, { ...timing }])),
      challenges: { issued: this.challengesIssued, solved: this.challengesSolved, rejected: this.challengesRejected },
      scores: { count: this.scoreCount, totalScore: this.scoreTotal, buckets: cumulate(this.scoreBuckets) },
      duration: { count: this.durationCount, totalMs: this.durationTotal, maxMs: this.durationMax, buckets: cumulate(this.durationBuckets) },
      actorsTracked,
    };
  }
}

/** Per-bucket counts to the running totals a Prometheus histogram is defined in terms of. */
function cumulate(counts: Float64Array): number[] {
  const buckets: number[] = [];
  let running = 0;
  for (let i = 0; i < counts.length; i++) {
    running += counts[i]!;
    buckets.push(running);
  }
  return buckets;
}

function bump(counters: Map<string, number>, key: string): void {
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export interface PrometheusOptions {
  /** Metric name prefix. Default `"bothandler"`. */
  prefix?: string;
}

/**
 * Renders a snapshot in the Prometheus text exposition format.
 *
 * Serve it from an endpoint your scraper can reach and nobody else can — the
 * detector-firing series describe how detection behaves, which is exactly what
 * someone tuning a scraper against you would like to read.
 */
export function toPrometheus(snapshot: MetricsSnapshot, options: PrometheusOptions = {}): string {
  const prefix = options.prefix ?? "bothandler";
  const lines: string[] = [];

  const counter = (name: string, help: string, samples: Array<[labels: string, value: number]>): void => {
    lines.push(`# HELP ${prefix}_${name} ${help}`, `# TYPE ${prefix}_${name} counter`);
    for (const [labels, value] of samples) lines.push(`${prefix}_${name}${labels} ${value}`);
  };

  counter("requests_total", "Requests assessed.", [["", snapshot.requests]]);
  counter("bypassed_total", "Requests that skipped detection entirely.", Object.entries(snapshot.bypassed).map(([reason, value]) => [`{reason="${reason}"}`, value]));
  counter("verdicts_total", "Assessments by verdict.", Object.entries(snapshot.verdicts).map(([verdict, value]) => [`{verdict="${verdict}"}`, value]));
  counter("bot_classes_total", "Assessments by bot class.", Object.entries(snapshot.botClasses).map(([botClass, value]) => [`{class="${botClass}"}`, value]));
  counter("actions_total", "Actions taken.", Object.entries(snapshot.actions).map(([action, value]) => [`{action="${action}"}`, value]));
  counter("downgrades_total", "Terminal actions the safety guard replaced for lack of proof.", [["", snapshot.downgrades]]);
  counter("proven_total", "Assessments resting on proven evidence.", [["", snapshot.proven]]);
  counter("detector_firings_total", "Evidence produced, by detector.", Object.entries(snapshot.detectorFirings).map(([detector, value]) => [`{detector="${escapeLabel(detector)}"}`, value]));
  counter("detector_failures_total", "Detector errors and timeouts.", Object.entries(snapshot.detectorFailures).map(([detector, value]) => [`{detector="${escapeLabel(detector)}"}`, value]));
  const timings = Object.entries(snapshot.detectorTimings);
  if (timings.length > 0) {
    counter("detector_duration_ms_sum", "Time spent inside each detector.", timings.map(([detector, timing]) => [`{detector="${escapeLabel(detector)}"}`, timing.totalMs]));
    counter("detector_duration_ms_count", "Detector invocations timed.", timings.map(([detector, timing]) => [`{detector="${escapeLabel(detector)}"}`, timing.count]));
  }
  counter("challenges_total", "Challenge lifecycle events.", Object.entries(snapshot.challenges).map(([event, value]) => [`{event="${event}"}`, value]));

  lines.push(
    `# HELP ${prefix}_score Distribution of probabilistic scores. Proven assessments carry no score and are counted by ${prefix}_proven_total.`,
    `# TYPE ${prefix}_score histogram`,
  );
  for (let i = 0; i < SCORE_BUCKETS.length; i++) {
    lines.push(`${prefix}_score_bucket{le="${SCORE_BUCKETS[i]}"} ${snapshot.scores.buckets[i]}`);
  }
  lines.push(
    // The top bound is 99 and a probabilistic score cannot exceed it, so +Inf is the
    // same number. It is here because a histogram without it is not a histogram.
    `${prefix}_score_bucket{le="+Inf"} ${snapshot.scores.count}`,
    `${prefix}_score_sum ${snapshot.scores.totalScore}`,
    `${prefix}_score_count ${snapshot.scores.count}`,
  );

  lines.push(`# HELP ${prefix}_assessment_duration_ms Time spent in detection.`, `# TYPE ${prefix}_assessment_duration_ms histogram`);
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
    lines.push(`${prefix}_assessment_duration_ms_bucket{le="${DURATION_BUCKETS_MS[i]}"} ${snapshot.duration.buckets[i]}`);
  }
  lines.push(
    `${prefix}_assessment_duration_ms_bucket{le="+Inf"} ${snapshot.duration.buckets[snapshot.duration.buckets.length - 1]}`,
    `${prefix}_assessment_duration_ms_sum ${snapshot.duration.totalMs}`,
    `${prefix}_assessment_duration_ms_count ${snapshot.duration.count}`,
    `# HELP ${prefix}_actors_tracked Actors currently held in the registry.`,
    `# TYPE ${prefix}_actors_tracked gauge`,
    `${prefix}_actors_tracked ${snapshot.actorsTracked}`,
  );

  return `${lines.join("\n")}\n`;
}

/** Detector ids are ours, but a custom one is caller-supplied and must not break the format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}
