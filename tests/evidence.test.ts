import { describe, expect, it } from "vitest";
import { combineEvidence, noisyOr, weightOf } from "../src/evidence.js";
import { safeSummary } from "../src/internal/text.js";
import { BotHandler } from "../src/index.js";
import { createFacts } from "../src/facts.js";
import type { Assessment, Evidence } from "../src/types.js";

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

/**
 * Evidence quotes the client - the path it asked for, the header it sent - and that
 * quotation is then printed to a log file, a terminal and a JSON feed. Each of those
 * reads some characters as instructions rather than as letters: a carriage return and a
 * newline end a log line, and let the next one be written by whoever sent the request;
 * an escape sequence repaints a terminal. This was a live hole, not a hypothetical one.
 * A URL containing CRLF came back inside an `id-enumeration` summary exactly as sent.
 */
describe("quoting the client instead of obeying it", () => {
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  const BAD = "\ufffd";

  it("leaves ordinary prose exactly as it was", () => {
    const plain = "40 requests to /api/v2/orders/# covering 100% of a 40-wide range of ids";
    expect(safeSummary(plain)).toBe(plain);
    expect(safeSummary("naive cafe - nihongo \u{1f389}")).toBe("naive cafe - nihongo \u{1f389}");
  });

  it("neutralises the characters that end a log line", () => {
    expect(safeSummary("/a\r\nSEVERE: nothing to see here")).toBe(`/a${BAD}${BAD}SEVERE: nothing to see here`);
    expect(safeSummary("/a\u0000b")).toBe(`/a${BAD}b`);
  });

  it("neutralises the sequences that repaint a terminal", () => {
    expect(safeSummary("/a\u001b[31m\u001b[2Jgone")).toBe(`/a${BAD}[31m${BAD}[2Jgone`);
    expect(safeSummary("/a\u007fx")).toBe(`/a${BAD}x`);
  });

  it("keeps whole characters whole and drops the halves of ones that are not", () => {
    expect(safeSummary("\u{1f389}")).toBe("\u{1f389}");
    expect(safeSummary("a\ud800b")).toBe(`a${BAD}b`);
    expect(safeSummary("a\udc00")).toBe(`a${BAD}`);
    expect(JSON.stringify(safeSummary("a\ud800"))).not.toContain("d800");
  });

  it("caps a summary no matter who wrote the detector", () => {
    const huge = safeSummary("x".repeat(10_000));
    expect(huge.length).toBe(513);
    expect(huge.endsWith("\u2026")).toBe(true);
  });

  it("cleans what a real request puts into real evidence", async () => {
    const handler = new BotHandler({ preset: "protect-api", onWarning: () => {} });
    const hostile = "/admin\r\nSEVERE: forged \u001b[31m/";
    let evidence: Assessment["evidence"] = [];
    for (let i = 0; i < 40; i++) {
      const assessment = await handler.assess(
        createFacts({ method: "GET", url: `${hostile}${i}`, headers: { host: "s.test", "user-agent": "curl/8.4.0" }, ip: "203.0.113.9" }),
      );
      evidence = assessment.evidence;
    }
    const walk = evidence.find((item) => item.summary.includes("range of ids"));
    // The detector still fires and still names the shape, which is the point of it.
    expect(walk).toBeDefined();
    expect(walk?.summary).toContain("40 requests to /admin");
    expect(walk?.summary).not.toMatch(CONTROL);
  });

  it("cleans a summary a detector this library did not write returns", async () => {
    const handler = new BotHandler({
      onWarning: () => {},
      detectors: [
        {
          id: "third-party",
          description: "a detector written by somebody else",
          cost: "cheap",
          inspect: () => ({
            detector: "third-party",
            summary: "wrote\r\nthis itself",
            direction: "bot" as const,
            certainty: "certain" as const,
            deterministicBasis: "and\r\nthis basis",
          }),
        },
      ],
    });
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.test" }, ip: "203.0.113.10" }));
    const item = assessment.evidence.find((entry) => entry.detector === "third-party");
    expect(item?.summary).toBe(`wrote${BAD}${BAD}this itself`);
    expect(item?.deterministicBasis).toBe(`and${BAD}${BAD}this basis`);
  });

  it("does not rewrite a detector's own frozen result", async () => {
    // A detector may return a shared constant. Rebuilding rather than mutating in place
    // is what keeps this from throwing.
    const constant = Object.freeze({
      detector: "frozen",
      summary: "clean",
      direction: "bot" as const,
      certainty: "moderate" as const,
    });
    const handler = new BotHandler({ onWarning: () => {}, detectors: [{ id: "frozen", description: "returns a shared constant", cost: "cheap", inspect: () => constant }] });
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.test" }, ip: "203.0.113.11" }));
    expect(assessment.evidence.find((entry) => entry.detector === "frozen")?.summary).toBe("clean");
    expect(constant.summary).toBe("clean");
  });

  it("cleans an operator's label as well", async () => {
    const handler = new BotHandler({ onWarning: () => {} });
    const facts = createFacts({ method: "GET", url: "/", headers: { host: "s.test" }, ip: "203.0.113.12" });
    await handler.assess(facts);
    handler.labelActor(handler.actorKeyFor(facts), "known\r\nscraper\u001b[31m");
    const actor = handler.registry.top(1, Date.now())[0];
    expect(actor?.label).toBe(`known${BAD}${BAD}scraper${BAD}[31m`);
  });
});
