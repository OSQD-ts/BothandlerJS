import { acceptSignatureDetector } from "./accept-signature.js";
import { browsingCoherenceDetector } from "./browsing-coherence.js";
import { cadenceDetector } from "./cadence.js";
import { clientHintsDetector } from "./client-hints.js";
import { crawlBreadthDetector } from "./crawl-breadth.js";
import { parameterSweepDetector } from "./parameter-sweep.js";
import { transportCoherenceDetector } from "./transport-coherence.js";
import { probeVolumeDetector } from "./probe-volume.js";
import { idEnumerationDetector } from "./id-enumeration.js";
import { blendedIdentityDetector } from "./blended-identity.js";
import { crawlerVerificationDetector } from "./crawler-verification.js";
import type { CrawlerVerificationOptions } from "./crawler-verification.js";
import { fetchMetadataDetector } from "./fetch-metadata.js";
import { headerIntegrityDetector } from "./header-integrity.js";
import { headerOrderDetector } from "./header-order.js";
import { ipIntelligenceDetector } from "./ip-intelligence.js";
import { probeSignatureDetector } from "./probe-signature.js";
import { targetIntegrityDetector } from "./target-integrity.js";
import { rateAnomalyDetector } from "./rate-anomaly.js";
import { selfIdentifiedDetector } from "./self-identified.js";
import { sessionIntegrityDetector } from "./session-integrity.js";
import { trapDetector } from "./trap.js";
import { uaCoherenceDetector } from "./ua-coherence.js";
import type { Detector } from "./types.js";

export type { DetectionContext, Detector, DetectorResult } from "./types.js";
export { evidence, absenceIsMeaningful } from "./types.js";

export { selfIdentifiedDetector } from "./self-identified.js";
export type { SelfIdentifiedOptions } from "./self-identified.js";
export { crawlerVerificationDetector } from "./crawler-verification.js";
export type { CrawlerVerificationOptions } from "./crawler-verification.js";
export { headerIntegrityDetector } from "./header-integrity.js";
export type { HeaderIntegrityOptions } from "./header-integrity.js";
export { clientHintsDetector } from "./client-hints.js";
export { fetchMetadataDetector } from "./fetch-metadata.js";
export { acceptSignatureDetector } from "./accept-signature.js";
export { headerOrderDetector, headerOrderFingerprint } from "./header-order.js";
export type { HeaderOrderOptions } from "./header-order.js";
export { rateAnomalyDetector } from "./rate-anomaly.js";
export type { RateAnomalyOptions } from "./rate-anomaly.js";
export { cadenceDetector } from "./cadence.js";
export type { CadenceOptions } from "./cadence.js";
export { crawlBreadthDetector } from "./crawl-breadth.js";
export { parameterSweepDetector } from "./parameter-sweep.js";
export { transportCoherenceDetector } from "./transport-coherence.js";
export { probeVolumeDetector } from "./probe-volume.js";
export { idEnumerationDetector } from "./id-enumeration.js";
export { blendedIdentityDetector } from "./blended-identity.js";
export { challengeReactionDetector } from "./challenge-reaction.js";
export type { ChallengeReactionOptions } from "./challenge-reaction.js";
export { challengeIntegrityDetector } from "./challenge-integrity.js";
export { distributedWalkDetector, pathNoveltyDetector, missBaselineDetector, pathCampaignDetector } from "./site-baseline.js";
export type { DistributedWalkOptions, PathNoveltyOptions, MissBaselineOptions, PathCampaignOptions } from "./site-baseline.js";
export type { ChallengeIntegrityOptions } from "./challenge-integrity.js";
export { identityDriftDetector, markerIntegrityDetector, markerPersistenceDetector, markerFanoutDetector } from "./marker.js";
export type { IdentityDriftOptions, MarkerIntegrityOptions, MarkerPersistenceOptions, MarkerFanoutOptions } from "./marker.js";
export type { CrawlBreadthOptions } from "./crawl-breadth.js";
export type { ParameterSweepOptions } from "./parameter-sweep.js";
export type { TransportCoherenceOptions } from "./transport-coherence.js";
export type { ProbeVolumeOptions } from "./probe-volume.js";
export type { IdEnumerationOptions } from "./id-enumeration.js";
export type { BlendedIdentityOptions } from "./blended-identity.js";
export { sessionIntegrityDetector } from "./session-integrity.js";
export type { SessionIntegrityOptions } from "./session-integrity.js";
export { identityRotationDetector } from "./identity-rotation.js";
export type { IdentityRotationOptions } from "./identity-rotation.js";
export { TRAP_FIELD_SOURCE, trapDetector, renderTrapLink, renderTrapField, trapRobotsEntries, DEFAULT_TRAP_PATHS } from "./trap.js";
export type { TrapOptions, TrapLinkOptions } from "./trap.js";
export { ipIntelligenceDetector } from "./ip-intelligence.js";
export type { IpIntelligenceOptions } from "./ip-intelligence.js";
export { tlsFingerprintDetector } from "./tls-fingerprint.js";
export type { TlsFingerprintOptions, FingerprintProfile } from "./tls-fingerprint.js";
export { clearanceDetector } from "./clearance.js";
export { uaCoherenceDetector } from "./ua-coherence.js";
export { targetIntegrityDetector } from "./target-integrity.js";
export type { TargetIntegrityOptions } from "./target-integrity.js";
export { probeSignatureDetector } from "./probe-signature.js";
export type { ProbeSignatureOptions } from "./probe-signature.js";
export { browsingCoherenceDetector } from "./browsing-coherence.js";
export { clientSignalsDetector } from "./client-signals.js";
export type { ClientSignalsOptions } from "./client-signals.js";

export { BOT_SIGNATURES, BENIGN_CATEGORIES, compileSignatures, indexSignatures } from "./known-bots.js";
export type { BotSignature, BotCategory, Verification } from "./known-bots.js";

/**
 * The detector set installed when you configure none.
 *
 * Two are missing on purpose, and both omissions are about false positives rather
 * than about cost:
 *
 * - `identityRotationDetector` fires on any address that fronts several browsers,
 *   which describes every corporate NAT and mobile carrier on the internet. It is
 *   valuable, but only once your `actorKey` is narrower than an IP.
 * - `tlsFingerprintDetector` needs a fingerprint from your edge and a profile table
 *   you maintain. With neither it is inert; with a stale table it misfires on anyone
 *   running a browser newer than your data.
 *
 * `clearanceDetector` is not here either, because it needs the challenge service —
 * the engine adds it automatically once `challenge.secrets` is configured. The three
 * marker detectors work the same way: with no `probe` there is no cookie to have been
 * issued, so they would be three permanently silent entries in every deployment that
 * does not use one, and the engine adds them once `probe` is.
 */
export function defaultDetectors(options: { crawlerVerification?: CrawlerVerificationOptions; behindProxy?: boolean } = {}): Detector[] {
  return [
    // Identity first: a self-declaration or a verified crawler settles the question
    // outright, and the engine can then skip everything that would only add nuance.
    selfIdentifiedDetector(),
    blendedIdentityDetector(),
    trapDetector(),
    ipIntelligenceDetector(),
    probeSignatureDetector(),
    targetIntegrityDetector(),
    // Single-request consistency.
    headerIntegrityDetector(),
    uaCoherenceDetector(),
    clientHintsDetector(),
    fetchMetadataDetector(),
    acceptSignatureDetector(),
    // The transport version is the *connection this process accepted*. Behind a proxy that
    // is the proxy's connection, not the client's — nginx still defaults to HTTP/1.0
    // upstream — so "a browser claiming Chrome over HTTP/1.0" then describes every visitor
    // and is a standing penalty for something none of them did. An integration measured it:
    // a full real-Chrome header set, 0 over HTTP/1.1 and 24 over HTTP/1.0, sitting under
    // the threshold and waiting for one more mild signal to tip people into a challenge.
    // `proxy.trustProxy` already says a proxy terminated the connection, so this stops
    // reading the version when it does. `legacyHttp: true` puts it back for a deployment
    // whose proxy passes the client's version through.
    transportCoherenceDetector(options.behindProxy === true ? { legacyHttp: false } : {}),
    headerOrderDetector(),
    // Behaviour across requests.
    rateAnomalyDetector(),
    cadenceDetector(),
    crawlBreadthDetector(),
    parameterSweepDetector(),
    probeVolumeDetector(),
    idEnumerationDetector(),
    sessionIntegrityDetector(),
    // The other side of the argument: what a real browsing session looks like.
    browsingCoherenceDetector(),
    // Confirming stage: only runs when an identity was claimed.
    crawlerVerificationDetector(options.crawlerVerification ?? {}),
  ];
}
