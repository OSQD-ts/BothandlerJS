import { describe, expect, it } from "vitest";
import { BotHandler, createFacts } from "../src/index.js";
import type { Detector } from "../src/detectors/types.js";
import type { Evidence } from "../src/types.js";

/**
 * Running a detector without letting it decide.
 *
 * The point of shadow mode is a promise, and the promise is negative: a shadowed detector
 * changes *nothing*. So most of what follows is about the ways a piece of evidence can
 * reach a verdict, and about each of them being closed — not about the feature working in
 * the ordinary case, which is the easy half.
 *
 * The reason it is not implemented as a weight of zero is the first test below. A weight
 * is consulted by the probabilistic path, and `certain` evidence does not go down the
 * probabilistic path: it short-circuits everything and returns `confirmed-bot` on its own.
 * A shadowed detector emitting `certain` would therefore have blocked people with its
 * weight sitting at zero the whole time.
 */
const CURL = { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" };
const BROWSER = {
  host: "shop.test",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-GB,en;q=0.9",
};

function shouting(id: string, evidence: Partial<Evidence> = {}): Detector {
  return {
    id,
    description: `Says the same thing about everything, for ${id}`,
    cost: "cheap",
    stage: "always",
    inspect: (): Evidence => ({
      detector: id,
      summary: "everything is a bot",
      direction: "bot",
      certainty: "strong",
      botClass: "scraper",
      ...evidence,
    }),
  };
}

const request = (headers: Record<string, string> = BROWSER, ip = "203.0.113.7") =>
  createFacts({ method: "GET", url: "/", headers, ip });

describe("a detector that has been shadowed", () => {
  /**
   * The whole reason this is not a weight.
   *
   * `certain` evidence never reaches the arithmetic — it returns `confirmed-bot`
   * immediately, which is what makes a terminal action permissible. A shadowed detector
   * emitting it must be unable to do that, and setting its weight to zero would not have
   * touched it.
   */
  it("cannot prove anything, even emitting certain evidence", async () => {
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      detectors: [
        shouting("loud", {
          certainty: "certain",
          deterministicBasis: "It says so.",
          botClass: "automation",
        }),
      ],
      shadowDetectors: ["loud"],
    });

    const assessment = await handler.assess(request());
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.certain, "a terminal action is gated on this flag").toBe(false);
    expect(assessment.score).toBe(0);
    expect(assessment.botClass).toBe("unknown");
    expect(assessment.evidence).toEqual([]);
    expect(assessment.shadowEvidence.map((item) => item.detector)).toEqual(["loud"]);
  });

  it("does not establish an identity", async () => {
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      detectors: [shouting("loud", { certainty: "certain", deterministicBasis: "It says so.", identity: "googlebot", botClass: "verified-bot" })],
      shadowDetectors: ["loud"],
    });
    const assessment = await handler.assess(request());
    expect(assessment.identity).toBeUndefined();
    expect(assessment.verdict).toBe("unknown");
  });

  /** A rule reading evidence must not see it either — that is the other way in. */
  it("cannot be matched by a rule", async () => {
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      detectors: [shouting("loud")],
      shadowDetectors: ["loud"],
      rules: [{ id: "on-loud", match: { detector: "loud" }, action: "block", reason: "the shadowed detector fired" }],
    });
    const { decision } = await handler.handle(request());
    expect(decision.action, "a rule that reads a shadowed detector matches nothing").not.toBe("block");
    expect(decision.rule).not.toBe("on-loud");
  });

  it("does not push the score across the suspect threshold", async () => {
    const detectors = [shouting("a"), shouting("b")];
    const shadowed = new BotHandler({ onWarning: () => {}, metrics: false, detectors, shadowDetectors: ["a", "b"] });
    const open = new BotHandler({ onWarning: () => {}, metrics: false, detectors });
    expect((await open.assess(request())).verdict, "the same detectors, counted").toBe("suspected-bot");
    expect((await shadowed.assess(request())).verdict).toBe("unknown");
  });

  /** Human-pointing evidence is shadowed the same way: it cannot rebut, either. */
  it("cannot rebut a real signal either", async () => {
    const vouching: Detector = {
      id: "vouch",
      description: "Insists everything is a person",
      cost: "cheap",
      stage: "always",
      inspect: (): Evidence => ({
        detector: "vouch",
        summary: "it is a person",
        direction: "human",
        certainty: "certain",
        deterministicBasis: "It says so.",
      }),
    };
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, extraDetectors: [vouching], shadowDetectors: ["vouch"] });
    const assessment = await handler.assess(request(CURL));
    expect(assessment.verdict, "curl is still curl").toBe("confirmed-bot");
    expect(assessment.humanEvidence.some((item) => item.detector === "vouch")).toBe(false);
    expect(assessment.shadowEvidence.some((item) => item.detector === "vouch")).toBe(true);
  });
});

describe("what shadowing reports", () => {
  it("says what the verdict would have been", async () => {
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, detectors: [shouting("a"), shouting("b")], shadowDetectors: ["a", "b"] });
    const assessment = await handler.assess(request());
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.shadowVerdict?.verdict, "and this is the number the decision is made on").toBe("suspected-bot");
    expect(assessment.shadowVerdict?.score).toBeGreaterThan(assessment.score);
  });

  it("says nothing at all when the shadowed detectors found nothing", async () => {
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, shadowDetectors: ["cadence"] });
    const assessment = await handler.assess(request());
    expect(assessment.shadowEvidence).toEqual([]);
    // Absent rather than "same as the real one": there was no second pass to report.
    expect(assessment.shadowVerdict).toBeUndefined();
  });

  it("counts firings and verdict changes apart from the real ones", async () => {
    const handler = new BotHandler({ onWarning: () => {}, detectors: [shouting("a"), shouting("b")], shadowDetectors: ["a", "b"] });
    await handler.assess(request());
    const metrics = handler.metrics();
    expect(metrics?.shadowFirings["a"]).toBe(1);
    expect(metrics?.shadowFirings["b"]).toBe(1);
    expect(metrics?.detectorFirings["a"], "not counted as a firing that decided anything").toBeUndefined();
    expect(metrics?.detectorFirings["b"]).toBeUndefined();
    expect(metrics?.verdicts["unknown"], "and the real verdict is the one that was recorded").toBe(1);
    expect(metrics?.shadowChanges["suspected-bot"], "which they would have moved").toBe(1);
  });

  it("charts nothing under shadow when nothing is shadowed", async () => {
    const handler = new BotHandler({ onWarning: () => {} });
    await handler.assess(request(CURL));
    const text = handler.prometheus() ?? "";
    expect(text).not.toContain("shadow_firings_total");
  });
});

describe("configuring it", () => {
  it("warns about an id that names no detector, because a typo here is silent", () => {
    const warnings: string[] = [];
    new BotHandler({ metrics: false, shadowDetectors: ["path-noveltyy"], onWarning: (message) => warnings.push(message) });
    expect(warnings.join(" ")).toContain("path-noveltyy");
  });

  /**
   * The check has to run after the handler has finished installing detectors, not while
   * the config is being resolved. The site, marker and challenge detectors arrive with
   * the source they read — and they are exactly the ones with thresholds worth shadowing,
   * so validating too early would have warned about every legitimate use of this.
   */
  it("does not warn about a detector that arrives with the source it reads", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({
      metrics: false,
      site: { warmupRequests: 10 },
      shadowDetectors: ["path-novelty"],
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings.join(" ")).not.toContain("path-novelty");
    // And it really is shadowed, rather than merely unremarked-upon.
    for (let i = 0; i < 30; i++) await handler.assess(createFacts({ method: "GET", url: `/warm/${i % 5}`, headers: BROWSER, ip: `192.0.2.${i + 1}` }));
    let last = await handler.assess(request());
    for (let i = 0; i < 30; i++) last = await handler.assess(createFacts({ method: "GET", url: `/nobody-asks/${i}`, headers: BROWSER, ip: "203.0.113.90" }));
    expect(last.evidence.some((item) => item.detector === "path-novelty")).toBe(false);
    expect(last.shadowEvidence.some((item) => item.detector === "path-novelty"), "it ran, and it landed in the shadow list").toBe(true);
  });
});
