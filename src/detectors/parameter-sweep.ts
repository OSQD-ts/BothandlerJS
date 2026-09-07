import { MAX_TRACKED_QUERIES } from "../state.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface ParameterSweepOptions {
  /**
   * Distinct path-and-query combinations at or above which a sweep is worth reporting.
   * Default 25. Cannot exceed {@link MAX_TRACKED_QUERIES}, where the count saturates;
   * asking for more throws rather than never firing.
   */
  threshold?: number;
  /**
   * How many variants must sit on one path before this is a sweep rather than browsing.
   * Default 8 — that is, twenty-five variants across three paths reports, and
   * twenty-five variants across twenty paths does not.
   */
  variantsPerPath?: number;
  /** Minimum requests before the shape means anything. Default 20. */
  minRequests?: number;
}

/**
 * The scraping that `crawl-breadth` cannot see.
 *
 * Breadth counts distinct *paths*, and a path has no query string on it. So the shape
 * it reads as "somebody rereading one page" is also the shape of enumerating a
 * catalogue: `/products?page=1` through `?page=200` is one path and two hundred
 * requests. Measured, on the same two hundred requests expressed both ways — as
 * distinct paths it scored 62 and was called `suspected-bot`; as `?page=N` it scored 55
 * and passed as `unknown`. Paginated collection is not an exotic case, it is how
 * catalogues, search results and APIs are actually taken.
 *
 * So this counts the other thing: distinct parameterisations, and how many of them
 * stack onto a single path. Both halves are needed. A high variant count alone is
 * ordinary — a shop's own visitors filter and sort — and it is the *concentration* that
 * separates a person changing their mind from a machine walking an index.
 *
 * `weak`, and deliberately. A person paging through search results produces a smaller
 * version of exactly this, and someone with a slow connection retrying looks similar
 * again. It is a shape, not a motive; its value is as a second signal beside an actor
 * that has already failed something sharper.
 */
export function parameterSweepDetector(options: ParameterSweepOptions = {}): Detector {
  const threshold = options.threshold ?? 25;
  const variantsPerPath = options.variantsPerPath ?? 8;
  const minRequests = options.minRequests ?? 20;
  if (threshold > MAX_TRACKED_QUERIES) {
    throw new RangeError(
      `parameterSweepDetector threshold ${threshold} can never be reached: an actor's distinct-query count saturates at ${MAX_TRACKED_QUERIES}. Use ${MAX_TRACKED_QUERIES} or fewer.`,
    );
  }

  return {
    id: "parameter-sweep",
    description: "Counts distinct query strings against the paths they sit on, to catch enumeration that leaves the path unchanged",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const { distinctPaths, distinctQueries, queriesSaturated, total } = ctx.state;
      if (total < minRequests || distinctQueries < threshold) return undefined;

      // Against the paths they landed on, not against the request count. Two hundred
      // variants spread over fifty pages is a busy site being used; the same two hundred
      // stacked on two pages is an index being walked.
      const spread = distinctQueries / Math.max(1, distinctPaths);
      if (spread < variantsPerPath) return undefined;

      return {
        detector: "parameter-sweep",
        summary: queriesSaturated
          ? `at least ${distinctQueries} distinct query strings across only ${distinctPaths} path(s)`
          : `${distinctQueries} distinct query strings across only ${distinctPaths} path(s) in ${total} requests`,
        direction: "bot",
        certainty: "weak",
        // Saturation means the count stopped being able to grow, so the real spread is
        // wider than the one reported — the same argument breadth makes for itself.
        weight: queriesSaturated ? 0.25 : 0.15,
        botClass: "scraper",
        metadata: {
          distinctQueries,
          distinctPaths,
          variantsPerPath: Number(spread.toFixed(1)),
          totalRequests: total,
          saturated: queriesSaturated,
        },
      };
    },
  };
}
