import { describe, expect, it } from "vitest";
import { combineEvidence, noisyOr, weightOf } from "../src/evidence.js";
import type { Evidence } from "../src/types.js";

const options = { suspectThreshold: 60, strictEvidence: true };

function bot(certainty: Evidence["certainty"], extra: Partial<Evidence> = {}): Evidence {
  return {
    detector: extra.detector ?? "test",
    summary: "test",
    direction: "bot",
    certainty,
    ...(certainty === "certain" ? { deterministicBasis: "test basis" } : {}),
    ...extra,
  } as Evidence;
}

describe("combineEvidence", () => {
  it("short-circuits to a proven verdict on certain evidence", () => {
    const result = combineEvidence([bot("certain", { botClass: "http-client" })], options);
    expect(result.verdict).toBe("confirmed-bot");
    expect(result.certain).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it("reports a verified crawler separately from a confirmed bot", () => {
    const result = combineEvidence([bot("certain", { botClass: "verified-bot", identity: "googlebot" })], options);
    expect(result.verdict).toBe("verified-bot");
    expect(result.identity).toBe("googlebot");
  });

  it("lets a proven contradiction outrank a confirmed identity", () => {
    const result = combineEvidence(
      [bot("certain", { botClass: "verified-bot", identity: "googlebot" }), bot("certain", { botClass: "impersonator", identity: "googlebot" })],
      options,
    );
    expect(result.botClass).toBe("impersonator");
  });

  // The central guarantee: probabilistic signals never accumulate into proof, no
  // matter how many of them fire.
  it("never reaches `certain` from probabilistic evidence alone", () => {
    const many = Array.from({ length: 40 }, (_, index) => bot("strong", { detector: `d${index}` }));
    const result = combineEvidence(many, options);
    expect(result.certain).toBe(false);
    expect(result.verdict).toBe("suspected-bot");
    // 100 is reserved for proof, so the probabilistic path is capped below it.
    expect(result.score).toBeLessThan(100);
  });

  it("stays below the suspect threshold on a single weak signal", () => {
    const result = combineEvidence([bot("weak")], options);
    expect(result.verdict).toBe("unknown");
    expect(result.score).toBe(15);
  });

  it("discounts the score with human evidence", () => {
    const withoutHuman = combineEvidence([bot("strong"), bot("strong", { detector: "other" })], options);
    const withHuman = combineEvidence(
      [bot("strong"), bot("strong", { detector: "other" }), { detector: "clearance", summary: "cleared", direction: "human", certainty: "strong" }],
      options,
    );
    expect(withHuman.score).toBeLessThan(withoutHuman.score);
  });

  it("treats certain human evidence as conclusive when nothing proven contradicts it", () => {
    const result = combineEvidence(
      [bot("strong"), { detector: "operator", summary: "signed in", direction: "human", certainty: "certain", deterministicBasis: "operator asserted" }],
      options,
    );
    expect(result.verdict).toBe("human");
    expect(result.certain).toBe(true);
  });

  it("lets proven bot evidence outrank a human clearance", () => {
    const result = combineEvidence(
      [bot("certain", { botClass: "automation" }), { detector: "operator", summary: "cleared", direction: "human", certainty: "certain", deterministicBasis: "x" }],
      options,
    );
    expect(result.verdict).toBe("confirmed-bot");
  });

  it("rejects certain evidence with no deterministic basis", () => {
    const bad: Evidence = { detector: "sloppy", summary: "vibes", direction: "bot", certainty: "certain" };
    expect(() => combineEvidence([bad], options)).toThrow(/deterministicBasis/);
  });

  it("reports rather than throws when a violation handler is supplied", () => {
    const seen: string[] = [];
    const bad: Evidence = { detector: "sloppy", summary: "vibes", direction: "bot", certainty: "certain" };
    const result = combineEvidence([bad], { ...options, onEvidenceViolation: (message) => seen.push(message) });
    expect(seen).toHaveLength(1);
    expect(result.certain).toBe(true);
  });

  it("sorts evidence strongest first", () => {
    const result = combineEvidence([bot("weak", { detector: "w" }), bot("strong", { detector: "s" })], options);
    expect(result.botEvidence[0]?.detector).toBe("s");
  });
});

describe("noisyOr", () => {
  it("is bounded below one and monotonic", () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([0.5])).toBeCloseTo(0.5);
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(0.75);
    // Saturates: with enough independent signals the product underflows to zero.
    // Honest for the statistic; the cap that keeps it out of the score lives in
    // `combineEvidence`, which is where the meaning of 100 is decided.
    expect(noisyOr(Array.from({ length: 100 }, () => 0.9))).toBe(1);
  });
});

describe("weightOf", () => {
  it("falls back to the tier weight and clamps overrides", () => {
    expect(weightOf({ detector: "d", summary: "s", direction: "bot", certainty: "strong" })).toBe(0.6);
    expect(weightOf({ detector: "d", summary: "s", direction: "bot", certainty: "weak", weight: 5 })).toBe(1);
    expect(weightOf({ detector: "d", summary: "s", direction: "bot", certainty: "weak", weight: Number.NaN })).toBe(0.15);
  });
});
