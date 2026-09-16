import { describe, expect, it } from "vitest";
import { BotHandler, toPrometheus } from "../src/index.js";
import { CHROME_HEADERS, failingResolver, makeFacts } from "./helpers.js";

describe("metrics", () => {
  it("counts verdicts, actions, downgrades and detector firings", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      rules: [{ id: "block-all", match: () => true, action: "block" }],
    });
    await handler.handle(makeFacts({ headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    await handler.handle(makeFacts({ headers: { host: "x", accept: "*/*", "user-agent": CHROME_HEADERS["user-agent"]! } }));

    const metrics = handler.metrics()!;
    expect(metrics.requests).toBe(2);
    expect(metrics.verdicts["confirmed-bot"]).toBe(1);
    expect(metrics.actions["block"]).toBe(1);
    expect(metrics.downgrades).toBe(1);
    expect(metrics.detectorFirings["self-identified"]).toBe(1);
    expect(metrics.duration.count).toBe(2);
  });

  /**
   * The score histogram.
   *
   * It exists because the dashboard's score distribution — the one chart that answers
   * "how close does ordinary traffic run to the line?" before somebody moves the line
   * — used to be drawn from the few hundred requests the page happened to be holding,
   * while every panel beside it counted since the process started. Same subtitle, two
   * populations. Now it comes from the same counters the Prometheus endpoint does.
   */
  it("distributes probabilistic scores across ten buckets, cumulatively", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ headers: { host: "x", accept: "*/*", "user-agent": CHROME_HEADERS["user-agent"]! } }));
    const metrics = handler.metrics()!;
    expect(metrics.scores.count).toBe(1);
    expect(metrics.scores.buckets).toHaveLength(10);
    // Cumulative, so the last bucket holds everything scored.
    expect(metrics.scores.buckets[9]).toBe(metrics.scores.count);
    for (let i = 1; i < metrics.scores.buckets.length; i++) {
      expect(metrics.scores.buckets[i]!).toBeGreaterThanOrEqual(metrics.scores.buckets[i - 1]!);
    }
  });

  it("leaves proven assessments out of it, because their score decides nothing", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    const metrics = handler.metrics()!;
    expect(metrics.proven).toBe(1);
    expect(metrics.scores.count).toBe(0);
    expect(metrics.scores.buckets[9]).toBe(0);
  });

  it("exposes the distribution to a scraper, so the screen and the alerting agree", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ headers: { host: "x", accept: "*/*", "user-agent": CHROME_HEADERS["user-agent"]! } }));
    const text = handler.prometheus()!;
    expect(text).toMatch(/# TYPE bothandler_score histogram/);
    expect(text).toMatch(/bothandler_score_bucket\{le="99"\} 1/);
    expect(text).toMatch(/bothandler_score_bucket\{le="\+Inf"\} 1/);
    expect(text).toMatch(/bothandler_score_count 1/);
  });

  it("counts bypassed requests without pretending they were assessed", async () => {
    const handler = new BotHandler({ resolver: failingResolver(), allowlist: ["203.0.113.0/24"], ignorePaths: ["/healthz"] });
    await handler.assess(makeFacts({ ip: "203.0.113.9" }));
    await handler.assess(makeFacts({ ip: "198.51.100.1", path: "/healthz" }));
    const metrics = handler.metrics()!;
    expect(metrics.requests).toBe(2);
    expect(metrics.bypassed).toEqual({ allowlist: 1, "ignored-path": 1, label: 0 });
    expect(metrics.duration.count).toBe(0);
  });

  it("renders valid Prometheus exposition text", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.handle(makeFacts({ headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    const text = handler.prometheus()!;
    expect(text).toMatch(/# TYPE bothandler_requests_total counter/);
    expect(text).toMatch(/bothandler_verdicts_total\{verdict="confirmed-bot"\} 1/);
    expect(text).toMatch(/bothandler_assessment_duration_ms_bucket\{le="\+Inf"\}/);
    expect(text.endsWith("\n")).toBe(true);
    // Every sample line must be `name value`, or a scraper rejects the whole payload.
    for (const line of text.trim().split("\n")) {
      if (line.startsWith("#")) continue;
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? -?[\d.e+]+$/);
    }
  });

  it("can be switched off", () => {
    expect(new BotHandler({ metrics: false }).metrics()).toBeUndefined();
  });

  it("escapes a custom detector id that would otherwise break the format", () => {
    const text = toPrometheus({
      requests: 1, bypassed: { allowlist: 0, "ignored-path": 0, label: 0 },
      verdicts: { "confirmed-bot": 0, "verified-bot": 0, "suspected-bot": 0, human: 0, unknown: 1 },
      botClasses: { human: 0, "verified-bot": 0, "declared-bot": 0, automation: 0, "http-client": 0, scanner: 0, scraper: 0, impersonator: 0, unknown: 1 },
      actions: { allow: 1, tag: 0, log: 0, delay: 0, "rate-limit": 0, challenge: 0, redirect: 0, block: 0, drop: 0, custom: 0 },
      downgrades: 0, proven: 0, detectorFirings: { 'we"ird': 3 }, detectorFailures: {}, detectorTimings: {},
      shadowFirings: { 'we"ird': 1 },
      shadowChanges: { 'confirmed-bot': 0, 'verified-bot': 0, 'suspected-bot': 1, human: 0, unknown: 0 },
      challenges: { issued: 0, solved: 0, rejected: 0 },
      clearances: {}, challengeRejections: {}, interactionScores: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      scores: { count: 1, totalScore: 12, buckets: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      duration: { count: 1, totalMs: 1, maxMs: 1, buckets: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      actorsTracked: 1,
    });
    expect(text).toContain('detector="we\\"ird"');
  });
});
