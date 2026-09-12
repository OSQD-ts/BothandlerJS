import { describe, expect, it, vi } from "vitest";
import { BotHandler } from "../src/core.js";
import { ConfigError } from "../src/config.js";
import { ManualClock } from "../src/internal/clock.js";
import { CHROME_HEADERS, CHROME_HEADER_ORDER, fakeResolver, failingResolver, makeFacts } from "./helpers.js";
import type { BotEvent } from "../src/notify/types.js";
import type { Detector } from "../src/detectors/types.js";
import { withTimeout } from "../src/internal/async.js";

const SECRET = "s".repeat(32);

function engine(overrides: ConstructorParameters<typeof BotHandler>[0] = {}) {
  return new BotHandler({ resolver: failingResolver(), clock: new ManualClock(1_700_000_000_000), ...overrides });
}

describe("assess", () => {
  it("leaves a genuine browser request alone", async () => {
    const assessment = await engine().assess(makeFacts({ headerOrder: CHROME_HEADER_ORDER }));
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.score).toBe(0);
    expect(assessment.evidence).toHaveLength(0);
  });

  it("proves a bare HTTP client", async () => {
    const assessment = await engine().assess(makeFacts({ headers: { host: "example.test", "user-agent": "python-requests/2.31.0" } }));
    expect(assessment.verdict).toBe("confirmed-bot");
    expect(assessment.certain).toBe(true);
    expect(assessment.botClass).toBe("http-client");
  });

  it("confirms a crawler whose DNS checks out", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"] }, { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] });
    const assessment = await engine({ resolver }).assess(
      makeFacts({ headers: { host: "example.test", "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, ip: "66.249.66.1" }),
    );
    expect(assessment.verdict).toBe("verified-bot");
    expect(assessment.identity).toBe("googlebot");
  });

  // Regression: `self-identified` and `crawler-verification` both fire on every
  // verified crawler, and if the bare declaration wins that tie the "allow verified
  // crawlers" rule never matches. The first symptom is your search traffic vanishing.
  it("actually allows a confirmed crawler through the content preset", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"] }, { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] });
    const handler = engine({ resolver, preset: "protect-content" });
    const { decision, outcome } = await handler.handle(
      makeFacts({ headers: { host: "example.test", "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, ip: "66.249.66.1" }),
    );
    expect(decision.rule).toBe("verified-crawler-allow");
    expect(outcome.kind).toBe("continue");
  });

  it("names a forged crawler as an impersonator", async () => {
    const resolver = fakeResolver({ "198.51.100.4": ["vps.cheap-hosting.example"] }, {});
    const assessment = await engine({ resolver }).assess(
      makeFacts({ headers: { host: "example.test", "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, ip: "198.51.100.4" }),
    );
    expect(assessment.botClass).toBe("impersonator");
    expect(assessment.certain).toBe(true);
  });

  it("skips detection entirely for an allowlisted address", async () => {
    const assessment = await engine({ allowlist: ["203.0.113.0/24"] }).assess(makeFacts({ headers: { "user-agent": "curl/8.4.0" } }));
    expect(assessment.bypass).toBe("allowlist");
    expect(assessment.evidence).toHaveLength(0);
  });

  it("skips ignored paths", async () => {
    const assessment = await engine({ ignorePaths: ["/healthz"] }).assess(makeFacts({ path: "/healthz", headers: { "user-agent": "curl/8.4.0" } }));
    expect(assessment.bypass).toBe("ignored-path");
  });

  it("accepts the application's assertion that a request is human", async () => {
    const handler = engine({ isHuman: () => true });
    const assessment = await handler.assess(makeFacts({ headers: { host: "example.test", "user-agent": "Mozilla/5.0 Firefox/120.0 Gecko/20100101" } }));
    expect(assessment.verdict).toBe("human");
    expect(assessment.certain).toBe(true);
  });

  // Isolation: one broken detector must not take the request, or the rest of
  // detection, down with it.
  it("survives a detector that throws, and records the failure", async () => {
    const broken: Detector = {
      id: "broken",
      description: "throws",
      inspect() {
        throw new Error("boom");
      },
    };
    const errors: string[] = [];
    const handler = engine({ extraDetectors: [broken], onError: (_error, context) => errors.push(context.source) });
    const assessment = await handler.assess(makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0" } }));
    expect(assessment.verdict).toBe("confirmed-bot");
    expect(assessment.failures).toEqual([{ detector: "broken", reason: "error", message: "boom" }]);
    expect(errors).toContain("detector:broken");
  });

  it("survives a detector that never settles", async () => {
    const slow: Detector = { id: "slow", description: "hangs", cost: "io", inspect: () => new Promise(() => {}) };
    const assessment = await engine({ extraDetectors: [slow], detectorTimeoutMs: 20 }).assess(makeFacts());
    expect(assessment.failures[0]).toMatchObject({ detector: "slow", reason: "timeout" });
  });
});

describe("handle", () => {
  it("blocks a proven bot under the content preset", async () => {
    const handler = engine({ preset: "protect-content" });
    const { outcome, decision } = await handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": "sqlmap/1.7" } }));
    expect(decision.action).toBe("block");
    expect(outcome.kind).toBe("respond");
    if (outcome.kind === "respond") {
      expect(outcome.status).toBe(403);
      expect(outcome.headers["x-robots-tag"]).toBe("noindex, nofollow");
    }
  });

  it("tags rather than blocks when the evidence is only probabilistic", async () => {
    const handler = engine({
      rules: [{ id: "block-everything", match: () => true, action: "block" }],
      // No challenge configured, so the guard's substitute is `tag`.
    });
    const { outcome, decision } = await handler.handle(makeFacts({ headers: { host: "example.test", accept: "*/*", "user-agent": CHROME_HEADERS["user-agent"]! } }));
    expect(decision.downgradedFrom).toBe("block");
    expect(outcome.kind).toBe("continue");
  });

  it("serves a challenge page when one is configured", async () => {
    const handler = engine({
      challenge: { secrets: [SECRET] },
      rules: [{ id: "challenge-all", match: () => true, action: "challenge" }],
    });
    const { outcome } = await handler.handle(makeFacts());
    expect(outcome.kind).toBe("respond");
    if (outcome.kind === "respond") {
      expect(outcome.status).toBe(429);
      expect(outcome.headers["content-security-policy"]).toBeTruthy();
    }
  });

  it("degrades gracefully when a rule asks for a challenge that is not configured", async () => {
    const warnings: string[] = [];
    const handler = engine({ rules: [{ id: "challenge-all", match: () => true, action: "challenge" }], onWarning: (message) => warnings.push(message) });
    const { outcome } = await handler.handle(makeFacts());
    expect(outcome.kind).toBe("continue");
    expect(warnings.join(" ")).toMatch(/no challenge secrets are configured/);
  });

  it("keeps verdict headers off the response unless asked", async () => {
    const quiet = await engine({ preset: "monitor-only" }).handle(makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0" } }));
    expect(quiet.outcome.kind === "continue" && quiet.outcome.responseHeaders).toBeUndefined();
    expect(quiet.outcome.kind === "continue" && quiet.outcome.requestHeaders?.["x-bot-verdict"]).toBe("confirmed-bot");

    const loud = await engine({ preset: "monitor-only", exposeVerdictHeaders: true }).handle(makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0" } }));
    expect(loud.outcome.kind === "continue" && loud.outcome.responseHeaders?.["x-bot-verdict"]).toBe("confirmed-bot");
  });

  it("enforces a rate limit and reports when to come back", async () => {
    const handler = engine({ rules: [{ id: "limit", match: () => true, action: "rate-limit", params: { limit: { max: 2, windowMs: 60_000 } } }] });
    const facts = makeFacts();
    expect((await handler.handle(facts)).outcome.kind).toBe("continue");
    expect((await handler.handle(facts)).outcome.kind).toBe("continue");
    const third = await handler.handle(facts);
    expect(third.outcome.kind).toBe("respond");
    if (third.outcome.kind === "respond") {
      expect(third.outcome.status).toBe(429);
      expect(third.outcome.headers["retry-after"]).toBe("60");
    }
  });

  it("strips control characters out of header values", async () => {
    const handler = engine({ preset: "monitor-only", exposeVerdictHeaders: true });
    const nasty = "curl/8.4.0\r\nX-Injected: yes";
    const { outcome } = await handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": nasty } }));
    const reason = outcome.kind === "continue" ? outcome.responseHeaders?.["x-bot-reason"] : undefined;
    expect(reason).toBeDefined();
    expect(reason).not.toMatch(/[\r\n]/);
  });
});

describe("notifications", () => {
  it("reports an action but stays quiet about an ordinary allow", async () => {
    const events: BotEvent[] = [];
    const handler = engine({
      preset: "protect-content",
      notifications: { sinks: [{ id: "test", notify: (event) => void events.push(event) }] },
    });
    await handler.handle(makeFacts({ headerOrder: CHROME_HEADER_ORDER }));
    expect(events).toHaveLength(0);
    await handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": "sqlmap/1.7" } }));
    expect(events.map((event) => event.type)).toContain("action");
  });

  it("collapses repeats from one actor", async () => {
    const events: BotEvent[] = [];
    const handler = engine({
      preset: "protect-content",
      notifications: { sinks: [{ id: "test", notify: (event) => void events.push(event) }], dedupeWindowMs: 60_000 },
    });
    const facts = makeFacts({ headers: { host: "example.test", "user-agent": "sqlmap/1.7" } });
    for (let i = 0; i < 20; i++) await handler.handle(facts);
    expect(events.length).toBeLessThanOrEqual(2);
  });

  it("masks the client address before an event leaves the process", async () => {
    const events: BotEvent[] = [];
    const handler = engine({
      preset: "protect-content",
      notifications: { sinks: [{ id: "test", notify: (event) => void events.push(event) }] },
    });
    await handler.handle(makeFacts({ headers: { host: "example.test", cookie: "session=secret", "user-agent": "sqlmap/1.7" }, ip: "203.0.113.55" }));
    const event = events[0]!;
    expect(event.assessment!.facts.ip).toBe("203.0.113.0/24");
    expect(event.assessment!.facts.headers["cookie"]).toBeUndefined();
  });

  it("contains a sink that throws", async () => {
    const errors: unknown[] = [];
    const handler = engine({
      preset: "protect-content",
      notifications: {
        sinks: [
          {
            id: "broken",
            notify: () => {
              throw new Error("sink down");
            },
          },
        ],
      },
      onError: (error) => errors.push(error),
    });
    await expect(handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": "sqlmap/1.7" } }))).resolves.toBeDefined();
    expect(errors).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("rejects a malformed range rather than matching nothing", () => {
    expect(() => engine({ allowlist: ["10.0.0.0/8", "oops"] })).toThrow(ConfigError);
  });

  it("rejects duplicate detector ids", () => {
    const twice: Detector = { id: "dupe", description: "x", inspect: () => undefined };
    expect(() => engine({ detectors: [twice, { ...twice }] })).toThrow(ConfigError);
  });

  it("rejects an unknown preset", () => {
    expect(() => engine({ preset: "nope" as never })).toThrow(ConfigError);
  });

  it("warns when trustProxy is on with nothing to anchor it", () => {
    const warnings: string[] = [];
    engine({ proxy: { trustProxy: true }, onWarning: (message) => warnings.push(message) });
    expect(warnings.join(" ")).toMatch(/clients can choose the address/);
  });

  /**
   * The quietest way this library can be wrong: a crawler refused for a missing config
   * entry, under a rule that fires and names a perfectly good reason for doing it.
   */
  it("names the crawlers a policy will refuse only because their ranges were never supplied", () => {
    const warnings: string[] = [];
    engine({ preset: "indexers-only", onWarning: (message) => warnings.push(message) });
    const said = warnings.join(" ");
    expect(said).toMatch(/DuckDuckBot/);
    expect(said).toMatch(/Facebook external hit/);
    // And it says which rule does it, since that is what you would have to change.
    expect(said).toMatch(/unverifiable-search-block/);
    expect(said).toMatch(/unverifiable-social-block/);

    // Supplying the ranges is the fix, so supplying them ends the warning.
    const fixed: string[] = [];
    engine({
      preset: "indexers-only",
      crawlerRanges: { duckduckbot: ["20.191.45.0/24"], "facebook-external": ["31.13.24.0/21"] },
      onWarning: (message) => fixed.push(message),
    });
    expect(fixed.join(" ")).not.toMatch(/DuckDuckBot|Facebook external hit/);
  });

  /**
   * The dashboard says "Facebook external hit"; the rule has to say "facebook-external".
   * Somebody reading a verdict off the screen writes the first, gets a rule that never
   * matches, and has a policy that looks like protection and is not.
   */
  it("catches a rule that names a signature's display name instead of its id", () => {
    const warnings: string[] = [];
    engine({ rules: [{ id: "unfurl", match: { identity: "Facebook external hit" }, action: "allow" }], onWarning: (message) => warnings.push(message) });
    const said = warnings.join(" ");
    expect(said).toMatch(/never match/);
    // And it says which id was meant, which is the whole value of noticing.
    expect(said).toMatch(/"facebook-external"/);
  });

  it("says a rule's identity is unknown without guessing when it cannot", () => {
    const warnings: string[] = [];
    engine({ rules: [{ id: "ours", match: { identity: "our-ssr" }, action: "allow" }], onWarning: (message) => warnings.push(message) });
    expect(warnings.join(" ")).toMatch(/not the id of any signature/);

    // A signature the deployment supplied is known, so naming it is silent.
    const quiet: string[] = [];
    engine({
      extraSignatures: [{ id: "our-ssr", name: "Our renderer", tokens: ["our-ssr"], category: "other", benign: true, verification: { kind: "none" } }],
      rules: [{ id: "ours", match: { identity: "our-ssr" }, action: "allow" }],
      onWarning: (message) => quiet.push(message),
    });
    expect(quiet.join(" ")).not.toMatch(/identity/);
  });

  it("says nothing about verification a policy never asks for", () => {
    // `protect-content` serves an unconfirmable indexer rather than refusing it, so
    // nothing is stranded and there is nothing to say.
    const warnings: string[] = [];
    engine({ preset: "protect-content", onWarning: (message) => warnings.push(message) });
    expect(warnings.join(" ")).not.toMatch(/crawlerRanges/);
  });

  it("warns loudly about aggressive mode", () => {
    const warnings: string[] = [];
    engine({ falsePositivePolicy: "aggressive", onWarning: (message) => warnings.push(message) });
    expect(warnings.join(" ")).toMatch(/Real visitors will be turned away/);
  });

  it("lists the detectors that are actually installed", () => {
    const described = engine({ challenge: { secrets: [SECRET] } }).describeDetectors();
    expect(described.map((entry) => entry.id)).toContain("clearance");
    expect(described.find((entry) => entry.id === "crawler-verification")?.stage).toBe("confirming");
  });
});

describe("challenge round trip through the engine", () => {
  it("recognises its own verification endpoint and grants clearance", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const handler = new BotHandler({ resolver: failingResolver(), clock, challenge: { secrets: [SECRET], difficulty: 8 } });
    const { solveProofOfWork } = await import("../src/challenge/pow.js");

    const challenged = await handler.handle(makeFacts());
    expect(handler.isChallengeEndpoint({ method: "POST", path: "/__bothandler/verify" })).toBe(true);

    const page = handler.challenge!.issue("203.0.113.10");
    const token = /"challenge":"([^"]+)"/.exec(page.body)![1]!;
    const nonce = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url").toString("utf8")).nonce as string;

    const outcome = await handler.verifyChallenge(makeFacts(), { challenge: token, solution: solveProofOfWork(nonce, 8) });
    expect(outcome.ok).toBe(true);
    expect(challenged.assessment.verdict).toBe("unknown");
  });

  it("mints operator clearance that later requests present as human evidence", async () => {
    const handler = new BotHandler({ resolver: failingResolver(), challenge: { secrets: [SECRET] } });
    const cookie = handler.grantClearance(makeFacts(), "operator")!;
    const value = cookie.split(";")[0]!;
    const withCookie = makeFacts({ headers: { ...CHROME_HEADERS, cookie: value } });
    const assessment = await handler.assess(withCookie);
    expect(assessment.verdict).toBe("human");
    expect(assessment.certain).toBe(true);
  });
});

describe("performance", () => {
  it("assesses a clean browser request in well under a millisecond", async () => {
    const handler = engine();
    const facts = makeFacts({ headerOrder: CHROME_HEADER_ORDER });
    // Warm up, then measure: the first call pays for lazy compilation.
    for (let i = 0; i < 100; i++) await handler.assess(facts);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) await handler.assess(facts);
    const perRequest = (performance.now() - started) / 1000;
    expect(perRequest).toBeLessThan(1);
  });
});

vi.setConfig({ testTimeout: 20_000 });

describe("regressions", () => {
  const ELECTRON_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.95.3 Chrome/128.0.6613.36 Electron/32.2.1 Safari/537.36";

  // A person reading a page in VS Code's Simple Browser, Slack or Postman sends an
  // Electron User-Agent. Treating that as *proven* automation is the exact class of
  // false positive this library exists to make impossible.
  it("does not treat an Electron desktop app as proven automation", async () => {
    const assessment = await engine().assess(
      makeFacts({ headers: { ...CHROME_HEADERS, "user-agent": ELECTRON_UA }, headerOrder: CHROME_HEADER_ORDER }),
    );
    expect(assessment.certain).toBe(false);
    expect(assessment.verdict).not.toBe("confirmed-bot");
    const electron = assessment.evidence.find((item) => item.identity === "electron");
    expect(electron?.certainty).toBe("weak");
    // "automation" would be asserting something the User-Agent does not establish.
    expect(electron?.botClass).toBe("unknown");
  });

  it("still proves a genuinely headless build", async () => {
    const assessment = await engine().assess(
      makeFacts({ headers: { host: "example.test", "user-agent": ELECTRON_UA.replace("Chrome/", "HeadlessChrome/") } }),
    );
    expect(assessment.certain).toBe(true);
    expect(assessment.botClass).toBe("automation");
  });

  // The livelock: passing a challenge cannot undo a `certain` verdict, so a
  // JS-capable client challenged on proven evidence would solve, reload, and be
  // challenged again forever.
  it("never re-challenges a client that already holds clearance", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({
      resolver: failingResolver(),
      challenge: { secrets: [SECRET] },
      rules: [{ id: "challenge-everything", match: () => true, action: "challenge" }],
      onWarning: (message) => warnings.push(message),
    });

    const first = await handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0" } }));
    expect(first.outcome.kind).toBe("respond");
    expect(first.outcome.kind === "respond" && first.outcome.status).toBe(429);

    // Now the client comes back holding the clearance the challenge would grant.
    const cookie = handler.grantClearance(makeFacts(), "pow")!.split(";")[0]!;
    const second = await handler.handle(makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0", cookie } }));

    expect(second.outcome.kind).toBe("continue");
    expect(warnings.join(" ")).toMatch(/already holds a valid clearance token/);
    expect(warnings.join(" ")).toMatch(/loop forever/);
  });

  it("breaks the loop even when the clearance cookie is gone but the actor is known cleared", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      challenge: { secrets: [SECRET] },
      rules: [{ id: "challenge-everything", match: () => true, action: "challenge" }],
    });
    const facts = makeFacts({ headers: { host: "example.test", "user-agent": "curl/8.4.0" } });
    handler.registry.clearUntil(handler.actorKeyFor(facts), Date.now() + 60_000);
    const result = await handler.handle(facts);
    expect(result.outcome.kind).toBe("continue");
  });
});

/**
 * The wrapper every I/O detector runs inside.
 *
 * Detection is inline on the request path, so an unbounded await is an availability bug —
 * a stalled reverse-DNS lookup or a hung Redis round trip would hold the response open.
 * Only the timeout path was exercised, through one engine test; the rest of this had no
 * coverage at all, including the branch that decides what happens when the work *rejects*.
 * That branch is the one that keeps a detector's failure from becoming the request's.
 */
describe("bounding work that may not come back", () => {
  it("returns the value when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000, "fallback")).resolves.toBe("done");
  });

  it("returns the fallback when the work rejects, rather than rejecting", async () => {
    await expect(withTimeout(Promise.reject(new Error("dns is unhappy")), 1000, "fallback")).resolves.toBe("fallback");
  });

  it("swallows a rejection that arrives after the timeout has already given up", async () => {
    // The dangerous shape: the wrapper has resolved and moved on, and the original promise
    // fails afterwards with nobody holding it. Unhandled, that takes the process down on
    // Node's default settings — from a detector that was already written off.
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", watch);
    try {
      const late = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("too late")), 30));
      await expect(withTimeout(late, 5, "fallback")).resolves.toBe("fallback");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("runs unbounded when asked for no bound at all", async () => {
    // `0` and a non-finite budget both mean "do not impose one", which is what an operator
    // setting `detectorTimeoutMs: 0` is asking for.
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(withTimeout(Promise.resolve("through"), budget, "fallback")).resolves.toBe("through");
    }
  });

  it("does not hold a process open waiting for a timer", () => {
    // The timer is unref'd where the runtime supports it, so a pending detection timer is
    // never the reason a CLI run or a serverless invocation stays alive.
    const timers: Array<{ unrefCalled: boolean }> = [];
    const original = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) => {
      const handle = original(fn, ms) as unknown as { unref?: () => void };
      const record = { unrefCalled: false };
      timers.push(record);
      const realUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        record.unrefCalled = true;
        realUnref?.();
        return handle as never;
      };
      return handle as never;
    }) as unknown as typeof globalThis.setTimeout;
    try {
      void withTimeout(Promise.resolve("x"), 1000, "fallback");
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = original;
    }
    expect(timers.length).toBe(1);
    expect(timers[0]?.unrefCalled).toBe(true);
  });
});
