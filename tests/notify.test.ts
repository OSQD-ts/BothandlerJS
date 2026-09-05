import { describe, expect, it } from "vitest";
import { NotificationHub } from "../src/notify/hub.js";
import { ManualClock } from "../src/internal/clock.js";
import { createFacts } from "../src/facts.js";
import { notifyJsNotifier, slackNotifier, webhookNotifier } from "../src/notify/sinks.js";
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
    actor: { key: "203.0.113.99", requests: 1, distinctPaths: 1, firstSeen: 0, lastSeen: 0, priorConfirmations: 0, unsolvedChallenges: 0, cleared: false },
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
