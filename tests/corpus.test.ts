import { describe, expect, it } from "vitest";
import { BotHandler, defaultDetectors, trapDetector } from "../src/index.js";
import { PRESETS } from "../src/policy/presets.js";
import { CORPUS, assertCorpusIntegrity, casesByAudience } from "../src/corpus/index.js";
import { runCorpus } from "../src/corpus/runner.js";
import type { PresetName } from "../src/policy/presets.js";
import type { RunnerOptions, Scorecard } from "../src/corpus/runner.js";

/**
 * The traffic corpus, run against every shipped policy.
 *
 * One assertion here matters more than all the others: **no case marked as a person
 * is ever denied service, under any preset.** Everything else in this file is
 * diagnostics; that one is the library's central claim, checked against two hundred
 * shapes of real traffic rather than against an argument.
 */

const TRAP_FIELD = "company_url";

function runner(preset: PresetName, overrides: Partial<RunnerOptions> = {}): Promise<Scorecard> {
  return runCorpus({
    provides: [`trap-form-field:${TRAP_FIELD}`, "denylist", "datacenter-ranges"],
    create: ({ resolver, clock }) =>
      new BotHandler({
        preset,
        resolver,
        clock,
        detectors: defaultDetectors().map((detector) => (detector.id === "trap" ? trapDetector({ formFields: [TRAP_FIELD] }) : detector)),
        // Documentation ranges only. The datacenter set deliberately covers the
        // corpus's VPN and privacy-relay cases: people in hosting address space are
        // the population that signal is capped for.
        datacenterRanges: ["192.0.2.128/25"],
        denylist: ["203.0.113.240/28"],
        challenge: { secrets: ["corpus-secret-used-only-by-the-traffic-corpus-test"] },
      }),
    ...overrides,
  });
}

function describeFailures(scorecard: Scorecard): string {
  return scorecard.results
    .filter((result) => result.failures.length > 0)
    .map((result) => `\n  ${result.case.id} (${result.case.title})\n    ${result.failures.join("\n    ")}`)
    .join("");
}

describe("corpus integrity", () => {
  it("has unique, well-formed, sourced cases", () => {
    expect(() => assertCorpusIntegrity()).not.toThrow();
  });

  it("is large enough to be worth trusting", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(150);
    expect(casesByAudience("human").length).toBeGreaterThanOrEqual(40);
  });

  it("every case records where its shape came from", () => {
    for (const item of CORPUS) {
      expect(item.provenance.length, `${item.id} has no provenance`).toBeGreaterThan(20);
    }
  });
});

describe("the reference policy (protect-content)", () => {
  it("classifies every case as the corpus expects", async () => {
    const scorecard = await runner("protect-content");
    expect(scorecard.failed, describeFailures(scorecard)).toBe(0);
  });

  it("exercises every detector it installs", async () => {
    const scorecard = await runner("protect-content");
    expect(scorecard.unexercisedDetectors, "an untested detector regresses unnoticed").toEqual([]);
  });

  it("proves most genuinely automated traffic", async () => {
    const scorecard = await runner("protect-content");
    const { total, proven } = scorecard.provenAutomation;
    // Not all of it, and deliberately so — see the evasion ladder, where the top
    // rungs are expected to remain unproven because they are not provable.
    expect(proven / total).toBeGreaterThan(0.8);
  });
});

describe("the no-false-positive guarantee", () => {
  // The claim, checked against every shipped policy rather than asserted once.
  for (const preset of Object.keys(PRESETS) as PresetName[]) {
    it(`denies no person under "${preset}"`, async () => {
      const scorecard = await runner(preset, { assertActions: false });
      const denied = scorecard.falsePositives.map((result) => `${result.case.id}: ${result.failures.join("; ")}`);
      expect(denied, `people denied service by the "${preset}" policy`).toEqual([]);
    });
  }

  it("never reaches a proven bot verdict on a person", async () => {
    const scorecard = await runner("protect-content", { assertActions: false });
    const proven = scorecard.results
      .filter((result) => result.case.audience === "human" && result.skipped === undefined && result.case.selfDeclared === undefined)
      .filter((result) => result.final.assessment.certain && result.final.assessment.verdict !== "human")
      .map((result) => `${result.case.id} -> ${result.final.assessment.verdict}: ${result.final.assessment.evidence[0]?.summary}`);
    expect(proven, "certainty must never be reached about a person").toEqual([]);
  });

  it("holds for every request of a sequence, not only the last", async () => {
    const scorecard = await runner("protect-content", { assertActions: false });
    const multi = scorecard.results.filter((result) => result.case.audience === "human" && result.requests.length > 1);
    expect(multi.length).toBeGreaterThan(4);
    for (const result of multi) {
      if (result.case.selfDeclared !== undefined) continue;
      for (const [index, request] of result.requests.entries()) {
        expect(["block", "drop", "redirect"], `${result.case.id} request ${index + 1}`).not.toContain(request.decision.action);
      }
    }
  });
});

describe("the exemptions, kept countable", () => {
  // The guarantee is about guesses. A client that announces itself automated is not a
  // guess, and the handful of people whose software does that are listed rather than
  // quietly excluded — with a written reason each.
  it("exempts only a handful of people, each with a stated reason", async () => {
    const scorecard = await runner("protect-content", { assertActions: false });
    expect(scorecard.selfDeclaredHumans.length).toBeLessThanOrEqual(5);
    for (const result of scorecard.selfDeclaredHumans) {
      expect(result.case.selfDeclared!.length, `${result.case.id} needs a written reason`).toBeGreaterThan(60);
    }
  });
});

describe("policy shape", () => {
  it("monitor-only withholds nothing from anybody", async () => {
    const scorecard = await runner("monitor-only", { assertActions: false });
    for (const result of scorecard.results) {
      if (result.skipped !== undefined) continue;
      expect(["allow", "log", "tag"], `${result.case.id}`).toContain(result.final.decision.action);
    }
  });

  it("allows confirmed search crawlers rather than merely tolerating them", async () => {
    const scorecard = await runner("protect-content");
    for (const id of ["googlebot-verified", "bingbot-verified", "googlebot-smartphone-verified"]) {
      const result = scorecard.results.find((entry) => entry.case.id === id)!;
      expect(result.final.assessment.verdict, id).toBe("verified-bot");
      expect(result.final.decision.action, id).toBe("allow");
    }
  });

  // Two claims a preset's documentation makes, checked against real traffic rather
  // than against the rule list — a rule that says `rate-limit` still has to produce
  // one on a request that arrives.
  it("protect-api challenges nobody, whatever the traffic looks like", async () => {
    const scorecard = await runner("protect-api", { assertActions: false });
    const challenged = scorecard.results
      .filter((result) => result.skipped === undefined && result.final.decision.action === "challenge")
      .map((result) => result.case.id);
    expect(challenged, "an API client cannot solve a challenge; the preset must never issue one").toEqual([]);
  });

  it("under-attack denies nobody it cannot prove something about", async () => {
    const scorecard = await runner("under-attack", { assertActions: false });
    const denied = scorecard.results
      .filter((result) => result.skipped === undefined)
      .filter((result) => ["block", "drop", "redirect"].includes(result.final.decision.action))
      .filter((result) => !result.final.assessment.certain)
      .map((result) => `${result.case.id} -> ${result.final.decision.rule}`);
    expect(denied, "the guard applies during an incident too").toEqual([]);
  });

  it("indexers-only serves no bot it has not confirmed", async () => {
    const scorecard = await runner("indexers-only", { assertActions: false });
    const served = scorecard.results
      .filter((result) => result.skipped === undefined && result.case.audience !== "human")
      .filter((result) => result.final.decision.action === "allow")
      .filter((result) => result.final.assessment.verdict !== "verified-bot")
      .map((result) => `${result.case.id} -> ${result.final.decision.rule}`);
    expect(served, "this preset serves crawlers it checked, never crawlers that claimed").toEqual([]);
  });

  // A finding from the corpus, kept as a regression test so the warning in the
  // preset's documentation stays true.
  it("protect-auth blocks your own infrastructure when applied site-wide", async () => {
    const scorecard = await runner("protect-auth", { assertActions: false });
    const blocked = scorecard.results
      .filter((result) => result.case.audience === "infrastructure" && result.skipped === undefined)
      .filter((result) => result.final.decision.action === "block")
      .map((result) => result.case.id);
    expect(blocked, "mount protect-auth on auth routes only — this is why").toContain("stripe-webhook");
  });

  it("under-attack refuses your own infrastructure, which is why its docs say to allowlist first", async () => {
    const scorecard = await runner("under-attack", { assertActions: false });
    const blocked = scorecard.results
      .filter((result) => result.case.audience === "infrastructure" && result.skipped === undefined)
      .filter((result) => result.final.decision.action === "block");
    expect(blocked.length, "allowlist your webhooks and probes before switching this on").toBeGreaterThan(0);
  });
});
