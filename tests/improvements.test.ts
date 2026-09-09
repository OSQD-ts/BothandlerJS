import { describe, expect, it } from "vitest";
import { BotHandler, ConfigError, MemoryStore, RedisStore, createFacts, fetchAddressList, fetchCrawlerRanges, generateRobotsTxt, refreshCrawlerRanges, resolveClientIp, robotsFromRules, toPrometheus } from "../src/index.js";
import { MultiPatternMatcher } from "../src/internal/matcher.js";
import { cachingResolver, forwardConfirmedReverseDns } from "../src/internal/dns.js";
import { ManualClock } from "../src/internal/clock.js";
import { PRESETS, protectData } from "../src/policy/presets.js";
import { main, parseCommonLogLine, parseJsonLine } from "../src/cli.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CHROME_HEADERS, collect, failingResolver, makeContext, makeFacts } from "./helpers.js";
import { crawlerVerificationDetector } from "../src/detectors/crawler-verification.js";
import type { Assessment } from "../src/index.js";
import type { DnsResolver } from "../src/internal/dns.js";
import type { RedisLike } from "../src/index.js";

const OFF = { trustProxy: false, hops: 1, header: "x-forwarded-for", trustedProxies: undefined };

describe("client IP resolution", () => {
  // A chain shorter than the configured hop count means the request did not come
  // through the expected topology, so every entry in it is client-controlled.
  it("falls back to the socket address rather than a client-chosen entry", () => {
    const proxy = { ...OFF, trustProxy: true, hops: 5 };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, proxy)).toBe("10.0.0.1");
  });

  it("still reads the right hop when the chain is long enough", () => {
    const proxy = { ...OFF, trustProxy: true, hops: 2 };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }, proxy)).toBe("203.0.113.9");
  });

  it("ignores a chain of junk rather than trusting it", () => {
    const proxy = { ...OFF, trustProxy: true, hops: 1 };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "nonsense, also-nonsense" }, proxy)).toBe("10.0.0.1");
  });
});

describe("RedisStore", () => {
  function recorder() {
    const calls: string[] = [];
    const client: RedisLike = {
      incr: async () => 1,
      get: async () => null,
      del: async () => 1,
      set: async (key, value, _mode, _ttl, condition) => {
        calls.push(`${key}=${value}${condition ? ` ${condition}` : ""}`);
        return "OK";
      },
    };
    return { calls, store: new RedisStore(client) };
  }

  // `set` with NX is a no-op after the first write, so a value could never be updated.
  it("overwrites on set", async () => {
    const { calls, store } = recorder();
    await store.set("k", "first", 1000);
    await store.set("k", "second", 1000);
    expect(calls).toEqual(["bh:v:k=first", "bh:v:k=second"]);
  });

  it("keeps NX for the single-use claim, which is what makes replay protection work", async () => {
    const { calls, store } = recorder();
    await store.consumeOnce("nonce", 1000);
    expect(calls[0]).toMatch(/NX$/);
  });
});

describe("notification redaction", () => {
  it("masks IPv6 to a /64, including compressed forms", async () => {
    const seen: string[] = [];
    for (const ip of ["2001:db8:1:2:3:4:5:6", "2001:db8::1", "fe80::abcd", "203.0.113.55"]) {
      const handler = new BotHandler({
        resolver: failingResolver(),
        preset: "monitor-only",
        notifications: { sinks: [{ id: "t", notify: (event) => void seen.push(event.assessment!.facts.ip) }], filter: { types: ["detection"], minScore: 0 } },
      });
      await handler.assess(makeFacts({ ip, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    }
    expect(seen).toEqual(["2001:db8:1:2::/64", "2001:db8::/64", "fe80::/64", "203.0.113.0/24"]);
  });

  // Removing a header from the map is not the same as removing it from the event.
  // Detectors quote what they saw, so a stripped header reappeared a few fields away.
  it("does not leak a stripped header back through what a detector quoted", async () => {
    const secrets: string[] = [];
    const handler = new BotHandler({
      resolver: failingResolver(),
      preset: "monitor-only",
      notifications: {
        redaction: { dropUserAgent: true },
        sinks: [{ id: "t", notify: (event) => void secrets.push(JSON.stringify(event)) }],
        filter: { types: ["detection"], minScore: 0 },
      },
    });
    const headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/122.0.0.0 Safari/537.36";
    await handler.assess(
      makeFacts({
        ip: "203.0.113.55",
        path: "/reset?token=abc123-secret-reset-token",
        headers: { host: "x", "user-agent": headless, cookie: "session=super-secret-value" },
      }),
    );
    const delivered = secrets.join("");
    expect(delivered, "the event must have been delivered at all").not.toBe("");
    expect(delivered).not.toContain("HeadlessChrome/122");
    expect(delivered).not.toContain("super-secret-value");
    // A query string is where reset tokens and session ids actually live.
    expect(delivered).not.toContain("abc123-secret-reset-token");
    expect(delivered, "parameter names are what make an alert legible").toContain("token");
  });

  it("keeps the event useful when nothing needs stripping", async () => {
    const events: string[] = [];
    const handler = new BotHandler({
      resolver: failingResolver(),
      preset: "monitor-only",
      notifications: {
        redaction: { maskQuery: false },
        sinks: [{ id: "t", notify: (event) => void events.push(JSON.stringify(event)) }],
        filter: { types: ["detection"], minScore: 0 },
      },
    });
    await handler.assess(makeFacts({ ip: "203.0.113.55", path: "/list?page=2", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    expect(events.join("")).toContain("curl/8.4.0");
    expect(events.join("")).toContain('"page":"2"');
  });
});

describe("header order as the caller supplied it", () => {
  // `rawHeaders` accepts Node's alternating name/value array or a plain list of names.
  // Any name-only list of even length used to be read as the alternating shape, so
  // every second name was silently discarded from a fingerprint.
  it("reads a name-only list without dropping half of it", () => {
    const headers = { host: "example.test", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" };
    const names = Object.keys(headers);
    expect(makeFacts({ headers, headerOrder: names }).headerOrder).toEqual(names);
  });

  it("reads Node's alternating array as names only", () => {
    const headers = { host: "example.test", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" };
    const raw = Object.entries(headers).flat();
    expect(makeFacts({ headers, headerOrder: raw }).headerOrder).toEqual(Object.keys(headers));
  });

  it("reads a single-header alternating pair, where the shape alone is ambiguous", () => {
    expect(makeFacts({ headers: { host: "example.test" }, headerOrder: ["Host", "example.test"] }).headerOrder).toEqual(["host"]);
  });

  it("preserves an order that differs from the map's own", () => {
    const headers = { host: "example.test", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" };
    const wire = ["accept", "host", "accept-encoding", "user-agent"];
    expect(makeFacts({ headers, headerOrder: wire }).headerOrder).toEqual(wire);
  });
});

describe("partial header sets", () => {
  const uaOnly = { "user-agent": CHROME_HEADERS["user-agent"]! };

  // A header missing from a record is not a header missing from the request.
  it("treats a browser in a header-poor record as unknown, not as a bot", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const complete = await handler.assess(makeFacts({ headers: uaOnly, ip: "203.0.113.1" }));
    const partial = await handler.assess(createFacts({ method: "GET", url: "/", headers: uaOnly, ip: "203.0.113.2", partialHeaders: true }));

    expect(complete.verdict).toBe("suspected-bot");
    expect(partial.verdict).toBe("unknown");
    expect(partial.evidence).toHaveLength(0);
  });

  it("still reads evidence from headers that are present", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const assessment = await handler.assess(
      createFacts({
        method: "GET",
        url: "/",
        headers: { ...CHROME_HEADERS, "sec-ch-ua-platform": '"Windows"' },
        ip: "203.0.113.3",
        partialHeaders: true,
        protocol: "https",
      }),
    );
    expect(assessment.evidence.map((item) => item.detector)).toContain("client-hints");
  });

  it("does not report an absent User-Agent it was never given", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: {}, ip: "203.0.113.4", partialHeaders: true }));
    expect(assessment.evidence).toHaveLength(0);
  });
});

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
    expect(metrics.bypassed).toEqual({ allowlist: 1, "ignored-path": 1 });
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
      requests: 1, bypassed: { allowlist: 0, "ignored-path": 0 },
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

/**
 * Acting on one client rather than on a class of request.
 *
 * Three operations that existed in the engine and were reachable from nothing: the
 * dashboard could show you an actor and could not do anything about one. Each is
 * announced, because each is somebody overriding the engine by hand and that is exactly
 * what an audit trail is for.
 */
describe("acting on an actor", () => {
  it("forgets one actor without touching anybody else", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ ip: "203.0.113.5", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    await handler.assess(makeFacts({ ip: "198.51.100.5", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    expect(handler.registry.peek("203.0.113.5")).toBeDefined();

    handler.forgetActor("203.0.113.5");
    expect(handler.registry.peek("203.0.113.5")).toBeUndefined();
    // The whole point: the cure for one false positive used to be `registry.clear()`,
    // which throws away everybody's history to fix one person's.
    expect(handler.registry.peek("198.51.100.5")).toBeDefined();
  });

  it("clears an actor as human, and says until when", () => {
    const handler = new BotHandler();
    const events: unknown[] = [];
    handler.on("actor-change", (event) => events.push(event));
    handler.clearActor("203.0.113.5", 60_000, { by: "ada@example.com" });

    expect(handler.registry.peek("203.0.113.5")?.snapshot(Date.now()).cleared).toBe(true);
    expect(events).toEqual([{ key: "203.0.113.5", action: "clear", until: expect.any(Number), by: "ada@example.com" }]);
  });

  it("names who did it, wherever the change is announced", () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    handler.forgetActor("203.0.113.5", { by: "ada@example.com" });
    handler.updateRanges("allowlist", ["203.0.113.0/24"], { by: "ada@example.com" });
    handler.updatePolicy([{ id: "tag-all", match: {}, action: "tag" }], { by: "ada@example.com" });
    handler.updateGuard({ falsePositivePolicy: "balanced" }, { by: "ada@example.com" });

    expect(warnings.filter((message) => message.includes("by ada@example.com"))).toHaveLength(4);
  });

  /**
   * One warning, one delivery. `warn()` emits the event *and* calls `config.onWarning`,
   * and `onWarning` used to be registered as a listener as well — so the one channel
   * most likely to be wired to a pager was the one that double-fired.
   */
  it("delivers a warning to onWarning exactly once", () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    handler.forgetActor("203.0.113.5");
    expect(warnings).toHaveLength(1);
  });

  it("reads as a sentence when nobody could say who", () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    handler.forgetActor("203.0.113.5");
    expect(warnings[0]).toBe('Actor "203.0.113.5" was forgotten at runtime.');
  });
});

/**
 * A dry run.
 *
 * The engine's opinion about a request that is not happening — a support ticket, a rule
 * being drafted, the dashboard's request tester. The verdict is real and the decision
 * is real; what must not happen is any trace of the question in the answer to "what is
 * my traffic doing?".
 */
describe("assessing without recording", () => {
  it("returns a real verdict", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const assessment = await handler.assess(makeFacts({ headers: { host: "x", "user-agent": "curl/8.4.0" } }), { record: false });
    expect(assessment.verdict).toBe("confirmed-bot");
    expect(assessment.certain).toBe(true);
  });

  it("moves no counter, no actor and no event", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const seen: unknown[] = [];
    handler.on("assessment", (assessment) => seen.push(assessment));

    await handler.assess(makeFacts({ ip: "203.0.113.9", headers: { host: "x", "user-agent": "curl/8.4.0" } }), { record: false });

    expect(handler.metrics()!.requests).toBe(0);
    expect(handler.registry.peek("203.0.113.9")).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("does not inflate the actor a real request would have moved", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    const facts = () => makeFacts({ ip: "203.0.113.9", headers: { host: "x", "user-agent": "curl/8.4.0" } });
    await handler.assess(facts());
    for (let i = 0; i < 5; i++) await handler.assess(facts(), { record: false });
    // One request, however many times somebody asked about it.
    expect(handler.registry.peek("203.0.113.9")?.snapshot(Date.now()).requests).toBe(1);
  });

  it("still refuses to assess what it was told to ignore", async () => {
    const handler = new BotHandler({ allowlist: ["203.0.113.0/24"] });
    const assessment = await handler.assess(makeFacts({ ip: "203.0.113.9" }), { record: false });
    expect(assessment.bypass).toBe("allowlist");
    expect(handler.metrics()!.requests).toBe(0);
  });
});

describe("the registry as a list", () => {
  it("ranks the actors it is holding by how much they are asking for", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    for (let i = 0; i < 5; i++) await handler.assess(makeFacts({ ip: "203.0.113.1", path: `/p${i}`, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    await handler.assess(makeFacts({ ip: "198.51.100.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));

    // The fixture's clock, not the wall clock: `makeFacts` timestamps every request at
    // a fixed instant, and a rate is measured against the time the requests claim.
    const top = handler.registry.top(10, 1_700_000_000_000);
    expect(top.map((actor) => actor.key)).toEqual(["203.0.113.1", "198.51.100.1"]);
    expect(top[0]!.requests).toBe(5);
    expect(top[0]!.distinctPaths).toBe(5);
    expect(top[0]!.recentRate).toBe(5);
  });

  /**
   * The registry holds `maxActors` clients and the dashboard used to be able to see only
   * the busiest page of them, which is the wrong half of the point: the feed's ring
   * already shows what is loudest, and this list exists for the population behind it.
   */
  it("pages past the busiest, by offset", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    // Six actors, each asking for one fewer than the last, so the ranking is unambiguous.
    for (let actor = 0; actor < 6; actor++) {
      for (let request = 0; request <= 6 - actor; request++) {
        await handler.assess(makeFacts({ ip: `198.51.100.${actor}`, path: `/p${request}`, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
      }
    }
    const at = 1_700_000_000_000;
    const all = handler.registry.top(10, at).map((actor) => actor.key);
    expect(all).toHaveLength(6);

    expect(handler.registry.top(2, at, 0).map((actor) => actor.key)).toEqual(all.slice(0, 2));
    expect(handler.registry.top(2, at, 2).map((actor) => actor.key)).toEqual(all.slice(2, 4));
    // A page that runs off the end is short rather than wrong, which is what tells the
    // dashboard it has reached the quiet end of the list.
    expect(handler.registry.top(4, at, 4).map((actor) => actor.key)).toEqual(all.slice(4));
    expect(handler.registry.top(2, at, 99)).toEqual([]);
    // Omitted means the front, so every existing caller keeps its behaviour.
    expect(handler.registry.top(3, at).map((actor) => actor.key)).toEqual(all.slice(0, 3));
    // A negative offset is a number somebody typed, not a request to read backwards.
    expect(handler.registry.top(2, at, -5).map((actor) => actor.key)).toEqual(all.slice(0, 2));
  });

  /** Listing the registry must not be the thing that changes it. */
  it("is a read: it records nothing and evicts nothing", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ ip: "203.0.113.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    handler.registry.top(10, Date.now());
    handler.registry.top(10, Date.now());
    expect(handler.registry.peek("203.0.113.1")?.snapshot(1_700_000_000_000).requests).toBe(1);
    expect(handler.registry.size).toBe(1);
  });

  it("says nothing about cadence until it has enough gaps to say something", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ ip: "203.0.113.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    expect(handler.registry.top(1, 1_700_000_000_000)[0]!.cadenceCv).toBeUndefined();
  });
});

/**
 * Published crawler ranges.
 *
 * Twelve signatures verify by address rather than by reverse DNS — every AI crawler
 * among them — and nothing in the library ever filled those ranges in. The fetcher is
 * injected in every test here: a suite that reaches the internet is a suite that fails
 * on a train.
 */
describe("fetching published crawler ranges", () => {
  const respond = (body: string, status = 200): typeof globalThis.fetch =>
    (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

  const google = JSON.stringify({ creationTime: "2026-01-01", prefixes: [{ ipv4Prefix: "66.249.64.0/27" }, { ipv6Prefix: "2001:4860:4801:10::/64" }] });

  /**
   * The size cap used to be checked after `await response.text()`, which decided whether
   * to *use* an oversized list without ever declining to *hold* one. A publisher sending
   * gigabytes — compromised, misconfigured, or an operator's typo in the URL — was met
   * with the whole thing in memory and an error afterwards.
   */
  describe("refusing a list that is too big to be one", () => {
    it("stops reading rather than reading it all and complaining", async () => {
      const chunk = new TextEncoder().encode(`${"1.2.3.4/32\n".repeat(10_000)}`);
      let sent = 0;
      const endless: typeof globalThis.fetch = (async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += chunk.byteLength;
              // Far more than the cap if it were ever read to the end.
              if (sent > 512 * 1024 * 1024) controller.close();
              else controller.enqueue(chunk);
            },
          }),
        )) as unknown as typeof globalThis.fetch;

      await expect(fetchAddressList({ id: "denylist", url: "https://example.invalid/feed.txt" }, { fetch: endless })).rejects.toThrow(/not a list of prefixes/);
      // The cap is 4 MB. Stopping near it is the whole point; reading half a gigabyte
      // and then objecting is the bug this replaced.
      expect(sent).toBeLessThan(16 * 1024 * 1024);
    });

    it("declines on a declared length before it looks at the body", async () => {
      // The body is a perfectly good list. If the declared length were not consulted
      // first this would parse and return, so the rejection is the proof.
      const body = "10.0.0.0/24\n";
      const lying: typeof globalThis.fetch = (async () =>
        new Response(body, { headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof globalThis.fetch;

      await expect(fetchAddressList({ id: "denylist", url: "https://example.invalid/feed.txt" }, { fetch: lying })).rejects.toThrow(/declares/);
      await expect(fetchAddressList({ id: "denylist", url: "https://example.invalid/feed.txt" }, { fetch: respond(body) })).resolves.toEqual(["10.0.0.0/24"]);
    });

    it("still reads a list of an ordinary size", async () => {
      const body = `${"# a comment\n"}${Array.from({ length: 500 }, (_, i) => `10.${i % 256}.0.0/24`).join("\n")}\n`;
      const prefixes = await fetchAddressList({ id: "denylist", url: "https://example.invalid/feed.txt" }, { fetch: respond(body) });
      expect(prefixes.length).toBe(500);
      expect(prefixes[0]).toBe("10.0.0.0/24");
    });
  });

  it("reads the JSON shape every major crawler publishes", async () => {
    const prefixes = await fetchCrawlerRanges({ id: "googlebot", url: "https://example.invalid/googlebot.json" }, { fetch: respond(google) });
    expect(prefixes).toEqual(["66.249.64.0/27", "2001:4860:4801:10::/64"]);
  });

  it("reads a plain list too, comments and all", async () => {
    const prefixes = await fetchCrawlerRanges(
      { id: "uptimerobot", url: "https://example.invalid/ips.txt" },
      { fetch: respond("# our probes\n203.0.113.4\n\n198.51.100.0/24 # europe\n") },
    );
    expect(prefixes).toEqual(["203.0.113.4", "198.51.100.0/24"]);
  });

  /**
   * These ranges do not describe a crawler, they *verify* one — an address inside them
   * is a `verified-bot`, which most policies allow. A list that arrived wrong would
   * hand that status to whatever it covered.
   */
  it("refuses a list containing a block bigger than any crawler owns", async () => {
    const wide = JSON.stringify({ prefixes: [{ ipv4Prefix: "66.249.64.0/27" }, { ipv4Prefix: "0.0.0.0/0" }] });
    await expect(fetchCrawlerRanges({ id: "googlebot", url: "https://example.invalid/x.json" }, { fetch: respond(wide) })).rejects.toThrow(/more of the internet/);
  });

  it("refuses an empty list, and one served over plain HTTP", async () => {
    await expect(fetchCrawlerRanges({ id: "x", url: "https://example.invalid/x.json" }, { fetch: respond('{"prefixes":[]}') })).rejects.toThrow(/empty/);
    await expect(fetchCrawlerRanges({ id: "x", url: "http://example.invalid/x.json" }, { fetch: respond(google) })).rejects.toThrow(/HTTPS/);
  });

  it("installs what it fetched, under the id the signature uses", async () => {
    const handler = new BotHandler();
    const result = await refreshCrawlerRanges(handler, {
      sources: [{ id: "googlebot", url: "https://example.invalid/googlebot.json" }],
      fetch: respond(google),
    });
    expect(result.updated).toEqual([{ id: "googlebot", prefixes: 2 }]);
    expect(handler.rangeEntries("crawler:googlebot")).toEqual(["66.249.64.0/27", "2001:4860:4801:10::/64"]);
  });

  /**
   * Fail open, per source. One publisher being down must not cost you another
   * crawler's ranges, and must not cost that crawler the ranges it already had.
   */
  it("leaves every other source alone when one fails, and never throws", async () => {
    const handler = new BotHandler();
    const warnings: string[] = [];
    handler.on("warning", (message) => warnings.push(message));
    await refreshCrawlerRanges(handler, { sources: [{ id: "googlebot", url: "https://example.invalid/g.json" }], fetch: respond(google) });

    const result = await refreshCrawlerRanges(handler, {
      sources: [
        { id: "googlebot", url: "https://example.invalid/g.json" },
        { id: "gptbot", url: "https://example.invalid/gpt.json" },
      ],
      fetch: (async (url: URL) => (String(url).includes("gpt") ? new Response("nope", { status: 503 }) : new Response(google))) as unknown as typeof globalThis.fetch,
    });

    expect(result.updated).toEqual([{ id: "googlebot", prefixes: 2 }]);
    expect(result.failed[0]?.id).toBe("gptbot");
    expect(handler.rangeEntries("crawler:googlebot")).toHaveLength(2);
    expect(warnings.some((message) => message.includes("gptbot") && message.includes("unchanged"))).toBe(true);
  });

  it("announces the change like every other runtime change", async () => {
    const handler = new BotHandler();
    const changes: Array<{ name: string; by?: string | undefined }> = [];
    handler.on("range-change", (event) => changes.push(event));
    await refreshCrawlerRanges(handler, { sources: [{ id: "googlebot", url: "https://example.invalid/g.json" }], fetch: respond(google), by: "the range refresher" });
    expect(changes).toEqual([expect.objectContaining({ name: "crawler:googlebot", by: "the range refresher" })]);
  });
});

/**
 * Proof travels between replicas; suspicion stays home.
 *
 * Behavioural state is process-local by design, because a round trip per request would
 * buy accuracy for signals that may only raise suspicion. A confirmation is not one of
 * those: `confirmed-bot` is a proven verdict, and behind eight replicas a fact
 * established on one of them was unknown to the other seven.
 */
describe("sharing confirmations across replicas", () => {
  const hit = (handler: BotHandler, ip = "203.0.113.9"): Promise<Assessment> =>
    handler.assess(makeFacts({ ip, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));

  it("tells another instance what this one proved", async () => {
    const store = new MemoryStore();
    const [a, b] = [new BotHandler({ store, shareConfirmations: true }), new BotHandler({ store, shareConfirmations: true })];

    for (let i = 0; i < 3; i++) await hit(a);
    await settle();

    // B has never seen this actor. The read happens on first sight, so the second
    // request is the first that can carry the answer.
    await hit(b);
    await settle();
    expect((await hit(b)).actor.priorConfirmations).toBeGreaterThanOrEqual(3);
  });

  it("does nothing at all unless it is asked for", async () => {
    const store = new MemoryStore();
    const [a, b] = [new BotHandler({ store }), new BotHandler({ store })];
    for (let i = 0; i < 3; i++) await hit(a);
    await settle();
    await hit(b);
    await settle();
    expect((await hit(b)).actor.priorConfirmations).toBe(1);
  });

  /** One read per actor per instance, not one per request. That is what makes it affordable. */
  it("asks the store once per actor, however many requests arrive", async () => {
    const store = new MemoryStore();
    let reads = 0;
    // Delegating explicitly rather than spreading: a class instance's methods live on
    // its prototype, so `{ ...store }` produces an object with no methods at all and a
    // spy that silently tests nothing.
    const counted = {
      increment: (key: string, windowMs: number) => store.increment(key, windowMs),
      consumeOnce: (key: string, ttlMs: number) => store.consumeOnce(key, ttlMs),
      set: (key: string, value: string, ttlMs: number) => store.set(key, value, ttlMs),
      delete: (key: string) => store.delete(key),
      get: (key: string) => {
        reads++;
        return store.get(key);
      },
    };

    const handler = new BotHandler({ store: counted, shareConfirmations: true });
    for (let i = 0; i < 10; i++) await hit(handler);
    await settle();
    expect(reads).toBe(1);
  });

  it("falls back to what this process saw when the store is unavailable", async () => {
    const broken = {
      increment: () => Promise.reject(new Error("down")),
      consumeOnce: () => Promise.reject(new Error("down")),
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
      delete: () => Promise.reject(new Error("down")),
    };
    const handler = new BotHandler({ store: broken, shareConfirmations: true });
    for (let i = 0; i < 3; i++) await hit(handler);
    await settle();
    expect((await hit(handler)).actor.priorConfirmations).toBe(3);
  });
});

describe("runtime range updates", () => {
  it("swaps a crawler range set without a restart", async () => {
    const GPT = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
    const handler = new BotHandler({ resolver: failingResolver() });
    const facts = makeFacts({ headers: { host: "x", "user-agent": GPT }, ip: "198.51.100.5" });

    // No ranges configured: an unverifiable claim, so no accusation either way.
    expect((await handler.assess(facts)).verdict).toBe("confirmed-bot");

    handler.updateCrawlerRanges("gptbot", ["198.51.100.0/24"]);
    expect((await handler.assess(facts)).verdict).toBe("verified-bot");

    handler.updateCrawlerRanges("gptbot", ["192.0.2.0/24"]);
    const outside = await handler.assess(facts);
    expect(outside.botClass).toBe("impersonator");
  });

  it("rejects an invalid range and leaves the previous set standing", () => {
    const handler = new BotHandler({ datacenterRanges: ["192.0.2.0/24"] });
    expect(() => handler.updateRanges("datacenter", ["oops"])).toThrow(ConfigError);
    expect(handler.listRanges()).toContainEqual({ name: "datacenter", size: 1 });
  });

  it("removes a set when handed an empty list", () => {
    const handler = new BotHandler({ denylist: ["192.0.2.0/24"] });
    handler.updateRanges("denylist", []);
    expect(handler.listRanges().find((entry) => entry.name === "denylist")).toBeUndefined();
  });
});

describe("robots.txt", () => {
  it("repeats global disallows inside each named group", () => {
    // RFC 9309: a crawler obeys the most specific group that names it and ignores
    // every other, so a trap path only in the wildcard group is *permitted* for a
    // crawler that has its own group.
    const text = generateRobotsTxt({ disallowBots: ["gptbot"], disallowPaths: ["/trap"] });
    const group = text.slice(text.indexOf("User-agent: GPTBot"));
    expect(group).toContain("Disallow: /trap");
    expect(group).toContain("Disallow: /");
  });

  it("expands categories and reports rules it could not read", () => {
    const result = robotsFromRules(protectData());
    expect(result.declined).toContain("gptbot");
    expect(result.declined).toContain("ahrefsbot");
    expect(result.declined.length).toBeGreaterThan(10);
    // Behavioural rules name no crawler, so they cannot be expressed in robots.txt —
    // and are reported rather than silently dropped.
    expect(result.unreadable.map((entry) => entry.rule)).toContain("scanner-block");
  });

  it("emits a wildcard group even with nothing to disallow", () => {
    expect(generateRobotsTxt()).toContain("User-agent: *\nDisallow:\n");
  });

  it("accepts several sitemaps", () => {
    const text = generateRobotsTxt({ sitemap: ["https://a.example/s.xml", "https://b.example/s.xml"] });
    expect(text).toContain("Sitemap: https://a.example/s.xml");
    expect(text).toContain("Sitemap: https://b.example/s.xml");
  });
});

describe("log parsing", () => {
  it("reads a Combined Log Format line, timestamp and all", () => {
    const facts = parseCommonLogLine(
      '203.0.113.5 - - [30/Aug/2026:09:15:04 +0000] "GET /products/3?x=1 HTTP/1.1" 200 2326 "https://ref.example/" "curl/8.4.0"',
    )!;
    expect(facts.method).toBe("GET");
    expect(facts.path).toBe("/products/3");
    expect(facts.ip).toBe("203.0.113.5");
    expect(facts.headers["user-agent"]).toBe("curl/8.4.0");
    expect(facts.headers["referer"]).toBe("https://ref.example/");
    expect(facts.httpVersion).toBe("1.1");
    expect(facts.partialHeaders).toBe(true);
    expect(new Date(facts.timestamp).toISOString()).toBe("2026-08-30T09:15:04.000Z");
  });

  it("honours the timezone offset", () => {
    const facts = parseCommonLogLine('1.2.3.4 - - [30/Aug/2026:09:00:00 -0700] "GET / HTTP/1.1" 200 1')!;
    expect(new Date(facts.timestamp).toISOString()).toBe("2026-08-30T16:00:00.000Z");
  });

  it("treats a dash as an absent header rather than a literal one", () => {
    const facts = parseCommonLogLine('1.2.3.4 - - [30/Aug/2026:09:00:00 +0000] "GET / HTTP/1.1" 200 1 "-" "-"')!;
    expect(facts.headers["user-agent"]).toBeUndefined();
  });

  it("returns undefined for a line it cannot read", () => {
    expect(parseCommonLogLine("not a log line")).toBeUndefined();
    expect(parseJsonLine("{ broken")).toBeUndefined();
    expect(parseJsonLine('{"method":"GET"}')).toBeUndefined();
  });

  it("reads JSON lines at full fidelity when headers are present", () => {
    const facts = parseJsonLine(
      JSON.stringify({ ip: "203.0.113.7", method: "post", url: "/login", headers: { "User-Agent": "curl/8", Accept: "*/*" }, timestamp: "2026-08-30T09:00:00Z", protocol: "https" }),
    )!;
    expect(facts.method).toBe("POST");
    expect(facts.headers["user-agent"]).toBe("curl/8");
    expect(facts.protocol).toBe("https");
    expect(facts.partialHeaders).toBeUndefined();
  });

  // The CLF branch declares itself header-poor precisely so that a replay does not
  // report a site's human traffic as automation. A JSON line carrying the handful of
  // headers a logger was configured to keep is in exactly the same position, and
  // reading it as a complete capture scored the same real Chrome request 0 from CLF
  // and 87 from JSON.
  it("treats a selected subset of headers as the extract it is", async () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    const line = JSON.stringify({
      ip: "203.0.113.44",
      method: "GET",
      url: "/",
      httpVersion: "1.1",
      headers: { host: "shop.example", "user-agent": chrome, referer: "https://shop.example/" },
    });
    const facts = parseJsonLine(line)!;
    expect(facts.partialHeaders).toBe(true);

    const assessment = await new BotHandler({ resolver: failingResolver() }).assess(facts);
    expect(assessment.score, "a browser in an access log is not evidence of automation").toBe(0);
  });

  it("still reads a full capture at full fidelity", () => {
    const line = JSON.stringify({ ip: "203.0.113.44", headers: { host: "s", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" } });
    expect(parseJsonLine(line)?.partialHeaders).toBeUndefined();
  });

  it("lets the record settle it either way", () => {
    const complete = JSON.stringify({ ip: "203.0.113.44", partialHeaders: false, headers: { host: "s", "user-agent": "x" } });
    expect(parseJsonLine(complete)?.partialHeaders).toBeUndefined();
    const partial = JSON.stringify({ ip: "203.0.113.44", partial_headers: true, headers: { host: "s", accept: "*/*" } });
    expect(parseJsonLine(partial)?.partialHeaders).toBe(true);
  });

  it("marks a JSON line with no headers as header-poor", () => {
    const facts = parseJsonLine(JSON.stringify({ remote_addr: "1.2.3.4", request_uri: "/" }))!;
    expect(facts.partialHeaders).toBe(true);
  });

  it("accepts epoch seconds and milliseconds alike", () => {
    expect(parseJsonLine(JSON.stringify({ ip: "1.2.3.4", timestamp: 1_756_544_400 }))!.timestamp).toBe(1_756_544_400_000);
    expect(parseJsonLine(JSON.stringify({ ip: "1.2.3.4", timestamp: 1_756_544_400_000 }))!.timestamp).toBe(1_756_544_400_000);
  });
});

describe("in-memory store", () => {
  it("counts within a fixed window", async () => {
    const store = new MemoryStore();
    expect(await store.increment("k", 60_000)).toBe(1);
    expect(await store.increment("k", 60_000)).toBe(2);
  });

  it("claims a single-use key exactly once", async () => {
    const store = new MemoryStore();
    expect(await store.consumeOnce("n", 1000)).toBe(true);
    expect(await store.consumeOnce("n", 1000)).toBe(false);
  });
});

describe("configuration that would fail silently", () => {
  // `test` on a `g` or `y` regex resumes from `lastIndex`, so the same pattern against
  // the same path answers true, false, true, false. On the rule that decides whether
  // detection runs at all, that assesses every second request to an ignored path.
  it("keeps a global ignorePaths regex from matching only every other time", () => {
    const handler = new BotHandler({ ignorePaths: [/\.png$/g] });
    for (let i = 0; i < 4; i++) expect(handler.isIgnoredPath("/assets/logo.png"), `call ${i + 1}`).toBe(true);
    expect(handler.isIgnoredPath("/assets/logo.svg")).toBe(false);
  });

  it("leaves a sticky regex's meaning intact apart from the flag", () => {
    const handler = new BotHandler({ ignorePaths: [/^\/health$/y] });
    expect(handler.isIgnoredPath("/health")).toBe(true);
    expect(handler.isIgnoredPath("/health")).toBe(true);
    expect(handler.isIgnoredPath("/healthz")).toBe(false);
  });

  // A fractional or negative hop count indexes nothing, so the forwarded header would
  // be ignored and every client would appear to be the proxy. Loud beats silent.
  it("refuses a hop count that could never select a hop", () => {
    for (const hops of [1.5, 0, -1, Number.NaN]) {
      expect(() => new BotHandler({ proxy: { trustProxy: true, hops } }), String(hops)).toThrow(ConfigError);
    }
    expect(() => new BotHandler({ proxy: { trustProxy: true, hops: 2 } })).not.toThrow();
  });
});

describe("signature matching", () => {
  // `extraSignatures` is a documented extension point, and both of these used to
  // compile into an entry that matched nothing at all — indistinguishable from a
  // crawler that simply never visited.
  it("matches a signature token that is not lowercase ASCII", () => {
    const matcher = new MultiPatternMatcher<string>([
      ["MyCorpBot", "cased"],
      ["яндекс", "cyrillic"],
      ["curl", "plain"],
    ]);
    expect(matcher.matchAll("mozilla/5.0 mycorpbot/2.0")).toEqual(["cased"]);
    expect(matcher.matchAll("mozilla/5.0 (compatible; яндекс/1.0)")).toEqual(["cyrillic"]);
    expect(matcher.matchAll("curl/8.4.0")).toEqual(["plain"]);
    expect(matcher.matchAll("mozilla/5.0 (macintosh)")).toEqual([]);
  });
});

describe("DNS verification under an unreliable resolver", () => {
  const PTR = "crawl-66-249-66-1.googlebot.com";
  const IP = "66.249.66.1";
  const absent = (): never => {
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  const unreachable = (): never => {
    throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  };

  // The distinction the whole module is built on: an answer that contradicts a claim
  // versus no answer at all. The cache used to erase it, throwing an unlabelled error
  // on every hit, so a forged crawler was proven once and shrugged at thereafter.
  it("replays a cached absence as an absence, not as a shrug", async () => {
    let lookups = 0;
    const cached = cachingResolver({
      reverse: async () => {
        lookups++;
        return absent();
      },
      resolveAddresses: async () => [],
    });

    for (const attempt of [1, 2, 3]) {
      const outcome = await forwardConfirmedReverseDns(cached, "203.0.113.5", ["googlebot.com"]);
      expect(outcome.status, `attempt ${attempt}`).toBe("contradicted");
    }
    expect(lookups, "the cache must still spare the repeat lookups").toBe(1);
  });

  it("replays a cached timeout as indeterminate", async () => {
    const cached = cachingResolver({
      reverse: async () => unreachable(),
      resolveAddresses: async () => [],
    });
    for (const attempt of [1, 2]) {
      const outcome = await forwardConfirmedReverseDns(cached, "203.0.113.5", ["googlebot.com"]);
      expect(outcome.status, `attempt ${attempt}`).toBe("indeterminate");
    }
  });

  // A crawler's requests arrive in bursts, so the miss that costs is the one a
  // hundred of them take at the same moment.
  it("collapses concurrent lookups of the same name into one query", async () => {
    let lookups = 0;
    const cached = cachingResolver({
      reverse: async () => {
        lookups++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [PTR];
      },
      resolveAddresses: async () => [IP],
    });
    const outcomes = await Promise.all(Array.from({ length: 25 }, () => forwardConfirmedReverseDns(cached, IP, ["googlebot.com"])));
    for (const outcome of outcomes) expect(outcome.status).toBe("verified");
    expect(lookups).toBe(1);
  });

  // The expensive direction to get wrong: a resolver blip must never read as proof
  // that a real crawler is forging its identity.
  it("does not accuse a crawler when the forward lookup merely fails", async () => {
    const outcome = await forwardConfirmedReverseDns(
      { reverse: async () => [PTR], resolveAddresses: async () => unreachable() },
      IP,
      ["googlebot.com"],
    );
    expect(outcome.status).toBe("indeterminate");
  });

  it("still contradicts when the PTR name authoritatively has no address", async () => {
    const outcome = await forwardConfirmedReverseDns(
      { reverse: async () => [PTR], resolveAddresses: async () => absent() },
      IP,
      ["googlebot.com"],
    );
    // Asserted on `cause`, not on the prose: a caller that branches on the sentence
    // silently changes behaviour the next time someone improves the wording.
    expect(outcome).toMatchObject({ status: "contradicted", cause: "no-forward-record" });
  });

  it("distinguishes the reasons a claim was refuted", async () => {
    const wrongDomain = await forwardConfirmedReverseDns(
      { reverse: async () => ["vps-1234.cheap-hosting.example"], resolveAddresses: async () => [IP] },
      IP,
      ["googlebot.com"],
    );
    expect(wrongDomain).toMatchObject({ status: "contradicted", cause: "wrong-domain" });

    const mismatch = await forwardConfirmedReverseDns(
      { reverse: async () => [PTR], resolveAddresses: async () => ["8.8.8.8"] },
      IP,
      ["googlebot.com"],
    );
    expect(mismatch).toMatchObject({ status: "contradicted", cause: "address-mismatch" });

    const noPtr = await forwardConfirmedReverseDns({ reverse: async () => absent(), resolveAddresses: async () => [] }, IP, ["googlebot.com"]);
    expect(noPtr).toMatchObject({ status: "contradicted", cause: "no-ptr" });
  });
});

describe("treatMissingPtrAsForgery", () => {
  // The option was implemented by searching the human-readable reason for "no PTR
  // record", so rewording that sentence would have turned the opt-out into a no-op.
  const claimsGooglebot = (resolver: DnsResolver) =>
    makeContext({ headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, ip: "66.249.66.1", resolver });
  const noPtr: DnsResolver = {
    reverse: () => Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" })),
    resolveAddresses: () => Promise.resolve([]),
  };

  it("accuses a claimed crawler with no PTR record by default", async () => {
    const evidence = await collect(crawlerVerificationDetector(), claimsGooglebot(noPtr));
    expect(evidence[0]?.botClass).toBe("impersonator");
  });

  it("stands down when the operator has switched that off", async () => {
    const evidence = await collect(crawlerVerificationDetector({ treatMissingPtrAsForgery: false }), claimsGooglebot(noPtr));
    expect(evidence).toEqual([]);
  });

  it("still accuses a PTR under the wrong domain either way", async () => {
    const wrong: DnsResolver = {
      reverse: () => Promise.resolve(["vps-1234.cheap-hosting.example"]),
      resolveAddresses: () => Promise.resolve(["66.249.66.1"]),
    };
    const evidence = await collect(crawlerVerificationDetector({ treatMissingPtrAsForgery: false }), claimsGooglebot(wrong));
    expect(evidence[0]?.botClass).toBe("impersonator");
  });
});

describe("actions that must not cost the visitor", () => {
  const facts = () => makeFacts({ headers: { "user-agent": "curl/8.4.0" }, headerOrder: ["user-agent"] });

  // The one place a third party's code runs on the request path. Everything else here
  // — detectors, stores, sinks — degrades to serving the request when it fails.
  it("contains a custom handler that throws", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({
      resolver: failingResolver(),
      onWarning: (message) => warnings.push(message),
      rules: [{ id: "boom", match: {}, action: "custom", params: { handler: "boom" } }],
      handlers: [
        {
          id: "boom",
          execute: () => {
            throw new Error("third-party handler bug");
          },
        },
      ],
    });
    const { outcome } = await handler.handle(facts());
    expect(outcome.kind).toBe("continue");
    expect(warnings.join(" ")).toContain("third-party handler bug");
  });

  it("contains a custom handler that rejects", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      rules: [{ id: "boom", match: {}, action: "custom", params: { handler: "boom" } }],
      handlers: [{ id: "boom", execute: () => Promise.reject(new Error("async handler bug")) }],
    });
    expect((await handler.handle(facts())).outcome.kind).toBe("continue");
  });

  // Headers configured on a rule were accepted and silently dropped for `allow`
  // alone, which is the "configured but inert" failure the config layer refuses to
  // allow anywhere else.
  it("applies a rule's headers on allow, as it does on tag", async () => {
    for (const action of ["allow", "tag"] as const) {
      const handler = new BotHandler({
        resolver: failingResolver(),
        rules: [{ id: action, match: {}, action, params: { headers: { "x-served-by": action } } }],
      });
      const { outcome } = await handler.handle(facts());
      expect(outcome.kind === "continue" ? outcome.responseHeaders : undefined, action).toEqual({ "x-served-by": action });
    }
  });
});

describe("single-use claims", () => {
  // `consumeOnce(key, ttlMs)` used to discard the caller's window entirely.
  it("honours the caller's window rather than the store's own", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    expect(await store.consumeOnce("nonce", 120_000)).toBe(true);
    expect(await store.consumeOnce("nonce", 120_000)).toBe(false);
    clock.advance(119_000);
    expect(await store.consumeOnce("nonce", 120_000)).toBe(false);
    clock.advance(2_000);
    expect(await store.consumeOnce("nonce", 120_000)).toBe(true);
  });
});

describe("patterns an operator wrote", () => {
  // The same stateful-regex trap as `ignorePaths`, but on a policy rule, where the
  // consequence is a bot blocked, served, blocked, served on identical requests.
  it("keeps a global regex in a rule from matching only every other time", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      rules: [{ id: "block-api", match: { certain: true, path: /\/api\//g }, action: "block" }],
    });
    const actions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { decision } = await handler.handle(
        makeFacts({ path: "/api/products", headers: { host: "x", "user-agent": "curl/8.4.0" } }),
      );
      actions.push(decision.action);
    }
    expect(actions).toEqual(["block", "block", "block", "block"]);
  });

  it("still applies a rule regex exactly where it was written to", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      rules: [{ id: "block-api", match: { certain: true, path: /^\/api\//g }, action: "block" }],
    });
    const { decision } = await handler.handle(makeFacts({ path: "/docs/api/", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    expect(decision.action).not.toBe("block");
  });
});

describe("robots.txt derived from a policy", () => {
  // A named group gets `Disallow: /`. A rule that only denies one path therefore
  // becomes a site-wide decline, and a crawler that stops fetching everything is the
  // expensive direction to be wrong in.
  it("reports a rule it declines more broadly than the policy does", () => {
    const { unreadable, declined } = robotsFromRules([
      { id: "premium-only", match: { identity: "gptbot", path: "/premium" }, action: "block" },
    ]);
    expect(declined).toContain("gptbot");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.rule).toBe("premium-only");
    expect(unreadable[0]!.reason).toContain("/premium");
  });

  it("says nothing about a rule that really is site-wide", () => {
    const { unreadable, declined } = robotsFromRules([{ id: "no-ai", match: { category: "ai" }, action: "block" }]);
    expect(unreadable).toEqual([]);
    expect(declined.length).toBeGreaterThan(0);
  });
});

describe("the replay command", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  function logFile(lines: readonly string[]): string {
    const path = join(tmpdir(), `bothandler-replay-${randomUUID()}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  // `Number("all")` is NaN and every comparison against NaN is false, so both flags
  // failed silently: `--limit` stopped limiting, and `--show` printed an empty list
  // under a heading announcing that the list is the point of the exercise.
  it("refuses a numeric flag it cannot read", async () => {
    const file = logFile([JSON.stringify({ ip: "203.0.113.1", url: "/", headers: { "user-agent": "curl/8.4.0", accept: "*/*" } })]);
    for (const args of [["--show", "all"], ["--limit", "-3"], ["--limit", "lots"]]) {
      const result = await run(["replay", file, ...args]);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toMatch(/needs a non-negative number/);
    }
    expect((await run(["replay", file, "--show", "3"])).code).toBe(0);
  });

  // A JSON log carrying the few headers somebody configured their logger to keep is
  // as header-poor as a CLF line, and a replay that quietly detects less while
  // reporting a clean result is the one thing this command must not produce.
  it("says so when the log it read was header-poor", async () => {
    const file = logFile([
      JSON.stringify({ ip: "203.0.113.1", url: "/", httpVersion: "1.1", headers: { host: "shop.example", "user-agent": CHROME } }),
      JSON.stringify({ ip: "203.0.113.2", url: "/", httpVersion: "1.1", headers: { host: "shop.example", "user-agent": CHROME } }),
    ]);
    const { code, out } = await run(["replay", file]);
    expect(code).toBe(0);
    expect(out).toContain("incomplete header set");
    expect(out, "a browser in an access log must not be reported as automation").toContain("unknown");
  });

  it("says nothing about fidelity when the log carried full headers", async () => {
    const file = logFile([
      JSON.stringify({
        ip: "203.0.113.1",
        url: "/",
        httpVersion: "1.1",
        headers: { host: "shop.example", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" },
      }),
    ]);
    const { out } = await run(["replay", file]);
    expect(out).not.toContain("incomplete header set");
  });
});

describe("robots.txt follows the rule order", () => {
  // The file and the policy have to say the same thing. A crawler an earlier rule
  // serves must not be told to stay away by a later category-wide block.
  it("does not decline a crawler an earlier rule serves", () => {
    const { robotsTxt, declined, served } = robotsFromRules([
      { id: "serve-the-citation", match: { identity: "chatgpt-user" }, action: "tag" },
      { id: "decline-the-trainers", match: { category: "ai", certain: true }, action: "block" },
    ]);

    expect(declined).toContain("gptbot");
    expect(declined).not.toContain("chatgpt-user");
    expect(served).toContain("chatgpt-user");
    expect(robotsTxt).not.toContain("ChatGPT-User");
    expect(robotsTxt).toContain("GPTBot");
  });

  it("still declines the whole category when nothing is served ahead of it", () => {
    const { declined } = robotsFromRules([{ id: "decline-ai", match: { category: "ai", certain: true }, action: "block" }]);
    expect(declined).toContain("chatgpt-user");
    expect(declined).toContain("gptbot");
  });

  // A path-scoped allow does not serve a crawler across the site, and a named group in
  // robots.txt can only speak about the whole site.
  it("does not treat a path-scoped rule as serving a crawler everywhere", () => {
    const { declined } = robotsFromRules([
      { id: "allow-on-the-blog", match: { identity: "gptbot", path: "/blog/" }, action: "allow" },
      { id: "decline-ai", match: { category: "ai", certain: true }, action: "block" },
    ]);
    expect(declined).toContain("gptbot");
  });

  it("generates a file for every shipped preset without complaint", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const result = robotsFromRules(preset());
      expect(result.robotsTxt, name).toContain("User-agent: *");
    }
  });
});

/**
 * `bothandlerjs check` — the policy against the corpus.
 *
 * The question the whole library is organised around, asked offline and before a
 * deploy: *if I point this configuration at the actual internet, who gets hurt?* The
 * exit code is the part that belongs in CI.
 */
describe("the check command", () => {
  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  it("reports every audience, and passes when no person is denied", async () => {
    const { code, out } = await run(["check", "--preset", "protect-content"]);
    expect(out).toMatch(/human\s+\d+ cases/);
    expect(out).toContain("No case marked as a person was denied service.");
    expect(code).toBe(0);
  }, 60_000);

  it("answers in JSON for a pipeline", async () => {
    const { code, out } = await run(["check", "--preset", "monitor-only", "--json"]);
    const report = JSON.parse(out) as { preset: string; total: number; falsePositives: unknown[] };
    expect(report.preset).toBe("monitor-only");
    expect(report.total).toBeGreaterThan(400);
    expect(report.falsePositives).toEqual([]);
    expect(code).toBe(0);
  }, 60_000);

  it("narrows to one audience when asked", async () => {
    const { out } = await run(["check", "--audience", "human", "--json"]);
    const report = JSON.parse(out) as { byAudience: Record<string, { total: number }> };
    expect(report.byAudience["human"]?.total).toBeGreaterThan(100);
    expect(report.byAudience["hostile"]?.total).toBe(0);
  }, 60_000);

  it("refuses a preset and an audience it does not have", async () => {
    expect((await run(["check", "--preset", "nonsense"])).code).toBe(1);
    expect((await run(["check", "--audience", "robots"])).err).toMatch(/Unknown audience/);
  });
});

/** `bothandlerjs explain` — the dry run, for the question that arrives by ticket. */
describe("the explain command", () => {
  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  it("explains a User-Agent, with the evidence and the rule", async () => {
    const { code, out } = await run(["explain", "curl/8.4.0"]);
    expect(out).toContain("confirmed-bot");
    expect(out).toContain("self-identified");
    expect(out).toMatch(/rule\s+\S/);
    expect(code).toBe(0);
  });

  /**
   * `--preset protect-data` is two tokens and only the first looks like a flag, so
   * filtering on a leading `--` left `protect-data` behind as though somebody had typed
   * it. `explain` read it as the request and reported a verdict on the string
   * "protect-data".
   */
  it("does not mistake a flag's value for the request", async () => {
    const { out } = await run(["explain", "--preset", "protect-data", "curl/8.4.0"]);
    expect(out).toContain("curl/8.4.0");
    expect(out).not.toContain("protect-data\n");
  });

  it("takes the fields beside the request", async () => {
    const { out } = await run(["explain", "--ip", "198.51.100.9", "--url", "/checkout", "curl/8.4.0"]);
    expect(out).toContain("GET /checkout");
    expect(out).not.toContain("client address 203.0.113.1");
  });

  it("says what it assumed, and that it has no history", async () => {
    const { out } = await run(["explain", "curl/8.4.0"]);
    expect(out).toContain("Assumed —");
    expect(out).toContain("assessed as a first request");
  });

  it("answers in JSON, and refuses an empty request", async () => {
    const parsed = JSON.parse((await run(["explain", "--json", "curl/8.4.0"])).out) as { assessment: { verdict: string } };
    expect(parsed.assessment.verdict).toBe("confirmed-bot");
    expect((await run(["explain", "   "])).code).toBe(1);
  });
});

/**
 * Loading a reputation feed.
 *
 * The data could always be *installed* — `updateRanges("denylist", …)` has been public
 * from the start — but there was no safe way to load one. `fetchCrawlerRanges` refuses a
 * list on the grounds that no crawler owns that much of the internet, which is the right
 * rule for a crawler and the wrong one for a feed of thousands of hijacked blocks.
 */
describe("fetching an address list", () => {
  const respond = (body: string, status = 200): typeof globalThis.fetch =>
    (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

  it("reads the line format every reputation feed publishes", async () => {
    const prefixes = await fetchAddressList(
      { id: "denylist", url: "https://example.invalid/drop.txt" },
      { fetch: respond("; a feed's header\n203.0.113.0/24\n198.51.100.0/22 ; hijacked\n\n# comment\n192.0.2.0/24\n") },
    );
    expect(prefixes).toEqual(["203.0.113.0/24", "198.51.100.0/22", "192.0.2.0/24"]);
  });

  it("accepts a list far larger than any crawler's", async () => {
    // The reason this exists. A crawler publishes hundreds of prefixes; a reputation feed
    // publishes thousands, and the crawler loader refuses those outright.
    const many = Array.from({ length: 12_000 }, (_, i) => `198.51.${i % 256}.${(i * 7) % 256}/32`).join("\n");
    const prefixes = await fetchAddressList({ id: "denylist", url: "https://example.invalid/big.txt" }, { fetch: respond(many) });
    expect(prefixes).toHaveLength(12_000);
    await expect(fetchCrawlerRanges({ id: "googlebot", url: "https://example.invalid/big.txt" }, { fetch: respond(many) })).rejects.toThrow();
  });

  it("refuses a list containing a block big enough to matter, whole", async () => {
    // Partial trust is the wrong shape: a denylist entry is `certain` and blocks people,
    // so a feed that slipped in half the internet must not be applied in part.
    await expect(
      fetchAddressList({ id: "denylist", url: "https://example.invalid/bad.txt" }, { fetch: respond("203.0.113.0/24\n10.0.0.0/4\n") }),
    ).rejects.toThrow(/covers more of the internet/);
  });

  it("will not fetch one over plain HTTP", async () => {
    // Anything between here and the publisher would get to choose who this blocks.
    await expect(fetchAddressList({ id: "denylist", url: "http://example.invalid/drop.txt" }, { fetch: respond("203.0.113.0/24") })).rejects.toThrow(ConfigError);
  });

  it("hands back prefixes rather than installing them", async () => {
    // Two steps on purpose: fetching is the part that fails, installing is the part that
    // changes what happens to somebody.
    const handler = new BotHandler();
    const prefixes = await fetchAddressList({ id: "denylist", url: "https://example.invalid/drop.txt" }, { fetch: respond("203.0.113.0/24") });
    handler.updateRanges("denylist", prefixes);
    const assessment = await handler.assess(
      createFacts({ method: "GET", url: "/", headers: { host: "shop.test", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15" }, ip: "203.0.113.9" }),
    );
    expect(assessment.evidence.some((item) => item.detector === "ip-intelligence")).toBe(true);
  });
});
