import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface ProbeVolumeOptions {
  /** Reported responses before the ratio means anything. Default 20. */
  minResponses?: number;
  /** Share of them that must be misses. Default 0.8. */
  missRatio?: number;
}

/**
 * An actor that is looking for something rather than reading anything.
 *
 * The oldest tell there is for a scanner, and the one this library could not see: it
 * decides *before* the response exists, which is what lets it shape the response and also
 * what hides the status code from it. Fed back through `recordOutcome`, the shape is
 * unmistakable — a person browsing a site does not generate forty misses in a row, and a
 * wordlist does almost nothing else.
 *
 * Counts 404 and 410 only. A 403 is usually this library's own doing, and counting it
 * would let a rule that challenges an actor manufacture the evidence for challenging it.
 * A 500 is the site's problem and says nothing about the client.
 *
 * `moderate`, not higher. A site that has just moved its URLs produces this from perfectly
 * ordinary readers, and so does a feed reader working through a list of removed articles.
 * It is also entirely absent unless the application reports outcomes, which is why nothing
 * else depends on it.
 */
export function probeVolumeDetector(options: ProbeVolumeOptions = {}): Detector {
  const minResponses = options.minResponses ?? 20;
  const missRatio = options.missRatio ?? 0.8;

  return {
    id: "probe-volume",
    description: "Reads the share of an actor's requests that were answered 404 or 410, where the application reports them",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const { responses, misses } = ctx.state;
      if (responses < minResponses) return undefined;
      const ratio = misses / responses;
      if (ratio < missRatio) return undefined;

      return {
        detector: "probe-volume",
        summary: `${misses} of this client's last ${responses} requests were answered "not found" (${(ratio * 100).toFixed(0)}%)`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scanner",
        metadata: { responses, misses, missRatio: Number(ratio.toFixed(3)) },
      };
    },
  };
}
