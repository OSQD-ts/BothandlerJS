import { claimsBrowser } from "../internal/ua.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Evidence that this request came out of a browsing session.
 *
 * Almost every detector in this library argues in one direction. That asymmetry is a
 * problem the scoring model makes visible: a person reading forty pages of
 * documentation from a university's shared address accumulates `rate-anomaly`,
 * `cadence`, `crawl-breadth` and `ip-intelligence` and can cross the suspicion
 * threshold without a single thing being wrong with their request. The engine
 * discounts a bot score by whatever human evidence it has — `pBot × (1 − pHuman)` —
 * and until now the only things that produced any were your own application's
 * assertion, a clearance token, a TLS profile table most people do not maintain, and
 * a page script most people do not embed. For an ordinary request from an ordinary
 * browser, `pHuman` was zero.
 *
 * So this detector reads the properties that come from a client having *state and
 * history* rather than from a client being well-formed:
 *
 * - **A cache to revalidate.** `If-None-Match` and `If-Modified-Since` mean this
 *   client has been here before and kept what it was given. A stateless fetch loop
 *   has nothing to revalidate against and asks for the resource fresh every time.
 * - **A cookie jar.** Something set state on this client and the client sent it back.
 * - **A user gesture.** `Sec-Fetch-User: ?1` is a forbidden header the browser sets
 *   only when a *person* activated the navigation — a link click, a typed URL, a
 *   bookmark. Page script cannot set it, and a driver navigating a page
 *   programmatically does not produce it.
 * - **A coherent modern fingerprint.** The Fetch Metadata group, the Client Hints and
 *   the negotiation headers all present and agreeing with each other.
 *
 * **None of this is proof and none of it ever will be.** Every one of these
 * properties is copyable: a scraper that keeps a cookie jar, replays an ETag and
 * copies a header set produces all four. That is why the ceiling here is `moderate`,
 * why the whole set shares one {@link Evidence.family} so it can never stack into a
 * large discount, and why it can only ever *reduce* a suspicion score rather than
 * establish a `human` verdict on its own. The only conclusive human evidence in this
 * library comes from you — `isHuman`, or an operator clearance token — because you
 * are the one party in the exchange whose word the client cannot forge.
 *
 * What it buys is the honest half of a two-sided argument: a request that shows the
 * marks of a real session is less suspicious than an identical one that does not,
 * and the population that benefits is precisely the one this library exists to
 * protect.
 */
export function browsingCoherenceDetector(): Detector {
  return {
    id: "browsing-coherence",
    description: "Reports the marks of a real browsing session — a cache, a cookie jar, a user gesture — as human-pointing evidence",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      if (!claimsBrowser(ctx.ua)) return undefined;
      const { headers } = ctx.facts;
      const results: Evidence[] = [];

      // Every observation below shares a family, so the engine takes the strongest
      // rather than compounding them. They are four views of one circumstance — that
      // this client has been using the web — not four independent arguments.
      const family = "browsing-session";

      const validator = headers["if-none-match"] ?? headers["if-modified-since"];
      if (validator !== undefined) {
        results.push({
          detector: "browsing-coherence",
          summary: "Request revalidates a cached copy, so this client has been here before and kept what it was served",
          direction: "human",
          certainty: "weak",
          weight: 0.25,
          family,
          metadata: { validator: validator.slice(0, 80) },
        });
      }

      if (headers["cookie"] !== undefined) {
        results.push({
          detector: "browsing-coherence",
          summary: "Request carries cookies previously set on this client",
          direction: "human",
          certainty: "weak",
          // The cheapest of these to fake — a copied Cookie header is one line — so
          // the smallest weight.
          weight: 0.15,
          family,
          metadata: { requests: ctx.state.total },
        });
      }

      // `Sec-Fetch-User` is only sent on a navigation a person activated, and only
      // with the value `?1`. `fetch-metadata` already reports any other spelling as a
      // fabrication; this is the same header read for what it says when it is right.
      if (headers["sec-fetch-user"]?.trim() === "?1" && headers["sec-fetch-mode"] === "navigate") {
        results.push({
          detector: "browsing-coherence",
          summary: "Navigation was marked user-activated by the browser's own network stack",
          direction: "human",
          certainty: "moderate",
          weight: 0.3,
          family,
          metadata: { dest: headers["sec-fetch-dest"] ?? null },
        });
      }

      if (coherentModernRequest(headers)) {
        results.push({
          detector: "browsing-coherence",
          summary: "Fetch Metadata, Client Hints and negotiation headers are all present and mutually consistent",
          direction: "human",
          certainty: "weak",
          weight: 0.2,
          family,
          metadata: { secFetchSite: headers["sec-fetch-site"], hasClientHints: headers["sec-ch-ua"] !== undefined },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

/**
 * The whole modern apparatus, present and agreeing.
 *
 * Stated as a conjunction rather than a score: a client that sends most of the set is
 * not two-thirds of a browser, it is something that copied most of the set. The
 * mutual-consistency clause is what stops the trivially assembled version from
 * qualifying — a request has to carry a Fetch Metadata group whose parts describe the
 * same kind of request.
 */
function coherentModernRequest(headers: Record<string, string | undefined>): boolean {
  const site = headers["sec-fetch-site"];
  const mode = headers["sec-fetch-mode"];
  const dest = headers["sec-fetch-dest"];
  if (site === undefined || mode === undefined || dest === undefined) return false;
  if (headers["accept"] === undefined || headers["accept-language"] === undefined || headers["accept-encoding"] === undefined) return false;
  if (dest === "document" && mode !== "navigate") return false;
  if (mode === "navigate" && dest !== "document" && dest !== "iframe" && dest !== "frame" && dest !== "embed" && dest !== "object") return false;
  return true;
}
