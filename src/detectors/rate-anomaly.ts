import { MAX_TRACKED_ARRIVALS } from "../state.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface RateAnomalyOptions {
  /** Window over which arrivals are counted, ms. Default 10000. */
  windowMs?: number;
  /** Requests in the window above which the rate is worth noting. Default 20. */
  threshold?: number;
  /**
   * Requests in the window above which the rate is well beyond human. Default 30.
   *
   * Both defaults sit under the per-actor timestamp ring's capacity, because the
   * count saturates there — a threshold above it could never be reached, which is a
   * detector that silently never fires. If you raise these, raise them knowing the
   * ceiling, and reach for the `rate-limit` action instead when you need real numbers.
   */
  hardThreshold?: number;
}

/**
 * How fast is this actor going?
 *
 * Rate is the signal people reach for first and trust the most, and it deserves the
 * least trust of anything in this library. The reason is that the *actor* behind a
 * high rate is frequently not one client: a corporate NAT, a mobile carrier's CGNAT
 * pool, a university, a VPN exit and a shared office all present hundreds of real
 * people as one address. Blocking on rate blocks all of them.
 *
 * So this detector reports and never concludes. Its output tops out at `moderate`,
 * which under the default policy cannot reach a terminal action no matter how
 * extreme the number gets. What high rate is genuinely good for is *corroborating* —
 * a client that already looks like a library and is also pulling 300 requests a
 * minute is a different proposition from either fact alone.
 *
 * If you want rate to actually stop traffic, that is what rate *limiting* is for,
 * and it belongs in the action layer where it applies to everyone equally and
 * recovers on its own. See the `rate-limit` action.
 */
export function rateAnomalyDetector(options: RateAnomalyOptions = {}): Detector {
  const windowMs = options.windowMs ?? 10_000;
  const threshold = options.threshold ?? 20;
  const hardThreshold = options.hardThreshold ?? 30;
  // The doc above says to raise these knowing the ceiling. Knowing it is not enough:
  // exceeding it produces a detector that runs on every request and can never fire,
  // and nothing about the running system would ever say so.
  for (const [name, value] of [
    ["threshold", threshold],
    ["hardThreshold", hardThreshold],
  ] as const) {
    if (value > MAX_TRACKED_ARRIVALS) {
      throw new RangeError(
        `rateAnomalyDetector ${name} of ${value} can never be reached: an actor's arrival count saturates at ${MAX_TRACKED_ARRIVALS}. Use ${MAX_TRACKED_ARRIVALS} or fewer, and reach for the \`rate-limit\` action when you need exact counting.`,
      );
    }
  }

  return {
    id: "rate-anomaly",
    description: "Counts an actor's arrivals in a short window and reports rates well outside human browsing",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const count = ctx.state.requestsWithin(windowMs, ctx.facts.timestamp);
      if (count < threshold) return undefined;

      const perSecond = Number((count / (windowMs / 1000)).toFixed(2));
      const extreme = count >= hardThreshold;

      return {
        detector: "rate-anomaly",
        summary: `${count} requests in ${windowMs / 1000}s (${perSecond}/s) from this actor`,
        direction: "bot",
        certainty: extreme ? "moderate" : "weak",
        // Even at the extreme end the weight is capped well below `strong`: a shared
        // egress address is the single most common explanation for a high number.
        weight: extreme ? 0.4 : 0.2,
        botClass: "unknown",
        metadata: {
          count,
          windowMs,
          perSecond,
          // The ring buffer saturates, so a very heavy actor is undercounted. Say so
          // rather than quietly reporting a floor as if it were the true rate.
          undercounted: ctx.state.ringSaturated,
        },
      };
    },
  };
}
