/**
 * Core vocabulary. Everything else in the library is written against these types.
 *
 * The single most important idea here is the split between **proof** and
 * **suspicion**, expressed as {@link Certainty}. It is what lets the engine offer a
 * real no-false-positive guarantee on its blocking path without pretending that bot
 * detection is a solved problem: probabilistic signals exist, they are useful, and
 * they are structurally barred from reaching a terminal action.
 */

/** What kind of client we believe we are talking to. */
export type BotClass =
  /** Positive evidence of a person driving a real browser. */
  | "human"
  /** A crawler whose *identity* was confirmed, not merely claimed. See `verified-crawler`. */
  | "verified-bot"
  /** Announces itself as a bot in its User-Agent and does not pretend otherwise. */
  | "declared-bot"
  /** A real browser engine driven by automation (Puppeteer, Playwright, Selenium). */
  | "automation"
  /** A bare HTTP library or CLI: curl, wget, requests, axios, Go's http client. */
  | "http-client"
  /** Security/vulnerability scanning and fuzzing tooling. */
  | "scanner"
  /** Behaves like bulk content extraction regardless of what it claims to be. */
  | "scraper"
  /**
   * Claims an identity it provably does not have — a forged `Googlebot`, a
   * `Sec-CH-UA` that contradicts its own User-Agent. The most actionable class we
   * produce, because the contradiction is self-evident from the request.
   */
  | "impersonator"
  /** Nothing pointed either way with enough weight to name a class. */
  | "unknown";

/**
 * How much a piece of evidence is worth — and, critically, whether it is allowed to
 * get a request blocked.
 *
 * - `certain` — **deterministic**. The request is self-contradictory, self-declaring,
 *   or its identity was verified against an authority outside the request itself.
 *   No legitimate human client produces it. Only this tier may drive a terminal
 *   action under the default policy, and every `certain` evidence must carry a
 *   `deterministicBasis` explaining why it cannot be wrong.
 * - `strong` / `moderate` / `weak` — **probabilistic**. Real signals, genuinely
 *   useful in aggregate, but each has a population of legitimate clients that trips
 *   it: privacy browsers, corporate proxies, accessibility tooling, someone on a
 *   train tunnel. These accumulate into a score and can drive a challenge, a tag, or
 *   an alert. They cannot, by default, drive a block.
 */
export type Certainty = "certain" | "strong" | "moderate" | "weak";

/** Which way a piece of evidence points. Human evidence actively rebuts bot evidence. */
export type EvidenceDirection = "bot" | "human";

/** One observation from one detector. Detectors return these; they never return verdicts. */
export interface Evidence {
  /** Id of the detector that produced this. */
  detector: string;
  /** Human-readable, log-safe explanation of what was observed. */
  summary: string;
  direction: EvidenceDirection;
  certainty: Certainty;
  /**
   * Contribution to the suspicion score, 0–1. Defaults to the weight implied by
   * `certainty` ({@link CERTAINTY_WEIGHT}); override only to express that a signal is
   * unusually weak or strong *for its tier*.
   */
  weight?: number | undefined;
  /**
   * A shared *root cause*, when this observation has one.
   *
   * Two pieces of evidence in the same family are not two reasons to be suspicious —
   * they are one circumstance seen twice. A corporate proxy that strips
   * `Sec-Fetch-*` also strips the Client Hints and the `Accept-Language`, and every
   * detector that reasons from absence then fires at once about a single person
   * behind a single appliance. Noisy-OR assumes independence; these are not
   * independent, and treating them as if they were is how an ordinary employee
   * accumulates a score of 95.
   *
   * {@link CERTAINTY_WEIGHT} scoring therefore takes the **strongest** observation in
   * each family rather than compounding them. Leave it undefined when a signal really
   * does stand on its own — every unfamilied piece of evidence is its own family, so
   * the default is the old behaviour.
   */
  family?: string | undefined;
  /** The class this evidence argues for, if it argues for one. */
  botClass?: BotClass | undefined;
  /** A concrete identity this evidence establishes or claims, e.g. `"googlebot"`. */
  identity?: string | undefined;
  /**
   * Required on `certain` evidence: why this observation admits no benign
   * explanation. Enforced at runtime in development (see {@link BotHandlerConfig.strictEvidence}).
   * Writing one is a useful forcing function — if you cannot, your evidence is `strong`.
   */
  deterministicBasis?: string | undefined;
  /** Structured detail for logs and dashboards. Must be JSON-serialisable. */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Every verdict and class, in a fixed order.
 *
 * Exported because three places need to enumerate them — the metrics counters, the
 * dashboard's rule editor, and anything generating documentation — and three hand-kept
 * copies is how a new verdict ends up missing from one of them.
 */
export const VERDICTS: readonly Verdict[] = ["confirmed-bot", "verified-bot", "suspected-bot", "human", "unknown"];
export const BOT_CLASSES: readonly BotClass[] = ["human", "verified-bot", "declared-bot", "automation", "http-client", "scanner", "scraper", "impersonator", "unknown"];

/** Score contribution implied by each certainty tier. */
export const CERTAINTY_WEIGHT: Record<Certainty, number> = {
  // `certain` short-circuits scoring entirely; the 1 is here for completeness.
  certain: 1,
  strong: 0.6,
  moderate: 0.35,
  weak: 0.15,
};

/**
 * The engine's conclusion about a request.
 *
 * `confirmed-bot` and `verified-bot` are *proven*: they rest on at least one
 * `certain` evidence. `suspected-bot` is a judgement call from accumulated
 * probabilistic signal — treat it as "worth a challenge", never as "worth a 403".
 */
export type Verdict =
  /** Proven automated: self-declared, self-contradictory, or caught in a trap. */
  | "confirmed-bot"
  /** Proven automated *and* proven to be who it says it is — Googlebot, Bingbot. */
  | "verified-bot"
  /** Probabilistic. Enough signal to act gently; not enough to be sure. */
  | "suspected-bot"
  /** Positive evidence of a person (valid attestation, real interaction, clearance token). */
  | "human"
  /** Nothing conclusive either way. The default resting state of ordinary traffic. */
  | "unknown";

/** A request reduced to exactly the facts detectors are allowed to see. */
export interface RequestFacts {
  /** Uppercase HTTP method. */
  method: string;
  /** Path only, no query string. Always begins with `/`. */
  path: string;
  /** Decoded query parameters. Null-prototype so `?__proto__=x` is visible, not swallowed. */
  query: Record<string, string>;
  /** Lowercased header names to values. Multi-value headers are joined with `, `. */
  headers: Record<string, string | undefined>;
  /**
   * Header names in the order the client actually sent them, lowercased. Browsers
   * emit a stable, engine-specific order; most tooling does not. Empty when the
   * transport does not expose ordering (HTTP/2 pseudo-headers, some proxies).
   */
  headerOrder: readonly string[];
  /** Resolved client IP. See {@link ProxyConfig} for how this is derived. */
  ip: string;
  /** Wall-clock arrival time, ms since epoch. Injected so tests can control it. */
  timestamp: number;
  /** Parsed request cookies, if the adapter supplied them. */
  cookies?: Record<string, string> | undefined;
  /** `https` when the connection is TLS-terminated at or before this server. */
  protocol?: "http" | "https" | undefined;
  /** Negotiated HTTP version, e.g. `"1.1"`, `"2.0"`. Used for header-order sanity. */
  httpVersion?: string | undefined;
  /**
   * TLS client fingerprint (JA3/JA4), if your edge computes one and forwards it.
   * Never computed here — Node does not expose the ClientHello.
   */
  tlsFingerprint?: string | undefined;
  /**
   * Set when the header set is known to be **incomplete** — the source could not
   * supply everything the client actually sent.
   *
   * This is a statement about the observer, not the client, and it changes what an
   * absent header means. Several detectors treat "no `Accept-Language`" as evidence,
   * which is sound for a live request and nonsense for a line of an access log that
   * only ever records two headers. With this set, every detector that reasons from
   * absence stands down; detectors that reason from what *is* present carry on.
   *
   * Adapters leave it unset. Set it yourself when replaying logs, reading from an
   * analytics pipeline, or on any transport that filters headers before you see them.
   */
  partialHeaders?: boolean | undefined;
  /** Opaque per-request extras an adapter or your own code attaches. */
  extra?: Record<string, unknown> | undefined;
}

/** What the engine knows about the actor behind a request, accumulated over time. */
export interface ActorSnapshot {
  /** Stable key this actor is tracked under. See {@link BotHandlerConfig.actorKey}. */
  key: string;
  /** Requests seen from this actor inside the behavioural window. */
  requests: number;
  /** Distinct paths seen inside the window — breadth of crawl. */
  distinctPaths: number;
  /** First and last sighting, ms since epoch. */
  firstSeen: number;
  lastSeen: number;
  /** Milliseconds since the previous request from this actor, or `undefined` if first. */
  sinceLastMs?: number | undefined;
  /** Assessments in the window that concluded `confirmed-bot`. */
  priorConfirmations: number;
  /**
   * Challenges issued to this actor that were never solved.
   *
   * Outstanding rather than cumulative: solving one clears the count. See
   * `MatchSpec.minUnsolvedChallenges` for the rule that reads it, and note that it is
   * deliberately **not** evidence — a person who gives up on a challenge is a person,
   * and what repeated abandonment means is a judgement about your traffic that only you
   * can make.
   */
  unsolvedChallenges: number;
  /** True when this actor holds a currently-valid human clearance token. */
  cleared: boolean;
}

/** The engine's full, explainable output for one request. */
export interface Assessment {
  /** Random per-request id, safe to log and to echo in a response header. */
  requestId: string;
  verdict: Verdict;
  botClass: BotClass;
  /** Established identity when there is one, e.g. `"googlebot"`. */
  identity?: string | undefined;
  /** Suspicion, 0–100. Derived only from probabilistic evidence. */
  score: number;
  /** How much to trust the verdict, 0–1. Exactly 1 when `certain` is true. */
  confidence: number;
  /**
   * True when at least one unrebutted `certain` evidence fired. This flag — not the
   * score — is what gates terminal actions in the default policy.
   */
  certain: boolean;
  /** Every bot-pointing observation, strongest first. */
  evidence: Evidence[];
  /** Every human-pointing observation. These rebut and dampen the score. */
  humanEvidence: Evidence[];
  actor: ActorSnapshot;
  /**
   * Set when detection was skipped rather than performed. `undefined` means every
   * configured detector actually ran, which is what distinguishes "we looked and
   * found nothing" from "we never looked" — a distinction that matters enormously
   * when reading a dashboard.
   */
  bypass?: BypassReason | undefined;
  /** Total time spent in detection, ms. */
  durationMs: number;
  /** Detectors that threw or timed out. Detection continues without them. */
  failures: DetectorFailure[];
  facts: RequestFacts;
}

/** Why an assessment skipped detection. */
export type BypassReason =
  /** The address matched the configured allowlist. */
  | "allowlist"
  /** The path matched `ignorePaths`. */
  | "ignored-path";

export interface DetectorFailure {
  detector: string;
  reason: "error" | "timeout";
  message: string;
}

/** JSON-serialisable value, for metadata and notification payloads. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
