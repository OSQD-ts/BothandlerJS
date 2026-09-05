import { compileMatch, independentStrongSignals } from "./match.js";
import { ACTION_NAMES, TERMINAL_ACTIONS } from "./types.js";
import type { Assessment } from "../types.js";
import type { ActionName, ActionParams, Decision, FalsePositivePolicy, PolicyOptions, Rule } from "./types.js";

interface CompiledRule {
  rule: Rule;
  matches: (assessment: Assessment) => boolean;
}

/** The settings that decide how far a rule may go. See {@link Policy.replaceGuard}. */
export interface GuardSettings {
  falsePositivePolicy: FalsePositivePolicy;
  fallbackAction: ActionName;
  defaultAction: ActionName;
  terminalScoreThreshold: number;
}

const POLICY_MODES: readonly FalsePositivePolicy[] = ["strict", "balanced", "aggressive"];

/** An absent field means "leave this one alone"; an explicit `undefined` has to mean the same. */
function stripUndefined(settings: Partial<GuardSettings>): Partial<GuardSettings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) if (value !== undefined) out[key] = value;
  return out as Partial<GuardSettings>;
}

/**
 * Chooses an action for an assessment, then refuses to let that action be harsher
 * than the evidence supports.
 *
 * The second half is the point. Rules are ordinary first-match-wins configuration and
 * there is nothing clever about them. What makes the policy trustworthy is the guard
 * that runs *after* a rule has been selected: under the default `strict` mode a
 * terminal action survives only if `assessment.certain` is true, and otherwise is
 * replaced by something recoverable, with the substitution recorded on the decision.
 *
 * That ordering is deliberate. The guard cannot be forgotten in a rule, cannot be
 * bypassed by a cleverly-worded predicate, and does not depend on whoever wrote the
 * rules understanding the certainty model. Turning it off is a single, explicit,
 * greppable configuration change.
 */
export class Policy {
  /**
   * Compiled rules, in evaluation order.
   *
   * Mutable — and only ever replaced wholesale, never spliced. {@link replaceRules}
   * swaps the array in one assignment, so a request evaluated during an update sees
   * either the old list or the new one and never a half-applied policy.
   */
  private compiled: CompiledRule[];
  /**
   * The guard settings.
   *
   * Not `readonly` any more, and the reason is narrow enough to write down.
   * {@link replaceGuard} exists so that an operator who has been *given* the power to
   * change these can change them without a deploy — the dashboard gates it behind a
   * control flag of its own that is off by default. Everything about how they are
   * *used* is unchanged: `decide()` reads them on every request, so a change takes
   * effect on the next one, and it can only ever be a whole valid set replacing
   * another whole valid set.
   */
  private defaultAction: ActionName;
  private defaultParams: ActionParams;
  private mode: FalsePositivePolicy;
  private fallbackAction: ActionName;
  private terminalScoreThreshold: number;
  private readonly onDowngrade: PolicyOptions["onDowngrade"];

  constructor(options: PolicyOptions = {}) {
    this.compiled = Policy.compile(options.rules ?? []);
    this.defaultAction = options.defaultAction ?? "allow";
    this.defaultParams = options.defaultParams ?? {};
    this.mode = options.falsePositivePolicy ?? "strict";
    this.fallbackAction = options.fallbackAction ?? "challenge";
    this.terminalScoreThreshold = options.terminalScoreThreshold ?? 85;
    this.onDowngrade = options.onDowngrade;
  }

  private static compile(rules: readonly Rule[]): CompiledRule[] {
    return rules.map((rule) => ({
      rule,
      matches: typeof rule.match === "function" ? rule.match : compileMatch(rule.match),
    }));
  }

  /** Ids of every configured rule, in evaluation order. For diagnostics and tests. */
  get ruleIds(): string[] {
    return this.compiled.map((entry) => entry.rule.id);
  }

  /**
   * The rule definitions themselves, in evaluation order.
   *
   * Exposed because two things outside the policy need to *read* rules rather than
   * apply them: `robotsFromRules`, which turns the ones that deny crawlers into a
   * `robots.txt`, and the dashboard, which shows an operator what is actually
   * installed. Both want the spec as written, not the compiled predicate.
   */
  get rules(): readonly Rule[] {
    return this.compiled.map((entry) => entry.rule);
  }

  /**
   * Replaces the rule list while the process runs.
   *
   * Deliberately narrow: this changes *which* rules exist, and nothing about how far
   * they are allowed to go. The guard settings are a separate, separately-gated
   * operation — see {@link replaceGuard} — so that "edit the rules" and "change what a
   * rule is allowed to do" are never the same permission.
   */
  replaceRules(rules: readonly Rule[]): void {
    this.compiled = Policy.compile(rules);
  }

  /**
   * Replaces the guard settings while the process runs.
   *
   * This is the one edit that can start denying people, so it is separated from
   * {@link replaceRules} at every level: a different method here, a different control
   * flag on the dashboard, a different endpoint, and a different event when it lands.
   * A caller that may change rules does not thereby become a caller that may change
   * this.
   *
   * Two things are refused outright rather than warned about, because both turn the
   * guard into scenery while leaving it apparently switched on:
   *
   * - **A terminal `fallbackAction`.** The fallback is what a downgrade *becomes*.
   *   Set it to `block` and every downgrade blocks, which is the exact outcome the
   *   downgrade exists to prevent — and the decision would still be recorded as a
   *   guard stop, so the metric that is supposed to catch this would report success.
   * - **A `terminalScoreThreshold` outside 1–100.** Zero would let balanced mode
   *   deny on any score at all.
   *
   * Fields left undefined keep their current value, so a caller can move one setting
   * without restating the rest.
   */
  replaceGuard(settings: Partial<GuardSettings>): void {
    const next: GuardSettings = { ...this.describeGuard(), ...stripUndefined(settings) };

    if (!POLICY_MODES.includes(next.falsePositivePolicy)) {
      throw new Error(`Unknown falsePositivePolicy "${String(next.falsePositivePolicy)}". Use one of: ${POLICY_MODES.join(", ")}.`);
    }
    for (const [field, value] of [
      ["fallbackAction", next.fallbackAction],
      ["defaultAction", next.defaultAction],
    ] as const) {
      if (!ACTION_NAMES.includes(value)) throw new Error(`Unknown ${field} "${String(value)}". Use one of: ${ACTION_NAMES.join(", ")}.`);
    }
    if (TERMINAL_ACTIONS.has(next.fallbackAction)) {
      throw new Error(
        `fallbackAction cannot be "${next.fallbackAction}": the fallback is what a downgraded decision becomes, so a terminal one would deny exactly the requests the guard stepped in to protect. Use "challenge", "rate-limit", "delay", "tag" or "log".`,
      );
    }
    if (!Number.isFinite(next.terminalScoreThreshold) || next.terminalScoreThreshold < 1 || next.terminalScoreThreshold > 100) {
      throw new Error(`terminalScoreThreshold must be between 1 and 100 (got ${String(next.terminalScoreThreshold)}).`);
    }

    this.mode = next.falsePositivePolicy;
    this.fallbackAction = next.fallbackAction;
    this.defaultAction = next.defaultAction;
    this.terminalScoreThreshold = next.terminalScoreThreshold;
  }

  /** Just the guard half of {@link describe}, in the shape {@link replaceGuard} accepts back. */
  describeGuard(): GuardSettings {
    return {
      falsePositivePolicy: this.mode,
      fallbackAction: this.fallbackAction,
      defaultAction: this.defaultAction,
      terminalScoreThreshold: this.terminalScoreThreshold,
    };
  }

  /**
   * The settings that decide how far a rule may go, for anything that reports on the
   * policy rather than applying it — a dashboard, a diagnostic, a startup log.
   *
   * Worth surfacing rather than keeping private: `falsePositivePolicy` is the single
   * setting that decides whether an unproven verdict can deny anybody, and a reader
   * looking at a screen full of verdicts cannot interpret one without knowing it.
   */
  describe(): { falsePositivePolicy: FalsePositivePolicy; fallbackAction: ActionName; defaultAction: ActionName; terminalScoreThreshold: number; rules: string[] } {

    return {
      falsePositivePolicy: this.mode,
      fallbackAction: this.fallbackAction,
      defaultAction: this.defaultAction,
      terminalScoreThreshold: this.terminalScoreThreshold,
      rules: this.ruleIds,
    };
  }

  decide(assessment: Assessment): Decision {
    for (const entry of this.compiled) {
      let matched: boolean;
      try {
        matched = entry.matches(assessment);
      } catch {
        // A throwing custom predicate must not take the request down, and must not
        // silently match either. Skipping is the only safe reading of "unknown".
        continue;
      }
      if (!matched) continue;
      return this.guard(
        {
          action: entry.rule.action,
          rule: entry.rule.id,
          reason: entry.rule.reason ?? describe(entry.rule.action, assessment),
          params: entry.rule.params ?? {},
        },
        assessment,
      );
    }

    return this.guard(
      {
        action: this.defaultAction,
        rule: "default",
        reason: `No rule matched; applying the default action (${this.defaultAction}).`,
        params: this.defaultParams,
      },
      assessment,
    );
  }

  /**
   * The safety guard.
   *
   * Note what it does *not* consider: how confident the score is, how many detectors
   * fired, or how badly the operator wants to block. Under `strict` there is exactly
   * one question — is there proof? — and everything else is a downgrade.
   */
  private guard(decision: Decision, assessment: Assessment): Decision {
    if (!TERMINAL_ACTIONS.has(decision.action)) return decision;
    if (this.mode === "aggressive") return decision;
    if (assessment.certain) return decision;

    if (this.mode === "balanced") {
      const strong = independentStrongSignals(assessment);
      if (assessment.score >= this.terminalScoreThreshold && strong >= 2) return decision;
      return this.downgrade(
        decision,
        assessment,
        `Balanced mode requires a score of at least ${this.terminalScoreThreshold} (this request scored ${assessment.score}) and at least two independent strong signals (found ${strong}).`,
      );
    }

    return this.downgrade(
      decision,
      assessment,
      `Strict mode permits a terminal action only on proven evidence. This request's verdict (${assessment.verdict}, score ${assessment.score}) rests on probabilistic signals, any of which a real client can trip.`,
    );
  }

  private downgrade(decision: Decision, assessment: Assessment, why: string): Decision {
    const downgraded: Decision = {
      ...decision,
      action: this.fallbackAction,
      downgradedFrom: decision.action,
      downgradeReason: why,
      reason: `${decision.reason} Downgraded from ${decision.action} to ${this.fallbackAction}: ${why}`,
    };
    this.onDowngrade?.(downgraded, assessment);
    return downgraded;
  }
}

function describe(action: ActionName, assessment: Assessment): string {
  const lead = assessment.certain
    ? `Proven ${assessment.botClass}${assessment.identity ? ` (${assessment.identity})` : ""}`
    : `${assessment.verdict} at score ${assessment.score}`;
  const top = assessment.evidence[0];
  return top ? `${lead}: ${top.summary}. Applying ${action}.` : `${lead}. Applying ${action}.`;
}
