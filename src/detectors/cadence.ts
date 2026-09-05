import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface CadenceOptions {
  /** Minimum gaps needed before the statistic means anything. Default 6. */
  minSamples?: number;
  /** Coefficient of variation at or below which the rhythm is machine-regular. Default 0.15. */
  regularityThreshold?: number;
  /** Ignore actors whose mean gap exceeds this, ms. Default 120000 (2 min). */
  maxMeanIntervalMs?: number;
}

/**
 * Is this actor's *rhythm* human?
 *
 * People generate ragged inter-arrival times. They read, scroll, get distracted, open
 * three tabs at once, then nothing for four minutes. A loop calling `setInterval` or
 * awaiting a fixed delay produces gaps clustered tightly around one value, and the
 * coefficient of variation makes that visible in a single number.
 *
 * The check is on *regularity*, not speed, which is what makes it complementary to
 * `rate-anomaly` — a slow, polite scraper deliberately pacing itself at one request
 * every two seconds to stay under a rate limit is invisible to rate counting and
 * extremely visible here.
 *
 * It stays `moderate` because a real page can produce regular traffic too: a polling
 * XHR, a video player fetching segments, an SSE reconnect loop. Those are your own
 * frontend, and the fix is to exclude their paths (see `ignorePaths` in the engine
 * config) rather than to weaken the statistic.
 */
export function cadenceDetector(options: CadenceOptions = {}): Detector {
  // A coefficient of variation computed from a single gap is identically zero,
  // whatever the data — so `minSamples: 1` would report every actor's second request
  // as perfectly machine-regular. Two is the floor at which the statistic exists at
  // all; the default of six is where it starts meaning something.
  const minSamples = Math.max(2, options.minSamples ?? 6);
  const regularityThreshold = options.regularityThreshold ?? 0.15;
  const maxMeanIntervalMs = options.maxMeanIntervalMs ?? 120_000;

  return {
    id: "cadence",
    description: "Measures the variance of an actor's inter-arrival times to spot machine-regular pacing",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const { count, mean, coefficientOfVariation } = ctx.state.intervalStats();
      if (count < minSamples) return undefined;

      // A mean at or near zero means everything arrived in one burst — that is a rate
      // observation, not a cadence one, and `rate-anomaly` already owns it.
      if (mean <= 1 || mean > maxMeanIntervalMs) return undefined;
      if (coefficientOfVariation > regularityThreshold) return undefined;

      return {
        detector: "cadence",
        summary: `Arrivals are machine-regular: ${count} gaps averaging ${Math.round(mean)}ms with a coefficient of variation of ${coefficientOfVariation.toFixed(3)}`,
        direction: "bot",
        certainty: "moderate",
        // Tighter rhythm, more weight — but capped, because a polling frontend is a
        // perfectly ordinary explanation.
        weight: coefficientOfVariation < regularityThreshold / 2 ? 0.45 : 0.3,
        botClass: "scraper",
        metadata: {
          samples: count,
          meanIntervalMs: Math.round(mean),
          coefficientOfVariation: Number(coefficientOfVariation.toFixed(4)),
        },
      };
    },
  };
}
