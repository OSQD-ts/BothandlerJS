import { MAX_TRACKED_PATHS } from "../state.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface CrawlBreadthOptions {
  /**
   * Distinct paths from one actor at or above which breadth is worth reporting.
   * Default 30. Cannot exceed {@link MAX_TRACKED_PATHS}, which is where the count
   * saturates; asking for more throws rather than never firing.
   */
  threshold?: number;
  /** Fraction of requests that must be to a path not seen before. Default 0.85. */
  noveltyRatio?: number;
  /** Minimum requests before the ratio is meaningful. Default 20. */
  minRequests?: number;
}

/**
 * Is this actor *reading* the site or *enumerating* it?
 *
 * A person revisits. They land on an article, go back to the index, follow a related
 * link, return to the article. Their ratio of distinct paths to total requests
 * settles well below one. A crawler walking a sitemap almost never revisits, so its
 * ratio sits near one and its distinct-path count climbs steadily.
 *
 * Worth being clear about what this cannot distinguish: a *welcome* crawler produces
 * exactly this shape, and so does a person on a first visit to a documentation site
 * clicking through the sidebar. It is a shape, not a motive — which is why it stays
 * `weak` and why the interesting use is combining it with an actor that has already
 * failed a header check.
 */
export function crawlBreadthDetector(options: CrawlBreadthOptions = {}): Detector {
  const threshold = options.threshold ?? 30;
  const noveltyRatio = options.noveltyRatio ?? 0.85;
  const minRequests = options.minRequests ?? 20;
  if (threshold > MAX_TRACKED_PATHS) {
    throw new RangeError(
      `crawlBreadthDetector threshold ${threshold} can never be reached: an actor's distinct-path count saturates at ${MAX_TRACKED_PATHS}. Use ${MAX_TRACKED_PATHS} or fewer.`,
    );
  }

  return {
    id: "crawl-breadth",
    description: "Compares distinct paths against total requests to distinguish reading a site from enumerating it",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const { distinctPaths, total, pathsSaturated } = ctx.state;
      if (total < minRequests || distinctPaths < threshold) return undefined;

      // The denominator is the window over which the numerator could still grow.
      //
      // `distinctPaths` stops at a cap; `total` does not. Dividing one by the other
      // once the cap is hit made the ratio fall as an actor kept crawling, so the
      // detector went quiet in proportion to how hard something was enumerating the
      // site: a crawler that pulled 300 pages without one revisit reported 21% novelty
      // and read as somebody rereading the same handful of articles. Measured over the
      // requests before saturation, that same crawler reports 98%, which is what it is.
      const measuredOver = pathsSaturated ? ctx.state.requestsWhenPathsSaturated : total;
      const ratio = measuredOver > 0 ? distinctPaths / measuredOver : 0;
      if (ratio < noveltyRatio) return undefined;

      return {
        detector: "crawl-breadth",
        summary: pathsSaturated
          ? `at least ${distinctPaths} distinct paths, ${(ratio * 100).toFixed(0)}% of the first ${measuredOver} requests never revisited`
          : `${distinctPaths} distinct paths across ${total} requests (${(ratio * 100).toFixed(0)}% never revisited)`,
        direction: "bot",
        certainty: "weak",
        weight: ctx.state.pathsSaturated ? 0.25 : 0.15,
        botClass: "scraper",
        metadata: {
          distinctPaths,
          totalRequests: total,
          noveltyRatio: Number(ratio.toFixed(3)),
          measuredOverRequests: measuredOver,
          saturated: pathsSaturated,
        },
      };
    },
  };
}
