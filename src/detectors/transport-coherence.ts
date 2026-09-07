import { claimsBrowser } from "../internal/ua.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface TransportCoherenceOptions {
  /**
   * Report a claimed browser arriving over HTTP/1.0. Default true.
   *
   * Turn it off if something in front of this application speaks HTTP/1.0 to it. A few
   * older load balancers and reverse proxies still do, and where that is true every
   * request arrives that way — so the signal says something about your infrastructure
   * rather than about your visitors, and a detector that fires on all of them is worse
   * than one that fires on none.
   */
  legacyHttp?: boolean;
  /** Requests an actor must have made before an all-HEAD visit means anything. Default 8. */
  minHeadRequests?: number;
}

/** No shipping browser has spoken this to a server in well over a decade. */
const LEGACY_VERSIONS = new Set(["0.9", "1.0"]);

/**
 * How a claimed browser *moves*, rather than what it says.
 *
 * The header checks read one request against the client it claims to be. This reads the
 * transport underneath and the verbs across a visit, which are harder to copy because
 * they are not in the part of the request most tools let you set.
 *
 * Two things, both measured as blind spots before this existed — a client claiming
 * Chrome 120 over HTTP/1.0, and one whose entire visit is HEAD, each scored exactly what
 * the honest control scored.
 *
 * Neither goes above `moderate`, and the reasons are different. HTTP/1.0 can be an
 * intermediary's doing rather than the client's. An all-HEAD visit is a strong shape but a
 * link checker is a real and mostly harmless thing to be.
 */
export function transportCoherenceDetector(options: TransportCoherenceOptions = {}): Detector {
  const checkLegacyHttp = options.legacyHttp ?? true;
  const minHeadRequests = options.minHeadRequests ?? 8;

  return {
    id: "transport-coherence",
    description: "Reads the HTTP version and the methods across a visit against the client the request claims to be",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      if (!claimsBrowser(ctx.ua)) return undefined;
      const results: Evidence[] = [];
      const version = ctx.facts.httpVersion;

      if (checkLegacyHttp && version !== undefined && LEGACY_VERSIONS.has(version)) {
        results.push({
          detector: "transport-coherence",
          summary: `Client claims to be a browser but negotiated HTTP/${version}, which no shipping browser has offered in over a decade`,
          direction: "bot",
          certainty: "moderate",
          botClass: "impersonator",
          // One downgrading proxy in front of the application does this to every request
          // that passes through it, so this must count once rather than once per reason.
          family: "legacy-transport",
          metadata: { httpVersion: version, browser: ctx.ua.browser },
        });
      }

      // Across the visit rather than this request: one HEAD is a browser checking a link
      // it is about to follow, or a cache revalidating. A visit made entirely of them is
      // something enumerating what exists without reading any of it.
      const methods = ctx.state.methodsSeen;
      if (ctx.state.total >= minHeadRequests && methods.length > 0 && methods.every((method) => method === "HEAD")) {
        results.push({
          detector: "transport-coherence",
          summary: `Client claims to be a browser but has issued nothing but HEAD across ${ctx.state.total} requests`,
          direction: "bot",
          certainty: "moderate",
          botClass: "scraper",
          metadata: { requests: ctx.state.total, browser: ctx.ua.browser },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
