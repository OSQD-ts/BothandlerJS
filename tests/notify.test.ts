import { describe, expect, it } from "vitest";
import { NotificationHub } from "../src/notify/hub.js";
import { ManualClock } from "../src/internal/clock.js";
import { createFacts } from "../src/facts.js";
import { consoleNotifier, notifyJsNotifier, slackNotifier, webhookNotifier } from "../src/notify/sinks.js";
import { redactEvent } from "../src/notify/redact.js";
import type { Assessment } from "../src/types.js";
import type { BotEvent } from "../src/notify/types.js";

/**
 * The notification path, whose failures are all of the same shape: something that
 * looks configured and quietly is not, or something that quietly says more than it
 * was supposed to.
 */

const SECRET_COOKIE = "session=super-secret-value";
const SECRET_TOKEN = "abc123-secret-reset-token";

function assessment(): Assessment {
  return {
    requestId: "r",
    verdict: "confirmed-bot",
    botClass: "http-client",
    score: 100,
    confidence: 1,
    certain: true,
    evidence: [],
    humanEvidence: [],
    shadowEvidence: [],
    actor: { key: "203.0.113.99", requests: 1, distinctPaths: 1, distinctQueries: 0, queriesSaturated: false, methodsSeen: ["GET"], responses: 0, misses: 0, firstSeen: 0, lastSeen: 0, priorConfirmations: 0, unsolvedChallenges: 0, cleared: false },
    durationMs: 0,
    failures: [],
    facts: createFacts({
      headers: { "user-agent": "curl/8.4.0", cookie: SECRET_COOKIE },
      rawHeaders: ["user-agent", "cookie"],
      url: `/reset?token=${SECRET_TOKEN}`,
      ip: "203.0.113.99",
    }),
  };
}

function event(): BotEvent {
  return { type: "action", at: "", assessment: assessment(), decision: { action: "block", rule: "r", reason: "r", params: {} } };
}

describe("the suppression summary", () => {
  // It built its own fan-out and sent the sample assessment straight through, so the
  // one moment redaction mattered most — a window rolling under heavy traffic — was
  // the one moment it did not run.
  it("is redacted like every other event", () => {
    const clock = new ManualClock(0);
    const delivered: string[] = [];
    const hub = new NotificationHub({
      clock,
      dedupeWindowMs: 1000,
      sinks: [{ id: "t", notify: (payload) => void delivered.push(JSON.stringify(payload)) }],
      filter: { types: ["action"], minScore: 0 },
    });

    hub.emit(event());
    hub.emit(event()); // deduplicated, so something is suppressed
    clock.advance(2000);
    hub.emit(event()); // window rolls: the summary goes out

    const summary = delivered.find((payload) => payload.includes("were suppressed"));
    expect(summary, "the summary must be delivered at all").toBeDefined();
    expect(summary).not.toContain("203.0.113.99");
    expect(summary).not.toContain(SECRET_COOKIE);
    expect(summary).not.toContain(SECRET_TOKEN);
  });

  it("still reports how much it hid", () => {
    const clock = new ManualClock(0);
    const delivered: BotEvent[] = [];
    const hub = new NotificationHub({
      clock,
      dedupeWindowMs: 1000,
      sinks: [{ id: "t", notify: (payload) => void delivered.push(payload) }],
      filter: { types: ["action"], minScore: 0 },
    });
    hub.emit(event());
    for (let i = 0; i < 4; i++) hub.emit(event());
    clock.advance(2000);
    hub.emit(event());
    expect(delivered.find((payload) => payload.error?.message.includes("4 notification(s)"))).toBeDefined();
  });
});

describe("webhook delivery", () => {
  function counting(status: number): { attempts: () => number; fetch: typeof globalThis.fetch } {
    let attempts = 0;
    return {
      attempts: () => attempts,
      fetch: (async () => {
        attempts++;
        return new Response("", { status });
      }) as typeof globalThis.fetch,
    };
  }

  // The `throw` meant to end the loop landed in the loop's own `catch`, so a status
  // that can never succeed was retried anyway and its code was lost.
  it("does not retry a rejection that will never succeed", async () => {
    for (const status of [400, 401, 403, 404]) {
      const stub = counting(status);
      const sink = webhookNotifier({ url: "https://example.test/hook", retries: 2, fetch: stub.fetch });
      await expect(sink.notify(event())).rejects.toThrow(String(status));
      expect(stub.attempts(), `status ${status}`).toBe(1);
    }
  });

  it("still retries what might succeed", async () => {
    const stub = counting(503);
    const sink = webhookNotifier({ url: "https://example.test/hook", retries: 2, timeoutMs: 50, fetch: stub.fetch });
    await expect(sink.notify(event())).rejects.toThrow();
    expect(stub.attempts()).toBe(3);
  });

  it("retries a 429, which is a hiccup rather than a rejection", async () => {
    const stub = counting(429);
    const sink = webhookNotifier({ url: "https://example.test/hook", retries: 1, fetch: stub.fetch });
    await expect(sink.notify(event())).rejects.toThrow();
    expect(stub.attempts()).toBe(2);
  });

  it("signs the exact body it sends, timestamp included", async () => {
    let seen: Record<string, string> = {};
    const sink = webhookNotifier({
      url: "https://example.test/hook",
      secret: "a-webhook-secret",
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return new Response("", { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    await sink.notify(event());
    expect(seen["x-bothandler-signature"]).toMatch(/^sha256=/);
    expect(seen["x-bothandler-timestamp"]).toMatch(/^\d+$/);
  });
});

describe("sinks that used to fail silently", () => {
  // A revoked webhook URL or an expired hub token produced no delivery and no error,
  // which is indistinguishable from a quiet week.
  it("reports a rejection from Slack", async () => {
    const sink = slackNotifier({ url: "https://hooks.example/x", fetch: (async () => new Response("no_service", { status: 404 })) as typeof globalThis.fetch });
    await expect(sink.notify(event())).rejects.toThrow("404");
  });

  it("reports a rejection from a NotifyJS hub", async () => {
    const sink = notifyJsNotifier({
      endpoint: "https://hub.example",
      token: "t",
      fetch: (async () => new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch,
    });
    await expect(sink.notify(event())).rejects.toThrow("401");
  });

  it("says nothing when delivery succeeds", async () => {
    const ok = (async () => new Response("ok", { status: 200 })) as typeof globalThis.fetch;
    await expect(slackNotifier({ url: "https://hooks.example/x", fetch: ok }).notify(event())).resolves.toBeUndefined();
    await expect(notifyJsNotifier({ endpoint: "https://hub.example", token: "t", fetch: ok }).notify(event())).resolves.toBeUndefined();
  });

  // The hub is what keeps a failing sink from becoming a failing request.
  it("contains a sink that rejects", async () => {
    const errors: string[] = [];
    const hub = new NotificationHub({
      sinks: [{ id: "bad", notify: () => Promise.reject(new Error("sink down")) }],
      filter: { types: ["action"], minScore: 0 },
      onError: (error, sinkId) => errors.push(`${sinkId}:${(error as Error).message}`),
    });
    expect(() => hub.emit(event())).not.toThrow();
    await Promise.resolve();
    expect(errors).toEqual(["bad:sink down"]);
  });
});

/**
 * The marker observation, on the way out to a sink.
 *
 * `redactEvent` masks the actor key and the address by default, and drops `facts.cookies`
 * outright — "a session in structured form", as the comment there puts it, is not
 * something an alert needs. A marker's claims are that same session spelled differently,
 * and `sub` identifies a client more precisely than either identifier the module masks.
 * It reached sinks untouched only because the marker was added after redaction was
 * written.
 */
describe("what a marker tells a sink", () => {
  const observed = {
    reading: { kind: "valid" as const, claims: { v: 1 as const, sub: "MARKER-ID-abc123", iat: 1_700_000_000_000, exp: 1_700_043_200_000, b: "chrome", o: "macos", l: "en" } },
    drift: { browser: true, platform: false, language: false },
    shape: { b: "curl", o: "none", l: "en" },
    networks: 4,
  };

  const eventWith = (marker: unknown): BotEvent =>
    ({ type: "detection", at: new Date().toISOString(), assessment: { ...assessment(), marker } } as unknown as BotEvent);

  it("keeps the marker's findings and drops its claims", () => {
    const out = redactEvent(eventWith(observed));
    const marker = (out.assessment as unknown as { marker?: Record<string, unknown> }).marker;
    expect(marker).toBeDefined();
    // The useful half survives.
    expect((marker as { reading: { kind: string } }).reading.kind).toBe("valid");
    expect((marker as { drift: unknown }).drift).toEqual({ browser: true, platform: false, language: false });
    expect((marker as { networks: number }).networks).toBe(4);
    // The identifying half does not.
    expect((marker as { reading: { claims?: unknown } }).reading.claims).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("MARKER-ID-abc123");
  });

  it("withholds the identity parts when the User-Agent is being withheld", () => {
    // The shape is three coarse parts of the User-Agent. Sending them while dropping the
    // User-Agent itself would make that setting half apply.
    const out = redactEvent(eventWith(observed), { dropUserAgent: true });
    expect(JSON.stringify(out)).not.toContain("curl");
  });

  it("says nothing about a marker on an event that has none", () => {
    const out = redactEvent(eventWith(undefined));
    expect((out.assessment as unknown as { marker?: unknown }).marker).toBeUndefined();
  });
});

/**
 * The console sink, which is the default and had no tests.
 *
 * Every deployment that configures notifications and names no sink gets this one, and it
 * has to survive all five event shapes — including `anomaly`, which carries no assessment
 * at all, and `error`, which is about the library rather than about traffic. A sink that
 * throws is caught and reported, so a bug here would not take a site down; it would
 * quietly turn the default notification channel into an error channel, which is a harder
 * thing to notice.
 */
describe("the console sink", () => {
  function recorder(): { target: Pick<Console, "log" | "warn" | "error">; log: string[]; warn: string[]; error: string[] } {
    const log: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    return {
      log,
      warn,
      error,
      target: {
        log: (...args: unknown[]) => void log.push(args.join(" ")),
        warn: (...args: unknown[]) => void warn.push(args.join(" ")),
        error: (...args: unknown[]) => void error.push(args.join(" ")),
      } as Pick<Console, "log" | "warn" | "error">,
    };
  }

  const eventOf = (type: BotEvent["type"], extra: Partial<BotEvent> = {}): BotEvent =>
    ({ type, at: new Date().toISOString(), assessment: assessment(), ...extra } as BotEvent);

  it("survives every event shape, in both formats", () => {
    for (const format of ["pretty", "json"] as const) {
      const sink = recorder();
      const notifier = consoleNotifier({ format, target: sink.target });
      const events: BotEvent[] = [
        eventOf("detection"),
        eventOf("action", { decision: { action: "block", params: {}, ruleId: "r" } as unknown as BotEvent["decision"] }),
        eventOf("downgrade"),
        eventOf("error", { assessment: undefined, error: { source: "detector:x", message: "boom" } }),
        // The shape with no assessment at all, which the pretty path has its own branch for.
        eventOf("anomaly", { assessment: undefined, anomaly: { id: "bot-share-spike", summary: "bots up" } as unknown as BotEvent["anomaly"] }),
      ];
      for (const event of events) expect(() => notifier.notify(event), `${format}/${event.type}`).not.toThrow();
      expect(sink.log.length + sink.warn.length + sink.error.length, format).toBe(events.length);
    }
  });

  it("prints what actually went wrong on an error event", () => {
    // `event.error` was unreachable through this sink. An error carrying no assessment
    // fell into the anomaly line and printed `[bothandler] error unknown — `, discarding
    // the source and the message; one carrying an assessment printed the request's
    // evidence instead. Errors are how a failed detector, sink or store is reported, and
    // this is the sink an operator gets without configuring one.
    const sink = recorder();
    consoleNotifier({ target: sink.target }).notify(
      eventOf("error", { assessment: undefined, error: { source: "detector:crawler-verification", message: "resolver exploded" } }),
    );
    expect(sink.error).toHaveLength(1);
    expect(sink.error[0]).toContain("detector:crawler-verification");
    expect(sink.error[0]).toContain("resolver exploded");
    expect(sink.error[0]).not.toContain("unknown");
  });

  it("prefers the error over the request when an event carries both", () => {
    // The hub's own suppression summary is this shape: it names a request for context but
    // the point of it is the message.
    const sink = recorder();
    consoleNotifier({ target: sink.target }).notify(
      eventOf("error", { error: { source: "notification-hub", message: "12 notification(s) were suppressed" } }),
    );
    expect(sink.error[0]).toContain("12 notification(s) were suppressed");
  });

  it("sends each event to the stream that matches how bad it is", () => {
    // An operator filtering their logs by level should get the same answer the event type
    // gives: an error is an error, a downgrade is a warning, everything else is a line.
    const sink = recorder();
    const notifier = consoleNotifier({ target: sink.target });
    notifier.notify(eventOf("error", { assessment: undefined, error: { source: "s", message: "m" } }));
    notifier.notify(eventOf("downgrade"));
    notifier.notify(eventOf("detection"));
    expect(sink.error).toHaveLength(1);
    expect(sink.warn).toHaveLength(1);
    expect(sink.log).toHaveLength(1);
  });

  it("writes one parseable object per event in json format", () => {
    const sink = recorder();
    consoleNotifier({ format: "json", target: sink.target }).notify(eventOf("detection"));
    expect(sink.log).toHaveLength(1);
    expect(() => JSON.parse(sink.log[0] as string)).not.toThrow();
    expect(JSON.parse(sink.log[0] as string).type).toBe("detection");
  });

  it("says what it knows when an anomaly carries no request", () => {
    const sink = recorder();
    consoleNotifier({ target: sink.target }).notify(
      eventOf("anomaly", { assessment: undefined, anomaly: { id: "bot-share-spike", summary: "bot share up 6x" } as unknown as BotEvent["anomaly"] }),
    );
    expect(sink.warn[0]).toContain("bot-share-spike");
    expect(sink.warn[0]).toContain("bot share up 6x");
  });
});

/** The same rule as the dashboard's, on the path that leaves the process entirely. */
describe("headers that hold a secret, on the way out", () => {
  it("drops one named by the deployment and one that names itself", () => {
    const event: BotEvent = {
      type: "detection",
      at: new Date().toISOString(),
      assessment: {
        ...assessment(),
        facts: createFacts({
          method: "GET",
          url: "/x",
          headers: { host: "s", "user-agent": "curl/8.4.0", "x-acme-automation": "namedvalue", "x-acme-token": "guessedvalue", "x-request-id": "keepthisone" },
          ip: "203.0.113.7",
        }),
      },
    };
    const sent = JSON.stringify(redactEvent(event, { neverSend: ["x-acme-automation"] }));
    expect(sent).not.toContain("namedvalue");
    expect(sent).not.toContain("guessedvalue");
    expect(sent).toContain("keepthisone");

    const guessless = JSON.stringify(redactEvent(event, { guessSecretHeaders: false }));
    expect(guessless).toContain("guessedvalue");
  });
});
