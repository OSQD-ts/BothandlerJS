import { claimsBrowser } from "../internal/ua.js";
import { absenceIsMeaningful } from "./types.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface SessionIntegrityOptions {
  /** Requests from one actor before a total absence of cookies is worth reporting. Default 12. */
  minRequests?: number;
  /** Also report navigations that carry no Referer. Default true. */
  checkReferer?: boolean;
}

/**
 * Does this client behave like something that holds a session?
 *
 * A browser accumulates state. Once your server has set anything at all — a session
 * cookie, a consent flag, an A/B bucket — a real browser sends it back on every
 * subsequent request, forever. A stateless HTTP client sends nothing back no matter
 * how many times it visits, because it discards the response headers it does not
 * care about.
 *
 * A dozen requests from one actor with not a single cookie is therefore a decent
 * tell. It is only `moderate`, though, and the reason is worth internalising: the
 * population that blocks all cookies is real people who have gone out of their way
 * to protect their privacy. Escalating on this signal alone punishes precisely the
 * users least deserving of it, which is the argument this library's whole design
 * exists to make.
 */
export function sessionIntegrityDetector(options: SessionIntegrityOptions = {}): Detector {
  const minRequests = options.minRequests ?? 12;
  const checkReferer = options.checkReferer ?? true;

  return {
    id: "session-integrity",
    description: "Reports clients that claim to be browsers but never carry session state or navigation context",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      // Every check here is an argument from absence.
      if (!claimsBrowser(ctx.ua) || !absenceIsMeaningful(ctx)) return undefined;
      const results: Evidence[] = [];
      const { headers } = ctx.facts;

      if (ctx.state.total >= minRequests && headers["cookie"] === undefined) {
        results.push({
          detector: "session-integrity",
          summary: `${ctx.state.total} requests from this actor, none carrying any cookie`,
          direction: "bot",
          certainty: "moderate",
          weight: 0.3,
          botClass: "scraper",
          family: "no-session",
          metadata: { requests: ctx.state.total },
        });
      }

      // A same-site *navigation* with no Referer. Browsers send one when following a
      // link; the referrer policy can suppress it, so this is only a nudge.
      //
      // The navigation check is load-bearing rather than decorative: subresources and
      // fetch() calls routinely carry no Referer by design, and an earlier version
      // that tested only `sec-fetch-site` fired on every image a page loaded.
      const isNavigation = headers["sec-fetch-mode"] === "navigate" || headers["sec-fetch-dest"] === "document";
      if (checkReferer && isNavigation && headers["sec-fetch-site"] === "same-origin" && headers["referer"] === undefined) {
        results.push({
          detector: "session-integrity",
          summary: "Same-origin navigation arrived with no Referer",
          direction: "bot",
          certainty: "weak",
          weight: 0.12,
          botClass: "scraper",
          family: "no-session",
          metadata: { path: ctx.facts.path },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
