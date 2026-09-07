import { describe, expect, it } from "vitest";
import { BotHandler, TrafficAudit, createFacts } from "../src/index.js";
import { ManualClock } from "../src/internal/clock.js";
import { CHROME_HEADERS } from "./helpers.js";
import type { Assessment, TrafficAnomaly } from "../src/index.js";
import type { Decision } from "../src/policy/types.js";

/**
 * The audit, and the hooks it reports through.
 *
 * Everything here uses a manual clock. An audit is a statement about two stretches of
 * time, and a test that waited for real ones would be slow, flaky, and unable to say
 * anything about an hour-long baseline at all.
 */

function fakeAssessment(overrides: Partial<Assessment> = {}, at = 0): Assessment {
  return {
    requestId: `r${at}`,
    verdict: "unknown",
    botClass: "unknown",
    score: 0,
    confidence: 0,
    certain: false,
    evidence: [],
    humanEvidence: [],
    actor: { key: "203.0.113.1", requests: 1, distinctPaths: 1, distinctQueries: 0, queriesSaturated: false, methodsSeen: ["GET"], responses: 0, misses: 0, firstSeen: at, lastSeen: at, priorConfirmations: 0, unsolvedChallenges: 0, cleared: false },
    durationMs: 0.1,
    failures: [],
    facts: createFacts({ method: "GET", url: "/", headers: { host: "s.example" }, ip: "203.0.113.1", timestamp: at }),
    ...overrides,
  };
}

function decision(action: Decision["action"], overrides: Partial<Decision> = {}): Decision {
  return { action, rule: "test", reason: "test", params: {}, ...overrides };
}

/** Fills a stretch of time with traffic of a given bot share. */
function fill(audit: TrafficAudit, from: number, to: number, everyMs: number, botShare: number): void {
  let index = 0;
  for (let at = from; at < to; at += everyMs) {
    const isBot = index % 100 < botShare * 100;
    audit.record(fakeAssessment({ verdict: isBot ? "confirmed-bot" : "human", certain: isBot }, at));
    index++;
  }
}

describe("the audit windows", () => {
  it("compares the recent window against the stretch before it, not one containing it", () => {
    const now = 10_000_000;
    const audit = new TrafficAudit({ windowMs: 60_000, baselineMs: 600_000, clock: new ManualClock(now) });

    fill(audit, now - 660_000, now - 60_000, 1000, 0);      // baseline: all human
    fill(audit, now - 60_000, now, 1000, 1);                // window: all bots

    const { window, baseline } = audit.summary(now);
    // Both spans are whole numbers of buckets ending at the current bucket's far edge,
    // so each boundary can sit up to one bucket (6s here) from the requested one. What
    // must hold is that each span is the configured width, that they do not overlap,
    // and — the point of the whole design — that neither borrows the other's shape.
    expect(window.spanMs).toBe(60_000);
    expect(baseline.spanMs).toBe(600_000);
    expect(window.requests).toBeGreaterThanOrEqual(54);
    expect(window.requests).toBeLessThanOrEqual(60);
    expect(window.botShare).toBe(1);
    expect(baseline.requests).toBeGreaterThanOrEqual(594);
    // Not exactly zero: the bucket the boundary falls in belongs to one span or the
    // other in whole, so an edge bucket can carry a couple of the neighbour's
    // requests. A share of well under a percent is that granularity, not a leak.
    expect(baseline.botShare).toBeLessThan(0.01);
  });

  it("forgets a stretch older than the ring rather than growing", () => {
    const audit = new TrafficAudit({ windowMs: 60_000, baselineMs: 120_000 });
    fill(audit, 0, 60_000, 1000, 1);
    // Two hours later the old buckets have been reused, so nothing from them counts.
    const later = 7_200_000;
    expect(audit.summary(later).window.requests).toBe(0);
    expect(audit.summary(later).baseline.requests).toBe(0);
  });
});

describe("the shipped checks", () => {
  const now = 10_000_000;

  function audited(shape: (audit: TrafficAudit) => void, options = {}): TrafficAnomaly[] {
    const audit = new TrafficAudit({ windowMs: 60_000, baselineMs: 600_000, minSamples: 20, clock: new ManualClock(now), ...options });
    shape(audit);
    return audit.evaluate(now);
  }

  it("says nothing about a window that looks like its baseline", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.1);
      fill(audit, now - 60_000, now, 1000, 0.1);
    });
    expect(anomalies).toEqual([]);
  });

  it("catches automation taking over the traffic", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.05);
      fill(audit, now - 60_000, now, 1000, 0.8);
    });
    const spike = anomalies.find((anomaly) => anomaly.id === "bot-share-spike");
    expect(spike?.severity).toBe("critical");
    expect(spike?.ratio).toBeGreaterThan(2);
    expect(spike?.summary).toContain("Automated traffic is");
  });

  // The 3am problem: a ratio computed from four requests is arithmetic, not a signal.
  it("refuses to speak from a sample too small to mean anything", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.02);
      // Five requests, all bots.
      fill(audit, now - 5_000, now, 1000, 1);
    });
    expect(anomalies).toEqual([]);
  });

  it("catches a policy denying far more than it used to", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.5);
      fill(audit, now - 60_000, now, 1000, 0.5);
      for (let at = now - 60_000; at < now; at += 1000) audit.recordDecision(decision("block"), at);
    });
    expect(anomalies.some((anomaly) => anomaly.id === "denial-spike")).toBe(true);
  });

  it("catches the guard stopping rules it did not used to stop", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.5);
      fill(audit, now - 60_000, now, 1000, 0.5);
      for (let at = now - 60_000; at < now; at += 1000) audit.recordDecision(decision("challenge", { downgradedFrom: "block" }), at);
    });
    const stop = anomalies.find((anomaly) => anomaly.id === "guard-stop-spike");
    expect(stop?.summary).toContain("asking to deny requests the evidence does not prove");
  });

  it("catches human traffic falling away", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.1);   // 90% human
      fill(audit, now - 60_000, now, 1000, 0.99);            // almost none
    });
    expect(anomalies.some((anomaly) => anomaly.id === "human-share-drop")).toBe(true);
  });

  it("catches detection degrading, which is not about the traffic at all", () => {
    const anomalies = audited((audit) => {
      fill(audit, now - 660_000, now - 60_000, 1000, 0.1);
      for (let at = now - 60_000; at < now; at += 1000) {
        audit.record(fakeAssessment({ failures: [{ detector: "crawler-verification", reason: "timeout", message: "exceeded 300ms" }] }, at));
      }
    });
    expect(anomalies.some((anomaly) => anomaly.id === "detector-failures")).toBe(true);
  });

  it("says a thing once per cooldown, not once per check", () => {
    const audit = new TrafficAudit({ windowMs: 60_000, baselineMs: 600_000, minSamples: 20, cooldownMs: 900_000, clock: new ManualClock(now) });
    fill(audit, now - 660_000, now - 60_000, 1000, 0.05);
    fill(audit, now - 60_000, now, 1000, 0.9);

    expect(audit.evaluate(now).length).toBeGreaterThan(0);
    expect(audit.evaluate(now + 1000)).toEqual([]);

    // Past the cooldown, with traffic of the same shape, it speaks again — a spike
    // that is still going is worth repeating once every fifteen minutes, not once a
    // minute.
    const later = now + 1_000_000;
    fill(audit, later - 660_000, later - 60_000, 1000, 0.05);
    fill(audit, later - 60_000, later, 1000, 0.9);
    expect(audit.evaluate(later).length).toBeGreaterThan(0);
  });

  it("takes a check of your own, and survives one that throws", () => {
    const audit = new TrafficAudit({
      windowMs: 60_000,
      baselineMs: 600_000,
      minSamples: 1,
      clock: new ManualClock(now),
      checks: [
        {
          id: "explodes",
          description: "throws",
          evaluate() {
            throw new Error("bad check");
          },
        },
        {
          id: "mine",
          description: "fires whenever there is any traffic",
          evaluate({ window }) {
            return { id: "mine", severity: "info", metric: "requests", value: window.requests, baseline: 0, summary: `saw ${window.requests}` };
          },
        },
      ],
    });
    fill(audit, now - 60_000, now, 1000, 0);
    const anomalies = audit.evaluate(now);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.id).toBe("mine");
  });
});

describe("the engine's hooks", () => {
  async function assessed(handler: BotHandler, userAgent: string, path = "/"): Promise<void> {
    const facts = createFacts({
      method: "GET",
      url: path,
      headers: { ...CHROME_HEADERS, "user-agent": userAgent },
      ip: "203.0.113.5",
      protocol: "https",
      httpVersion: "1.1",
    });
    handler.decide(await handler.assess(facts));
  }

  it("calls the config handlers, which are the same mechanism as the emitter", async () => {
    const seen: string[] = [];
    const handler = new BotHandler({
      rules: [{ id: "block-clients", match: { botClass: "http-client", certain: true }, action: "block" }],
      onAssessment: () => seen.push("assessment"),
      onDecision: () => seen.push("decision"),
      onDenial: () => seen.push("denial"),
    });
    handler.on("denial", () => seen.push("denial-listener"));

    await assessed(handler, "curl/8.4.0");
    expect(seen).toEqual(["assessment", "decision", "denial", "denial-listener"]);
  });

  it("reports a guard stop separately from the decision it replaced", async () => {
    const downgrades: Array<{ decision: Decision }> = [];
    const handler = new BotHandler({
      rules: [{ id: "overreach", match: { verdict: "suspected-bot" }, action: "block" }],
      onDowngrade: (event) => downgrades.push(event),
    });

    // A Chrome string with nothing else a Chrome sends: suspected, never proven.
    await assessed(handler, CHROME_HEADERS["user-agent"]!);
    const facts = createFacts({ method: "GET", url: "/", headers: { host: "s.example", "user-agent": CHROME_HEADERS["user-agent"]!, accept: "*/*" }, ip: "203.0.113.6", protocol: "https", httpVersion: "1.1" });
    handler.decide(await handler.assess(facts));

    expect(downgrades).toHaveLength(1);
    expect(downgrades[0]?.decision.downgradedFrom).toBe("block");
    expect(downgrades[0]?.decision.action).not.toBe("block");
  });

  it("reports a rule set replaced at runtime", async () => {
    const changes: Array<{ rules: readonly string[] }> = [];
    const handler = new BotHandler({ onPolicyChange: (event) => changes.push(event) });
    handler.updatePolicy([{ id: "tag-all", match: {}, action: "tag" }]);
    expect(changes[0]?.rules).toEqual(["tag-all"]);
  });

  it("reports a detector that fails without letting it reach the request", async () => {
    const failures: Array<{ detector: string }> = [];
    const handler = new BotHandler({
      detectors: [
        {
          id: "broken",
          description: "throws",
          inspect() {
            throw new Error("boom");
          },
        },
      ],
      onDetectorFailure: (event) => failures.push(event),
      onError: () => {},
    });

    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.example" }, ip: "203.0.113.7" }));
    expect(failures[0]?.detector).toBe("broken");
    expect(assessment.verdict).toBe("unknown");
  });

  // A handler is somebody else's code on the request path. It gets one chance to
  // misbehave and no chance to take a request down with it.
  it("isolates a handler that throws", async () => {
    const errors: string[] = [];
    const handler = new BotHandler({
      onAssessment: () => {
        throw new Error("subscriber is broken");
      },
      onError: (_error, context) => errors.push(context.source),
    });
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.example" }, ip: "203.0.113.8" }));
    expect(assessment.verdict).toBe("unknown");
    expect(errors).toContain("event:assessment");
  });
});

describe("the audit on a handler", () => {
  it("watches real traffic and raises through the hook", async () => {
    const clock = new ManualClock(5_000_000);
    const anomalies: TrafficAnomaly[] = [];
    const handler = new BotHandler({
      clock,
      audit: { windowMs: 60_000, baselineMs: 600_000, minSamples: 20 },
      onAnomaly: (anomaly) => anomalies.push(anomaly),
    });

    // A quiet baseline of ordinary browsers, then a minute of curl.
    for (let at = clock.now() - 660_000; at < clock.now() - 60_000; at += 2000) {
      await handler.assess(createFacts({ method: "GET", url: "/", headers: CHROME_HEADERS, ip: "203.0.113.9", timestamp: at, protocol: "https", httpVersion: "1.1" }));
    }
    for (let at = clock.now() - 60_000; at < clock.now(); at += 1000) {
      await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.10", timestamp: at }));
    }

    const raised = handler.runAudit();
    expect(raised.some((anomaly) => anomaly.id === "bot-share-spike")).toBe(true);
    expect(anomalies).toEqual(raised);
  });

  it("can be switched off entirely", () => {
    expect(new BotHandler({ audit: false }).audit).toBeUndefined();
    expect(new BotHandler({ audit: false }).runAudit()).toEqual([]);
  });

  it("sends anomalies to configured sinks as well as to hooks", async () => {
    const delivered: Array<{ type: string; summary: string | undefined }> = [];
    const clock = new ManualClock(5_000_000);
    const handler = new BotHandler({
      clock,
      audit: { windowMs: 60_000, baselineMs: 600_000, minSamples: 5 },
      notifications: {
        sinks: [
          {
            id: "test",
            notify: (event) => {
              delivered.push({ type: event.type, summary: event.anomaly?.summary });
            },
          },
        ],
        filter: { types: ["anomaly"] },
        clock,
      },
    });

    for (let at = clock.now() - 660_000; at < clock.now() - 60_000; at += 2000) {
      await handler.assess(createFacts({ method: "GET", url: "/", headers: CHROME_HEADERS, ip: "203.0.113.11", timestamp: at, protocol: "https", httpVersion: "1.1" }));
    }
    for (let at = clock.now() - 60_000; at < clock.now(); at += 1000) {
      await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.12", timestamp: at }));
    }

    handler.runAudit();
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0]?.type).toBe("anomaly");
    expect(delivered[0]?.summary).toContain("Automated traffic");
  });
});

/**
 * The check that watches the mitigation rather than the traffic.
 *
 * Everything else in the audit asks whether the traffic changed shape. This asks
 * whether the challenges are landing on the right population — and a *high* number is
 * the bad direction, which is the opposite of what "solve rate" suggests to most
 * people.
 */
describe("the challenge solve rate", () => {
  function busy(options: { challenges: number; solved: number }): TrafficAudit {
    const clock = new ManualClock(1_700_000_000_000);
    const audit = new TrafficAudit({ clock, windowMs: 300_000, baselineMs: 600_000, minSamples: 5 });
    for (let i = 0; i < options.challenges; i++) {
      audit.record({ verdict: "suspected-bot", facts: { timestamp: clock.now() }, failures: [], bypass: undefined } as never);
      audit.recordDecision({ action: "challenge", rule: "r", reason: "", params: {} } as never, clock.now());
      if (i < options.solved) audit.recordChallengeSolved(clock.now());
      clock.advance(1000);
    }
    return audit;
  }

  it("counts solves separately from the challenges that prompted them", () => {
    const { window } = busy({ challenges: 30, solved: 20 }).summary(1_700_000_030_000);
    expect(window.challenges).toBe(30);
    expect(window.challengesSolved).toBe(20);
    expect(window.challengeSolveRate).toBeCloseTo(0.667, 2);
  });

  it("says nothing at all about three challenges", () => {
    const { window } = busy({ challenges: 3, solved: 3 }).summary(1_700_000_003_000);
    // Not zero, and not one: a ratio over three decisions is not a rate, and the
    // difference between "we do not know" and "nobody is solving these" matters.
    expect(window.challengeSolveRate).toBeUndefined();
  });

  it("raises an anomaly when nearly everything challenged is getting through", () => {
    const anomalies = busy({ challenges: 40, solved: 39 }).evaluate(1_700_000_040_000);
    const found = anomalies.find((anomaly) => anomaly.id === "challenge-solve-rate");
    expect(found?.summary).toMatch(/mostly landing on people/);
  });

  it("stays quiet when the challenges are doing what they are for", () => {
    const anomalies = busy({ challenges: 40, solved: 4 }).evaluate(1_700_000_040_000);
    expect(anomalies.some((anomaly) => anomaly.id === "challenge-solve-rate")).toBe(false);
  });

  it("stays quiet on a handful of challenges, whatever the ratio", () => {
    const anomalies = busy({ challenges: 8, solved: 8 }).evaluate(1_700_000_008_000);
    expect(anomalies.some((anomaly) => anomaly.id === "challenge-solve-rate")).toBe(false);
  });
});
