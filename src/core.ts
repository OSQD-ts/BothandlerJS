import { ActorRegistry, ActorState } from "./state.js";
import { ChallengeService } from "./challenge/index.js";
import { Emitter } from "./internal/emitter.js";
import { MemoryStore } from "./stores/memory.js";
import { Metrics, toPrometheus } from "./metrics.js";
import { TrafficAudit } from "./audit.js";
import { NotificationHub } from "./notify/hub.js";
import { Policy } from "./policy/policy.js";
import type { GuardSettings } from "./policy/policy.js";
import { cachingResolver, nodeDnsResolver } from "./internal/dns.js";
import { clearanceDetector } from "./detectors/clearance.js";
import { challengeReactionDetector } from "./detectors/challenge-reaction.js";
import { challengeIntegrityDetector } from "./detectors/challenge-integrity.js";
import { distributedWalkDetector, missBaselineDetector, pathCampaignDetector, pathNoveltyDetector } from "./detectors/site-baseline.js";
import { identityDriftDetector, markerIntegrityDetector, markerPersistenceDetector, markerFanoutDetector } from "./detectors/marker.js";
import { combineEvidence, sortEvidence } from "./evidence.js";
import { compileSignatures } from "./detectors/known-bots.js";
import { TERMINAL_ACTIONS } from "./policy/types.js";
import { executeAction } from "./actions/index.js";
import { parseUserAgent } from "./internal/ua.js";
import { pathMatches } from "./internal/pattern.js";
import { randomId } from "./internal/crypto.js";
import { safeSummary } from "./internal/text.js";
import { MarkerProbe, identityShape } from "./probe/index.js";
import { SiteProfile } from "./site/index.js";
import { walkStepOf } from "./state.js";
import { ConfigError, resolveClientIp, resolveConfig, validateRules } from "./config.js";
import { withTimeout } from "./internal/async.js";
import type { ActionOutcome, CustomHandler } from "./actions/types.js";
import type { Rule } from "./policy/types.js";
import type { Assessment, DetectorFailure, Evidence, RequestFacts } from "./types.js";
import type { BotHandlerConfig, ResolvedConfig } from "./config.js";
import type { AuditOptions, TrafficAnomaly } from "./audit.js";
import type { DashboardOptions, DashboardServer } from "./dashboard/types.js";
import type { MetricsSnapshot, PrometheusOptions } from "./metrics.js";
import type { BotHandlerStore } from "./stores/types.js";
import type { BotSignature } from "./detectors/known-bots.js";
import type { DetectionContext, Detector, DetectorResult } from "./detectors/types.js";
import type { Decision } from "./policy/types.js";
import type { DnsResolver } from "./internal/dns.js";
import type { MultiPatternMatcher } from "./internal/matcher.js";
import type { SolutionOutcome } from "./challenge/index.js";
import { IpRangeSet } from "./internal/ip.js";

/** Sentinel for a detector that ran out of time. A module-level symbol, so the hot path allocates none. */
const TIMED_OUT: unique symbol = Symbol("bothandler.timeout");

export interface HandleResult {
  assessment: Assessment;
  decision: Decision;
  outcome: ActionOutcome;
}

/**
 * Everything the engine will tell you about, and the whole integration surface.
 *
 * Each of these has a matching `onX` in the config — the same mechanism, registered
 * for you at construction. Subscribe here when you want to add a listener later,
 * add several, or remove one; use the config form when you just want a callback.
 *
 * They are deliberately *derived* rather than raw: `denial` and `downgrade` exist
 * because "a request was refused" and "the guard refused a rule" are the two things
 * an operator wants an alert on, and making every subscriber re-derive them from
 * `decision` is how two integrations end up disagreeing about what a denial is.
 */
export interface BotHandlerEvents extends Record<string, unknown> {
  /** Every assessment, including the ones that concluded nothing. */
  assessment: Assessment;
  /** Every decision, with the assessment behind it. */
  decision: { assessment: Assessment; decision: Decision };
  /** A request that was actually denied: `block`, `drop` or `redirect`. */
  denial: { assessment: Assessment; decision: Decision };
  /** The guard replaced a terminal action with something recoverable. */
  downgrade: { assessment: Assessment; decision: Decision };
  /** A challenge was issued, solved or rejected. */
  /**
   * A challenge was issued, solved or turned down.
   *
   * `level`, `score` and `reason` are present only when the interaction challenge is on,
   * and they are the whole basis for tuning it: without the score distribution an
   * operator moving `interactionAt` is guessing, and without the reason a rise in
   * rejections says nothing about whether the cause is bots or a browser that cannot
   * run a probe.
   */
  challenge: {
    phase: "issued" | "solved" | "rejected";
    actorKey?: string | undefined;
    /** Clearance granted, on a solve. */
    level?: "pow" | "interaction" | "operator" | undefined;
    /** Interaction score, 0â€“1, when one was computed. */
    score?: number | undefined;
    /** Why it was turned down. */
    reason?: string | undefined;
  };
  /**
   * A detector threw or timed out.
   *
   * `requestId` is empty when the failure was noticed before the assessment was
   * assembled — the failure list on the assessment is the per-request record; this
   * event is the operational one, for the alert that says a resolver is down.
   */
  "detector-failure": { detector: string; reason: string; message: string; requestId: string };
  /** The rule set was replaced at runtime. */
  "policy-change": { rules: readonly string[]; warnings: readonly string[]; by?: string | undefined };
  /**
   * The guard settings were changed at runtime.
   *
   * Separate from `policy-change` on purpose. "Which rules exist" and "how far a rule
   * is allowed to go" are different powers with different consequences, and an
   * operator wiring an alert almost always wants the second one and not the first.
   * `before` and `after` both travel so the alert can say what actually moved.
   */
  "guard-change": { before: GuardSettings & { suspectThreshold: number }; after: GuardSettings & { suspectThreshold: number }; by?: string | undefined };
  /**
   * A range set was replaced at runtime — an allowlist entry added, a crawler's
   * published ranges refreshed.
   *
   * Worth an event of its own because the allowlist is the one list that stops
   * detection *running*: an address on it is not judged leniently, it is not judged at
   * all. A change to it is a change to what your bot handling can see.
   */
  "range-change": { name: string; size: number; entries: readonly string[]; by?: string | undefined };
  /**
   * An actor's behavioural memory was changed by hand — forgotten, or granted human
   * clearance.
   *
   * The remedy for a false positive that has stuck to somebody, and therefore exactly
   * the operation an audit trail wants to have seen.
   */
  "actor-change": { key: string; action: "forget" | "clear"; until?: number | undefined; by?: string | undefined };
  /** The audit noticed the traffic change shape. */
  anomaly: TrafficAnomaly;
  warning: string;
  error: { error: unknown; source: string };
}

/**
 * Who asked for a runtime change.
 *
 * Every mutating method takes one, and every one of them puts it in the warning and in
 * the event. The library has no idea who anybody is — it has no user model and does not
 * want one — so this is a string the caller supplies, and the caller is the thing that
 * *does* know: an authenticating dashboard, a deploy pipeline, an admin CLI. An absent
 * `by` is not a failure; it means whatever made the change could not say who.
 */
export interface ChangeContext {
  by?: string | undefined;
}

/** Options for a single assessment. */
export interface AssessOptions {
  /**
   * Whether this request is part of your traffic. Default true.
   *
   * `record: false` is a **dry run**: the detectors all run and the verdict is real,
   * but nothing is written down. No actor state moves, no counter increments, no
   * `assessment` event fires and no notification is sent — so asking "what would this
   * request be judged as?" does not become a row in the answer to "what is my traffic
   * doing?".
   *
   * It is what the dashboard's request tester uses, and what to reach for anywhere else
   * you want the engine's opinion about a request that is not happening: a support
   * ticket, a test, a rule you are drafting. The one thing a dry run cannot see is
   * history — it gets an actor with no past, because the alternative is to record the
   * request against a real one, which is the thing it promised not to do.
   */
  record?: boolean;
}

/** Description of a registered detector, for documentation and diagnostics. */
export interface DetectorDescription {
  id: string;
  description: string;
  cost: "cheap" | "io";
  stage: "always" | "confirming";
  /** Running, and deciding nothing. See {@link BotHandlerConfig.shadowDetectors}. */
  shadow?: true | undefined;
}

/**
 * The engine.
 *
 * Three separable steps, in a fixed order, each usable on its own:
 *
 * 1. {@link assess} — gather evidence and reach a verdict. Reads the request, touches
 *    no response, and is safe to call anywhere, including from a log processor
 *    replaying yesterday's traffic.
 * 2. {@link decide} — apply the policy, subject to the safety guard.
 * 3. {@link handle} — do both, then turn the decision into an outcome an adapter can
 *    apply.
 *
 * Keeping them apart is what makes the library testable and what makes a
 * monitor-only deployment a first-class mode rather than a configuration trick: call
 * `assess` alone and you have a detector with no opinions about your traffic at all.
 *
 * Everything is failure-isolated. A detector that throws, a store that will not
 * answer, a notification sink that hangs — each degrades exactly itself and is
 * reported through `onError`. Nothing in this file can turn a bad day for a
 * dependency into a bad day for the site it is protecting.
 */
/**
 * Quotes the client rather than obeying it. A summary — and the written basis behind a
 * `certain` verdict — often contains text the client chose, and both are printed. The
 * item is rebuilt only when something actually needed fixing, because a detector may
 * return a frozen constant and because the clean path is every ordinary request.
 */
function sanitize(item: Evidence): Evidence {
  const summary = safeSummary(item.summary);
  const basis = item.deterministicBasis === undefined ? undefined : safeSummary(item.deterministicBasis);
  if (summary === item.summary && basis === item.deterministicBasis) return item;
  return { ...item, summary, ...(basis === undefined ? {} : { deterministicBasis: basis }) };
}

export class BotHandler {
  readonly config: ResolvedConfig;
  readonly registry: ActorRegistry;
  readonly store: BotHandlerStore;
  readonly policy: Policy;
  readonly challenge: ChallengeService | undefined;
  /** The marker-cookie probe, when the operator asked for one. See `probe` in the config. */
  readonly probe: MarkerProbe | undefined;
  /** The site-wide baseline, when the operator asked for one. See `site` in the config. */
  readonly site: SiteProfile | undefined;
  readonly notifications: NotificationHub;
  /**
   * The traffic audit, or `undefined` when it was switched off with `audit: false`.
   *
   * Exposed so you can ask it questions on your own schedule — `summary()` for the
   * two windows as they stand, `evaluate()` to run the checks now — which is what a
   * health endpoint or a cron job wants rather than waiting for the timer.
   */
  readonly audit: TrafficAudit | undefined;

  private readonly signatures: MultiPatternMatcher<BotSignature>;
  private readonly resolver: DnsResolver;
  private readonly handlers: Map<string, CustomHandler>;
  private readonly cheapDetectors: Detector[] = [];
  private readonly ioDetectors: Detector[] = [];
  private readonly confirmingDetectors: Detector[] = [];
  /** Hoisted from the resolved config: read once per detector per request. */
  private readonly shadowIds: ReadonlySet<string>;
  private readonly events: Emitter<BotHandlerEvents>;
  private readonly ignoreExact: Set<string>;
  private readonly ignorePatterns: readonly (string | RegExp)[];
  private readonly isHuman: ((facts: RequestFacts) => boolean) | undefined;
  private readonly meter: Metrics | undefined;
  /** Hoisted out of the metrics object: read once per detector per request. */
  private readonly timing: boolean;

  constructor(options: BotHandlerConfig = {}) {
    this.config = resolveConfig(options);
    this.events = new Emitter<BotHandlerEvents>((error, event) => this.config.onError(error, { source: `event:${event}` }));

    for (const warning of this.config.warnings) this.warn(warning);

    this.store = options.store ?? new MemoryStore({ clock: this.config.clock });
    this.registry = new ActorRegistry(this.config.clock, { windowMs: this.config.actorWindowMs, maxActors: this.config.maxActors });
    this.signatures = compileSignatures(this.config.signatures);
    this.shadowIds = this.config.shadowDetectors;
    this.resolver = cachingResolver(options.resolver ?? nodeDnsResolver(this.config.detectorTimeoutMs));
    this.handlers = new Map((options.handlers ?? []).map((handler) => [handler.id, handler]));
    this.isHuman = options.isHuman;
    // On unless switched off. A handful of integer increments per request is a price
    // worth paying by default: bot detection you cannot observe is bot detection that
    // starts turning people away without anyone noticing.
    this.meter = options.metrics === false ? undefined : new Metrics(typeof options.metrics === "object" ? options.metrics : {});
    this.timing = this.meter?.perDetectorTiming === true;

    this.challenge = options.challenge
      ? new ChallengeService({ ...options.challenge, store: this.store, clock: this.config.clock })
      : undefined;

    // Constructed only when asked for, and refused rather than half-built: a probe
    // without usable secrets would accuse every visitor of forgery after a restart.
    this.probe =
      options.probe !== undefined ? new MarkerProbe({ ...options.probe, clock: this.config.clock }) : undefined;
    this.site = options.site !== undefined ? new SiteProfile({ ...options.site, clock: this.config.clock }) : undefined;

    this.notifications = new NotificationHub({
      ...options.notifications,
      clock: this.config.clock,
      onError: (error, sinkId) => this.fail(error, `notify:${sinkId}`),
    });

    this.policy = new Policy({
      rules: this.config.rules,
      defaultAction: options.defaultAction ?? "allow",
      ...(options.defaultActionParams !== undefined ? { defaultParams: options.defaultActionParams } : {}),
      falsePositivePolicy: options.falsePositivePolicy ?? "strict",
      // Falling back to a challenge only makes sense if one can actually be issued.
      fallbackAction: options.fallbackAction ?? (this.challenge ? "challenge" : "tag"),
      ...(options.terminalScoreThreshold !== undefined ? { terminalScoreThreshold: options.terminalScoreThreshold } : {}),
      onDowngrade: (decision, assessment) => {
        this.notifications.emit({ type: "downgrade", at: new Date(assessment.facts.timestamp).toISOString(), assessment, decision });
      },
    });

    // The clearance detector needs the challenge service, so it is installed here
    // rather than in `defaultDetectors()`.
    const detectors = [...this.config.detectors];
    if (this.challenge && !detectors.some((detector) => detector.id === "clearance")) {
      detectors.unshift(clearanceDetector(this.challenge));
      // Reading a reaction needs something to have been asked, so this one arrives with
      // the challenge service for the same reason the clearance detector does.
      if (!detectors.some((detector) => detector.id === "challenge-reaction")) {
        detectors.unshift(challengeReactionDetector());
      }
      if (!detectors.some((detector) => detector.id === "challenge-integrity")) {
        detectors.unshift(challengeIntegrityDetector());
      }
    }
    // Likewise the marker detectors: without a probe there is no cookie anyone could
    // have been issued, so installing them by default would put three permanently
    // silent entries in `describeDetectors()` for every deployment that does not use
    // one. Each is skipped if the operator already configured it themselves.
    // The site detectors need a baseline to compare against, so like the marker and
    // clearance ones they arrive with the thing they read rather than by default.
    if (this.site !== undefined) {
      for (const detector of [distributedWalkDetector(), pathNoveltyDetector(), missBaselineDetector(), pathCampaignDetector()]) {
        if (!detectors.some((installed) => installed.id === detector.id)) detectors.unshift(detector);
      }
    }
    if (this.probe !== undefined) {
      for (const detector of [identityDriftDetector(), markerIntegrityDetector(), markerPersistenceDetector(), markerFanoutDetector()]) {
        if (!detectors.some((installed) => installed.id === detector.id)) detectors.unshift(detector);
      }
    }
    for (const detector of detectors) {
      if (detector.stage === "confirming") this.confirmingDetectors.push(detector);
      else if (detector.cost === "io") this.ioDetectors.push(detector);
      else this.cheapDetectors.push(detector);
    }

    // Checked here rather than in `resolveConfig`, because the list is only complete now:
    // the marker, site and challenge detectors are added above, alongside the sources
    // they read, and those are the ones with thresholds worth shadowing. Named but not
    // installed is almost always a typo, and a typo here is invisible — nothing was going
    // to run, so nothing looks any different either way.
    for (const id of this.shadowIds) {
      if (!detectors.some((detector) => detector.id === id)) {
        this.warn(
          `shadowDetectors names "${id}", which is not an installed detector, so nothing is being shadowed by that entry. Installed: ${detectors.map((detector) => detector.id).join(", ")}.`,
        );
      }
    }

    // Proof travels between replicas; suspicion does not. See `shareConfirmations`.
    // Registered here rather than beside the store because the registry is built above
    // and a hook on an unassigned field is a very quiet way to do nothing.
    if (options.shareConfirmations === true) {
      this.registry.onFirstSight = (state) => this.loadSharedConfirmations(state);
    }

    this.ignoreExact = new Set(this.config.ignorePaths.filter((entry): entry is string => typeof entry === "string" && !entry.endsWith("/")));
    this.ignorePatterns = this.config.ignorePaths.filter((entry) => typeof entry !== "string" || entry.endsWith("/"));

    // Hooks are registered as ordinary listeners rather than being called directly
    // from the code that emits. One mechanism means one set of failure semantics: a
    // handler that throws is isolated and reported, whichever way it was registered.
    const hooks: Array<[keyof BotHandlerEvents & string, ((payload: never) => void) | undefined]> = [
      ["assessment", options.onAssessment as never],
      ["decision", options.onDecision as never],
      ["denial", options.onDenial as never],
      ["downgrade", options.onDowngrade as never],
      ["challenge", options.onChallenge as never],
      ["detector-failure", options.onDetectorFailure as never],
      ["policy-change", options.onPolicyChange as never],
      ["guard-change", options.onGuardChange as never],
      ["range-change", options.onRangeChange as never],
      ["actor-change", options.onActorChange as never],
      ["anomaly", options.onAnomaly as never],
      // `warning` is deliberately *not* in this list. `warn()` emits the event and
      // calls `config.onWarning` itself, so registering the same function as a listener
      // as well delivered every warning to it twice — which, for the one channel an
      // operator wires to a pager, is the worst place for a duplicate.
      ["error", undefined],
    ];
    for (const [event, handler] of hooks) {
      if (handler !== undefined) this.events.on(event, handler as (payload: BotHandlerEvents[typeof event]) => void);
    }

    this.audit = options.audit === false ? undefined : new TrafficAudit({ clock: this.config.clock, ...(typeof options.audit === "object" ? options.audit : {}) });
    // Only worth a timer when somebody is listening. An audit nobody subscribed to
    // still answers `handler.audit.evaluate()` on demand; it just does not wake up on
    // its own to say something into an empty room.
    if (this.audit !== undefined && (options.onAnomaly !== undefined || this.notifications.enabled)) {
      this.audit.start(auditInterval(options.audit), (anomaly) => this.raiseAnomaly(anomaly));
    }
  }

  /**
   * Runs the audit's checks now and emits whatever they found.
   *
   * The timer does this on a schedule; calling it yourself is for the cases a timer
   * cannot serve — a health endpoint that should report the current picture, a cron
   * job, a test with a manual clock.
   */
  runAudit(): TrafficAnomaly[] {
    if (this.audit === undefined) return [];
    const anomalies = this.audit.evaluate();
    for (const anomaly of anomalies) this.raiseAnomaly(anomaly);
    return anomalies;
  }

  private raiseAnomaly(anomaly: TrafficAnomaly): void {
    this.events.emit("anomaly", anomaly);
    // Anomalies reach configured sinks as well as hooks, so an alerting setup that is
    // already wired up gets these without a second integration.
    if (this.notifications.enabled) {
      this.notifications.emit({ type: "anomaly", at: new Date(anomaly.at).toISOString(), anomaly });
    }
  }

  on<K extends keyof BotHandlerEvents & string>(event: K, listener: (payload: BotHandlerEvents[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  /**
   * A point-in-time copy of the counters. Cheap enough to call on every scrape.
   *
   * Returns `undefined` when metrics were switched off with `metrics: false`.
   */
  metrics(): MetricsSnapshot | undefined {
    return this.meter?.snapshot(this.registry.size);
  }

  /** The same counters in Prometheus text exposition format. */
  prometheus(options?: PrometheusOptions): string | undefined {
    const snapshot = this.metrics();
    return snapshot === undefined ? undefined : toPrometheus(snapshot, options);
  }

  /**
   * Starts the operator dashboard on a listener of its own.
   *
   * ```ts
   * const dashboard = await botHandler.serveDashboard({
   *   port: 9674,
   *   auth: { username: "ops", password: process.env.DASH_PASSWORD! },
   * });
   * console.log(dashboard.url);
   * ```
   *
   * **Its own listener, not a route in your application.** Mounting it inside the app
   * it reports on puts it behind the bot handler, and that arrangement has three
   * separate failure modes: reading the dashboard shows up in the dashboard, a
   * challenge served to your site can lock you out of the tool you are using to read
   * about it, and the page becomes reachable at whatever authentication your public
   * site happens to have. A second port is the cheapest fix for all three.
   *
   * **Loopback by default, and it refuses to bind anywhere else without an explicit
   * `auth`.** This page shows client addresses and, per request, the exact evidence
   * behind the verdict — which is a tuning guide for anyone building a scraper
   * against you. See {@link DashboardOptions.host}.
   *
   * The returned handle carries the URL to open (with the real port, which matters if
   * you passed 0) and a `close()` that stops the listener, drops the event streams and
   * unsubscribes from this handler.
   */
  async serveDashboard(options?: DashboardOptions): Promise<DashboardServer> {
    // Imported here rather than at the top of the file: the dashboard pulls in an
    // HTTP server and a page's worth of markup, and a library used only for `assess()`
    // in a worker should not carry either.
    const { startDashboard } = await import("./dashboard/index.js");
    return startDashboard(this, options);
  }

  /**
   * Replaces an IP range set while the process runs.
   *
   * Published crawler ranges are the reason this exists. Operators revise them, a
   * stale list turns a verified crawler into an accused impersonator, and requiring a
   * restart to pick up a new one means the list is refreshed roughly never. Fetch
   * them on whatever schedule you like and hand them here.
   *
   * The swap is atomic — the new set is fully parsed and validated before it replaces
   * the old one — so a request assessed mid-update sees one list or the other, never
   * a half-built one. Invalid input throws and leaves the existing set in place,
   * because a range set that silently matches nothing is worse than a stale one.
   */
  updateRanges(name: string, entries: readonly string[], context: ChangeContext = {}): void {
    const set = new IpRangeSet(entries);
    if (set.invalid.length > 0) {
      throw new ConfigError(`Cannot update the "${name}" ranges: ${set.invalid.join(", ")} are not valid addresses or CIDRs. The previous set is unchanged.`);
    }
    if (set.size === 0) this.config.ranges.delete(name);
    else this.config.ranges.set(name, set);
    // Announced like the other runtime changes, and for a sharper reason than most:
    // the allowlist is the one list that stops detection *running*, so an address
    // added to it stops being assessed at all.
    this.warn(`Range set "${name}" replaced at runtime${attribute(context)}: ${set.size} entr${set.size === 1 ? "y" : "ies"}.`);
    this.events.emit("range-change", { name, size: set.size, entries: set.entries(), by: context.by });
  }

  /** The ranges in a set, as written. `undefined` when no set of that name exists. */
  rangeEntries(name: string): readonly string[] | undefined {
    return this.config.ranges.get(name)?.entries();
  }

  /**
   * Discards one actor's behavioural memory.
   *
   * The remedy for a false positive that has stuck: a person whose actor key collected
   * a `confirmed-bot` — a shared office address, a phone that reused an IP — carries
   * `priorConfirmations` for the rest of the window, and any rule reading
   * `minPriorConfirmations` keeps matching them. Until this existed the only cure was
   * `registry.clear()`, which throws away every actor's history to fix one.
   *
   * It is not an allowlist: the next request from this actor is assessed exactly as any
   * first request would be.
   */
  forgetActor(key: string, context: ChangeContext = {}): void {
    this.registry.forget(key);
    this.warn(`Actor "${key}" was forgotten at runtime${attribute(context)}.`);
    this.events.emit("actor-change", { key, action: "forget", by: context.by });
  }

  /**
   * Grants an actor human clearance for a while, as though it had solved a challenge.
   *
   * The `clearance` detector reads it, so this is an assertion about a person made by
   * an operator on evidence the request does not carry — the same category of claim as
   * `isHuman`, and it expires the same way a solved challenge does.
   */
  clearActor(key: string, forMs: number, context: ChangeContext = {}): void {
    const until = this.config.clock.now() + Math.max(0, forMs);
    this.registry.clearUntil(key, until);
    this.warn(`Actor "${key}" was cleared as human at runtime${attribute(context)}, until ${new Date(until).toISOString()}.`);
    this.events.emit("actor-change", { key, action: "clear", until, by: context.by });
  }

  /**
   * Tells the engine what the application answered.
   *
   * The one thing detection cannot see for itself. Every verdict here is reached *before*
   * the response exists — that is what makes it useful, since it can shape the response —
   * and so the status is knowledge only the application holds. Handed back, it closes the
   * oldest gap in reading a scanner: an actor whose requests are almost all misses is
   * looking for something rather than reading anything, and no amount of header analysis
   * shows that.
   *
   * Optional, and silent when the actor has already been forgotten. Nothing about
   * detection depends on it being called; supplying it sharpens `probe-volume` and
   * nothing else. The bundled Node adapter wires it up for you.
   */
  recordOutcome(facts: RequestFacts, status: number): void {
    // Skipped for exactly the requests `assess` skips, so the site's own miss rate is
    // measured over the traffic it judges. Adapters call this on every response,
    // including the ones detection never looked at — and an allowlisted health check or
    // an ignored asset path answering 404 all day would otherwise set the baseline that
    // decides whether anybody else's misses are unusual. Measured: a run where every
    // judged request was answered 200 reported a site miss rate of 0.89.
    if (!this.isIgnoredPath(facts.path) && !this.isAllowlisted(facts.ip)) {
      this.site?.recordOutcome(facts.path, status);
    }
    if (!Number.isFinite(status)) return;
    this.registry.peek(this.actorKeyFor(facts))?.recordOutcome(status);
  }

  /**
   * Gives an actor a name, or clears it with `undefined`.
   *
   * Detection never reads it — a label cannot make anybody more or less suspicious, and
   * that separation is deliberate: the moment a note changes a verdict, writing notes
   * becomes a way to be wrong about people at scale. It is for the humans reading the
   * dashboard, and it survives exactly as long as the actor does.
   *
   * Available from code so a deployment can label what it already knows — its own
   * monitoring, a partner's feed, the office egress — rather than waiting for somebody to
   * recognise the address twice.
   */
  labelActor(key: string, label: string | undefined, context: ChangeContext = {}): void {
    const state = this.registry.peek(key);
    if (state === undefined) return;
    state.setLabel(label);
    this.warn(`Actor "${key}" was ${label === undefined ? "unlabelled" : `labelled "${state.label ?? ""}"`} at runtime${attribute(context)}.`);
  }

  /** Convenience for `updateRanges("crawler:<id>", …)`, matching a signature id. */
  updateCrawlerRanges(signatureId: string, entries: readonly string[], context: ChangeContext = {}): void {
    this.updateRanges(`crawler:${signatureId}`, entries, context);
  }

  /**
   * Replaces the rule list while the process runs.
   *
   * The dashboard's policy editor is the reason this exists, and the shape of it is
   * deliberate: you may change **which rules exist**, and nothing about **how far a
   * rule is allowed to go**. `falsePositivePolicy`, `fallbackAction` and
   * `terminalScoreThreshold` are fixed at construction. A dashboard — or anything
   * else holding a reference to this handler — therefore cannot relax the guard that
   * stops an unproven verdict from denying somebody. Loosening that is a deploy, on
   * purpose, reviewed by whoever reviews deploys.
   *
   * Validation runs first and throws on a rule that could never work; the swap only
   * happens if every rule survives it, so a bad edit leaves the running policy exactly
   * as it was. Warnings — a duplicate id, a rule that can never match — come back to
   * the caller *and* go to `onWarning`, because a policy changed at runtime should
   * leave a trace in the same place a policy loaded at startup does.
   */
  updatePolicy(rules: readonly Rule[], context: ChangeContext = {}): { warnings: string[] } {
    const warnings = validateRules(rules);
    this.policy.replaceRules(rules);
    const summary = `Policy replaced at runtime${attribute(context)}: ${rules.length} rule(s) — ${rules.map((rule) => rule.id).join(", ") || "none"}.`;
    this.warn(summary);
    for (const warning of warnings) this.warn(warning);
    this.events.emit("policy-change", { rules: rules.map((rule) => rule.id), warnings, by: context.by });
    return { warnings };
  }

  /**
   * Changes the guard settings while the process runs.
   *
   * The one runtime change that can start denying people, and it is kept apart from
   * {@link updatePolicy} for exactly that reason: a separate method, a separate
   * dashboard control, a separate event. Fields left out keep their current value.
   *
   * Everything is validated before anything is applied, so a rejected change leaves
   * the running guard exactly as it was — the same contract `updatePolicy` has. What
   * is refused and why is documented on {@link Policy.replaceGuard}; the short version
   * is that a terminal `fallbackAction` would turn every downgrade into the denial the
   * downgrade exists to prevent.
   *
   * It is announced twice on purpose: a `warning`, which lands wherever your startup
   * warnings land and in the dashboard's notices, and a `guard-change` event carrying
   * both the before and the after.
   */
  updateGuard(settings: Partial<GuardSettings> & { suspectThreshold?: number }, context: ChangeContext = {}): { guard: GuardSettings & { suspectThreshold: number } } {
    const before = { ...this.policy.describeGuard(), suspectThreshold: this.config.suspectThreshold };

    const threshold = settings.suspectThreshold;
    if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 1 || threshold > 100)) {
      throw new ConfigError(`suspectThreshold must be between 1 and 100 (got ${String(threshold)}).`);
    }

    // Validation lives in the policy, and it throws before it assigns — so this line
    // either changes all four settings or none of them.
    this.policy.replaceGuard(settings);
    if (threshold !== undefined) this.config.suspectThreshold = threshold;

    const after = { ...this.policy.describeGuard(), suspectThreshold: this.config.suspectThreshold };
    const moved = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key]);
    this.warn(
      moved.length === 0
        ? `Guard settings were re-applied at runtime${attribute(context)} with no change.`
        : `Guard settings changed at runtime${attribute(context)}: ${moved.map((key) => `${key} ${String(before[key])} → ${String(after[key])}`).join(", ")}.`,
    );
    this.events.emit("guard-change", { before, after, by: context.by });
    return { guard: after };
  }

  /**
   * Tells the other replicas that this actor has been proven a bot.
   *
   * Fire and forget, off the request path, and failure is silence: a store that is
   * unavailable costs the *other* instances a fact they would have liked, and costs
   * this request nothing at all. The window is the registry's own, so a shared count
   * ages out at the same rate the local one does rather than accumulating for ever.
   */
  private publishConfirmation(state: ActorState): void {
    if (this.registry.onFirstSight === undefined) return;
    // A write of this instance's own total rather than an increment, and the difference
    // is not incidental. `increment` buckets its key by window — that is what makes it
    // a fixed-window rate limiter — so what it writes is not what `get` reads back.
    //
    // Last writer wins, which under-counts when two replicas confirm the same actor
    // without having seen each other: each writes what it knows, and a third instance
    // reads the larger. It never over-counts, and under-counting is the safe direction
    // here, exactly as it is everywhere else in this library — a rule that reads
    // `minPriorConfirmations` fails towards not matching, which is towards not acting.
    const total = state.confirmations + (state.sharedConfirmations ?? 0);
    void this.store.set(`confirmed:${state.key}`, String(total), this.config.actorWindowMs).catch(() => {
      /* the local count still stands */
    });
  }

  /**
   * Asks the store what other replicas already know about an actor we have just met.
   *
   * Once per actor per instance, and deliberately *not* awaited: making it synchronous
   * would put a network round trip on the request path, which is the one thing the
   * behavioural state is arranged to avoid.
   *
   * So the request that triggers the read is assessed with whatever has arrived by the
   * time the detectors finish — which for a fast store is usually the answer, and for a
   * slow or distant one is nothing. Every request after it has the number. Neither
   * outcome is wrong: an actor nobody here has seen before is an actor with no local
   * history either, so the first request was always going to be judged on the request
   * alone.
   *
   * The read subtracts nothing. This instance has not confirmed anything about a
   * brand-new actor yet, so whatever the store holds was put there by somebody else,
   * and the two counts add up cleanly from here.
   */
  private loadSharedConfirmations(state: ActorState): void {
    void this.store
      .get(`confirmed:${state.key}`)
      .then((value) => {
        const shared = value === undefined ? 0 : Number.parseInt(value, 10);
        if (Number.isFinite(shared) && shared > 0) state.sharedConfirmations = shared;
      })
      .catch(() => {
        // A store outage leaves the actor with what this process saw itself, which is
        // where every actor was before this option existed.
      });
  }

  /** Names and sizes of every configured range set. */
  listRanges(): Array<{ name: string; size: number }> {
    return [...this.config.ranges].map(([name, set]) => ({ name, size: set.size }));
  }

  /** Every registered detector, for documentation and for checking what is actually installed. */
  describeDetectors(): DetectorDescription[] {
    return [...this.cheapDetectors, ...this.ioDetectors, ...this.confirmingDetectors].map((detector) => ({
      id: detector.id,
      description: detector.description,
      cost: detector.cost ?? "cheap",
      stage: detector.stage ?? "always",
      // Present only when it is true, so a deployment shadowing nothing lists exactly
      // what it listed before.
      ...(this.shadowIds.has(detector.id) ? { shadow: true as const } : {}),
    }));
  }

  /** Recovers the client address from a socket address and headers, honouring the proxy config. */
  resolveIp(socketAddress: string | undefined, headers: Record<string, string | undefined>): string {
    return resolveClientIp(socketAddress, headers, this.config.proxy);
  }

  actorKeyFor(facts: RequestFacts): string {
    try {
      return this.config.actorKey(facts);
    } catch (error) {
      this.fail(error, "actorKey");
      return facts.ip;
    }
  }

  isAllowlisted(ip: string): boolean {
    return this.config.ranges.get("allowlist")?.contains(ip) ?? false;
  }

  isIgnoredPath(path: string): boolean {
    if (this.ignoreExact.has(path)) return true;
    return pathMatches(this.ignorePatterns, path);
  }

  /**
   * Gathers evidence and reaches a verdict. Never throws, never writes a response.
   *
   * Detectors run in three phases, ordered by what they cost:
   *
   * 1. **Cheap** — pure string and header inspection, sequential, microseconds.
   * 2. **I/O** — concurrent, each under its own timeout, so one slow lookup cannot
   *    hold the request open.
   * 3. **Confirming** — only when the request actually claimed an identity worth
   *    checking. A request that named no crawler resolves no DNS.
   */
  async assess(facts: RequestFacts, options: AssessOptions = {}): Promise<Assessment> {
    const started = this.config.clock.now();
    const requestId = randomId(9);
    const record = options.record !== false;

    if (this.isIgnoredPath(facts.path)) return this.bypassed(facts, requestId, started, "ignored-path", record);
    if (this.isAllowlisted(facts.ip)) return this.bypassed(facts, requestId, started, "allowlist", record);

    const actorKey = this.actorKeyFor(facts);
    // A dry run gets an actor of its own, created and discarded here. Anything else
    // would make asking the question change the answer to the next one: `observe`
    // records a request against the real actor, which moves its rate, its path breadth
    // and its cadence — the three things `cadence`, `crawl-breadth` and `rate-anomaly`
    // are reading. The cost is that a dry run has no history, and that is the honest
    // reading of a request that has not happened.
    const state = record ? this.registry.observe(actorKey, facts) : detachedActor(actorKey, facts);
    const ua = parseUserAgent(facts.headers["user-agent"]);
    const signatureMatches = ua.lower.length > 0 ? this.signatures.matchAll(ua.lower) : [];
    // Filed against the actor before the detectors run, so a detector reading the set sees
    // this request in it. What one request claimed is a claim; what a series of them
    // claimed is sometimes a contradiction.
    for (const match of signatureMatches) state.noteIdentity(match.id, match.category, match.verification.kind !== "none");

    // Read before the detectors run, and recorded on the actor, so that a detector
    // reading the marker sees this request in the series rather than after it.
    const marker = this.probe?.observe(facts, ua);
    if (marker !== undefined && record) {
      state.noteMarker(marker.reading.kind === "valid", marker.reading.kind === "forged", marker.drift);
    }

    // Filed before the detectors run, so a detector comparing this request against the
    // site sees this request counted in it. Only for requests that are actually being
    // recorded: a dry run must not move the baseline it is asking about.
    if (this.site !== undefined && record) {
      // Asked before it is counted, so "has anybody else been here" does not answer
      // itself. Recording first would make every path seen at least once.
      const seenBefore = this.site.timesSeen(facts.path);
      this.site.record(facts.path, actorKey);
      if (seenBefore === 0) state.noteNovelPath();
      const step = walkStepOf(facts.path);
      if (step !== undefined) this.site.recordWalk(step.template, step.id, actorKey);
    }

    const context: DetectionContext = {
      facts,
      marker,
      site: this.site,
      ua,
      actor: state.snapshot(facts.timestamp),
      state,
      clock: this.config.clock,
      signatures: this.signatures,
      signatureMatches,
      resolver: this.resolver,
      ranges: this.config.ranges,
      shared: new Map<string, unknown>(),
    };

    const evidence: Evidence[] = [];
    // Kept apart from the first line of this function to the last. See `Assessment.shadowEvidence`.
    const shadowEvidence: Evidence[] = [];
    const failures: DetectorFailure[] = [];

    // Cheap detectors are synchronous by contract, so they are run *without* an
    // await. This is not micro-optimisation for its own sake: `await` on a
    // non-promise still yields a microtask turn, so awaiting each of a dozen
    // detectors put a dozen scheduler round-trips on every request to the site,
    // which dominated the cost of a clean browser request. A detector that returns a
    // promise anyway is collected and awaited below, so the contract is enforced
    // by behaviour rather than by trust.
    let pending: Array<Promise<void>> | undefined;
    for (const detector of this.cheapDetectors) {
      const inFlight = this.run(detector, context, evidence, shadowEvidence, failures, 0);
      if (inFlight !== undefined) (pending ??= []).push(inFlight);
    }

    for (const detector of this.ioDetectors) {
      const inFlight = this.run(detector, context, evidence, shadowEvidence, failures, this.config.detectorTimeoutMs);
      if (inFlight !== undefined) (pending ??= []).push(inFlight);
    }

    if (pending !== undefined) await Promise.all(pending);

    // The confirming stage exists to turn a *claim* into a verified identity or a
    // proven forgery. With no claim there is nothing to confirm and no lookup to make.
    if (signatureMatches.length > 0 && this.confirmingDetectors.length > 0) {
      let confirming: Array<Promise<void>> | undefined;
      for (const detector of this.confirmingDetectors) {
        const inFlight = this.run(detector, context, evidence, shadowEvidence, failures, this.config.detectorTimeoutMs);
        if (inFlight !== undefined) (confirming ??= []).push(inFlight);
      }
      if (confirming !== undefined) await Promise.all(confirming);
    }

    if (this.isHuman !== undefined) {
      try {
        if (this.isHuman(facts)) {
          evidence.push({
            detector: "operator-assertion",
            summary: "The application identified this request as belonging to a person",
            direction: "human",
            certainty: "certain",
            deterministicBasis: "The operator's own code asserted this, on evidence the request does not carry — a signed-in session, a completed payment, or whatever bar the application sets. It is an assertion, not an inference.",
          });
        }
      } catch (error) {
        this.fail(error, "isHuman");
      }
    }

    // Noted after the detectors, so the *next* request from this actor knows a scanner
    // payload has already come from it. Cross-request by nature: one probe is a probe, and
    // a probe alongside a claimed crawler identity is a lie about who is probing.
    if (evidence.some((item) => item.detector === "probe-signature")) state.notePayloadProbe();

    const combined = combineEvidence(evidence, {
      suspectThreshold: this.config.suspectThreshold,
      strictEvidence: this.config.strictEvidence,
      onEvidenceViolation: (message) => this.warn(message),
    });

    // The counterfactual, computed only when a shadowed detector actually found
    // something. Combining is cheap — a sort and a noisy-OR over a handful of items — but
    // it is not free, and on a well-behaved shadowed detector this branch is taken almost
    // never. On a badly-behaved one it is taken often, which is the case you wanted to
    // hear about anyway.
    //
    // The violation handler is scoped to the shadowed items because the real evidence has
    // already been through this once; without the filter every `certain`-without-a-basis
    // in the ordinary set would be reported twice per request.
    let shadowVerdict: Assessment["shadowVerdict"];
    if (shadowEvidence.length > 0) {
      const wouldBe = combineEvidence([...evidence, ...shadowEvidence], {
        suspectThreshold: this.config.suspectThreshold,
        strictEvidence: this.config.strictEvidence,
        onEvidenceViolation: (message, item) => {
          if (item.shadow === true) this.warn(message);
        },
      });
      shadowVerdict = { verdict: wouldBe.verdict, botClass: wouldBe.botClass, score: wouldBe.score, certain: wouldBe.certain };
    }

    // Snapshot before recording this request's own outcome. `priorConfirmations`
    // means "how many times has this actor been proven a bot *before now*", and a
    // rule reading `minPriorConfirmations: 1` should not match on an actor's very
    // first request.
    const actor = state.snapshot(facts.timestamp);
    if (combined.verdict === "confirmed-bot" && record) {
      state.confirmations++;
      this.publishConfirmation(state);
    }

    const assessment: Assessment = {
      requestId,
      verdict: combined.verdict,
      botClass: combined.botClass,
      identity: combined.identity,
      score: combined.score,
      confidence: Math.round(combined.confidence * 1000) / 1000,
      certain: combined.certain,
      evidence: combined.botEvidence,
      humanEvidence: combined.humanEvidence,
      shadowEvidence: sortEvidence(shadowEvidence),
      ...(shadowVerdict === undefined ? {} : { shadowVerdict }),
      actor,
      durationMs: this.config.clock.now() - started,
      failures,
      facts,
      ...(marker === undefined ? {} : { marker }),
    };

    // A dry run is counted by nothing and told to nobody: it is not traffic, and a
    // counter that includes the questions an operator asked about traffic is a counter
    // that disagrees with the access log.
    if (!record) return assessment;

    this.meter?.recordAssessment(assessment);
    this.audit?.record(assessment);
    this.events.emit("assessment", assessment);
    // `enabled` is checked here rather than inside `emit` because constructing the
    // event is itself the expensive part — an ISO timestamp costs more than several
    // detectors — and with no sinks configured it would be built and discarded on
    // every single request.
    if (assessment.verdict !== "unknown" && this.notifications.enabled) {
      this.notifications.emit({ type: "detection", at: new Date(facts.timestamp).toISOString(), assessment });
    }
    return assessment;
  }

  /** Applies the policy. Pure — no I/O, no side effects beyond the downgrade notification. */
  decide(assessment: Assessment): Decision {
    const decision = this.policy.decide(assessment);
    this.meter?.recordDecision(decision);
    this.audit?.recordDecision(decision, assessment.facts.timestamp);
    this.events.emit("decision", { assessment, decision });
    // Derived once, here, so every integration agrees about what a denial is and what
    // a guard stop is. `downgrade` fires for the rule that was refused, whatever the
    // substitute turned out to be.
    if (decision.downgradedFrom !== undefined) this.events.emit("downgrade", { assessment, decision });
    if (TERMINAL_ACTIONS.has(decision.action)) this.events.emit("denial", { assessment, decision });
    return decision;
  }

  /** Assess, decide, and turn the decision into an outcome for an adapter to apply. */
  async handle(facts: RequestFacts): Promise<HandleResult> {
    const assessment = await this.assess(facts);
    const decision = this.decide(assessment);

    const outcome = await executeAction({
      assessment,
      decision,
      store: this.store,
      challenge: this.challenge,
      clock: this.config.clock,
      exposeVerdictHeaders: this.config.exposeVerdictHeaders,
      handlers: this.handlers,
      onWarning: (message) => this.warn(message),
      onChallenge: (event: "issued") => {
        this.meter?.recordChallenge(event);
        // Counted here rather than derived later: at this moment the challenge is
        // outstanding, and it stays outstanding until a solution arrives or the actor
        // ages out of the registry. `verifyChallenge` is the only thing that clears it.
        const state = this.registry.peek(assessment.actor.key);
        if (state !== undefined) {
          state.unsolvedChallenges++;
          // The identity claimed at the moment of the challenge, so a change made in
          // response to it is legible as a response rather than as drift over a session.
          // Computed here when no probe supplied one: a challenge is rare enough to
          // afford re-parsing a User-Agent, and without this the reaction can only be
          // read on deployments that run a probe — which is most of them, but not all.
          state.noteChallengeIssued(
            this.config.clock.now(),
            assessment.marker?.shape ?? identityShape(assessment.facts, parseUserAgent(assessment.facts.headers["user-agent"])),
          );
        }
        this.events.emit("challenge", { phase: event, actorKey: assessment.actor.key });
      },
    });

    // Hand out a marker when this client is not already holding a good one, which for
    // an ordinary visitor is the first request of a session and no other. Attached here
    // rather than inside an action because it is not a consequence of the verdict: a
    // client that was allowed and a client that was challenged both need to be readable
    // as a series next time, and a `drop` has no response to attach anything to.
    const issued = this.markerFor(assessment);
    if (issued !== undefined) {
      // Never over the top of one that is already there. Nothing in this library sets a
      // response cookie on these paths today, but a rule's `params.headers` can, and
      // silently dropping an operator's own `Set-Cookie` to fit ours in would be a
      // detection feature breaking the application it is protecting.
      if (outcome.kind === "continue" && outcome.responseHeaders?.["set-cookie"] === undefined) {
        outcome.responseHeaders = { ...outcome.responseHeaders, "set-cookie": issued };
      } else if (outcome.kind === "respond" && outcome.headers["set-cookie"] === undefined) {
        outcome.headers = { ...outcome.headers, "set-cookie": issued };
      }
    }

    // Notify only when something was actually withheld or altered. An `allow` on a
    // recognised crawler is not news, and treating it as such is how a channel that
    // matters becomes one nobody reads.
    if (this.notifications.enabled && (outcome.kind !== "continue" || outcome.delayMs !== undefined)) {
      this.notifications.emit({ type: "action", at: new Date(facts.timestamp).toISOString(), assessment, decision });
    }

    return { assessment, decision, outcome };
  }


  /**
   * The `Set-Cookie` this response should carry, if any.
   *
   * Nothing is issued to a client that already holds a valid marker, because a
   * `Set-Cookie` on every response makes every response uncacheable by shared caches —
   * a detection feature is not worth a site's cache-hit ratio. Nothing is issued to a
   * verified crawler either: Googlebot does not keep cookies, so a marker sent to it is
   * a header that will never come back and an issuance count that means nothing.
   */
  private markerFor(assessment: Assessment): string | undefined {
    if (this.probe === undefined || assessment.marker === undefined) return undefined;
    if (assessment.botClass === "verified-bot") return undefined;
    if (!this.probe.shouldIssue(assessment.marker)) return undefined;
    const state = this.registry.peek(assessment.actor.key);
    state?.noteMarkerIssued();
    return this.probe.issue(assessment.marker);
  }

  /** True when this request is the challenge verification endpoint. */
  isChallengeEndpoint(facts: Pick<RequestFacts, "method" | "path">): boolean {
    return this.challenge !== undefined && facts.method === "POST" && facts.path === this.challenge.verifyPath;
  }

  /**
   * Verifies a submitted challenge solution.
   *
   * Deliberately its own entry point rather than something `handle` detects: the
   * verification endpoint must not itself be assessed, or a client that has just been
   * challenged would be challenged again for trying to answer.
   */
  async verifyChallenge(facts: RequestFacts, body: unknown): Promise<SolutionOutcome> {
    if (!this.challenge) return { ok: false, status: 404, reason: "no challenge configured" };
    const actorKey = this.actorKeyFor(facts);
    const outcome = await this.challenge.verifySolution(actorKey, body);
    this.meter?.recordChallenge(outcome.ok ? "solved" : "rejected");
    if (outcome.ok) this.meter?.recordClearance(outcome.level);
    else this.meter?.recordChallengeRejection(outcome.reason);
    // Filed against the actor, because one of these means little and a pattern of them
    // means a great deal — and the verification endpoint is not itself assessed, so
    // nothing else would ever see it.
    if (!outcome.ok && outcome.signal !== undefined) {
      this.registry.peek(actorKey)?.noteChallengeAnomaly(outcome.signal);
    }
    // Recorded whether or not it passed: a distribution with the refusals cut out of it
    // is the wrong shape for the one decision it exists to inform.
    if (outcome.interactionScore !== undefined) this.meter?.recordInteractionScore(outcome.interactionScore);
    // A solve lands on a *later* request than the challenge that prompted it, so the
    // audit has to be told rather than being able to derive it from decisions.
    if (outcome.ok) this.audit?.recordChallengeSolved(this.config.clock.now());
    this.events.emit("challenge", {
      phase: outcome.ok ? "solved" : "rejected",
      actorKey,
      ...(outcome.ok ? { level: outcome.level } : { reason: outcome.reason }),
      ...(outcome.interactionScore === undefined ? {} : { score: outcome.interactionScore }),
    });
    if (outcome.ok) {
      // Solving one clears the lot. The count is meant to say "has been asked and never
      // answers", and somebody who answers has answered — carrying their earlier
      // abandoned attempts forward would keep accusing a person who just proved they
      // are one.
      const solver = this.registry.peek(actorKey);
      if (solver !== undefined) solver.unsolvedChallenges = 0;

      // Record the clearance locally too, so behavioural detectors can see it without
      // re-verifying the cookie on every subsequent request. It has to expire *with*
      // the cookie rather than on a fixed hour of its own: this flag is what stops an
      // actor being challenged again, so outliving the token it mirrors would hand
      // whoever solved one puzzle a stretch of unchallengeable requests afterwards.
      this.registry.clearUntil(actorKey, this.config.clock.now() + this.challenge.clearanceTtlMs);
    }
    return outcome;
  }

  /**
   * Mints a clearance cookie for an actor, bypassing the challenge.
   *
   * Call it the moment your application knows something the request cannot show — a
   * completed login, a verified payment. `operator` clearance is the only conclusive
   * human signal this library recognises.
   */
  grantClearance(facts: RequestFacts, level: "pow" | "interaction" | "operator" = "operator"): string | undefined {
    if (!this.challenge) return undefined;
    const actorKey = this.actorKeyFor(facts);
    // Mirrored locally for the same reason a solved challenge is: the cookie only
    // starts arriving on the *next* request, and until it does the registry flag is
    // the only thing stopping this actor being challenged for something the operator
    // has already vouched for.
    this.registry.clearUntil(actorKey, this.config.clock.now() + this.challenge.clearanceTtlMs);
    return this.challenge.grant(actorKey, level);
  }

  /**
   * Runs one detector.
   *
   * Returns `undefined` when the detector completed synchronously — the common case,
   * and the one worth keeping off the microtask queue — or a promise the caller must
   * await. Failures are absorbed here in both paths: a detector can throw, reject or
   * hang, and none of those may reach the request.
   */
  private run(
    detector: Detector,
    context: DetectionContext,
    sink: Evidence[],
    shadowSink: Evidence[],
    failures: DetectorFailure[],
    timeoutMs: number,
  ): Promise<void> | undefined {
    // Which list this detector's findings land in is decided once, here, rather than by
    // filtering the combined list afterwards. Nothing downstream then has to remember to
    // exclude them — not the scoring, not the rules, not `notePayloadProbe`, not a
    // detector added next year. A shadowed detector is otherwise run identically: same
    // context, same timeout, same failure handling, same timings, because the whole
    // point is to learn what it would have done.
    const shadowed = this.shadowIds.has(detector.id);
    const target = shadowed ? shadowSink : sink;
    // Two clock reads per detector per request, and only when the operator has asked
    // for them: on a twenty-detector set that is forty reads to measure work usually
    // counted in microseconds. See `MetricsSnapshot.detectorTimings`.
    //
    // Written as a number and four call sites rather than as a closure, because a
    // closure here is allocated per detector per request whether or not timing is on —
    // twenty allocations on the hot path to support a feature that is off by default.
    // The benchmark caught it: it cost more than the audit, the metrics and the event
    // emitter put together.
    const startedAt = this.timing ? this.config.clock.now() : 0;

    let raw: DetectorResult | Promise<DetectorResult>;
    try {
      raw = detector.inspect(context);
    } catch (error) {
      if (startedAt !== 0) this.meter?.recordDetectorTiming(detector.id, this.config.clock.now() - startedAt);
      this.recordFailure(detector, failures, error);
      return undefined;
    }

    if (!(raw instanceof Promise)) {
      this.collect(raw, target, shadowed);
      if (startedAt !== 0) this.meter?.recordDetectorTiming(detector.id, this.config.clock.now() - startedAt);
      return undefined;
    }

    // A detector declared `cheap` that returns a promise anyway still gets a timeout:
    // mislabelling one is exactly the mistake that would put an unbounded await on
    // the request path, so the contract is enforced rather than assumed.
    const budget = timeoutMs > 0 ? timeoutMs : this.config.detectorTimeoutMs;
    const timedOut = TIMED_OUT;
    return withTimeout(raw as Promise<unknown>, budget, timedOut as unknown).then(
      (result) => {
        if (startedAt !== 0) this.meter?.recordDetectorTiming(detector.id, this.config.clock.now() - startedAt);
        if (result === timedOut) {
          const message = `exceeded ${budget}ms`;
          failures.push({ detector: detector.id, reason: "timeout", message });
          this.events.emit("detector-failure", { detector: detector.id, reason: "timeout", message, requestId: "" });
          return;
        }
        this.collect(result as DetectorResult, target, shadowed);
      },
      (error: unknown) => {
        if (startedAt !== 0) this.meter?.recordDetectorTiming(detector.id, this.config.clock.now() - startedAt);
        this.recordFailure(detector, failures, error);
      },
    );
  }

  private collect(result: DetectorResult, sink: Evidence[], shadowed = false): void {
    if (result === undefined || result === null) return;
    const mark = (item: Evidence): Evidence => (shadowed ? { ...sanitize(item), shadow: true } : sanitize(item));
    if (Array.isArray(result)) {
      for (let i = 0; i < result.length; i++) sink.push(mark(result[i]!));
      return;
    }
    sink.push(mark(result as Evidence));
  }

  private recordFailure(detector: Detector, failures: DetectorFailure[], error: unknown, requestId = ""): void {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ detector: detector.id, reason: "error", message });
    this.events.emit("detector-failure", { detector: detector.id, reason: "error", message, requestId });
    this.fail(error, `detector:${detector.id}`);
  }

  private bypassed(facts: RequestFacts, requestId: string, started: number, reason: "allowlist" | "ignored-path", record = true): Assessment {
    const actorKey = this.actorKeyFor(facts);
    const existing: ActorState | undefined = this.registry.peek(actorKey);
    const assessment: Assessment = {
      requestId,
      verdict: "unknown",
      botClass: "unknown",
      score: 0,
      confidence: 0,
      certain: false,
      evidence: [],
      humanEvidence: [],
      shadowEvidence: [],
      actor: existing?.snapshot(facts.timestamp) ?? {
        key: actorKey,
        requests: 0,
        distinctPaths: 0, distinctQueries: 0, queriesSaturated: false, methodsSeen: ["GET"], responses: 0, misses: 0,
        firstSeen: facts.timestamp,
        lastSeen: facts.timestamp,
        priorConfirmations: 0,
        unsolvedChallenges: 0,
        cleared: false,
      },
      bypass: reason,
      durationMs: this.config.clock.now() - started,
      failures: [],
      facts,
    };
    if (record) {
      this.meter?.recordAssessment(assessment);
      this.audit?.record(assessment);
    }
    return assessment;
  }

  /**
   * Raises a warning through the handler's own channel.
   *
   * Public because things outside this class legitimately have something to say: an
   * adapter that has spotted a misconfiguration, the crawler-range refresher reporting
   * a publisher it could not reach. Both used to call `config.onWarning` directly,
   * which reaches the callback and *not* the `warning` event — so a subscriber, and
   * with it the dashboard's notices panel, never heard about either. One channel, one
   * set of listeners.
   */
  warn(message: string): void {
    this.events.emit("warning", message);
    this.config.onWarning(message);
  }

  private fail(error: unknown, source: string): void {
    this.events.emit("error", { error, source });
    this.config.onError(error, { source });
  }
}

/** How often the audit compares its windows. Defaults to a minute. */
/** " by ada@example.com", or nothing at all. Reads as a sentence either way. */
function attribute(context: ChangeContext): string {
  return context.by === undefined || context.by === "" ? "" : ` by ${context.by}`;
}

/** A one-request actor, for a dry run. Never enters the registry, never seen again. */
function detachedActor(key: string, facts: RequestFacts): ActorState {
  const state = new ActorState(key, facts.timestamp);
  state.record(facts);
  return state;
}

function auditInterval(audit: AuditOptions | false | undefined): number {
  return typeof audit === "object" && audit.intervalMs !== undefined ? audit.intervalMs : 60_000;
}
