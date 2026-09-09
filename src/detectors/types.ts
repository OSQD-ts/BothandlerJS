import type { ActorSnapshot, Evidence, RequestFacts } from "../types.js";
import type { ParsedUserAgent } from "../internal/ua.js";
import type { MultiPatternMatcher } from "../internal/matcher.js";
import type { BotSignature } from "./known-bots.js";
import type { ActorState } from "../state.js";
import type { Clock } from "../internal/clock.js";
import type { IpRangeSet } from "../internal/ip.js";
import type { DnsResolver } from "../internal/dns.js";
import type { MarkerObservation } from "../probe/index.js";
import type { SiteProfile } from "../site/index.js";

/**
 * Everything a detector is allowed to see.
 *
 * Detectors get a read-only view of the request plus the small number of services
 * they legitimately need. They deliberately do **not** get the config object, the
 * policy, or the response — a detector that can see the policy is a detector that
 * will eventually be written to game it, and a detector that can touch the response
 * has stopped being a detector.
 */
export interface DetectionContext {
  readonly facts: RequestFacts;
  /** The User-Agent, parsed once per request and shared by every detector. */
  readonly ua: ParsedUserAgent;
  /** Accumulated history for this actor. Read-only here; the engine owns mutation. */
  readonly actor: ActorSnapshot;
  /** The mutable state record behind the snapshot, for detectors that need the raw series. */
  readonly state: ActorState;
  readonly clock: Clock;
  /** Compiled known-bot signatures, matched in a single pass. */
  readonly signatures: MultiPatternMatcher<BotSignature>;
  /** Signature matches for this request's UA, computed once and cached here. */
  readonly signatureMatches: readonly BotSignature[];
  /** DNS access for identity verification. Already timeout-bounded by the engine. */
  readonly resolver: DnsResolver;
  /** Named IP range sets from config: `allowlist`, `denylist`, `datacenter`, and per-crawler ranges. */
  readonly ranges: ReadonlyMap<string, IpRangeSet>;
  /**
   * What the marker cookie on this request turned out to be, when the probe is on.
   *
   * `undefined` means the probe is not configured, which is the default — a detector
   * reading this must treat absence as "no information" and never as "no marker".
   */
  readonly marker: MarkerObservation | undefined;
  /**
   * What the rest of the site's traffic looks like, when a profile is configured.
   *
   * `undefined` means no profile, which is the default. A profile that exists may still
   * be cold — every reader must check `warm` before believing a count, because during
   * warmup every path looks rare and every client looks unique.
   */
  readonly site: SiteProfile | undefined;
  /** Scratch space shared between detectors within one request. Cleared afterwards. */
  readonly shared: Map<string, unknown>;
}

/** Detectors return evidence, never verdicts. Combining evidence is the engine's job. */
export type DetectorResult = Evidence | readonly Evidence[] | undefined | null;

export interface Detector {
  /** Stable id. Appears in evidence, rules, logs and metrics — treat it as public API. */
  id: string;
  /** One line, shown in `describeDetectors()` and in generated documentation. */
  description: string;
  /**
   * `cheap` detectors are pure and synchronous: string and header inspection only.
   * `io` detectors may touch DNS or a shared store, so the engine wraps them in a
   * timeout and runs them concurrently. Mislabelling a blocking detector as `cheap`
   * puts an unbounded await on the request path — the one thing this pipeline must
   * never do.
   */
  cost?: "cheap" | "io";
  /**
   * `always` runs on every request. `confirming` runs only once a primary detector
   * has produced something worth checking — used by reverse-DNS verification, which
   * has no reason to resolve anything for a request that made no identity claim.
   */
  stage?: "always" | "confirming";
  inspect(context: DetectionContext): DetectorResult | Promise<DetectorResult>;
}

/** Convenience for the common case of returning a single piece of evidence. */
export function evidence(input: Evidence): Evidence {
  return input;
}

/**
 * Whether a *missing* header may be treated as evidence.
 *
 * False when the source told us its header set is incomplete. Any check phrased as
 * "the client did not send X" has to consult this first; a check phrased as "the
 * client sent X and it contradicts Y" does not, because presence is still presence.
 */
export function absenceIsMeaningful(context: DetectionContext): boolean {
  return context.facts.partialHeaders !== true;
}
