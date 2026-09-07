import { forwardConfirmedReverseDns } from "../internal/dns.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";
import type { BotSignature } from "./known-bots.js";

/**
 * What an operator's own check concluded about a claimed identity.
 *
 * Three answers, and the third is not a formality. "I could not tell" has to be
 * expressible and has to mean *silence* — a verifier that returned false for both "this
 * is a forgery" and "my key server timed out" would turn an outage into an accusation.
 */
export type VerificationOutcome = "verified" | "refuted" | "unknown";

/**
 * Your own answer to "is this really who it says it is".
 *
 * Called with the same context the built-in checks get, for one claimed signature. It
 * may be async: the natural implementations are a lookup or a signature check.
 */
export type CrawlerVerifier = (ctx: DetectionContext, signature: BotSignature) => VerificationOutcome | Promise<VerificationOutcome>;

export interface CrawlerVerificationOptions {
  /**
   * Verifiers of your own, by signature id — `{ googlebot: ..., gptbot: ... }`.
   *
   * Most of this database cannot be checked from inside a request: the operator
   * publishes no DNS proof and no range list, and the claim is simply unfalsifiable.
   * That is most bots, and until now it meant the library had nothing to offer an
   * operator who *could* check — because their CDN had already verified the crawler and
   * said so in a header, because the bot signs its requests, or because they hold the
   * ASN data. Writing a whole detector to say so meant reimplementing the confirm and
   * refute semantics in this file, including the part where an inconclusive answer must
   * stay silent.
   *
   * A verifier here runs before the built-in check for that signature and a definite
   * answer settles it, which also means no DNS lookup. `unknown` falls through to
   * whatever this library can do on its own.
   */
  verifiers?: Readonly<Record<string, CrawlerVerifier>>;
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
  const verifiers = options.verifiers ?? {};

  return {
    id: "crawler-verification",
    description: "Confirms or refutes a claimed crawler identity via forward-confirmed reverse DNS or published IP ranges",
    cost: "io",
    // Only runs when something already claimed an identity. A request that named no
    // crawler gives us nothing to verify, and resolving DNS for it would be pure cost.
    stage: "confirming",

    async inspect(ctx: DetectionContext): Promise<Evidence[] | undefined> {
      // A `none` claim is still worth offering to a verifier of the operator's own: they
      // may be able to check something this library cannot, which is the entire reason
      // that hook exists. Without one, it is filtered out exactly as before.
      const claims = ctx.signatureMatches.filter((signature) => signature.verification.kind !== "none" || verifiers[signature.id] !== undefined);
      if (claims.length === 0) return undefined;

      const results: Evidence[] = [];
      for (const claim of claims) {
        const own = await runVerifier(verifiers[claim.id], ctx, claim);
        if (own !== undefined) {
          results.push(own);
          continue;
        }
        const outcome = await verifyClaim(ctx, claim, { missingPtrIsForgery, useRanges });
        if (outcome) results.push(outcome);
      }
      return results.length > 0 ? results : undefined;
    },
  };
}

/**
 * Runs an operator's verifier and turns its answer into evidence.
 *
 * A throw is `unknown`, not a refutation: the same argument as the timeout above, and the
 * failure mode of getting it wrong is accusing a real Googlebot because a key server was
 * briefly unreachable.
 */
async function runVerifier(verifier: CrawlerVerifier | undefined, ctx: DetectionContext, signature: BotSignature): Promise<Evidence | undefined> {
  if (verifier === undefined) return undefined;
  let outcome: VerificationOutcome;
  try {
    outcome = await verifier(ctx, signature);
  } catch {
    return undefined;
  }
  if (outcome === "unknown") return undefined;

  const via = signature.verification.kind === "proof" ? signature.verification.via : "a check you supplied";
  if (outcome === "verified") {
    return {
      detector: "crawler-verification",
      summary: `${signature.name} confirmed by your own verifier`,
      direction: "bot",
      certainty: "certain",
      botClass: "verified-bot",
      identity: signature.id,
      deterministicBasis: `Your application confirmed this identity through ${via} — a proof it holds and this library cannot see. It is your assertion about your own infrastructure, and it is treated the way the operator's word is treated everywhere else here.`,
      metadata: { signatureId: signature.id, method: "operator-verifier" },
    };
  }
  return {
    detector: "crawler-verification",
    summary: `Client claims to be ${signature.name}, and your own verifier refutes it`,
    direction: "bot",
    certainty: "certain",
    botClass: "impersonator",
    identity: signature.id,
    deterministicBasis: `The client named itself ${signature.name}, and the check you supplied for that identity — ${via} — returned a definite no. The refutation is yours; this library only reports it.`,
    metadata: { signatureId: signature.id, method: "operator-verifier" },
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

  // `proof` and anything else without a built-in check: verifiable only by a verifier of
  // the operator's own, and one either was not supplied or did not know.
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
