import { forwardConfirmedReverseDns } from "../internal/dns.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";
import type { BotSignature } from "./known-bots.js";

export interface CrawlerVerificationOptions {
  /**
   * Treat an address with no PTR record as a forged claim. Default true.
   *
   * Every operator whose crawler this applies to publishes PTR records precisely so
   * that servers can check them; a claimed Googlebot with no reverse DNS at all is
   * not a configuration accident, it is the cheapest possible forgery. Set false if
   * you have a resolver that cannot be trusted to distinguish NXDOMAIN from failure.
   */
  treatMissingPtrAsForgery?: boolean;
  /**
   * Also assert forgery for `ip-ranges` crawlers when ranges *are* configured and the
   * client is outside them. Default true. Has no effect for a crawler whose ranges
   * you have not supplied — an unverifiable claim stays unverified, never accused.
   */
  useConfiguredRanges?: boolean;
}

/**
 * Confirms or refutes a claimed crawler identity against an authority outside the
 * request.
 *
 * This is the only detector that can produce `verified-bot`, and the only one that
 * can produce a `certain` `impersonator`. Both directions matter:
 *
 * - **Confirmed** — the operator's own DNS vouches for this address. Forging it needs
 *   control of `googlebot.com`'s DNS, so a pass here is proof, and the default policy
 *   uses it to *allow*: your SEO does not deserve to be collateral damage from a bot
 *   rule.
 * - **Refuted** — the client specifically claimed to be a named third party and the
 *   claim is false. Note how narrow that is. A privacy extension rewriting a UA to a
 *   generic browser string never lands here, because it never claims to be Googlebot.
 *   Only a deliberate forgery of a *verifiable* identity does, which is why this one
 *   is allowed to block.
 *
 * Anything short of a clear answer — a timeout, SERVFAIL, an unconfigured range list
 * — yields nothing at all. Silence is never treated as an accusation.
 */
export function crawlerVerificationDetector(options: CrawlerVerificationOptions = {}): Detector {
  const missingPtrIsForgery = options.treatMissingPtrAsForgery ?? true;
  const useRanges = options.useConfiguredRanges ?? true;

  return {
    id: "crawler-verification",
    description: "Confirms or refutes a claimed crawler identity via forward-confirmed reverse DNS or published IP ranges",
    cost: "io",
    // Only runs when something already claimed an identity. A request that named no
    // crawler gives us nothing to verify, and resolving DNS for it would be pure cost.
    stage: "confirming",

    async inspect(ctx: DetectionContext): Promise<Evidence[] | undefined> {
      const claims = ctx.signatureMatches.filter((signature) => signature.verification.kind !== "none");
      if (claims.length === 0) return undefined;

      const results: Evidence[] = [];
      for (const claim of claims) {
        const outcome = await verifyClaim(ctx, claim, { missingPtrIsForgery, useRanges });
        if (outcome) results.push(outcome);
      }
      return results.length > 0 ? results : undefined;
    },
  };
}

async function verifyClaim(
  ctx: DetectionContext,
  signature: BotSignature,
  flags: { missingPtrIsForgery: boolean; useRanges: boolean },
): Promise<Evidence | undefined> {
  if (signature.verification.kind === "ip-ranges") {
    if (!flags.useRanges) return undefined;
    const ranges = ctx.ranges.get(`crawler:${signature.id}`);
    // No ranges configured for this crawler: the claim is simply unverifiable here.
    // Producing "suspicious because we could not check" would be exactly backwards.
    if (!ranges || ranges.size === 0) return undefined;

    const matched = ranges.match(ctx.facts.ip);
    if (matched !== undefined) {
      return {
        detector: "crawler-verification",
        summary: `${signature.name} confirmed: client is inside the operator's published IP ranges`,
        direction: "bot",
        certainty: "certain",
        botClass: "verified-bot",
        identity: signature.id,
        deterministicBasis: `The address falls in ${matched}, a range ${signature.name}'s operator publishes as its own. Appearing there requires controlling that network.`,
        metadata: { signatureId: signature.id, range: matched, method: "ip-ranges" },
      };
    }
    return {
      detector: "crawler-verification",
      summary: `Client claims to be ${signature.name} but is outside the operator's published IP ranges`,
      direction: "bot",
      certainty: "certain",
      botClass: "impersonator",
      identity: signature.id,
      deterministicBasis: `The client named itself ${signature.name}, whose operator publishes the exhaustive set of addresses it crawls from. This address is not among them, so the claim is false regardless of intent.`,
      metadata: { signatureId: signature.id, method: "ip-ranges", ip: ctx.facts.ip },
    };
  }

  if (signature.verification.kind !== "fcrdns") return undefined;

  const outcome = await forwardConfirmedReverseDns(ctx.resolver, ctx.facts.ip, signature.verification.domains);

  if (outcome.status === "verified") {
    return {
      detector: "crawler-verification",
      summary: `${signature.name} confirmed by forward-confirmed reverse DNS (${outcome.hostname})`,
      direction: "bot",
      certainty: "certain",
      botClass: "verified-bot",
      identity: signature.id,
      deterministicBasis: `The address reverse-resolves to ${outcome.hostname} under a domain ${signature.name}'s operator controls, and that name forward-resolves back to this address. Faking both halves requires authority over the operator's DNS.`,
      metadata: { signatureId: signature.id, hostname: outcome.hostname, method: "fcrdns" },
    };
  }

  if (outcome.status === "contradicted") {
    if (outcome.cause === "no-ptr" && !flags.missingPtrIsForgery) return undefined;
    return {
      detector: "crawler-verification",
      summary: `Client claims to be ${signature.name}, but DNS refutes it: ${outcome.reason}`,
      direction: "bot",
      certainty: "certain",
      botClass: "impersonator",
      identity: signature.id,
      deterministicBasis: `The client named itself ${signature.name}, an identity its operator publishes a DNS-based proof for. The lookup returned a definitive answer and that answer contradicts the claim: ${outcome.reason}.`,
      metadata: { signatureId: signature.id, cause: outcome.cause, reason: outcome.reason, method: "fcrdns", ...(outcome.hostname ? { hostname: outcome.hostname } : {}) },
    };
  }

  // Indeterminate. Deliberately silent — see this file's header.
  return undefined;
}
