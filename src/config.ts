import { IpRangeSet, normalizeIp, parseIp, stripPort } from "./internal/ip.js";
import { statelessPattern } from "./internal/pattern.js";
import { systemClock } from "./internal/clock.js";
import { defaultDetectors } from "./detectors/index.js";
import { BOT_SIGNATURES } from "./detectors/known-bots.js";
import { MIN_TOKEN_LENGTH, ServiceTokens } from "./service-tokens.js";
import type { ServiceTokenOptions } from "./service-tokens.js";
import type { LabelOptions } from "./labels.js";
import { ACTION_NAMES } from "./policy/types.js";
import { PRESETS } from "./policy/presets.js";
import type { PresetName } from "./policy/presets.js";
import type { Clock } from "./internal/clock.js";
import type { DnsResolver } from "./internal/dns.js";
import type { Detector } from "./detectors/types.js";
import type { CrawlerVerificationOptions } from "./detectors/crawler-verification.js";
import type { BotCategory, BotSignature } from "./detectors/known-bots.js";
import type { ActionParams, FalsePositivePolicy, MatchSpec, Rule } from "./policy/types.js";
import type { CustomHandler } from "./actions/types.js";
import type { BotHandlerStore } from "./stores/types.js";
import type { AuditOptions, TrafficAnomaly } from "./audit.js";
import type { Decision } from "./policy/types.js";
import type { MetricsOptions } from "./metrics.js";
import type { NotificationOptions } from "./notify/hub.js";
import type { ChallengeOptions } from "./challenge/index.js";
import type { MarkerProbeOptions } from "./probe/index.js";
import type { SiteProfileOptions } from "./site/index.js";
import type { Assessment, RequestFacts } from "./types.js";

/**
 * How the client address is recovered from behind a proxy.
 *
 * This is the highest-consequence configuration in the library and the easiest to get
 * wrong, so it has no convenient default: `trustProxy` is off, and with it off the
 * socket address is used and `X-Forwarded-For` is ignored entirely.
 *
 * The reason is that `X-Forwarded-For` is a *client-supplied header*. If you trust it
 * without knowing how many proxies actually sit in front of you, anyone can prepend a
 * fake hop and choose the address you rate-limit, allowlist and block on. The
 * failure is silent, and it turns every per-actor mechanism here into an attacker
 * input. Configure `trustedProxies` if you can — it is the only variant that does not
 * depend on getting a number right.
 */
export interface ProxyConfig {
  /** Read the forwarded header at all. Default false. */
  trustProxy?: boolean;
  /**
   * CIDRs of proxies you operate. The header is walked from the right, discarding
   * addresses inside these ranges, and the first address outside them is the client.
   * Robust against an extra hop appearing, and the recommended setting.
   *
   * The connecting peer counts as the first hop and is checked the same way. A
   * request that arrives from outside these ranges did not come through your proxies,
   * so its forwarded header is not evidence of anything and the socket address is
   * used instead — which is what makes this variant safe on a server that is
   * reachable both through the load balancer and directly.
   */
  trustedProxies?: readonly string[];
  /**
   * How many proxies sit in front of this process, when you cannot enumerate them.
   * The Nth address from the right is taken. Default 1.
   *
   * If the chain turns out to be shorter than this, the socket address is used
   * instead: a short chain means the request did not come through the expected
   * topology, and every entry in it is then client-controlled. Prefer
   * `trustedProxies`, which does not depend on getting a count right.
   */
  hops?: number;
  /** Header carrying the chain. Default `"x-forwarded-for"`. */
  header?: string;
}

export interface BotHandlerConfig {
  /** Replaces the built-in detector set entirely. */
  detectors?: readonly Detector[];
  /** Appended to the built-in set. Ignored when `detectors` is given. */
  extraDetectors?: readonly Detector[];
  /**
   * Detector ids to run without letting them decide anything.
   *
   * A shadowed detector runs on every request exactly as it otherwise would. Its
   * findings are counted, charted and readable in the dashboard and in every event —
   * and they are kept out of the verdict, the score, the class, the identity and every
   * rule. So the question "what would turning this on do to my traffic?" is answered by
   * a week of your own logs instead of by an argument about thresholds.
   *
   * This is the honest way to introduce a detector, and the correlation sources are why
   * it exists: several of them fire at `moderate` on real people by design — a mobile
   * user roaming between networks trips `marker-fanout`, a crowd arriving on a broken
   * link trips `path-campaign`, somebody toggling "Request desktop site" trips
   * `identity-drift`. Whether the thresholds are right *for your site* is not a thing
   * this library can know, and shadowing is how you find out without anybody being
   * turned away while you do.
   *
   * ```js
   * new BotHandler({ site: {}, shadowDetectors: ["path-novelty", "miss-baseline"] })
   * ```
   *
   * An id that names no installed detector is a warning rather than an error: the usual
   * cause is a typo, and a typo here silently does nothing, which is the one outcome
   * worth being loud about.
   */
  shadowDetectors?: readonly string[];
  /**
   * How claimed crawler identities are confirmed or refuted.
   *
   * Chiefly `verifiers`: your own answer to "is this really Googlebot", for the many
   * identities that publish no proof this library can check on its own. Also the two
   * strictness flags, which were documented on the detector and reachable only by
   * rebuilding the whole detector list.
   */
  crawlerVerification?: CrawlerVerificationOptions;

  /** A named starting policy. Combined with `rules`, which are evaluated first. */
  preset?: PresetName;
  /** Your own rules, evaluated before any preset's. */
  rules?: readonly Rule[];
  /** Action when nothing matches. Default `allow`. */
  defaultAction?: import("./policy/types.js").ActionName;
  defaultActionParams?: ActionParams;
  /** How strictly terminal actions are gated. Default `strict`. See {@link FalsePositivePolicy}. */
  falsePositivePolicy?: FalsePositivePolicy;
  /** Substituted when the guard blocks a terminal action. Default `challenge`. */
  fallbackAction?: import("./policy/types.js").ActionName;
  /** Score needed for a terminal action under `balanced`. Default 85. */
  terminalScoreThreshold?: number;

  /** Score at or above which an unproven request is `suspected-bot`. Default 60. */
  suspectThreshold?: number;
  /**
   * Reject `certain` evidence that carries no `deterministicBasis`. Defaults to true
   * unless `NODE_ENV` is `production`, where it downgrades to a warning so a
   * third-party detector cannot take a live site down.
   */
  strictEvidence?: boolean;

  /** Addresses and CIDRs exempt from detection entirely. Your monitors, your office, your CI. */
  allowlist?: readonly string[];
  /** Addresses and CIDRs treated as proven automation. An explicit local decision. */
  denylist?: readonly string[];
  /** Hosting-provider ranges. Supply your own; none ships with the library. */
  datacenterRanges?: readonly string[];
  /** Published crawler ranges, keyed by signature id, e.g. `{ gptbot: ["1.2.3.0/24"] }`. */
  crawlerRanges?: Readonly<Record<string, readonly string[]>>;

  proxy?: ProxyConfig;
  /**
   * Derives the key an actor is tracked under. Defaults to the client address.
   *
   * Worth replacing. An address is a poor identity — shared by a whole office,
   * changed by a phone every few minutes — and every behavioural detector is only as
   * good as this function. A session id, an authenticated user id, or an address
   * combined with a TLS fingerprint all make the same detectors much sharper.
   */
  actorKey?: (facts: RequestFacts) => string;
  /** Paths detection skips entirely: health checks, your own polling endpoints, static assets. */
  ignorePaths?: readonly (string | RegExp)[];
  /**
   * Shared secrets that let a service caller prove itself, so a rule can name one.
   *
   * A challenge is unanswerable from `fetch`, so an uptime monitor under a strict policy
   * is challenged at best and reports the site down while the site is fine. The rule that
   * fixes it handles a credential, and written by hand it is almost always compared with
   * `===` — variable-time — and carried in a header this library has never heard of, which
   * is therefore printed in full on the dashboard and into every export.
   *
   * ```ts
   * serviceTokens: { tokens: { "uptime monitor": process.env.MONITOR_SECRET! } }
   * // then: { id: "monitor", match: { serviceToken: "uptime monitor" }, action: "allow" }
   * ```
   *
   * The comparison is constant-time, the header is redacted wherever headers are shown,
   * and what reaches a rule is the name rather than the secret. See `ServiceTokenOptions`.
   */
  serviceTokens?: ServiceTokenOptions;
  /**
   * Names for traffic you already recognise: known address ranges, and a lookup for the
   * actors only your application can name.
   *
   * ```ts
   * labels: {
   *   sources: [{ label: "CI runner", cidrs: ["198.51.100.0/24"] }],
   *   resolve: async (key) => lookupAccountName(key),
   * }
   * ```
   *
   * A name never changes a verdict. See `LabelOptions`.
   */
  labels?: LabelOptions;

  /**
   * Lets your application declare a request human — an authenticated session, a
   * completed payment, whatever bar you set. Produces `certain` human evidence, the
   * only conclusive human signal available, because it comes from you and not from
   * the client.
   */
  isHuman?: (facts: RequestFacts) => boolean;

  /** Enables the challenge action. Without it, rules asking for one degrade to `tag`. */
  challenge?: Omit<ChallengeOptions, "store" | "clock">;
  /**
   * Hand each client a signed marker cookie, and read what comes back.
   *
   * Off by default. It is the only part of this library that acts in order to detect,
   * and it is what lets a series of requests be attributed to one *client* rather than
   * to one address — which is the difference between "three people share an office
   * connection" and "one client claimed to be three different browsers".
   *
   * See `docs/detection/correlation.md`. Requires `secrets`; without them it stays off
   * and says so, because a secret invented at startup would mark every marker forged
   * after a restart.
   */
  probe?: Omit<MarkerProbeOptions, "clock">;
  /**
   * Compare each client against the rest of your traffic rather than against a fixed
   * idea of what clients do.
   *
   * Off by default, and silent for the first `warmupRequests` after being switched on.
   * A baseline drawn from a few hundred requests is not a baseline: every path is rare
   * when nothing has been seen. See `docs/detection/correlation.md`.
   */
  site?: Omit<SiteProfileOptions, "clock">;
  store?: BotHandlerStore;
  /**
   * Share `priorConfirmations` between replicas through the store. Default false.
   *
   * Behavioural state is process-local by design — see `state.ts` — because a round
   * trip per request would buy accuracy for signals that are only ever allowed to raise
   * suspicion. A **confirmation is not one of those.** `confirmed-bot` is a proven
   * verdict: something declared itself, forged an identity, or walked into a trap. That
   * is a fact about the client rather than a judgement about it, and behind eight
   * replicas a fact established on one of them is unknown to the other seven — so a
   * rule reading `minPriorConfirmations: 1` fires roughly an eighth as often as it
   * reads.
   *
   * So proof travels and suspicion stays home. The cost is one store read the **first
   * time each instance sees an actor** — not one per request — and it is never awaited:
   * the request that triggered it is judged with whatever arrived before the detectors
   * finished, and every request after it has the number. A store outage means the count
   * falls back to what this process saw itself, which is where it was before.
   *
   * Needs a shared `store`. With the default in-memory one there is nothing to share
   * with, and setting this does nothing at all.
   */
  shareConfirmations?: boolean;
  notifications?: NotificationOptions;
  handlers?: readonly CustomHandler[];

  /** Replaces the built-in signature database. */
  signatures?: readonly BotSignature[];
  /** Appended to the built-in database. */
  extraSignatures?: readonly BotSignature[];

  /** Budget for each `io` detector, ms. Default 300. Exceeding it drops that detector, not the request. */
  detectorTimeoutMs?: number;
  /** How long an idle actor is remembered, ms. Default 900000. */
  actorWindowMs?: number;
  /**
   * Maximum actors tracked concurrently. Default 20000.
   *
   * This is a memory budget: see the cap arithmetic in `state.ts`. Past the limit the
   * least recently seen actor is evicted, never one still sending traffic.
   */
  maxActors?: number;

  /**
   * Put verdict headers on the *response*. Default false.
   *
   * Leave it off in production. An `X-Bot-Score` in the response is a live feedback
   * signal for anyone tuning a scraper against you — they change one header, watch
   * the number fall, and iterate. Request-side tagging gives your application the
   * same information and tells the client nothing.
   */
  exposeVerdictHeaders?: boolean;

  /**
   * Collect counters. Default true — see {@link BotHandler.metrics}. Switching it off
   * saves a few integer increments per request and costs you the ability to see what
   * your policy is doing.
   */
  metrics?: boolean | MetricsOptions;

  /**
   * Watches the *shape* of your traffic and raises {@link BotHandlerConfig.onAnomaly}
   * when it changes. `false` switches it off; the default is on with the shipped
   * checks. See {@link AuditOptions}.
   */
  audit?: AuditOptions | false;

  resolver?: DnsResolver;
  clock?: Clock;

  // --- Hooks -----------------------------------------------------------------
  //
  // Every one of these mirrors an event on {@link BotHandler.on}: the config form is
  // the convenient one, the emitter form is the one you can subscribe to later, or
  // more than once, or unsubscribe from. They are the same mechanism, so a handler
  // registered either way is isolated the same way — one that throws is reported
  // through `onError` and never reaches the request.
  //
  // None of them is awaited. Returning a promise is fine and its rejection is
  // reported, but the response does not wait for your webhook.

  /** Every assessment, including the ones that concluded nothing. The firehose. */
  onAssessment?: (assessment: Assessment) => void;
  /** Every decision, paired with the assessment behind it. */
  onDecision?: (event: { assessment: Assessment; decision: Decision }) => void;
  /** A request that was actually denied: `block`, `drop` or `redirect`. */
  onDenial?: (event: { assessment: Assessment; decision: Decision }) => void;
  /**
   * The safety guard replaced a terminal action with something recoverable.
   *
   * The most useful hook here, and the one worth paging on a rise in: it means your
   * rules are asking to deny requests the evidence does not prove.
   */
  onDowngrade?: (event: { assessment: Assessment; decision: Decision }) => void;
  /** A challenge was issued, solved or rejected. */
  onChallenge?: (event: { phase: "issued" | "solved" | "rejected"; actorKey?: string | undefined }) => void;
  /**
   * A detector threw or timed out. Operational: usually a resolver or a store, and a
   * rising rate means detection is degraded rather than that traffic changed.
   */
  onDetectorFailure?: (event: { detector: string; reason: string; message: string; requestId: string }) => void;
  /** The rule set was replaced at runtime. Your audit trail for {@link BotHandler.updatePolicy}. */
  onPolicyChange?: (event: { rules: readonly string[]; warnings: readonly string[]; by?: string | undefined }) => void;
  /**
   * The guard settings changed at runtime — `falsePositivePolicy`, `fallbackAction`,
   * `defaultAction`, `terminalScoreThreshold` or `suspectThreshold`.
   *
   * Worth its own hook rather than folding into `onPolicyChange`: this is the change
   * that decides whether an unproven verdict can deny anybody, and it is the one an
   * audit trail wants named. Both the before and the after travel with it.
   */
  onGuardChange?: (event: {
    before: import("./policy/policy.js").GuardSettings & { suspectThreshold: number };
    after: import("./policy/policy.js").GuardSettings & { suspectThreshold: number };
    by?: string | undefined;
  }) => void;
  /**
   * A range set was replaced at runtime.
   *
   * The allowlist is the one worth watching: an address on it is not judged leniently,
   * it is not judged at all, so a change to it changes what your bot handling can see.
   */
  onRangeChange?: (event: { name: string; size: number; entries: readonly string[]; by?: string | undefined }) => void;
  /** An actor's behavioural memory was forgotten, or the actor was cleared as human. */
  onActorChange?: (event: { key: string; action: "forget" | "clear"; until?: number | undefined; by?: string | undefined }) => void;
  /** The audit noticed the traffic change shape. See {@link AuditOptions}. */
  onAnomaly?: (anomaly: TrafficAnomaly) => void;

  /** Called when a detector, sink or store fails. Wire it to your logs. */
  onError?: (error: unknown, context: { source: string }) => void;
  /** Called on a misconfiguration noticed at runtime. Wire it to your logs. */
  onWarning?: (message: string) => void;
}

export interface ResolvedConfig {
  detectors: Detector[];
  /**
   * {@link BotHandlerConfig.shadowDetectors}, as given. Not yet checked against the
   * installed set — see the note at the assignment for why that has to wait.
   */
  shadowDetectors: ReadonlySet<string>;
  rules: Rule[];
  ranges: Map<string, IpRangeSet>;
  signatures: readonly BotSignature[];
  proxy: Required<Omit<ProxyConfig, "trustedProxies">> & { trustedProxies: IpRangeSet | undefined };
  actorKey: (facts: RequestFacts) => string;
  ignorePaths: readonly (string | RegExp)[];
  /** Compiled once. `undefined` when none are configured, which is nearly every deployment. */
  serviceTokens: ServiceTokens | undefined;
  suspectThreshold: number;
  strictEvidence: boolean;
  detectorTimeoutMs: number;
  actorWindowMs: number;
  maxActors: number;
  exposeVerdictHeaders: boolean;
  clock: Clock;
  onError: (error: unknown, context: { source: string }) => void;
  onWarning: (message: string) => void;
  /** Problems found while resolving. Fatal ones throw; these are advisory. */
  warnings: string[];
}

/**
 * Checks a rule list for the mistakes that are silent at runtime.
 *
 * Shared with {@link BotHandler.updatePolicy}, because rules can now be replaced while
 * the process runs and a list swapped in from a dashboard deserves the same reading
 * as one written in a config file. Structural problems throw; problems that merely
 * make a rule useless are returned as warnings, since a policy that refuses to load
 * over a dead rule is worse than one that says so.
 */
export function validateRules(rules: readonly Rule[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
      throw new ConfigError("Every rule needs a non-empty id: it is what every decision, log line and metric names.");
    }
    if (typeof rule.action !== "string" || !VALID_ACTIONS.has(rule.action)) {
      throw new ConfigError(`Rule "${rule.id}" has action "${String(rule.action)}", which is not one of: ${ACTION_NAMES.join(", ")}.`);
    }
    if (rule.match === undefined || rule.match === null || (typeof rule.match !== "function" && typeof rule.match !== "object")) {
      throw new ConfigError(`Rule "${rule.id}" has no match. Use a spec object, or a predicate function for anything a spec cannot express.`);
    }
    if (rule.action === "custom" && rule.params?.handler === undefined) {
      throw new ConfigError(`Rule "${rule.id}" asks for the custom action but names no handler in params.handler.`);
    }
    if (seen.has(rule.id)) warnings.push(`Two rules share the id "${rule.id}"; only the first can ever match, and decisions naming it will be ambiguous in your logs.`);
    seen.add(rule.id);
  }

  return warnings;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>(ACTION_NAMES);

/** The actions that end a request. A crawler refused by one of these is simply gone. */
const TERMINAL_ACTIONS: ReadonlySet<string> = new Set(["block", "tarpit", "challenge"]);

/**
 * Rules naming an identity no signature has.
 *
 * `match: { identity }` takes a signature's `id` — `"facebook-external"` — and what is on
 * the dashboard, in a log line and in this library's own documentation is its `name`:
 * "Facebook external hit". Somebody reading a verdict off the screen and writing the rule
 * it suggests therefore writes the display name, and gets a rule that matches nothing,
 * ever, in silence. It sits in the policy looking like protection.
 *
 * Guessed against the names as well as the ids, so the message can say which id was meant
 * rather than only that the rule is dead. An identity this does not recognise is reported
 * too, but softly: `actorKey`, `isHuman` and a custom signature set can all put identities
 * in play that this function cannot see, so it says what it checked against.
 */
function unknownIdentities(rules: readonly Rule[], signatures: readonly BotSignature[]): string[] {
  const ids = new Set(signatures.map((signature) => signature.id));
  const byName = new Map(signatures.map((signature) => [signature.name.toLowerCase(), signature.id]));
  const warnings: string[] = [];
  const said = new Set<string>();

  for (const rule of rules) {
    if (typeof rule.match !== "object") continue;
    const named = (rule.match as MatchSpec).identity;
    if (named === undefined) continue;
    for (const identity of Array.isArray(named) ? named : [named]) {
      if (typeof identity !== "string" || ids.has(identity) || said.has(identity)) continue;
      said.add(identity);
      const meant = byName.get(identity.toLowerCase());
      warnings.push(
        meant === undefined
          ? `Rule "${rule.id}" matches identity "${identity}", which is not the id of any signature this handler knows. It will never match. Identities are ids such as "googlebot", not display names.`
          : `Rule "${rule.id}" matches identity "${identity}", which is a signature's display name rather than its id, so it will never match. Use "${meant}".`,
      );
    }
  }
  return warnings;
}

/**
 * Crawlers a policy will refuse for being unverifiable, which the deployment could have
 * verified and has not.
 *
 * A handful of operators — DuckDuckGo and Facebook among the indexers, most of the AI
 * crawlers — publish IP ranges instead of usable reverse DNS. This library will not fetch
 * those ranges for you, because a detector that makes an outbound request on a schedule
 * is a dependency you should take on knowingly. The consequence is that without
 * `crawlerRanges` they can never reach `verified-bot`, and a policy that refuses
 * unverified crawlers of their category therefore refuses them — for a missing config
 * entry rather than for anything they did.
 *
 * That failure is invisible from the inside. The rule fires, names a real reason, and the
 * logs read exactly as they would if DuckDuckBot had been an impostor. So it is said once,
 * at construction, while somebody is still looking: these specific crawlers, that specific
 * rule, and the one line of configuration that changes the answer.
 */
function unreachableVerification(rules: readonly Rule[], signatures: readonly BotSignature[], ranges: ReadonlyMap<string, IpRangeSet>): string[] {
  const refused = new Map<BotCategory, string>();
  for (const rule of rules) {
    // A predicate can refuse anything and says nothing about what; only a spec is readable.
    if (typeof rule.match !== "object" || !TERMINAL_ACTIONS.has(rule.action)) continue;
    const spec = rule.match as MatchSpec;
    if (spec.category === undefined) continue;
    // The rules this is about refuse a *claim* — a bot proven to be what it says while
    // unable to prove whose it is. One that refuses `verified-bot` is refusing crawlers it
    // did confirm, which is a policy choice and not a gap in configuration.
    const verdicts = spec.verdict === undefined ? [] : Array.isArray(spec.verdict) ? spec.verdict : [spec.verdict];
    if (!verdicts.includes("confirmed-bot")) continue;
    for (const category of Array.isArray(spec.category) ? spec.category : [spec.category]) {
      if (!refused.has(category as BotCategory)) refused.set(category as BotCategory, rule.id);
    }
  }
  if (refused.size === 0) return [];

  const stranded = new Map<string, string[]>();
  for (const signature of signatures) {
    if (signature.verification?.kind !== "ip-ranges") continue;
    const rule = refused.get(signature.category);
    if (rule === undefined || ranges.has(`crawler:${signature.id}`)) continue;
    stranded.set(rule, [...(stranded.get(rule) ?? []), signature.name]);
  }

  const warnings = [...stranded].map(
    ([rule, names]) =>
      `${names.join(", ")} ${names.length === 1 ? "publishes" : "publish"} IP ranges rather than reverse DNS, so ${names.length === 1 ? "it" : "they"} can never be verified without a \`crawlerRanges\` entry — and rule "${rule}" refuses unverified crawlers of ${names.length === 1 ? "that" : "their"} kind. Supply the ranges, or change that rule, or ${names.length === 1 ? "it stays" : "they stay"} refused for a missing config entry.`,
  );

  // And the larger half, which is about the crawlers that *can* be confirmed.
  //
  // A rule like this refuses anything it could not verify, and with no ranges loaded the
  // only way to verify anything is a reverse-DNS lookup on the request path, inside a
  // timeout. A resolver having a bad afternoon therefore produces no evidence — correctly,
  // because a slow lookup must never read as an accusation — and "no evidence" is exactly
  // what this rule refuses on. The result is a real Googlebot getting 403 on one route and
  // 200 on the next, seconds apart, which an integration reported from production.
  //
  // Published ranges are the fix because they are answered from memory: they turn
  // verification from a per-request network call into a lookup, and the DNS path becomes
  // the fallback rather than the whole basis.
  if (!hasCrawlerRanges(ranges)) {
    const [category, rule] = [...refused][0] as [BotCategory, string];
    warnings.push(
      `Rule "${rule}" refuses a ${category} crawler it could not verify, and no crawler ranges are loaded — so verification rests entirely on a reverse-DNS lookup inside a timeout. A slow resolver yields no evidence, which this rule reads as unverified, so a genuine crawler is refused intermittently and for no reason visible in the logs. Load published ranges with startCrawlerRangeRefresh(), or set \`crawlerRanges\`.`,
    );
  }
  return warnings;
}

/** Whether any published crawler range is loaded at all. */
function hasCrawlerRanges(ranges: ReadonlyMap<string, IpRangeSet>): boolean {
  for (const name of ranges.keys()) if (name.startsWith("crawler:")) return true;
  return false;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Validates and normalises configuration.
 *
 * Invalid input throws here, at construction, rather than degrading quietly at
 * request time. A mistyped CIDR that silently matches nothing is a security control
 * that looks configured and is not — the worst possible state to be in, because
 * everything appears to be working.
 */
export function resolveConfig(config: BotHandlerConfig = {}): ResolvedConfig {
  const warnings: string[] = [];

  const behindProxy = config.proxy?.trustProxy === true;
  const detectors = config.detectors
    ? [...config.detectors]
    : [
        ...defaultDetectors({
          ...(config.crawlerVerification === undefined ? {} : { crawlerVerification: config.crawlerVerification }),
          ...(behindProxy ? { behindProxy: true } : {}),
        }),
        ...(config.extraDetectors ?? []),
      ];
  const seen = new Set<string>();
  for (const detector of detectors) {
    if (seen.has(detector.id)) {
      throw new ConfigError(`Two detectors share the id "${detector.id}". Ids appear in evidence and in rules, so they must be unique.`);
    }
    seen.add(detector.id);
  }

  // Carried through unchecked on purpose. Several detectors are installed by the handler
  // rather than here — the marker, site and challenge ones arrive with the source they
  // read — so a name is only knowably wrong once the full set exists, and those are
  // precisely the detectors somebody has reason to shadow. `BotHandler` does the check.
  const shadowDetectors = new Set<string>(config.shadowDetectors ?? []);

  const rules: Rule[] = [...(config.rules ?? [])];
  if (config.preset !== undefined) {
    const preset = PRESETS[config.preset];
    if (!preset) throw new ConfigError(`Unknown preset "${config.preset}". Available: ${Object.keys(PRESETS).join(", ")}.`);
    rules.push(...preset());
  }
  warnings.push(...validateRules(rules));

  const ranges = new Map<string, IpRangeSet>();
  addRange(ranges, "allowlist", config.allowlist);
  addRange(ranges, "denylist", config.denylist);
  addRange(ranges, "datacenter", config.datacenterRanges);
  for (const [id, entries] of Object.entries(config.crawlerRanges ?? {})) {
    addRange(ranges, `crawler:${id}`, entries);
  }

  const signatures = config.signatures ?? [...BOT_SIGNATURES, ...(config.extraSignatures ?? [])];
  warnings.push(...unreachableVerification(rules, signatures, ranges));
  warnings.push(...unknownIdentities(rules, signatures));

  const serviceTokens = config.serviceTokens === undefined ? undefined : new ServiceTokens(config.serviceTokens);
  if (serviceTokens !== undefined) {
    // An empty set is almost always an environment variable that did not arrive. Silence
    // here means the monitor's rule never matches and the monitor starts reporting the
    // site down — with the configuration on screen looking exactly right.
    if (serviceTokens.size === 0) {
      warnings.push("serviceTokens is configured but no token has a value, so no rule matching one can ever fire. An unset environment variable is the usual cause.");
    }
    if (serviceTokens.weak.length > 0) {
      warnings.push(
        `Service token(s) ${serviceTokens.weak.map((name) => `"${name}"`).join(", ")} are shorter than ${MIN_TOKEN_LENGTH} characters. This is a bearer secret that never expires and is replayable by anyone who sees it once; give it the length of one.`,
      );
    }
    // A rule naming a token that does not exist never matches, in silence — the same
    // failure as an identity typo, and worth the same warning.
    const known = new Set(serviceTokens.names);
    for (const rule of rules) {
      if (typeof rule.match !== "object") continue;
      const named = (rule.match as MatchSpec).serviceToken;
      if (named === undefined || named === true) continue;
      for (const name of Array.isArray(named) ? named : [named]) {
        if (typeof name === "string" && !known.has(name)) {
          warnings.push(`Rule "${rule.id}" matches service token "${name}", which is not one of the configured tokens (${[...known].join(", ") || "none"}). It will never match.`);
        }
      }
    }
  } else {
    for (const rule of rules) {
      if (typeof rule.match === "object" && (rule.match as MatchSpec).serviceToken !== undefined) {
        warnings.push(`Rule "${rule.id}" matches a service token, but no \`serviceTokens\` are configured, so it can never match.`);
      }
    }
  }

  const proxyConfig = config.proxy ?? {};
  const trustedProxies = proxyConfig.trustedProxies ? new IpRangeSet(proxyConfig.trustedProxies) : undefined;
  if (trustedProxies && trustedProxies.invalid.length > 0) {
    throw new ConfigError(`proxy.trustedProxies contains entries that are not valid addresses or CIDRs: ${trustedProxies.invalid.join(", ")}`);
  }
  if (proxyConfig.trustProxy === true && trustedProxies === undefined && proxyConfig.hops === undefined) {
    warnings.push(
      "proxy.trustProxy is on with neither `trustedProxies` nor `hops` set, so exactly one proxy hop is assumed. If the real number differs, clients can choose the address this library rate-limits, allowlists and blocks on. Prefer `trustedProxies`.",
    );
  }
  if (proxyConfig.trustProxy !== true && (trustedProxies !== undefined || proxyConfig.hops !== undefined)) {
    warnings.push("proxy.trustedProxies / proxy.hops are configured but proxy.trustProxy is not enabled, so the forwarded header is ignored and the socket address is used.");
  }

  // The marker probe and the site baseline are the two things an operator switches on
  // that change what the library *does* rather than only what it reads, so the ways they
  // can be quietly wrong are worth naming at construction rather than discovering from a
  // detector that fires on everybody.
  if (config.probe !== undefined) {
    if (config.probe.cookieName !== undefined && config.probe.cookieName === config.challenge?.cookieName) {
      throw new ConfigError(
        `probe.cookieName and challenge.cookieName are both "${config.probe.cookieName}". One would overwrite the other on every response, so clearance and the marker would each destroy the other.`,
      );
    }
    if (config.probe.secure === false) {
      warnings.push(
        "probe.secure is false, so the marker cookie will travel over plain HTTP and can be read by anything on the path. It is meant for local development; leave it unset in production.",
      );
    }
    // A marker that is never stored comes back never, and `marker-persistence` reads
    // exactly that — so this misconfiguration would report every visitor who keeps
    // cookies as a client that refuses to keep ours.
    if (config.probe.domain !== undefined && config.probe.domain.startsWith(".") === false && config.probe.domain.includes(".") === false) {
      warnings.push(`probe.domain is "${config.probe.domain}", which is not a domain a browser will accept, so the marker will never be stored or returned.`);
    }
    if (config.probe.ttlMs !== undefined && config.probe.ttlMs < 60_000) {
      warnings.push(
        `probe.ttlMs is ${config.probe.ttlMs}ms. A marker that expires within a minute is re-issued on almost every request, which makes responses uncacheable and leaves nothing long enough to correlate.`,
      );
    }
  }

  if (config.site !== undefined && config.site.warmupRequests !== undefined && config.site.warmupRequests < 500) {
    warnings.push(
      `site.warmupRequests is ${config.site.warmupRequests}. A baseline drawn from so little traffic is not one — every path is rare when nothing has been seen — so the site detectors will report ordinary visitors until real traffic arrives.`,
    );
  }

  // `identity-rotation` reads "one actor, several User-Agents" as one client lying — and
  // under the default actor key one actor is one address, so a corporate office, a
  // university or a carrier's CGNAT pool is a hundred people's browsers wearing one. The
  // detector says so in its own documentation and is off by default because of it; this
  // catches the case where somebody switched it on without moving the actor key, which is
  // a decision they cannot see the consequences of until real visitors are being
  // challenged. Both facts are known here, so the warning costs nothing.
  if (config.actorKey === undefined && detectors.some((detector) => detector.id === "identity-rotation")) {
    warnings.push(
      "identity-rotation is enabled while `actorKey` is left as the client address, so one actor means one address. A NAT gateway — an office, a campus, a mobile carrier — presents many people's browsers under a single address, which is this detector's exact signature and is entirely innocent. Give `actorKey` something narrower than an address (a session cookie, an authenticated user id, or an address combined with a TLS fingerprint), or take the detector out.",
    );
  }

  const strictEvidence = config.strictEvidence ?? process.env["NODE_ENV"] !== "production";
  const falsePositivePolicy = config.falsePositivePolicy ?? "strict";
  if (falsePositivePolicy === "aggressive") {
    warnings.push(
      "falsePositivePolicy is 'aggressive': rules run exactly as written, and probabilistic evidence alone can deny a request. Real visitors will be turned away. Make sure you are notified when it happens and that the refusal tells people how to reach you.",
    );
  }

  const actorKey = config.actorKey ?? ((facts: RequestFacts): string => facts.ip);

  const hops = proxyConfig.hops;
  if (hops !== undefined && (!Number.isInteger(hops) || hops < 1)) {
    throw new ConfigError(`proxy.hops must be a positive whole number of proxies; received ${String(hops)}. A fractional or negative count indexes nothing in the forwarded chain, so the header would be silently ignored and every client would appear to come from your proxy.`);
  }

  return {
    detectors,
    shadowDetectors,
    rules,
    ranges,
    signatures,
    proxy: {
      trustProxy: proxyConfig.trustProxy ?? false,
      hops: hops ?? 1,
      header: (proxyConfig.header ?? "x-forwarded-for").toLowerCase(),
      trustedProxies,
    },
    actorKey,
    ignorePaths: (config.ignorePaths ?? []).map(statelessPattern),
    serviceTokens,
    suspectThreshold: clamp(config.suspectThreshold ?? 60, 1, 100),
    strictEvidence,
    detectorTimeoutMs: Math.max(1, config.detectorTimeoutMs ?? 300),
    actorWindowMs: Math.max(1000, config.actorWindowMs ?? 900_000),
    maxActors: Math.max(16, config.maxActors ?? 20_000),
    exposeVerdictHeaders: config.exposeVerdictHeaders ?? false,
    clock: config.clock ?? systemClock,
    onError: config.onError ?? (() => {}),
    onWarning: config.onWarning ?? (() => {}),
    warnings,
  };
}

function addRange(target: Map<string, IpRangeSet>, name: string, entries: readonly string[] | undefined): void {
  if (!entries || entries.length === 0) return;
  const set = new IpRangeSet(entries);
  if (set.invalid.length > 0) {
    throw new ConfigError(`${name} contains entries that are not valid addresses or CIDRs: ${set.invalid.join(", ")}. A range that silently matches nothing is a control that looks configured and is not.`);
  }
  target.set(name, set);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Recovers the client address from the socket address and the request headers.
 *
 * Exported because getting this right matters more than almost anything else here,
 * and you may want to call it directly or test it in isolation.
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  headers: Record<string, string | undefined>,
  proxy: ResolvedConfig["proxy"],
): string {
  const direct = socketAddress !== undefined ? (normalizeIp(stripPort(socketAddress)) ?? socketAddress) : "";
  if (!proxy.trustProxy) return direct;

  const header = headers[proxy.header];
  if (header === undefined) return direct;

  // Bounded: the chain is client-supplied and would otherwise be an unbounded split.
  const chain = header
    .slice(0, 2048)
    .split(",")
    // The port is removed before parsing: an entry that carries one is written by a
    // real proxy rather than by an attacker, and dropping it empties the chain.
    .map((entry) => stripPort(entry))
    .filter((entry) => entry.length > 0 && parseIp(entry) !== null)
    .map((entry) => normalizeIp(entry) as string);

  if (chain.length === 0) return direct;

  if (proxy.trustedProxies) {
    // The peer we are actually talking to is the first hop, and it is checked like
    // any other. This is the load-bearing line: without it, a request that reached
    // this server *without* passing through the configured proxies — a leaked origin
    // address, a pod reachable inside the cluster, anything that bypasses the load
    // balancer — is believed when it claims to come from somewhere else, and the
    // caller picks their own actor key, rate-limit bucket and IP reputation. The
    // header may only be read on behalf of a peer we put there ourselves.
    if (direct !== "" && !proxy.trustedProxies.contains(direct)) return direct;

    // Walk right to left past our own infrastructure. The first address that is not
    // ours is the closest one we did not put there — the furthest we can trust.
    for (let i = chain.length - 1; i >= 0; i--) {
      const candidate = chain[i]!;
      if (!proxy.trustedProxies.contains(candidate)) return candidate;
    }
    // Everything in the chain is our own proxies; the socket address is the truth.
    return direct;
  }

  // A chain shorter than the number of proxies we expect means the request did not
  // traverse the topology this server was configured for. Falling back to the
  // leftmost entry — as an earlier version of this function did — hands the choice of
  // address to whoever sent the header, which is precisely the attack `hops` exists
  // to prevent. The socket address is the only value that is always truthful, so a
  // surprising chain degrades to it rather than to attacker input.
  const index = chain.length - proxy.hops;
  if (index < 0) return direct;
  return chain[index] ?? direct;
}
