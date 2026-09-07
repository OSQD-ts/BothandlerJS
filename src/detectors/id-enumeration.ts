import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface IdEnumerationOptions {
  /** Requests to one path shape before a walk is worth reporting. Default 30. */
  minRequests?: number;
  /**
   * How completely those requests must cover the range they span. Default 0.9 — thirty
   * requests reaching from id 1 to id 33 report; the same thirty scattered across a
   * thousand ids do not.
   */
  density?: number;
}

/**
 * Somebody working through the identifiers rather than following the links.
 *
 * `crawl-breadth` sees this as "many distinct paths", which is what it also sees when a
 * person reads a documentation site — so it stays `weak` and nothing separates the two.
 * Measured: `/user/1` through `/user/120` in order scored exactly the same as a hundred
 * and twenty scattered ids, and the same again as ordinary article paths. All three
 * `unknown`, all three 57.
 *
 * What separates them is not which ids were asked for but whether they *cover a range*.
 * People arrive at ids through links, and links do not densely enumerate an integer
 * interval; a harvester does nothing else. Thirty requests reaching from id 1 to id 33 is
 * a walk. Thirty scattered across a hundred thousand is somebody reading.
 *
 * `moderate`, and the bar is set high on purpose. The awkward case is real: products in
 * one category often carry consecutive ids, so somebody browsing a catalogue can produce a
 * smaller version of this. Thirty requests covering ninety per cent of their own span is
 * meant to be past what that produces, and it is still a shape rather than a motive.
 */
export function idEnumerationDetector(options: IdEnumerationOptions = {}): Detector {
  const minRequests = options.minRequests ?? 30;
  const density = options.density ?? 0.9;

  return {
    id: "id-enumeration",
    description: "Reports an actor covering a contiguous range of numeric identifiers under one path shape",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const walk = ctx.state.densestWalk();
      if (walk === undefined || walk.count < minRequests) return undefined;
      // A span narrower than the count is one id fetched repeatedly, which is a person
      // refreshing rather than anybody enumerating.
      if (walk.span < minRequests) return undefined;
      // Clamped: a repeated id makes the count exceed the span, and "covering 102% of a
      // range" is not a thing. The comparison below is unaffected — anything over the bar
      // is over it — but the number a person reads has to mean something.
      const covered = Math.min(1, walk.count / walk.span);
      if (covered < density) return undefined;

      return {
        detector: "id-enumeration",
        summary: `${walk.count} requests to ${walk.template} covering ${(covered * 100).toFixed(0)}% of a ${walk.span}-wide range of ids`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scraper",
        metadata: { template: walk.template, requests: walk.count, span: walk.span, coverage: Number(covered.toFixed(3)) },
      };
    },
  };
}
