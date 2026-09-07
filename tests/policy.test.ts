import { describe, expect, it } from "vitest";
import { Policy } from "../src/policy/policy.js";
import { PRESETS, allowCrawlers, declineAiTraining, indexersOnly, protectApi, protectContent, underAttack } from "../src/policy/presets.js";
import { makeFacts } from "./helpers.js";
import type { Assessment, Verdict } from "../src/types.js";
import type { Decision } from "../src/policy/types.js";

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  const facts = makeFacts();
  return {
    requestId: "test",
    verdict: "suspected-bot" as Verdict,
    botClass: "scraper",
    score: 75,
    confidence: 0.75,
    certain: false,
    evidence: [{ detector: "header-integrity", summary: "no Accept header", direction: "bot", certainty: "strong" }],
    humanEvidence: [],
    actor: { key: facts.ip, requests: 3, distinctPaths: 3, distinctQueries: 0, queriesSaturated: false, methodsSeen: ["GET"], responses: 0, misses: 0, firstSeen: 0, lastSeen: 0, priorConfirmations: 0, unsolvedChallenges: 0, cleared: false },
    durationMs: 1,
    failures: [],
    facts,
    ...overrides,
  };
}

const blockEverything = [{ id: "block-all", match: () => true, action: "block" as const }];

describe("the safety guard", () => {
  // The library's central promise, expressed as a test: a rule that says "block"
  // does not block a request that has not been proven automated.
  it("refuses to block on probabilistic evidence in strict mode", () => {
    const policy = new Policy({ rules: blockEverything, falsePositivePolicy: "strict", fallbackAction: "challenge" });
    const decision = policy.decide(assessment());
    expect(decision.action).toBe("challenge");
    expect(decision.downgradedFrom).toBe("block");
    expect(decision.downgradeReason).toMatch(/proven evidence/);
  });

  it("blocks freely once the evidence is proven", () => {
    const policy = new Policy({ rules: blockEverything, falsePositivePolicy: "strict" });
    const decision = policy.decide(assessment({ certain: true, verdict: "confirmed-bot", score: 100 }));
    expect(decision.action).toBe("block");
    expect(decision.downgradedFrom).toBeUndefined();
  });

  it("never downgrades a recoverable action", () => {
    const policy = new Policy({ rules: [{ id: "tag-all", match: () => true, action: "tag" }], falsePositivePolicy: "strict" });
    expect(policy.decide(assessment()).action).toBe("tag");
  });

  it("reports every downgrade, so intent and effect cannot silently diverge", () => {
    const seen: Decision[] = [];
    const policy = new Policy({ rules: blockEverything, onDowngrade: (decision) => seen.push(decision) });
    policy.decide(assessment());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.downgradedFrom).toBe("block");
  });

  describe("balanced mode", () => {
    it("still refuses when only one detector fired, however high the score", () => {
      const policy = new Policy({ rules: blockEverything, falsePositivePolicy: "balanced", terminalScoreThreshold: 70 });
      const decision = policy.decide(assessment({ score: 99 }));
      expect(decision.action).toBe("challenge");
      expect(decision.downgradeReason).toMatch(/independent strong signals/);
    });

    it("allows a block once two independent strong signals agree and the score clears", () => {
      const policy = new Policy({ rules: blockEverything, falsePositivePolicy: "balanced", terminalScoreThreshold: 70 });
      const decision = policy.decide(
        assessment({
          score: 90,
          evidence: [
            { detector: "header-integrity", summary: "a", direction: "bot", certainty: "strong" },
            { detector: "client-hints", summary: "b", direction: "bot", certainty: "strong" },
          ],
        }),
      );
      expect(decision.action).toBe("block");
    });
  });

  it("honours rules exactly as written in aggressive mode", () => {
    const policy = new Policy({ rules: blockEverything, falsePositivePolicy: "aggressive" });
    expect(policy.decide(assessment({ score: 5 })).action).toBe("block");
  });
});

describe("rule matching", () => {
  it("takes the first matching rule", () => {
    const policy = new Policy({
      rules: [
        { id: "first", match: { verdict: "suspected-bot" }, action: "tag" },
        { id: "second", match: () => true, action: "delay" },
      ],
    });
    expect(policy.decide(assessment()).rule).toBe("first");
  });

  it("falls through to the default when nothing matches", () => {
    const policy = new Policy({ rules: [{ id: "never", match: { verdict: "verified-bot" }, action: "block" }], defaultAction: "allow" });
    const decision = policy.decide(assessment());
    expect(decision.rule).toBe("default");
    expect(decision.action).toBe("allow");
  });

  it("skips a predicate that throws rather than treating it as a match", () => {
    const policy = new Policy({
      rules: [
        {
          id: "broken",
          match: () => {
            throw new Error("boom");
          },
          action: "block",
        },
      ],
      defaultAction: "allow",
    });
    expect(policy.decide(assessment()).rule).toBe("default");
  });

  it("matches on score bands, paths, methods and detectors", () => {
    const policy = new Policy({
      rules: [
        { id: "api-only", match: { path: "/api/", minScore: 50 }, action: "rate-limit" },
        { id: "by-detector", match: { detector: "header-integrity" }, action: "delay" },
      ],
      defaultAction: "allow",
    });
    expect(policy.decide(assessment()).rule).toBe("by-detector");
    expect(policy.decide(assessment({ facts: makeFacts({ path: "/api/items" }) })).rule).toBe("api-only");
  });

  it("matches an identity from any piece of evidence", () => {
    const policy = new Policy({
      rules: [{ id: "gpt", match: { identity: "gptbot" }, action: "block" }],
      defaultAction: "allow",
      falsePositivePolicy: "aggressive",
    });
    const withIdentity = assessment({
      evidence: [{ detector: "self-identified", summary: "GPTBot", direction: "bot", certainty: "certain", identity: "gptbot", deterministicBasis: "x" }],
    });
    expect(policy.decide(withIdentity).rule).toBe("gpt");
  });
});

describe("presets", () => {
  it("gives every rule a unique id", () => {
    const ids = protectContent().map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets a confirmed crawler through untouched", () => {
    const policy = new Policy({ rules: protectContent() });
    const decision = policy.decide(assessment({ verdict: "verified-bot", botClass: "verified-bot", certain: true, identity: "googlebot" }));
    expect(decision.action).toBe("allow");
  });
});

/**
 * Replacing rules while the process runs.
 *
 * The dashboard's editor is the caller this exists for, so the tests are written from
 * its point of view: what an operator can change, what they cannot, and what happens
 * to a rule that could not have been sent over HTTP in the first place.
 */
describe("runtime policy replacement", () => {
  it("swaps the rule list and evaluates the new one immediately", () => {
    const policy = new Policy({ rules: [{ id: "tag-all", match: {}, action: "tag" }], defaultAction: "allow" });
    expect(policy.decide(assessment()).rule).toBe("tag-all");

    policy.replaceRules([{ id: "log-all", match: {}, action: "log" }]);
    expect(policy.decide(assessment()).rule).toBe("log-all");
    expect(policy.ruleIds).toEqual(["log-all"]);
  });

  it("exposes the rule definitions, not just their ids", () => {
    const rules = [{ id: "block-scanners", match: { botClass: "scanner" as const, certain: true }, action: "block" as const }];
    expect(new Policy({ rules }).rules[0]?.match).toEqual({ botClass: "scanner", certain: true });
  });

  // The guard is the library's central promise. A caller who can reach `replaceRules`
  // still cannot reach this, which is what makes an editor safe to expose at all.
  it("keeps the guard settings a replacement cannot touch", () => {
    const policy = new Policy({ rules: [], falsePositivePolicy: "strict", fallbackAction: "challenge" });
    policy.replaceRules([{ id: "block-suspected", match: { verdict: "suspected-bot" }, action: "block" }]);

    const decision = policy.decide(assessment({ verdict: "suspected-bot", score: 95, certain: false }));
    expect(decision.action).toBe("challenge");
    expect(decision.downgradedFrom).toBe("block");
    expect(policy.describe().falsePositivePolicy).toBe("strict");
  });
});

/**
 * Changing the guard at runtime.
 *
 * `replaceRules` deliberately cannot reach these, and that has not changed: this is a
 * second, separate method, so "may edit the rules" and "may change what a rule is
 * allowed to do" stay different powers. What is tested here is that the second one
 * validates whole — a rejected change leaves the guard exactly as it was — and that
 * two settings are refused outright because they would leave the guard switched on and
 * doing nothing.
 */
/**
 * Challenges that were never answered.
 *
 * A field that existed on `ActorState` and which nothing wrote or read — the same shape
 * `updateCrawlerRanges()` was in before anything called it. It is a rule rather than
 * evidence on purpose: one abandoned challenge is a person having a moment, and what
 * repeated abandonment means depends on traffic the library cannot see.
 */
describe("matching on unanswered challenges", () => {
  const rules = [{ id: "refusers", match: { minUnsolvedChallenges: 3 }, action: "rate-limit" as const }];
  const withUnsolved = (count: number, overrides: Partial<Assessment> = {}): Assessment => {
    const base = assessment(overrides);
    return { ...base, actor: { ...base.actor, unsolvedChallenges: count } };
  };

  it("fires only once the count is reached", () => {
    const policy = new Policy({ rules, defaultAction: "allow" });
    expect(policy.decide(withUnsolved(2)).rule).toBe("default");
    expect(policy.decide(withUnsolved(3)).rule).toBe("refusers");
  });

  it("is a rule about the actor rather than about the request", () => {
    const policy = new Policy({ rules, defaultAction: "allow" });
    // Nothing about this request is suspicious. The history is the whole case.
    expect(policy.decide(withUnsolved(5, { verdict: "unknown", certain: false, score: 0 })).action).toBe("rate-limit");
  });
});

describe("runtime guard replacement", () => {
  it("changes how far a rule may go, from the next decision on", () => {
    const policy = new Policy({ rules: [{ id: "block-suspected", match: { verdict: "suspected-bot" }, action: "block" }], falsePositivePolicy: "strict" });
    expect(policy.decide(assessment({ verdict: "suspected-bot", score: 95, certain: false })).action).toBe("challenge");

    policy.replaceGuard({ falsePositivePolicy: "aggressive" });
    expect(policy.decide(assessment({ verdict: "suspected-bot", score: 95, certain: false })).action).toBe("block");
  });

  it("leaves the fields it was not given alone", () => {
    const policy = new Policy({ falsePositivePolicy: "strict", fallbackAction: "delay", terminalScoreThreshold: 70 });
    policy.replaceGuard({ falsePositivePolicy: "balanced" });
    expect(policy.describeGuard()).toEqual({ falsePositivePolicy: "balanced", fallbackAction: "delay", defaultAction: "allow", terminalScoreThreshold: 70 });
  });

  /**
   * A terminal fallback is the one setting that makes the guard a liar: every downgrade
   * would deny the request it stepped in to protect, and the decision would still be
   * recorded as a guard stop — so the metric that exists to catch this would report
   * success.
   */
  it("refuses a terminal fallback", () => {
    const policy = new Policy();
    for (const fallbackAction of ["block", "drop", "redirect"] as const) {
      expect(() => policy.replaceGuard({ fallbackAction })).toThrow(/fallbackAction cannot be/);
    }
  });

  it("refuses a threshold that would let balanced mode deny on any score at all", () => {
    const policy = new Policy();
    expect(() => policy.replaceGuard({ terminalScoreThreshold: 0 })).toThrow(/between 1 and 100/);
    expect(() => policy.replaceGuard({ terminalScoreThreshold: 101 })).toThrow(/between 1 and 100/);
  });

  it("refuses a mode or an action it has never heard of", () => {
    const policy = new Policy();
    expect(() => policy.replaceGuard({ falsePositivePolicy: "permissive" as never })).toThrow(/Unknown falsePositivePolicy/);
    expect(() => policy.replaceGuard({ defaultAction: "ban" as never })).toThrow(/Unknown defaultAction/);
  });

  it("applies whole or not at all", () => {
    const policy = new Policy({ falsePositivePolicy: "strict" });
    expect(() => policy.replaceGuard({ falsePositivePolicy: "aggressive", fallbackAction: "block" })).toThrow();
    expect(policy.describeGuard().falsePositivePolicy).toBe("strict");
  });
});

/**
 * One test per preset, pinning the thing that makes it different from its neighbours.
 *
 * Not coverage for its own sake: each of these is a claim the preset's documentation
 * makes, and documentation that drifts from the rules is worse than none — somebody
 * chooses a policy by reading it.
 */
describe("what each preset is for", () => {
  function decide(rules: Parameters<typeof Policy.prototype.replaceRules>[0], overrides: Partial<Assessment> = {}): Decision {
    return new Policy({ rules, defaultAction: "allow" }).decide(assessment(overrides));
  }

  const aiCrawler = {
    verdict: "confirmed-bot" as const,
    botClass: "declared-bot" as const,
    certain: true,
    identity: "gptbot",
    evidence: [{ detector: "self-identified", summary: "GPTBot", direction: "bot" as const, certainty: "certain" as const, identity: "gptbot", metadata: { category: "ai" }, deterministicBasis: "declared" }],
  };

  it("every preset gives its rules unique ids", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const ids = preset().map((rule) => rule.id);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });

  it("allow-crawlers allows a declared benign crawler outright", () => {
    const feedReader = {
      verdict: "confirmed-bot" as const,
      botClass: "declared-bot" as const,
      certain: true,
      identity: "feedly",
      evidence: [{ detector: "self-identified", summary: "Feedly", direction: "bot" as const, certainty: "certain" as const, identity: "feedly", metadata: { category: "feed" }, deterministicBasis: "declared" }],
    };
    expect(decide(allowCrawlers(), feedReader).action).toBe("allow");
    // And it still refuses the three things that are proven and cannot be anything else.
    expect(decide(allowCrawlers(), { verdict: "confirmed-bot", botClass: "scanner", certain: true }).action).toBe("block");
  });

  // The split the preset exists to draw: the same operator's training crawler and its
  // fetch-for-a-user client are different jobs and get different answers.
  it("decline-ai-training blocks the trainer and serves the citation", () => {
    expect(decide(declineAiTraining(), aiCrawler).action).toBe("block");

    const onBehalfOfAPerson = {
      ...aiCrawler,
      identity: "chatgpt-user",
      evidence: [{ detector: "self-identified", summary: "ChatGPT-User", direction: "bot" as const, certainty: "certain" as const, identity: "chatgpt-user", metadata: { category: "ai" }, deterministicBasis: "declared" }],
    };
    expect(decide(declineAiTraining(), onBehalfOfAPerson).action).toBe("tag");
  });

  it("decline-ai-training keeps the search crawler it exists to keep", () => {
    const googlebot = {
      verdict: "verified-bot" as const,
      botClass: "verified-bot" as const,
      certain: true,
      identity: "googlebot",
      evidence: [{ detector: "crawler-verification", summary: "confirmed", direction: "bot" as const, certainty: "certain" as const, identity: "googlebot", metadata: { category: "search" }, deterministicBasis: "fcrdns" }],
    };
    expect(decide(declineAiTraining(), googlebot).action).toBe("allow");
  });

  // The whole point of the API preset, and the rule people copy in from a content
  // policy without noticing what it does to their customers' scripts.
  it("protect-api never challenges anybody", () => {
    for (const rule of protectApi()) expect(rule.action, rule.id).not.toBe("challenge");

    const suspected = decide(protectApi(), { verdict: "suspected-bot", score: 95, certain: false });
    expect(suspected.action).toBe("rate-limit");

    // A bare HTTP client is the normal case on an API, not a suspicious one.
    const client = decide(protectApi(), { verdict: "confirmed-bot", botClass: "http-client", certain: true });
    expect(client.action).toBe("tag");
  });

  it("under-attack lowers the challenge bar without lowering the guard", () => {
    const policy = new Policy({ rules: underAttack(), defaultAction: "allow" });

    const mildlySuspicious = policy.decide(assessment({ verdict: "suspected-bot", score: 45, certain: false }));
    expect(mildlySuspicious.action).toBe("challenge");

    // Even at 95 it is a challenge, because unproven evidence may go no further —
    // an incident is exactly when somebody reaches for a block and the guard is
    // exactly what stops them.
    const verySuspicious = policy.decide(assessment({ verdict: "suspected-bot", score: 95, certain: false }));
    expect(verySuspicious.action).toBe("challenge");
    expect(verySuspicious.downgradedFrom).toBeUndefined();
  });

  it("under-attack still allows a confirmed crawler and a vouched-for person", () => {
    expect(decide(underAttack(), { verdict: "verified-bot", botClass: "verified-bot", certain: true }).action).toBe("allow");
    expect(decide(underAttack(), { verdict: "human", botClass: "human", certain: true }).action).toBe("allow");
  });

  it("puts a rate limit on everyone under attack, including traffic it likes", () => {
    expect(decide(underAttack(), { verdict: "unknown", certain: false }).action).toBe("rate-limit");
  });

  // The claim the preset is built on: an identity is served because it was checked,
  // never because it was claimed — however honest the claim looks.
  it("indexers-only separates a confirmed indexer from a claimed one", () => {
    const googlebot = {
      verdict: "verified-bot" as const,
      botClass: "verified-bot" as const,
      certain: true,
      identity: "googlebot",
      evidence: [{ detector: "crawler-verification", summary: "confirmed", direction: "bot" as const, certainty: "certain" as const, identity: "googlebot", metadata: { category: "search" }, deterministicBasis: "fcrdns" }],
    };
    expect(decide(indexersOnly(), googlebot).action).toBe("allow");

    // Slack publishes nothing to check this against, so it can never be verified.
    const slackbot = {
      verdict: "confirmed-bot" as const,
      botClass: "declared-bot" as const,
      certain: true,
      identity: "slackbot",
      evidence: [{ detector: "self-identified", summary: "Slackbot", direction: "bot" as const, certainty: "certain" as const, identity: "slackbot", metadata: { category: "social" }, deterministicBasis: "declared" }],
    };
    const declined = decide(indexersOnly(), slackbot);
    expect(declined.action).toBe("block");
    expect(declined.rule, "the rule to lift when link previews matter more").toBe("unverifiable-indexer-block");
  });

  it("indexers-only refuses a confirmed crawler that is not indexing", () => {
    const verifiedTrainer = {
      verdict: "verified-bot" as const,
      botClass: "verified-bot" as const,
      certain: true,
      identity: "claudebot",
      evidence: [{ detector: "crawler-verification", summary: "confirmed", direction: "bot" as const, certainty: "certain" as const, identity: "claudebot", metadata: { category: "ai" }, deterministicBasis: "fcrdns" }],
    };
    expect(decide(indexersOnly(), verifiedTrainer).rule).toBe("non-indexing-crawler-block");
  });

  // The preset asks for exactly what the guard permits, so its blocks are decisions
  // rather than downgrades. A rule asking to block on suspicion would land here as a
  // guard stop on every suspicious request, which is noise, not strictness.
  it("indexers-only challenges suspicion rather than asking for a block", () => {
    const policy = new Policy({ rules: indexersOnly(), defaultAction: "allow" });
    const decision = policy.decide(assessment({ verdict: "suspected-bot", score: 95, certain: false }));
    expect(decision.action).toBe("challenge");
    expect(decision.downgradedFrom).toBeUndefined();
  });
});
