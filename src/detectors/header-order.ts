import { claimsBrowser } from "../internal/ua.js";
import { shortHash } from "../internal/crypto.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * One ordering rule that holds for every mainstream browser and is broken by common
 * HTTP libraries. Each is stated as "`before` must not appear after `after`".
 */
interface OrderInvariant {
  before: string;
  after: string;
  why: string;
  weight: number;
}

/**
 * Invariants verified against Chrome, Firefox, Safari and Edge on HTTP/1.1. Kept
 * deliberately few: the value is in rules that no browser breaks, not in modelling
 * every browser's exact sequence, which changes between releases and would turn
 * this detector into a source of false positives on next month's Chrome.
 */
const INVARIANTS: readonly OrderInvariant[] = [
  {
    before: "accept",
    after: "accept-encoding",
    why: "Every mainstream browser sends Accept before Accept-Encoding; several HTTP libraries (notably python-requests) send them the other way round.",
    weight: 0.4,
  },
  {
    before: "user-agent",
    after: "accept",
    why: "Browsers place User-Agent ahead of the content-negotiation headers.",
    weight: 0.25,
  },
];

export interface HeaderOrderOptions {
  /** Include the order fingerprint in evidence metadata for cross-actor correlation. Default true. */
  emitFingerprint?: boolean;
}

/**
 * Reads the *order* in which headers arrived.
 *
 * Header order is a genuine fingerprint: a browser's network stack emits a fixed
 * sequence that has nothing to do with what the page requested, and it is one of the
 * few properties a scraper cannot fix by copying a User-Agent string. HTTP client
 * libraries have their own, very different, and equally fixed orders.
 *
 * The reason this detector stays weak is structural rather than a lack of
 * confidence: **anything between the client and this process may reorder headers.**
 * HTTP/2 and HTTP/3 do not preserve a meaningful order at all, some CDNs normalise
 * it, and some proxies rebuild the request wholesale. So it is checked only on
 * HTTP/1.x, only when the transport actually exposed an order, and it contributes a
 * nudge rather than a conclusion.
 */
export function headerOrderDetector(options: HeaderOrderOptions = {}): Detector {
  const emitFingerprint = options.emitFingerprint ?? true;

  return {
    id: "header-order",
    description: "Compares the order headers arrived in against orderings every mainstream browser respects",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const order = ctx.facts.headerOrder;
      const version = ctx.facts.httpVersion;
      // HTTP/2+ carries no meaningful ordering, and an absent order means the
      // adapter could not supply one. Both are "no data", not "suspicious".
      if (order.length === 0) return undefined;
      if (version !== undefined && !version.startsWith("1")) return undefined;
      if (!claimsBrowser(ctx.ua)) return undefined;

      // A single pass recording only the four positions the rules below need. The
      // previous version built a Map of every header and then hashed the whole order
      // to a fingerprint — on every request, before knowing whether it had anything
      // to say. On traffic from real browsers, which is the overwhelming majority,
      // none of that work was ever used, and the HMAC alone made this detector cost
      // more than the other twelve put together.
      let hostAt = -1;
      let acceptAt = -1;
      let encodingAt = -1;
      let agentAt = -1;
      for (let i = 0; i < order.length; i++) {
        switch (order[i]) {
          case "host": if (hostAt === -1) hostAt = i; break;
          case "accept": if (acceptAt === -1) acceptAt = i; break;
          case "accept-encoding": if (encodingAt === -1) encodingAt = i; break;
          case "user-agent": if (agentAt === -1) agentAt = i; break;
          default: break;
        }
      }

      const violations: OrderInvariant[] = [];
      if (acceptAt !== -1 && encodingAt !== -1 && acceptAt > encodingAt) violations.push(INVARIANTS[0]!);
      if (agentAt !== -1 && acceptAt !== -1 && agentAt > acceptAt) violations.push(INVARIANTS[1]!);
      const hostNotFirst = hostAt > 0;

      if (violations.length === 0 && !hostNotFirst) return undefined;

      // Only now is the fingerprint worth computing.
      const fingerprint = emitFingerprint ? headerOrderFingerprint(order) : undefined;
      const results: Evidence[] = [];

      for (const invariant of violations) {
        results.push({
          detector: "header-order",
          summary: `Header order puts ${invariant.after} before ${invariant.before}, which no mainstream browser does`,
          direction: "bot",
          certainty: "moderate",
          weight: invariant.weight,
          botClass: "impersonator",
          // Whatever reordered the headers reordered all of them: one cause.
          family: "reordered-headers",
          metadata: {
            reason: invariant.why,
            order: order.slice(0, 24),
            ...(fingerprint ? { fingerprint } : {}),
          },
        });
      }

      // Browsers send Host first on HTTP/1.1. A request that does not is either
      // hand-assembled or was rebuilt by an intermediary — hence only `weak`.
      if (hostNotFirst) {
        results.push({
          detector: "header-order",
          summary: `HTTP/1.1 request did not send Host first (sent "${order[0]}")`,
          direction: "bot",
          certainty: "weak",
          botClass: "impersonator",
          family: "reordered-headers",
          metadata: { first: order[0], ...(fingerprint ? { fingerprint } : {}) },
        });
      }

      return results;
    },
  };
}

/**
 * Stable fingerprint of a header order, for correlating one actor across rotating
 * addresses. Exported because it is useful well outside this detector — an actor
 * that changes IP every request but keeps the same order fingerprint is one actor.
 */
export function headerOrderFingerprint(order: readonly string[]): string {
  return shortHash(order.join(","));
}
