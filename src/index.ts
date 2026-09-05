/**
 * bothandlerjs — bot traffic detection and handling for TypeScript.
 *
 * The whole library rests on one distinction: **proof versus suspicion**. Evidence is
 * tiered ({@link Certainty}), the two tiers are combined by different rules
 * ({@link combineEvidence}), and a safety guard in the policy layer stops a
 * probabilistic verdict from ever reaching a terminal action ({@link Policy}). That is
 * what "no false positives" means here, precisely: nothing is *denied* on a guess.
 * Guesses still get to tag, delay, rate-limit, challenge and alert — they just cannot
 * shut the door.
 *
 * ```ts
 * import { BotHandler } from "bothandlerjs";
 * import { botHandler } from "bothandlerjs/adapters";
 *
 * const detector = new BotHandler({ preset: "protect-content" });
 * app.use(botHandler(detector));
 * ```
 */

export { BotHandler } from "./core.js";
export type { AssessOptions, ChangeContext, HandleResult, BotHandlerEvents, DetectorDescription } from "./core.js";

export { createFacts } from "./facts.js";
export type { FactsInput } from "./facts.js";

export { resolveConfig, resolveClientIp, validateRules, ConfigError } from "./config.js";
export type { BotHandlerConfig, ResolvedConfig, ProxyConfig } from "./config.js";

export { combineEvidence, noisyOr, sortEvidence, weightOf } from "./evidence.js";
export type { CombineOptions, CombinedEvidence } from "./evidence.js";

export { generateRobotsTxt, robotsFromRules, agentFor } from "./robots.js";

// Published crawler address ranges. Opt-in, and it makes outbound requests — which is
// why it is a separate call rather than something the handler does on its own.
export { fetchCrawlerRanges, refreshCrawlerRanges, startCrawlerRangeRefresh, PUBLISHED_CRAWLER_RANGES } from "./crawler-ranges.js";
export type { PublishedRangeSource, RefreshOptions, RefreshResult, ScheduleOptions } from "./crawler-ranges.js";
export type { RobotsOptions, RobotsFromRulesResult } from "./robots.js";

export { TrafficAudit, DEFAULT_CHECKS } from "./audit.js";
export type { AnomalySeverity, AuditCheck, AuditContext, AuditOptions, AuditWindow, TrafficAnomaly } from "./audit.js";

export { Metrics, toPrometheus, DURATION_BUCKETS_MS, SCORE_BUCKETS } from "./metrics.js";
export type { MetricsOptions, MetricsSnapshot, PrometheusOptions } from "./metrics.js";

// The dashboard. `handler.serveDashboard()` is the way in; these are exported for
// callers who want to run it against their own server or type their own config.
export { startDashboard, createDashboardHandler, renderDashboardPage } from "./dashboard/index.js";
export type { DashboardAuth, DashboardControls, DashboardEntry, DashboardEvidence, DashboardOptions, DashboardHandlerOptions, DashboardRedaction, DashboardRefusal, DashboardRequestHandler, DashboardSections, DashboardServer, DashboardSnapshot } from "./dashboard/index.js";

export { ActorRegistry, ActorState } from "./state.js";
export type { ActorRegistryOptions, ActorSummary } from "./state.js";

export { CERTAINTY_WEIGHT, VERDICTS, BOT_CLASSES } from "./types.js";
export type {
  ActorSnapshot,
  Assessment,
  BotClass,
  BypassReason,
  Certainty,
  DetectorFailure,
  Evidence,
  EvidenceDirection,
  Json,
  RequestFacts,
  Verdict,
} from "./types.js";

export * from "./detectors/index.js";
export * from "./policy/index.js";
export * from "./actions/index.js";
export * from "./stores/index.js";
export * from "./notify/index.js";
export * from "./challenge/index.js";

export { ChallengeService } from "./challenge/index.js";
export type { ChallengeCopy, ChallengeOptions, ChallengeResponse, SolutionOutcome } from "./challenge/index.js";
export { parseAcceptLanguage, pickTranslation } from "./challenge/index.js";

// Utilities that are genuinely useful outside the library: address handling that is
// not fooled by alternative spellings, and the multi-pattern matcher.
export { IpRangeSet, cidrContains, formatIp, isSpecialUse, networkKey, normalizeIp, parseCidr, parseIp, SPECIAL_USE_RANGES } from "./internal/ip.js";
export type { Cidr, IpBytes } from "./internal/ip.js";
export { MultiPatternMatcher } from "./internal/matcher.js";
export { parseUserAgent, claimsBrowser, sendsModernHeaders, MAX_USER_AGENT_LENGTH } from "./internal/ua.js";
export type { ParsedUserAgent, UaShape } from "./internal/ua.js";
export { parseCookies, serializeCookie } from "./internal/http.js";
export type { CookieOptions } from "./internal/http.js";
export { systemClock, ManualClock } from "./internal/clock.js";
export type { Clock } from "./internal/clock.js";
export { cachingResolver, forwardConfirmedReverseDns, nodeDnsResolver } from "./internal/dns.js";
export type { DnsResolver, VerificationOutcome, CachingResolverOptions } from "./internal/dns.js";
export { TtlLru } from "./internal/lru.js";
export { Emitter } from "./internal/emitter.js";
