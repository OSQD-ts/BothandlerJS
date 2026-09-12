import type { Assessment, BotClass, Verdict } from "../types.js";
import type { BotCategory } from "../detectors/known-bots.js";

/**
 * What the engine does about an assessment.
 *
 * Ordered roughly by how much they cost a client that turns out to be a person:
 *
 * - `allow` — nothing at all. The verdict is still emitted for logging.
 * - `tag` — serve normally, attach headers describing the verdict so a downstream
 *   service (your app, a cache, an edge worker) can decide for itself.
 * - `log` — serve normally and raise a notification. Costs the client nothing.
 * - `delay` — serve normally, but slowly. Invisible to a person, expensive at scale.
 * - `rate-limit` — serve until a threshold, then reject with `429` and `Retry-After`.
 *   Recovers on its own.
 * - `challenge` — withhold the response until the client passes a check. Recoverable
 *   by the client itself, which is what makes it the safe escalation. It does still
 *   shut out anyone without JavaScript, so it is not free.
 * - `redirect` — send the client somewhere else.
 * - `block` — refuse, with a status and a body explaining it.
 * - `drop` — close the connection without a response.
 *
 * `redirect`, `block` and `drop` are **terminal**: the client is denied and cannot
 * recover on its own. Those are the three the safety guard governs.
 */
export type ActionName = "allow" | "tag" | "log" | "delay" | "rate-limit" | "challenge" | "redirect" | "block" | "drop" | "custom";

/** Every action, ordered by how much it costs a client that turns out to be a person. */
export const ACTION_NAMES: readonly ActionName[] = ["allow", "tag", "log", "delay", "rate-limit", "challenge", "redirect", "block", "drop", "custom"];

/** Actions a client cannot recover from by itself. The guard's whole concern. */
export const TERMINAL_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>(["redirect", "block", "drop"]);

export interface ActionParams {
  /** Status for `block`. Default 403. */
  status?: number | undefined;
  /** Response body for `block`. Defaults to a short plain-text explanation. */
  body?: string | undefined;
  contentType?: string | undefined;
  /** Target for `redirect`. Must be same-origin or an absolute URL you control. */
  location?: string | undefined;
  /** Milliseconds for `delay`. */
  delayMs?: number | undefined;
  /** Ceiling for `rate-limit`. */
  limit?: { max: number; windowMs: number } | undefined;
  /** Extra response headers, merged after the engine's own. */
  headers?: Record<string, string> | undefined;
  /** Handler id for `custom`. */
  handler?: string | undefined;
}

export interface Decision {
  action: ActionName;
  /** Id of the rule that produced it, or `"default"`. */
  rule: string;
  /** Sentence explaining the choice, safe to log and to show an operator. */
  reason: string;
  params: ActionParams;
  /**
   * Set when the safety guard replaced a stronger action. Both the original and the
   * substitute are recorded, because a policy silently doing less than it says is
   * worse than one that refuses loudly.
   */
  downgradedFrom?: ActionName | undefined;
  /** Why the downgrade happened. */
  downgradeReason?: string | undefined;
}

/** Declarative matcher. Every field present must match; absent fields are ignored. */
export interface MatchSpec {
  verdict?: Verdict | readonly Verdict[];
  botClass?: BotClass | readonly BotClass[];
  /** Established or claimed identity, e.g. `"googlebot"`. */
  identity?: string | readonly string[];
  /** Category of the matched signature, e.g. `"ai"`, `"seo"`. */
  category?: BotCategory | readonly BotCategory[];
  /**
   * A service token this request presented and proved — by name, never by value.
   *
   * `true` matches any configured token. This is the one place a *claim* in a header is
   * allowed to decide a rule, and it is allowed because the claim carries a shared secret
   * that was checked in constant time before this ran. Nothing else about a header is
   * matchable, deliberately: a header is something the client wrote.
   *
   * ```ts
   * { id: "monitor", match: { serviceToken: "uptime monitor" }, action: "allow" }
   * ```
   *
   * See `serviceTokens` in the handler configuration.
   */
  serviceToken?: string | readonly string[] | true;
  /**
   * Require (or forbid) proven evidence.
   *
   * Note what this does *not* mean: `certain` is about the strength of the evidence,
   * not its direction, so `{ certain: true }` also matches a proven **human** — a
   * customer your application vouched for through `grantClearance`. A rule intended
   * for automation must say so, either by putting an allow rule for `verdict: "human"`
   * ahead of it or by naming the verdicts it means. Both shipped presets had this
   * wrong until the traffic corpus caught it.
   */
  certain?: boolean;
  minScore?: number;
  maxScore?: number;
  /** Request path. Strings match as a prefix; regexes are tested as written. */
  path?: string | RegExp | readonly (string | RegExp)[];
  method?: string | readonly string[];
  /** Fires when any evidence came from one of these detectors. */
  detector?: string | readonly string[];
  /** Fires only when the actor has been proven a bot at least this many times before. */
  minPriorConfirmations?: number;
  /**
   * Fires only when this actor has this many challenges outstanding — issued, and never
   * answered.
   *
   * A rule rather than evidence, and the difference is the point. Somebody who abandons
   * a challenge is somebody: a slow phone, a lost tab, a change of mind. It is only
   * *repetition* that means anything, and how much it means depends on traffic the
   * library cannot see — a checkout flow and a documentation site should read the same
   * number differently. So the engine counts, and your policy decides.
   *
   * Solving one clears the count, so this never accumulates against a person who came
   * back and proved it.
   *
   * ```ts
   * { id: "persistent-refusers", match: { minUnsolvedChallenges: 3 }, action: "rate-limit" }
   * ```
   */
  minUnsolvedChallenges?: number;
}

export interface Rule {
  /** Stable id. Appears in every decision and log line this rule produces. */
  id: string;
  /** Declarative spec, or a predicate for anything the spec cannot express. */
  match: MatchSpec | ((assessment: Assessment) => boolean);
  action: ActionName;
  params?: ActionParams;
  /** Overrides the generated explanation. */
  reason?: string;
}

/**
 * How strictly the engine refuses to act on unproven evidence.
 *
 * - **`strict`** (default) — a terminal action requires `assessment.certain`. A rule
 *   asking to block on a probabilistic verdict is downgraded to `fallbackAction` and
 *   the substitution is recorded. This is the mode in which the library's central
 *   claim holds: nothing is ever denied service on the strength of a guess.
 * - **`balanced`** — terminal actions additionally allowed when the score clears
 *   `terminalScoreThreshold` **and** at least two independent `strong` signals fired.
 *   Two independent strong signals is a much higher bar than a score alone, which any
 *   number of weak correlated observations can reach. It is still, unambiguously, a
 *   probabilistic decision — some real people will be caught.
 * - **`aggressive`** — rules run exactly as written. Choose this only with a way to
 *   see who you turned away, and a way for them to reach you.
 */
export type FalsePositivePolicy = "strict" | "balanced" | "aggressive";

export interface PolicyOptions {
  /** Evaluated in order; the first match wins. */
  rules?: readonly Rule[];
  /** Used when no rule matches. Default `allow`. */
  defaultAction?: ActionName;
  defaultParams?: ActionParams;
  falsePositivePolicy?: FalsePositivePolicy;
  /**
   * Substituted when the guard blocks a terminal action. Default `challenge` if a
   * challenge is configured, otherwise `tag`.
   */
  fallbackAction?: ActionName;
  /** Score needed for a terminal action under `balanced`. Default 85. */
  terminalScoreThreshold?: number;
  /** Called whenever the guard downgrades, so a mismatch between intent and effect is visible. */
  onDowngrade?: ((decision: Decision, assessment: Assessment) => void) | undefined;
}
