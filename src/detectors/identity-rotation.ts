import { MAX_TRACKED_USER_AGENTS } from "../state.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface IdentityRotationOptions {
  /**
   * Distinct User-Agents from one actor at or above which rotation is reported.
   * Default 3.
   *
   * An actor remembers at most {@link MAX_TRACKED_USER_AGENTS} of them, so a threshold
   * above that can never be reached — an actor cycling through thirty spoofed strings
   * still reports four. Asking for more throws rather than producing a detector that
   * runs on every request and can never fire.
   */
  threshold?: number;
  /** Minimum requests before the count is meaningful. Default 10. */
  minRequests?: number;
}

/**
 * One actor, several identities.
 *
 * A single client does not change its User-Agent mid-session. Something that does is
 * cycling through a spoofing list, which is behaviour with no innocent
 * interpretation *for a single client*.
 *
 * **This detector is off by default, and you should think before enabling it.** With
 * the default IP-based actor key, "one actor" routinely means "one NAT gateway", and
 * a corporate office, a university, a coffee shop or a mobile carrier's CGNAT pool
 * legitimately presents hundreds of distinct browsers behind one address. Under that
 * key this detector fires on exactly the busiest legitimate networks on the internet.
 *
 * It becomes genuinely valuable once your `actorKey` identifies something narrower
 * than an address — a session cookie, an authenticated user id, or an IP combined
 * with a TLS fingerprint. Then a rotating User-Agent really is one client lying, and
 * it is worth a lot. Enable it there, and only there.
 */
export function identityRotationDetector(options: IdentityRotationOptions = {}): Detector {
  const threshold = options.threshold ?? 3;
  const minRequests = options.minRequests ?? 10;
  if (threshold > MAX_TRACKED_USER_AGENTS) {
    throw new RangeError(
      `identityRotationDetector threshold ${threshold} can never be reached: an actor remembers at most ${MAX_TRACKED_USER_AGENTS} distinct User-Agents, so the detector would run on every request and never fire. Use ${MAX_TRACKED_USER_AGENTS} or fewer.`,
    );
  }

  return {
    id: "identity-rotation",
    description: "Reports a single actor presenting several different User-Agent strings (off by default; see the doc comment)",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      if (ctx.state.total < minRequests) return undefined;
      const distinct = ctx.state.distinctUserAgents;
      if (distinct < threshold) return undefined;

      return {
        detector: "identity-rotation",
        summary: `Actor has presented ${distinct} distinct User-Agent strings across ${ctx.state.total} requests`,
        direction: "bot",
        certainty: "moderate",
        weight: 0.35,
        botClass: "impersonator",
        metadata: { distinctUserAgents: distinct, requests: ctx.state.total, actorKey: ctx.actor.key },
      };
    },
  };
}
