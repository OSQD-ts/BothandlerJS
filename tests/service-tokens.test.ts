import { describe, expect, it } from "vitest";
import { BotHandler } from "../src/core.js";
import { DEFAULT_TOKEN_HEADER, ServiceTokens } from "../src/service-tokens.js";
import { ManualClock } from "../src/internal/clock.js";
import { createFacts } from "../src/facts.js";
import { failingResolver } from "./helpers.js";

/**
 * Shared secrets that let a service caller prove itself.
 *
 * The case this exists for: an uptime monitor is a bare `fetch` with nothing
 * browser-shaped about it, so a strict policy challenges it — and a challenge is
 * unanswerable from `fetch`, so the monitor reports the site down every fifteen minutes
 * while the site is fine. Everyone writes a rule to let it through, so everyone writes a
 * rule that handles a credential, and the two mistakes that rule makes are always the
 * same: `===`, and a header nothing redacts.
 */

const SECRET = "a-monitor-secret-long-enough-to-be-one";
const OTHER = "a-different-secret-entirely-and-longer";

function handler(overrides: ConstructorParameters<typeof BotHandler>[0] = {}) {
  return new BotHandler({ resolver: failingResolver(), clock: new ManualClock(1_700_000_000_000), ...overrides });
}

function monitorFacts(headers: Record<string, string> = {}) {
  // Deliberately unlovely: no browser headers at all, which is what a monitor looks like
  // and what a strict policy would otherwise challenge.
  return createFacts({ method: "GET", url: "/healthz", headers: { host: "shop.example", ...headers }, ip: "198.51.100.7" });
}

describe("proving a service caller", () => {
  it("names the token a request presented, by name and not by value", async () => {
    const engine = handler({ serviceTokens: { tokens: { "uptime monitor": SECRET } } });
    const assessment = await engine.assess(monitorFacts({ [DEFAULT_TOKEN_HEADER]: SECRET }));
    expect(assessment.serviceToken).toBe("uptime monitor");
    // The assessment still carries the request as it arrived, header and all — the same
    // way it carries `authorization`. That is in-process and is what the facts *are*; the
    // paths that matter are the ones that leave, and they are tested below.
    expect(assessment.facts.headers[DEFAULT_TOKEN_HEADER]).toBe(SECRET);
  });

  it("says nothing when the token is wrong, absent or empty", async () => {
    const engine = handler({ serviceTokens: { tokens: { "uptime monitor": SECRET } } });
    for (const headers of [{}, { [DEFAULT_TOKEN_HEADER]: "" }, { [DEFAULT_TOKEN_HEADER]: "wrong" }, { [DEFAULT_TOKEN_HEADER]: `${SECRET} ` }]) {
      const assessment = await engine.assess(monitorFacts(headers));
      expect(assessment.serviceToken, JSON.stringify(headers)).toBeUndefined();
    }
  });

  it("lets a rule name one, which is the whole point", async () => {
    const engine = handler({
      preset: "protect-content",
      serviceTokens: { tokens: { "uptime monitor": SECRET, "deploy hook": OTHER } },
      rules: [{ id: "monitor-allow", match: { serviceToken: "uptime monitor" }, action: "allow" }],
    });
    const proved = await engine.handle(monitorFacts({ [DEFAULT_TOKEN_HEADER]: SECRET }));
    expect(proved.decision.rule).toBe("monitor-allow");
    expect(proved.outcome.kind).toBe("continue");

    // A different valid token is a different caller, and this rule is not about it.
    const other = await engine.handle(monitorFacts({ [DEFAULT_TOKEN_HEADER]: OTHER }));
    expect(other.decision.rule).not.toBe("monitor-allow");
  });

  it("can match any configured token at once", async () => {
    const engine = handler({
      serviceTokens: { tokens: { "uptime monitor": SECRET, "deploy hook": OTHER } },
      rules: [{ id: "ours", match: { serviceToken: true }, action: "allow" }],
    });
    for (const secret of [SECRET, OTHER]) {
      const result = await engine.handle(monitorFacts({ [DEFAULT_TOKEN_HEADER]: secret }));
      expect(result.decision.rule).toBe("ours");
    }
    const none = await engine.handle(monitorFacts());
    expect(none.decision.rule).not.toBe("ours");
  });

  it("takes the header name the deployment uses", async () => {
    const engine = handler({ serviceTokens: { header: "X-Acme-Automation", tokens: { acme: SECRET } } });
    // Matched case-insensitively, because a header name is.
    const assessment = await engine.assess(monitorFacts({ "x-acme-automation": SECRET }));
    expect(assessment.serviceToken).toBe("acme");
  });

  /**
   * A token is a claim with a secret attached, not a verdict. Nothing about presenting one
   * makes a client more or less suspect — only a rule decides what it is worth — which is
   * the same guarantee labels have, and for the same reason.
   */
  it("changes no verdict by itself", async () => {
    const engine = handler({ serviceTokens: { tokens: { monitor: SECRET } } });
    const bare = await engine.assess(monitorFacts({ "user-agent": "curl/8.4.0" }));
    const proved = await engine.assess(monitorFacts({ "user-agent": "curl/8.4.0", [DEFAULT_TOKEN_HEADER]: SECRET }));
    expect(proved.verdict).toBe(bare.verdict);
    expect(proved.score).toBe(bare.score);
  });
});

describe("comparing the secret", () => {
  it("does not throw on a presented value of a different length", () => {
    // The obvious implementation checks lengths before `timingSafeEqual`, which throws on
    // a mismatch — and that check is itself an oracle for the real secret's length.
    const tokens = new ServiceTokens({ tokens: { a: SECRET } });
    for (const presented of ["", "x", "x".repeat(4096), SECRET.slice(0, -1), `${SECRET}x`]) {
      expect(() => tokens.identify({ [DEFAULT_TOKEN_HEADER]: presented })).not.toThrow();
      expect(tokens.identify({ [DEFAULT_TOKEN_HEADER]: presented })).toBeUndefined();
    }
    expect(tokens.identify({ [DEFAULT_TOKEN_HEADER]: SECRET })).toBe("a");
  });

  it("reports the names it holds and the ones too short to be secrets", () => {
    const tokens = new ServiceTokens({ tokens: { good: SECRET, short: "abc", unset: "" } });
    expect(tokens.names).toEqual(["good", "short"]);
    expect(tokens.weak).toEqual(["short"]);
  });
});

describe("what the handler says about a token set", () => {
  const warningsOf = (overrides: ConstructorParameters<typeof BotHandler>[0]): string => {
    const said: string[] = [];
    handler({ ...overrides, onWarning: (message) => said.push(message) });
    return said.join(" ");
  };

  it("says so when every token is empty, which is an unset environment variable", () => {
    expect(warningsOf({ serviceTokens: { tokens: { monitor: "" } } })).toMatch(/no token has a value/);
  });

  it("says so when a secret is short enough to guess", () => {
    expect(warningsOf({ serviceTokens: { tokens: { monitor: "hunter2" } } })).toMatch(/shorter than/);
  });

  it("catches a rule naming a token that does not exist", () => {
    const said = warningsOf({
      serviceTokens: { tokens: { "uptime monitor": SECRET } },
      rules: [{ id: "typo", match: { serviceToken: "uptime-monitor" }, action: "allow" }],
    });
    expect(said).toMatch(/never match/);
    expect(said).toMatch(/uptime monitor/);
  });

  it("catches a rule matching a token when none are configured at all", () => {
    expect(warningsOf({ rules: [{ id: "monitor", match: { serviceToken: "x" }, action: "allow" }] })).toMatch(/no `serviceTokens` are configured/);
  });

  it("stays quiet about a set that is fine", () => {
    const said = warningsOf({
      serviceTokens: { tokens: { "uptime monitor": SECRET } },
      rules: [{ id: "monitor", match: { serviceToken: "uptime monitor" }, action: "allow" }],
    });
    expect(said).not.toMatch(/serviceToken|token/i);
  });
});

/**
 * The half of this feature that is not about matching.
 *
 * A hand-written monitor rule carries its secret in a header the library has never heard
 * of, so the dashboard prints it in full and an export carries it into whatever file
 * somebody pastes into a chat. Configuring `serviceTokens` is a deployment saying that
 * header holds a credential — so it is redacted because it was configured, not because
 * somebody also remembered to list it under `redact.secretHeaders`.
 */
describe("keeping the secret inside the process", () => {
  it("redacts the token header on the dashboard without being told twice", async () => {
    const { DashboardFeed } = await import("../src/dashboard/feed.js");
    const engine = handler({ serviceTokens: { header: "x-acme-automation", tokens: { acme: SECRET } } });
    const feed = new DashboardFeed(engine, 50, {});
    await engine.handle(monitorFacts({ "x-acme-automation": SECRET, authorization: "Bearer abc" }));

    const serialised = JSON.stringify(feed.backlog());
    expect(serialised, "the configured token header").not.toContain(SECRET);
    expect(serialised, "and the one it has always known about").not.toContain("Bearer abc");
    // The header is still listed, because knowing it was sent is the useful half.
    expect(serialised).toContain("x-acme-automation");
  });

  it("strips the token header from an event on its way out of the process", async () => {
    const sent: string[] = [];
    const engine = handler({
      serviceTokens: { header: "x-acme-automation", tokens: { acme: SECRET } },
      rules: [{ id: "tag-all", match: {}, action: "tag" }],
      notifications: {
        sinks: [{ id: "recorder", notify: (event) => void sent.push(JSON.stringify(event)) }],
        filter: { types: ["detection", "action"], minScore: 0 },
      },
    });
    await engine.handle(monitorFacts({ "x-acme-automation": SECRET, "user-agent": "curl/8.4.0" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.length, "the sink should have been told about this request").toBeGreaterThan(0);
    expect(sent.join(" ")).not.toContain(SECRET);
  });
});
