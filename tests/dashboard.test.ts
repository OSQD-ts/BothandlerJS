import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { BotHandler, ConfigError, ManualClock, createDashboardHandler, createFacts } from "../src/index.js";
import { CHROME_HEADERS } from "./helpers.js";
import type { DashboardOptions, DashboardServer } from "../src/index.js";

/**
 * The dashboard.
 *
 * Two groups of test here matter more than the rest. The **configuration refusals**
 * check that an unsafe deployment cannot start at all — this page describes your
 * detection, and a scraper that can read it knows which signal to fix next. The
 * **markup rules** check that a User-Agent can never become script: every value on the
 * page arrives as `textContent`, and the one thing that would break that guarantee is
 * somebody reaching for `innerHTML` in a hurry.
 */

const running: DashboardServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function serve(options: DashboardOptions = {}, handlerOptions = {}): Promise<{ handler: BotHandler; dashboard: DashboardServer; base: string }> {
  const handler = new BotHandler(handlerOptions);
  const dashboard = await handler.serveDashboard({ port: 0, ...options });
  running.push(dashboard);
  return { handler, dashboard, base: dashboard.url.replace(/\/$/, "") };
}

/** `Response.json()` is `unknown` under this project's strictness; the tests know their shapes. */
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface FeedBody {
  entries: Array<{
    path: string;
    actor: string;
    verdict: string;
    action?: string;
    rule?: string;
    evidence: Array<{ detector: string; certainty: string; deterministicBasis?: string }>;
  }>;
}

interface StatsBody {
  metrics: { requests: number; detectorTimings: Record<string, { count: number; totalMs: number }> };
  detectors: unknown[];
  rules: string[];
  policy: { falsePositivePolicy: string; editable: boolean; terminalScoreThreshold: number };
  notices: Array<{ kind: string; message: string; source?: string }>;
}

interface PolicyBody {
  rules: Array<{ id: string; index: number; editable: boolean; rule?: { id: string; action: string } }>;
  robots: string;
  robotsNotes: Array<{ rule: string; reason: string }>;
  editable: boolean;
}

interface PreviewBody {
  evaluated: number;
  changed: number;
  newDenials: number;
  before: Record<string, number>;
  after: Record<string, number>;
  ruleHits: Array<{ rule: string; hits: number }>;
  samples: Array<{ from: string; to: string }>;
  error?: string;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

/** One assessed-and-decided request, so the feed has something in it. */
async function hit(handler: BotHandler, userAgent = "curl/8.4.0", path = "/products"): Promise<void> {
  const facts = createFacts({
    method: "GET",
    url: path,
    headers: { host: "shop.example", "user-agent": userAgent, accept: "*/*" },
    ip: "203.0.113.7",
    protocol: "https",
    httpVersion: "1.1",
  });
  const assessment = await handler.assess(facts);
  handler.decide(assessment);
}

/** One request at a stated time, for the tests that drive a clock rather than the wall. */
async function hitAt(handler: BotHandler, timestamp: number): Promise<void> {
  const facts = createFacts({
    method: "GET",
    url: "/products",
    headers: { host: "shop.example", "user-agent": "curl/8.4.0" },
    ip: "203.0.113.7",
    timestamp,
    protocol: "https",
    httpVersion: "1.1",
  });
  handler.decide(await handler.assess(facts));
}

/** The feed publishes one turn of the event loop after the assessment. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));
}

describe("configuration refusals", () => {
  it("refuses to publish itself to the network without a decision about access", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, host: "0.0.0.0" })).rejects.toThrow(ConfigError);
    await expect(handler.serveDashboard({ port: 0, host: "0.0.0.0" })).rejects.toThrow(/auth/);
  });

  it("accepts a public bind once access is stated explicitly", async () => {
    const { dashboard } = await serve({ host: "0.0.0.0", auth: false });
    expect(dashboard.port).toBeGreaterThan(0);
  });

  it("rejects an empty basic credential", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, auth: { username: "ops", password: "" } })).rejects.toThrow(/non-empty/);
  });

  it("rejects a token short enough to guess", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, auth: { token: "short" } })).rejects.toThrow(/at least 16/);
  });

  it("reports a port already in use as configuration rather than as a crash", async () => {
    const { dashboard } = await serve();
    const second = new BotHandler();
    await expect(second.serveDashboard({ port: dashboard.port })).rejects.toThrow(ConfigError);
  });
});

describe("authentication", () => {
  it("serves the page with no auth on loopback", async () => {
    const { base } = await serve();
    expect((await fetch(base + "/")).status).toBe(200);
  });

  it("challenges for basic credentials and accepts only the right ones", async () => {
    const { base } = await serve({ auth: { username: "ops", password: "correct horse" } });

    const anonymous = await fetch(base + "/");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");

    const wrongPassword = await fetch(base + "/", { headers: { authorization: "Basic " + btoa("ops:wrong") } });
    expect(wrongPassword.status).toBe(401);

    const wrongUser = await fetch(base + "/", { headers: { authorization: "Basic " + btoa("someone:correct horse") } });
    expect(wrongUser.status).toBe(401);

    const right = await fetch(base + "/", { headers: { authorization: "Basic " + btoa("ops:correct horse") } });
    expect(right.status).toBe(200);
  });

  it("accepts a token as a bearer header or as a query parameter", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const { base } = await serve({ auth: { token } });

    expect((await fetch(base + "/")).status).toBe(401);
    expect((await fetch(base + "/", { headers: { authorization: "Bearer " + token } })).status).toBe(200);
    expect((await fetch(base + "/?token=" + token)).status).toBe(200);
    expect((await fetch(base + "/?token=nope")).status).toBe(401);
  });

  // A bearer server that sent `WWW-Authenticate: Basic` would pop a browser dialog
  // that no credential could satisfy.
  it("does not prompt for a password when it wants a token", async () => {
    const { base } = await serve({ auth: { token: "0123456789abcdef0123456789abcdef" } });
    expect((await fetch(base + "/")).headers.get("www-authenticate")).toBe(null);
  });

  it("uses a caller's own check, and treats a throwing one as a refusal", async () => {
    const { base } = await serve({ auth: { authorize: (request) => request.headers["x-ops"] === "yes" } });
    expect((await fetch(base + "/")).status).toBe(401);
    expect((await fetch(base + "/", { headers: { "x-ops": "yes" } })).status).toBe(200);

    const { base: base2 } = await serve({
      auth: {
        authorize: () => {
          throw new Error("session store is down");
        },
      },
    });
    expect((await fetch(base2 + "/")).status).toBe(401);
  });

  // Routing after authentication, so an anonymous probe cannot map the endpoints.
  it("answers 401 rather than 404 for an unknown path when unauthenticated", async () => {
    const { base } = await serve({ auth: { username: "ops", password: "secret" } });
    expect((await fetch(base + "/api/does-not-exist")).status).toBe(401);
  });
});

describe("routes", () => {
  it("serves the page, the stats and the feed", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await settle();

    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");

    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(stats.metrics.requests).toBe(1);
    expect(stats.detectors.length).toBeGreaterThan(10);
    expect(stats.policy.falsePositivePolicy).toBe("strict");

    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.verdict).toBe("confirmed-bot");
  });

  it("mounts under a base path and ignores everything outside it", async () => {
    const { base, dashboard } = await serve({ basePath: "/_bots" });
    expect(dashboard.url).toContain("/_bots/");
    expect((await fetch(base + "/")).status).toBe(200);
    expect((await fetch(dashboard.url.replace("/_bots/", "/"))).status).toBe(404);
  });

  it("keeps the Prometheus endpoint off unless asked for", async () => {
    const { base } = await serve();
    expect((await fetch(base + "/metrics")).status).toBe(404);

    const { base: exposed } = await serve({ exposePrometheus: true });
    const metrics = await fetch(exposed + "/metrics");
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("bothandler_requests_total");
  });

  it("refuses to reset unless the control is enabled", async () => {
    const { base } = await serve();
    expect((await fetch(base + "/api/reset", { method: "POST" })).status).toBe(403);
  });

  it("clears the feed and the actor registry when reset is enabled", async () => {
    const { handler, base } = await serve({ controls: { reset: true } });
    await hit(handler);
    await settle();
    expect(handler.registry.size).toBe(1);

    expect((await fetch(base + "/api/reset")).status).toBe(405);
    expect((await fetch(base + "/api/reset", { method: "POST" })).status).toBe(200);

    expect(handler.registry.size).toBe(0);
    expect((await json<FeedBody>(await fetch(base + "/api/feed"))).entries).toHaveLength(0);
  });
});

describe("the feed", () => {
  it("publishes one row per request, with the decision attached", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await hit(handler, "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "/");
    await settle();

    const { entries } = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.action).toBeDefined();
      expect(entry.rule).toBeDefined();
    }
  });

  // A monitor-only deployment never calls `decide`, and a dashboard that waited for a
  // decision would show it nothing at all.
  it("shows assessments that never reached a decision", async () => {
    const { handler, base } = await serve();
    await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "a.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.9" }));
    await settle();

    const { entries } = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBeUndefined();
  });

  it("carries the evidence, including the written basis of a proven verdict", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await settle();

    const { entries } = await json<FeedBody>(await fetch(base + "/api/feed"));
    const proven = entries[0]!.evidence.find((item) => item.certainty === "certain");
    expect(proven?.detector).toBe("self-identified");
    expect(proven?.deterministicBasis).toContain("HTTP library");
  });

  it("bounds the ring, whatever the traffic does", async () => {
    const { handler, base } = await serve({ feedLimit: 5 });
    for (let index = 0; index < 20; index++) await hit(handler, "curl/8.4.0", "/p/" + index);
    await settle();

    const { entries } = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(entries).toHaveLength(5);
    expect(entries[4]!.path).toBe("/p/19");
  });

  it("masks addresses when asked, and shows them when not", async () => {
    const { handler, base } = await serve({ redact: { maskIp: true } });
    await hit(handler);
    await settle();
    const masked = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(masked.entries[0]!.actor).toBe("203.0.113.0/24");

    const plain = await serve();
    await hit(plain.handler);
    await settle();
    const shown = await json<FeedBody>(await fetch(plain.base + "/api/feed"));
    expect(shown.entries[0]!.actor).toBe("203.0.113.7");
  });
});

describe("the event stream", () => {
  async function readFrames(url: string, count: number, headers: Record<string, string> = {}): Promise<string> {
    const response = await fetch(url, { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 4000;
    while (text.split("\n\n").length <= count && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    return text;
  }

  it("opens with the current counters and replays the backlog", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await settle();

    const text = await readFrames(base + "/api/stream", 2);
    expect(text).toContain("event: stats");
    expect(text).toContain("event: entry");
    expect(text).toContain("curl/8.4.0");
  });

  it("caps the number of viewers rather than growing without limit", async () => {
    const { base } = await serve({ maxClients: 1 });
    const first = await fetch(base + "/api/stream");
    const second = await fetch(base + "/api/stream");
    expect(second.status).toBe(503);
    await first.body?.cancel();
  });
});

describe("the page", () => {
  it("is served with the headers a page full of evidence needs", async () => {
    const { base } = await serve();
    const response = await fetch(base + "/");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("runs its script under a nonce that changes every response", async () => {
    const { base } = await serve();
    const first = await fetch(base + "/");
    const html = await first.text();
    const policy = first.headers.get("content-security-policy") ?? "";

    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);

    const second = await fetch(base + "/");
    const secondNonce = /'nonce-([^']+)'/.exec(second.headers.get("content-security-policy") ?? "")?.[1];
    expect(secondNonce).not.toBe(nonce);
  });

  // The page renders User-Agents, paths and evidence summaries — all client-written.
  // `textContent` is what keeps them text; one `innerHTML` would undo it.
  it("builds every node with textContent and never with innerHTML", async () => {
    const { base } = await serve();
    const html = await (await fetch(base + "/")).text();
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("outerHTML");
    expect(html).not.toContain("insertAdjacentHTML");
    expect(html).not.toContain("document.write");
  });

  it("escapes a title supplied by the caller", async () => {
    const { base } = await serve({ title: '</title><script>alert(1)</script>' });
    const html = await (await fetch(base + "/")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("reports the link and reset configuration to the page as data, not as markup", async () => {
    const { base } = await serve({ links: [{ label: "Site", href: "http://localhost:3000/" }], controls: { reset: true } });
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('\\"allowReset\\":true');
    expect(html).toContain("http://localhost:3000/");
  });
});

describe("lifecycle", () => {
  it("stops listening and lets go of the handler when closed", async () => {
    const handler = new BotHandler();
    const dashboard = await handler.serveDashboard({ port: 0 });
    const base = dashboard.url.replace(/\/$/, "");
    expect((await fetch(base + "/api/stats")).status).toBe(200);

    await dashboard.close();
    await expect(fetch(base + "/api/stats")).rejects.toThrow();

    // The feed unsubscribed, so traffic after a close cannot accumulate anywhere.
    await hit(handler);
    await settle();
    await dashboard.close(); // idempotent
  });

  it("reports the port it actually bound", async () => {
    const { dashboard } = await serve({ port: 0 });
    expect(dashboard.port).toBeGreaterThan(1024);
    expect(dashboard.url).toContain(String(dashboard.port));
  });

  it("leaves the handler's own behaviour alone", async () => {
    const { handler } = await serve();
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: CHROME_HEADERS, ip: "203.0.113.5", protocol: "https", httpVersion: "1.1" }));
    expect(assessment.verdict).toBe("unknown");
  });
});

describe("what a row carries", () => {
  it("carries the actor's history, so the drill-down needs no second request", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await hit(handler);
    await settle();

    const { entries } = await json<FeedBody & { entries: Array<{ actorStats: { requests: number; priorConfirmations: number; cleared: boolean } }> }>(await fetch(base + "/api/feed"));
    expect(entries[1]!.actorStats.requests).toBe(2);
    expect(entries[1]!.actorStats.priorConfirmations).toBeGreaterThanOrEqual(1);
    expect(entries[1]!.actorStats.cleared).toBe(false);
  });

  it("carries the headers in wire order with credentials replaced", async () => {
    const { handler, base } = await serve();
    const facts = createFacts({
      method: "GET",
      url: "/account",
      headers: { host: "shop.example", cookie: "session=secret-value", "user-agent": "curl/8.4.0", authorization: "Bearer secret-token", accept: "*/*" },
      rawHeaders: ["Host", "Cookie", "User-Agent", "Authorization", "Accept"],
      ip: "203.0.113.7",
    });
    handler.decide(await handler.assess(facts));
    await settle();

    const { entries } = await json<{ entries: Array<{ headers: Array<[string, string]> }> }>(await fetch(base + "/api/feed"));
    const headers = entries[0]!.headers;
    expect(headers.map((pair) => pair[0])).toEqual(["host", "cookie", "user-agent", "authorization", "accept"]);
    expect(headers.find((pair) => pair[0] === "cookie")?.[1]).toBe("[redacted]");
    expect(headers.find((pair) => pair[0] === "authorization")?.[1]).toBe("[redacted]");
    expect(JSON.stringify(entries)).not.toContain("secret-value");
    expect(JSON.stringify(entries)).not.toContain("secret-token");
  });

  it("masks query values by default and keeps the names", async () => {
    const { handler, base } = await serve();
    handler.decide(await handler.assess(createFacts({ method: "GET", url: "/reset?token=abc123&email=a@b.example", headers: { host: "s.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.7" })));
    await settle();

    const { entries } = await json<{ entries: Array<{ query: Record<string, string> }> }>(await fetch(base + "/api/feed"));
    expect(Object.keys(entries[0]!.query).sort()).toEqual(["email", "token"]);
    expect(entries[0]!.query["token"]).toBe("[redacted]");
  });

  it("omits headers entirely when asked", async () => {
    const { handler, base } = await serve({ redact: { headers: false } });
    await hit(handler);
    await settle();
    const { entries } = await json<{ entries: Array<{ headers?: unknown }> }>(await fetch(base + "/api/feed"));
    expect(entries[0]!.headers).toBeUndefined();
  });
});

describe("notices", () => {
  it("shows the warnings raised at startup", async () => {
    // Two rules with one id: a warning, not an error, and exactly the kind that
    // scrolls past on a busy boot.
    const { base } = await serve({}, { rules: [{ id: "dup", match: {}, action: "tag" }, { id: "dup", match: {}, action: "log" }] });
    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(stats.notices.some((notice) => notice.message.includes("share the id"))).toBe(true);
    expect(stats.notices[0]?.source).toBe("startup");
  });

  it("follows warnings raised later", async () => {
    const { handler, base } = await serve();
    handler.updatePolicy([{ id: "tag-all", match: {}, action: "tag" }]);
    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(stats.notices.some((notice) => notice.message.includes("Policy replaced at runtime"))).toBe(true);
  });
});

describe("per-detector timing", () => {
  it("collects nothing unless it is asked for", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(stats.metrics.detectorTimings).toEqual({});
  });

  it("times every detector that ran when it is", async () => {
    const { handler, base } = await serve({ exposePrometheus: true }, { metrics: { perDetectorTiming: true } });
    await hit(handler);
    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(Object.keys(stats.metrics.detectorTimings).length).toBeGreaterThan(5);
    expect(stats.metrics.detectorTimings["self-identified"]?.count).toBe(1);

    const prometheus = await (await fetch(base + "/metrics")).text();
    expect(prometheus).toContain("bothandler_detector_duration_ms_sum");
  });
});

describe("the policy document", () => {
  it("returns the rules, the robots.txt they imply, and whether they can be changed", async () => {
    const { base } = await serve({}, { preset: "protect-data" });
    const document_ = await json<PolicyBody>(await fetch(base + "/api/policy"));
    expect(document_.editable).toBe(false);
    expect(document_.rules.length).toBeGreaterThan(5);
    expect(document_.rules[0]?.rule?.id).toBe(document_.rules[0]?.id);
    // protect-data declines the AI and SEO categories by name, so they belong in a
    // robots.txt and the preview says so.
    expect(document_.robots).toContain("User-agent:");
  });

  it("marks a predicate rule as unsendable rather than serialising it wrong", async () => {
    const { base } = await serve({}, { rules: [{ id: "custom", match: () => false, action: "tag" }] });
    const document_ = await json<PolicyBody>(await fetch(base + "/api/policy"));
    // Index and all: the editor shows a locked rule *where it sits*, because that is
    // what decides whether it runs before or after the ones being edited.
    expect(document_.rules[0]).toEqual({ id: "custom", index: 0, editable: false });
  });
});

describe("policy preview", () => {
  it("reports what a candidate would have done to the window", async () => {
    const { handler, base } = await serve({}, { rules: [{ id: "tag-clients", match: { botClass: "http-client" }, action: "tag" }], defaultAction: "allow" });
    await hit(handler);
    await hit(handler, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", "/");
    await settle();

    const { status, body } = await post(base + "/api/policy/preview", { rules: [{ id: "block-clients", match: { botClass: "http-client", certain: true }, action: "block" }] });
    const preview = body as PreviewBody;
    expect(status).toBe(200);
    expect(preview.evaluated).toBe(2);
    expect(preview.changed).toBe(1);
    expect(preview.newDenials).toBe(1);
    expect(preview.samples[0]?.from).toBe("tag");
    expect(preview.samples[0]?.to).toBe("block");
    expect(preview.ruleHits.find((row) => row.rule === "block-clients")?.hits).toBe(1);
  });

  it("previews a shipped preset by name", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await settle();
    const { status, body } = await post(base + "/api/policy/preview", { preset: "protect-auth" });
    expect(status).toBe(200);
    expect((body as PreviewBody).evaluated).toBe(1);

    const unknown = await post(base + "/api/policy/preview", { preset: "does-not-exist" });
    expect(unknown.status).toBe(400);
  });

  it("changes nothing about the running policy", async () => {
    const { handler, base } = await serve({}, { rules: [{ id: "tag-all", match: {}, action: "tag" }] });
    await hit(handler);
    await settle();
    await post(base + "/api/policy/preview", { rules: [{ id: "block-all", match: {}, action: "block" }] });
    expect(handler.policy.ruleIds).toEqual(["tag-all"]);
  });

  it("refuses a document it cannot read", async () => {
    const { base } = await serve();
    expect((await post(base + "/api/policy/preview", { rules: "not-an-array" })).status).toBe(400);
    expect((await post(base + "/api/policy/preview", { rules: [{ match: {}, action: "tag" }] })).status).toBe(400);
    expect((await post(base + "/api/policy/preview", { rules: [{ id: "x", match: {}, action: "explode" }] })).status).toBe(400);
  });

  // Preview is available to anyone who can read the dashboard; applying is not.
  it("is available even when editing is off", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    await settle();
    expect((await post(base + "/api/policy/preview", { rules: [] })).status).toBe(200);
    expect((await post(base + "/api/policy/apply", { rules: [] })).status).toBe(403);
  });
});

describe("policy editing", () => {
  it("applies a rule set to the running handler", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } }, { rules: [{ id: "tag-all", match: {}, action: "tag" }] });

    const { status, body } = await post(base + "/api/policy/apply", {
      rules: [
        { id: "allow-verified", match: { verdict: "verified-bot" }, action: "allow" },
        { id: "tag-all", match: {}, action: "tag" },
      ],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(handler.policy.ruleIds).toEqual(["allow-verified", "tag-all"]);

    // And the new rules are in force, not merely stored.
    const assessment = await handler.assess(createFacts({ method: "GET", url: "/", headers: { host: "s.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.7" }));
    expect(handler.decide(assessment).rule).toBe("tag-all");
  });

  it("leaves the running policy untouched when the edit is rejected", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } }, { rules: [{ id: "tag-all", match: {}, action: "tag" }] });
    const { status } = await post(base + "/api/policy/apply", { rules: [{ id: "broken", match: {}, action: "nonsense" }] });
    expect(status).toBe(400);
    expect(handler.policy.ruleIds).toEqual(["tag-all"]);
  });

  // The one edit nobody may make from a browser.
  it("cannot relax the guard, however the rules are written", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } });
    await post(base + "/api/policy/apply", {
      falsePositivePolicy: "aggressive",
      rules: [{ id: "block-suspected", match: { verdict: "suspected-bot" }, action: "block" }],
    });

    expect(handler.policy.describe().falsePositivePolicy).toBe("strict");
    const facts = createFacts({
      method: "GET",
      url: "/",
      headers: { host: "s.example", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", accept: "*/*" },
      ip: "203.0.113.7",
      protocol: "https",
      httpVersion: "1.1",
    });
    const decision = handler.decide(await handler.assess(facts));
    expect(decision.action).not.toBe("block");
    expect(decision.downgradedFrom).toBe("block");
  });

  it("keeps a predicate rule that could not be sent over the wire", async () => {
    const { handler, base } = await serve(
      { controls: { editPolicy: true } },
      { rules: [{ id: "predicate", match: () => false, action: "tag" }, { id: "sendable", match: {}, action: "log" }] },
    );
    await post(base + "/api/policy/apply", { rules: [{ id: "sendable", match: {}, action: "tag" }] });
    expect(handler.policy.ruleIds).toContain("predicate");
    expect(handler.policy.rules.find((rule) => rule.id === "sendable")?.action).toBe("tag");
  });

  it("refuses to enable an unauthenticated editor on a public address", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, host: "0.0.0.0", auth: false, controls: { editPolicy: true } })).rejects.toThrow(/rewrite your bot policy/);
  });

  it("announces the change through the handler's warning event", async () => {
    const warnings: string[] = [];
    const { base } = await serve({ controls: { editPolicy: true } }, { onWarning: (message: string) => warnings.push(message) });
    await post(base + "/api/policy/apply", { rules: [{ id: "tag-all", match: {}, action: "tag" }] });
    expect(warnings.some((warning) => warning.includes("Policy replaced at runtime"))).toBe(true);
  });

  it("bounds the body it will read", async () => {
    const { base } = await serve({ controls: { editPolicy: true } });
    const huge = JSON.stringify({ rules: [{ id: "x".repeat(300000), match: {}, action: "tag" }] });
    const response = await fetch(base + "/api/policy/apply", { method: "POST", headers: { "content-type": "application/json" }, body: huge });
    expect(response.status).toBe(400);
  });
});

describe("the editor's vocabulary", () => {
  // The GUI builds its dropdowns from this rather than from a copy of its own, so a
  // verdict or an action added to the library shows up without anybody remembering.
  it("comes from the same constants the engine uses", async () => {
    const { base } = await serve();
    const document_ = await json<PolicyBody & { vocabulary: Record<string, string[]> }>(await fetch(base + "/api/policy"));

    expect(document_.vocabulary.verdicts).toContain("suspected-bot");
    expect(document_.vocabulary.botClasses).toContain("impersonator");
    expect(document_.vocabulary.categories).toContain("ai");
    expect(document_.vocabulary.actions).toContain("rate-limit");
    expect(document_.vocabulary.presets).toContain("protect-content");
    // Detectors are the ones actually installed on *this* handler, not a static list.
    expect(document_.vocabulary.detectors).toContain("browsing-coherence");
  });

  it("lists the detectors this handler really has", async () => {
    const { base } = await serve({}, { detectors: [{ id: "only-one", description: "test", inspect: () => undefined }] });
    const document_ = await json<PolicyBody & { vocabulary: Record<string, string[]> }>(await fetch(base + "/api/policy"));
    expect(document_.vocabulary.detectors).toEqual(["only-one"]);
  });
});

describe("settings export and import", () => {
  it("exports the rules and a record of everything around them", async () => {
    const { base } = await serve({ exposePrometheus: true, controls: { editPolicy: true } }, { preset: "protect-content" });
    const settings = await json<{
      format: string;
      version: number;
      rules: Array<{ id: string }>;
      readOnly: { guard: { falsePositivePolicy: string }; detectors: unknown[]; lockedRules: string[]; dashboard: { controls: { editPolicy: boolean } } };
    }>(await fetch(base + "/api/settings"));

    expect(settings.format).toBe("bothandlerjs/settings");
    expect(settings.version).toBe(1);
    expect(settings.rules.length).toBeGreaterThan(5);
    expect(settings.readOnly.guard.falsePositivePolicy).toBe("strict");
    expect(settings.readOnly.detectors.length).toBeGreaterThan(10);
    expect(settings.readOnly.dashboard.controls.editPolicy).toBe(true);
  });

  it("round-trips: what it exports is what apply accepts", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } }, { preset: "protect-data" });
    const settings = await json<{ rules: Array<{ id: string; reason?: string }> }>(await fetch(base + "/api/settings"));

    settings.rules[0]!.reason = "edited on the way through";
    const applied = await post(base + "/api/policy/apply", { rules: settings.rules });

    expect(applied.status).toBe(200);
    expect(handler.policy.ruleIds).toEqual(settings.rules.map((rule) => rule.id));
    expect(handler.policy.rules[0]?.reason).toBe("edited on the way through");
  });

  it("does not pretend a file can change the guard", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } });
    const settings = await json<{ rules: unknown[]; readOnly: { guard: Record<string, unknown> } }>(await fetch(base + "/api/settings"));

    // A settings document carries the guard so a reader can see it, and applying one
    // back cannot change it — the apply path reads `rules` and nothing else.
    await post(base + "/api/policy/apply", { ...settings, readOnly: { guard: { falsePositivePolicy: "aggressive" } } });
    expect(handler.policy.describe().falsePositivePolicy).toBe("strict");
  });
});

describe("locked rules keep their place", () => {
  it("puts a predicate rule back at the index it held", async () => {
    const { handler, base } = await serve(
      { controls: { editPolicy: true } },
      {
        rules: [
          { id: "first", match: {}, action: "tag" },
          { id: "locked", match: () => false, action: "log" },
          { id: "third", match: {}, action: "log" },
        ],
      },
    );

    // The editor sends only the two it can serialise, reordered.
    await post(base + "/api/policy/apply", {
      rules: [
        { id: "third", match: {}, action: "log" },
        { id: "first", match: {}, action: "tag" },
      ],
    });

    // The locked rule is still second, because that is where it was and order is the
    // whole semantics of a first-match policy.
    expect(handler.policy.ruleIds).toEqual(["third", "locked", "first"]);
  });
});

/**
 * Cross-site writes.
 *
 * The dashboard has two buttons that change something — apply a policy and reset the
 * feed — and a browser attaches whatever credentials it holds for this origin to a
 * request from *any* page, not just this one. So authentication cannot be what
 * decides these; the request's own provenance has to. Three locks, tested one at a
 * time so a regression names which one slipped.
 */
describe("cross-site writes", () => {
  const CREDENTIALS = { username: "ops", password: "hunter2" };
  const AUTHORIZED = "Basic " + Buffer.from("ops:hunter2").toString("base64");

  /** A cross-site form post, on the wire, exactly as a browser sends it. */
  async function forgery(url: string, extra: Record<string, string> = {}, body?: string): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        referer: "https://evil.example/page",
        "sec-fetch-site": "cross-site",
        authorization: AUTHORIZED,
        ...extra,
      },
      ...(body !== undefined ? { body } : {}),
    });
  }

  it("refuses a forged policy edit even with valid credentials", async () => {
    const { handler, base } = await serve(
      { auth: CREDENTIALS, controls: { editPolicy: true } },
      { rules: [{ id: "tag-all", match: {}, action: "tag" }] },
    );

    const response = await forgery(base + "/api/policy/apply", { "content-type": "application/json" }, JSON.stringify({ preset: "monitor-only" }));

    expect(response.status).toBe(403);
    // And the running policy is what it was. This is the assertion that matters: a
    // forged edit that returned 403 but still swapped the rules would be worse than
    // no check at all.
    expect(handler.policy.ruleIds).toEqual(["tag-all"]);
  });

  it("refuses a forged reset", async () => {
    const { handler, base } = await serve({ auth: CREDENTIALS, controls: { reset: true } });
    await hit(handler);

    expect(await forgery(base + "/api/reset").then((r) => r.status)).toBe(403);

    const feed = await fetch(base + "/api/feed", { headers: { authorization: AUTHORIZED } }).then((r) => json<FeedBody>(r));
    expect(feed.entries).toHaveLength(1);
  });

  /**
   * The lock that does not depend on a header the client chose to send. `text/plain`
   * is what an HTML form uses to dodge a preflight, and it is the shape of the attack
   * that works when `Sec-Fetch-Site` is missing.
   */
  it("refuses a body that is not JSON", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } }, { rules: [{ id: "tag-all", match: {}, action: "tag" }] });

    const response = await fetch(base + "/api/policy/apply", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ preset: "under-attack" }),
    });

    expect(response.status).toBe(400);
    expect((await json<{ error: string }>(response)).error).toContain("application/json");
    expect(handler.policy.ruleIds).toEqual(["tag-all"]);
  });

  it("still accepts the dashboard's own page", async () => {
    const { handler, base } = await serve({ controls: { editPolicy: true } });

    const response = await fetch(base + "/api/policy/apply", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ preset: "monitor-only" }),
    });

    expect(response.status).toBe(200);
    expect(handler.policy.ruleIds.length).toBeGreaterThan(0);
  });

  /** curl and CI send no fetch metadata and no origin. Neither may be locked out. */
  it("still accepts a request with no browser provenance at all", async () => {
    const { base } = await serve({ controls: { reset: true } });
    expect(await fetch(base + "/api/reset", { method: "POST" }).then((r) => r.status)).toBe(200);
  });

  it("leaves reads alone, because CORS already withholds the response", async () => {
    const { handler, base } = await serve();
    await hit(handler);
    const response = await fetch(base + "/api/feed", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

/**
 * DNS rebinding.
 *
 * The attack that survives every check above: the attacker points a name they own at
 * 127.0.0.1, so the browser calls their page same-origin with this server and the
 * provenance checks agree. What they cannot do is make the operator write that name
 * down, so the `Host` header is where it comes apart.
 *
 * These go through `node:http` rather than `fetch`, because `Host` is a forbidden
 * header name: `fetch` quietly rewrites it to the address it dialled, which would
 * make every one of these pass against a server that checks nothing.
 */
describe("the host allowlist", () => {
  function request(port: number, path: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const call = httpRequest({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      call.on("error", reject);
      call.end();
    });
  }

  it("refuses a Host header it was never configured for", async () => {
    const { handler, dashboard } = await serve();
    await hit(handler);
    const response = await request(dashboard.port, "/api/feed", "rebind.evil.example");
    expect(response.status).toBe(421);
    // The point of the check: the evidence trail stays behind it.
    expect(response.body).not.toContain("203.0.113.7");
  });

  it("accepts the loopback names a dashboard is actually opened under", async () => {
    const { dashboard } = await serve();
    for (const host of [`localhost:${dashboard.port}`, `127.0.0.1:${dashboard.port}`, `[::1]:${dashboard.port}`, "localhost"]) {
      expect((await request(dashboard.port, "/api/stats", host)).status).toBe(200);
    }
  });

  it("accepts a name the operator did configure", async () => {
    const { dashboard } = await serve({ allowedHosts: ["bots.internal"] });
    expect((await request(dashboard.port, "/api/stats", "bots.internal")).status).toBe(200);
    expect((await request(dashboard.port, "/api/stats", `bots.internal:${dashboard.port}`)).status).toBe(200);
  });

  it("stands down when asked to", async () => {
    const { dashboard } = await serve({ allowedHosts: ["*"] });
    expect((await request(dashboard.port, "/api/stats", "anything.example")).status).toBe(200);
  });

  /**
   * A public bind is fronted by a proxy with a real domain name, and rebinding wins
   * an attacker nothing against an address they can already reach. Enforcing a list
   * there would break the deployment without buying anything.
   */
  it("does not enforce a list on a public bind", async () => {
    const { dashboard } = await serve({ host: "0.0.0.0", auth: { token: "a-sufficiently-long-token" } });
    const response = await request(dashboard.port, "/api/stats", "bots.example.com", { authorization: "Bearer a-sufficiently-long-token" });
    expect(response.status).toBe(200);
  });
});

/**
 * What a caller who is turned away is told.
 *
 * The default is honest — three refusals, three statuses, because the likeliest
 * reader is an operator debugging their own deployment. Everything else here is
 * concealment, and the tests hold it to the one property concealment has to have: a
 * probe must not be able to tell *which* check refused it, or a quiet dashboard
 * becomes an oracle for the loud one behind it.
 */
describe("refusal modes", () => {
  /** Raw HTTP, because `fetch` cannot set `Host` and a dropped connection is not a response. */
  function probe(port: number, options: { path?: string; host?: string; method?: string; headers?: Record<string, string> } = {}): Promise<
    { status: number; body: string; headers: Record<string, string | string[] | undefined> } | { dropped: true }
  > {
    return new Promise((resolve, reject) => {
      const call = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: options.path ?? "/api/stats",
          method: options.method ?? "GET",
          headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
        },
      );
      // A destroyed socket surfaces as ECONNRESET, or as an end with no response.
      call.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? resolve({ dropped: true }) : reject(error)));
      call.end();
    });
  }

  const TOKEN = { token: "a-token-long-enough-to-be-accepted" };

  it("says 401 by default, and says which refusal it was", async () => {
    const { dashboard } = await serve({ auth: TOKEN });
    const denied = await probe(dashboard.port);
    expect(denied).toMatchObject({ status: 401 });
    // And a different failure still reads differently, which is the point of the default.
    expect(await probe(dashboard.port, { host: "elsewhere.example" })).toMatchObject({ status: 421 });
  });

  it("is indistinguishable from an empty server when told to be", async () => {
    const { dashboard } = await serve({ auth: TOKEN, refusal: "not-found" });
    const port = dashboard.port;

    const noCredentials = await probe(port);
    const wrongHost = await probe(port, { host: "elsewhere.example" });
    const crossSite = await probe(port, { method: "POST", path: "/api/reset", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    // The control: what this server says about a path it genuinely does not have.
    const unknownPath = await probe(port, { path: "/nope", headers: { authorization: `Bearer ${TOKEN.token}` } });

    for (const answer of [noCredentials, wrongHost, crossSite]) {
      expect(answer).toEqual(unknownPath);
    }
    expect(unknownPath).toMatchObject({ status: 404 });
  });

  it("never hints that a credential would help", async () => {
    const { dashboard } = await serve({ auth: TOKEN, refusal: "not-found" });
    const denied = await probe(dashboard.port);
    expect("headers" in denied && denied.headers["www-authenticate"]).toBeFalsy();
  });

  it("drops the connection when told to answer nothing at all", async () => {
    const { dashboard } = await serve({ auth: TOKEN, refusal: "close" });
    expect(await probe(dashboard.port)).toEqual({ dropped: true });
    // And the holder of the token is unaffected.
    expect(await probe(dashboard.port, { headers: { authorization: `Bearer ${TOKEN.token}` } })).toMatchObject({ status: 200 });
  });

  it("redirects when given somewhere to send people", async () => {
    const { dashboard } = await serve({ auth: TOKEN, refusal: { redirect: "https://sso.example/login" } });
    const denied = await probe(dashboard.port);
    expect(denied).toMatchObject({ status: 302 });
    expect("headers" in denied && denied.headers["location"]).toBe("https://sso.example/login");
  });

  it("honours a redirect status that preserves the method", async () => {
    const { dashboard } = await serve({ auth: TOKEN, refusal: { redirect: "/login", status: 307 } });
    expect(await probe(dashboard.port)).toMatchObject({ status: 307 });
  });

  it("still serves the person holding the credential, whatever the mode", async () => {
    for (const refusal of ["not-found", "close", { redirect: "/login" }] as const) {
      const { dashboard } = await serve({ auth: TOKEN, refusal });
      expect(await probe(dashboard.port, { headers: { authorization: `Bearer ${TOKEN.token}` } })).toMatchObject({ status: 200 });
    }
  });

  /**
   * A browser prompts for a password because a 401 asked it to. Answer 404 and no
   * prompt appears, so the credential the server is waiting for can never be typed.
   * That fails at the moment somebody needs the dashboard; this fails at startup.
   */
  it("refuses to combine a silent refusal with basic auth", async () => {
    for (const refusal of ["not-found", "close"] as const) {
      await expect(serve({ auth: { username: "ops", password: "hunter2" }, refusal })).rejects.toThrow(ConfigError);
      await expect(serve({ auth: { username: "ops", password: "hunter2" }, refusal })).rejects.toThrow(/ever be able to log in/);
    }
  });

  it("allows a redirect alongside basic auth, because a prompt is still reachable", async () => {
    const { dashboard } = await serve({ auth: { username: "ops", password: "hunter2" }, refusal: { redirect: "/login" } });
    expect(await probe(dashboard.port)).toMatchObject({ status: 302 });
  });

  it("refuses a redirect with nowhere to go", async () => {
    await expect(serve({ auth: TOKEN, refusal: { redirect: "" } })).rejects.toThrow(/needs a URL or a path/);
  });
});

/**
 * The stream, and what a reconnecting browser costs.
 *
 * Every frame a viewer can miss carries an `id:`, which `EventSource` hands back as
 * `Last-Event-ID` on its own. Before that, a reconnect — a laptop lid, a proxy timing
 * out an idle stream — replayed the whole ring: five hundred entries with their
 * headers, evidence and actor history, per viewer, per blip.
 */
describe("the event stream", () => {
  /** Reads a stream for a moment and returns the raw frames. */
  async function listen(url: string, headers: Record<string, string> = {}, ms = 200): Promise<string> {
    const controller = new AbortController();
    const response = await fetch(url, { headers, signal: controller.signal });
    const reader = response.body!.getReader();
    let text = "";
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      /* aborted, which is how a reader stops */
    }
    clearTimeout(timer);
    return text;
  }

  const entriesIn = (frames: string): number => (frames.match(/event: entry/g) ?? []).length;
  const lastId = (frames: string): string => [...frames.matchAll(/^id: (\d+)$/gm)].pop()?.[1] ?? "";

  it("sends the backlog and a cursor to resume from", async () => {
    const { handler, base } = await serve();
    for (let i = 0; i < 3; i++) await hit(handler, "curl/8.4.0", `/p${i}`);
    await settle();

    const frames = await listen(base + "/api/stream");
    expect(entriesIn(frames)).toBe(3);
    expect(frames).toContain('event: sync\ndata: {"replace":true}');
    expect(lastId(frames)).not.toBe("");
  });

  it("sends only what was missed when a viewer comes back", async () => {
    const { handler, base } = await serve();
    for (let i = 0; i < 3; i++) await hit(handler, "curl/8.4.0", `/p${i}`);
    await settle();
    const cursor = lastId(await listen(base + "/api/stream"));

    await hit(handler, "curl/8.4.0", "/late");
    await settle();

    const resumed = await listen(base + "/api/stream", { "last-event-id": cursor });
    expect(entriesIn(resumed)).toBe(1);
    expect(resumed).toContain('"replace":false');
    expect(resumed).toContain("/late");
  });

  /**
   * A decision lands after the assessment, as a second write to the same request. A
   * cursor numbering *requests* could not express that; this one numbers frames, so a
   * viewer that reconnects between the two is told about the second.
   */
  it("resends a request whose decision arrived while the viewer was away", async () => {
    const { handler, base } = await serve();
    const facts = createFacts({
      method: "GET",
      url: "/products",
      headers: { host: "shop.example", "user-agent": "curl/8.4.0" },
      ip: "203.0.113.7",
      protocol: "https",
      httpVersion: "1.1",
    });
    const assessment = await handler.assess(facts);
    await settle();
    const cursor = lastId(await listen(base + "/api/stream"));

    handler.decide(assessment);
    await settle();

    const resumed = await listen(base + "/api/stream", { "last-event-id": cursor });
    expect(entriesIn(resumed)).toBe(1);
  });

  it("replaces the viewer's feed when the cursor cannot be honoured", async () => {
    const { handler, base } = await serve();
    for (let i = 0; i < 3; i++) await hit(handler, "curl/8.4.0", `/p${i}`);
    await settle();

    for (const cursor of ["999999", "not-a-number", "-1"]) {
      const frames = await listen(base + "/api/stream", { "last-event-id": cursor });
      expect(frames).toContain('"replace":true');
      expect(entriesIn(frames)).toBe(3);
    }
  });

  it("tells every viewer when the feed is cleared, not just the one that pressed it", async () => {
    const { handler, base } = await serve({ controls: { reset: true } });
    await hit(handler);
    await settle();

    const controller = new AbortController();
    const response = await fetch(base + "/api/stream", { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();

    await post(base + "/api/reset", {});
    let sawReset = false;
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (new TextDecoder().decode(value).includes("event: reset")) {
          sawReset = true;
          break;
        }
      }
    } catch {
      /* aborted */
    }
    clearTimeout(timer);
    controller.abort();
    expect(sawReset).toBe(true);
  });
});

/**
 * The guard, changed from the page.
 *
 * Off by default, gated on its own flag rather than on `editPolicy`, and validated the
 * same way whichever door it came through. The two refusals below are the ones that
 * matter: a terminal fallback would make every downgrade deny the request the
 * downgrade exists to protect, and it would still be recorded as a guard stop.
 */
describe("guard editing", () => {
  it("is refused when the control is off, however the request is shaped", async () => {
    const { base } = await serve({ controls: { editPolicy: true } });
    const result = await post(base + "/api/guard", { falsePositivePolicy: "aggressive" });
    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/editGuard/);
  });

  it("changes the running guard when it is on", async () => {
    const { handler, base } = await serve({ controls: { editGuard: true } });
    const result = await post(base + "/api/guard", { falsePositivePolicy: "balanced", terminalScoreThreshold: 90 });
    expect(result.status).toBe(200);
    expect(handler.policy.describeGuard()).toMatchObject({ falsePositivePolicy: "balanced", terminalScoreThreshold: 90 });
  });

  it("moves the suspect threshold, which lives on the config rather than the policy", async () => {
    const { handler, base } = await serve({ controls: { editGuard: true } });
    await post(base + "/api/guard", { suspectThreshold: 75 });
    expect(handler.config.suspectThreshold).toBe(75);
  });

  it("refuses a terminal fallback, because that is the guard denying what it protected", async () => {
    const { handler, base } = await serve({ controls: { editGuard: true } });
    const before = handler.policy.describeGuard().fallbackAction;
    for (const fallbackAction of ["block", "drop", "redirect"]) {
      const result = await post(base + "/api/guard", { fallbackAction });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/fallbackAction cannot be/);
    }
    expect(handler.policy.describeGuard().fallbackAction).toBe(before);
  });

  it("leaves everything as it was when one field is bad", async () => {
    const { handler, base } = await serve({ controls: { editGuard: true } });
    const result = await post(base + "/api/guard", { falsePositivePolicy: "aggressive", terminalScoreThreshold: 0 });
    expect(result.status).toBe(400);
    expect(handler.policy.describeGuard().falsePositivePolicy).toBe("strict");
  });

  it("ignores anything that is not a guard setting", async () => {
    const { handler, base } = await serve({ controls: { editGuard: true } });
    await post(base + "/api/guard", { falsePositivePolicy: "balanced", rules: [{ id: "smuggled", match: {}, action: "block" }] });
    expect(handler.policy.ruleIds).not.toContain("smuggled");
  });

  it("announces the change where startup warnings go, with both sides of it", async () => {
    const warnings: string[] = [];
    const changes: unknown[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message), onGuardChange: (event) => changes.push(event) });
    const dashboard = await handler.serveDashboard({ port: 0, controls: { editGuard: true } });
    running.push(dashboard);
    await post(dashboard.url.replace(/\/$/, "") + "/api/guard", { falsePositivePolicy: "balanced" });
    expect(warnings.some((message) => /falsePositivePolicy strict → balanced/.test(message))).toBe(true);
    expect(changes).toEqual([{ before: expect.objectContaining({ falsePositivePolicy: "strict" }), after: expect.objectContaining({ falsePositivePolicy: "balanced" }) }]);
  });

  it("refuses to enable an unauthenticated guard editor on a public address", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, host: "0.0.0.0", auth: false, controls: { editGuard: true } })).rejects.toThrow(/editGuard/);
  });

  it("previews a guard change without applying it, even where it cannot be applied", async () => {
    const { handler, base } = await serve({}, { preset: "protect-content" });
    await hit(handler, "curl/8.4.0");
    await settle();
    const result = await post(base + "/api/policy/preview", { rules: [{ id: "all", match: {}, action: "block" }], guard: { falsePositivePolicy: "aggressive" } });
    expect(result.status).toBe(200);
    expect(handler.policy.describeGuard().falsePositivePolicy).toBe("strict");
  });

  it("refuses to preview a guard it would refuse to apply", async () => {
    const { base } = await serve();
    const result = await post(base + "/api/policy/preview", { rules: [], guard: { fallbackAction: "drop" } });
    expect(result.status).toBe(400);
  });
});

/**
 * Sections: what a listener shows, as opposed to what it lets you do.
 *
 * The point of every one of these is that a switched-off section is *gone*, not
 * hidden. A viewer with devtools open sees what the page sees, because the server
 * never sent the rest.
 */
describe("sections", () => {
  it("drops the evidence from the wire, not just from the screen", async () => {
    const { handler, base } = await serve({ sections: { evidence: false } });
    await hit(handler, "curl/8.4.0");
    await settle();
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries[0]!.evidence).toEqual([]);
    expect((feed.entries[0] as { headers?: unknown }).headers).toBeUndefined();
  });

  it("keeps the evidence for the preview, which re-decides from the same entries", async () => {
    const { handler, base } = await serve({ sections: { evidence: false } });
    await hit(handler, "curl/8.4.0");
    await settle();
    // If the projection had been applied to the stored entry, a rule matching on a
    // detector would match nothing here and the preview would quietly be wrong.
    const preview = await post(base + "/api/policy/preview", { rules: [{ id: "self", match: { detector: ["self-identified"] }, action: "tag" }] });
    expect(preview.body.ruleHits.find((row: { rule: string }) => row.rule === "self").hits).toBeGreaterThan(0);
  });

  it("blanks the actor history when the actor section is off", async () => {
    const { handler, base } = await serve({ sections: { actors: false } });
    await hit(handler, "curl/8.4.0");
    await settle();
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect((feed.entries[0] as unknown as { actorStats: { requests: number } }).actorStats.requests).toBe(0);
  });

  it("closes the endpoint behind a section, not only the panel in front of it", async () => {
    const { base } = await serve({ sections: { policy: false, feed: false } });
    expect((await fetch(base + "/api/policy")).status).toBe(403);
    expect((await fetch(base + "/api/feed")).status).toBe(403);
    expect((await fetch(base + "/api/stream")).status).toBe(403);
    expect((await fetch(base + "/api/settings")).status).toBe(403);
    expect((await post(base + "/api/policy/preview", { rules: [] })).status).toBe(403);
  });

  it("withholds the counters when the statistics section is off", async () => {
    const { handler, base } = await serve({ sections: { statistics: false } });
    await hit(handler);
    const stats = await json<StatsBody>(await fetch(base + "/api/stats"));
    expect(stats.metrics).toBeUndefined();
    expect(stats.detectors).toEqual([]);
  });

  it("takes the guard and the robots preview down with the policy section", async () => {
    const { base } = await serve({ sections: { policy: false }, controls: { editGuard: true } });
    expect((await post(base + "/api/guard", { falsePositivePolicy: "balanced" })).status).toBe(403);
  });

  it("tells the page what it has, so it can remove the rest", async () => {
    const { base } = await serve({ sections: { audit: false, notices: false } });
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('\\"audit\\":false');
    expect(html).toContain('\\"notices\\":false');
    expect(html).toContain('\\"feed\\":true');
  });

  it("is a whole dashboard when nothing is said about it", async () => {
    const { handler, base } = await serve();
    await hit(handler, "curl/8.4.0");
    await settle();
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries[0]!.evidence.length).toBeGreaterThan(0);
    expect((await fetch(base + "/api/policy")).status).toBe(200);
  });
});

/**
 * Who did it.
 *
 * The dashboard has no user model and does not want one — `authorize` is a predicate,
 * and roles are the caller's. But an audit trail that can say the guard was changed and
 * cannot say by whom is half an audit trail, so the predicate may name the viewer and
 * the name travels with every change they make.
 */
describe("attribution", () => {
  it("takes a name from a basic credential without being asked", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    const dashboard = await handler.serveDashboard({ port: 0, auth: { username: "ops", password: "correct-horse" }, controls: { editGuard: true } });
    running.push(dashboard);
    const base = dashboard.url.replace(/\/$/, "");

    const response = await fetch(base + "/api/guard", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("ops:correct-horse").toString("base64")}` },
      body: JSON.stringify({ falsePositivePolicy: "balanced" }),
    });
    expect(response.status).toBe(200);
    expect(warnings.some((message) => message.includes("by ops"))).toBe(true);
  });

  it("takes a name from a custom check that returns one", async () => {
    const changes: Array<{ by?: string | undefined }> = [];
    const handler = new BotHandler({ onGuardChange: (event) => changes.push(event) });
    const dashboard = await handler.serveDashboard({
      port: 0,
      auth: { authorize: () => "ada@example.com" },
      controls: { editGuard: true },
    });
    running.push(dashboard);
    await post(dashboard.url.replace(/\/$/, "") + "/api/guard", { falsePositivePolicy: "balanced" });
    expect(changes[0]?.by).toBe("ada@example.com");
  });

  /** A lookup that returns "" for "no such user" must fail closed, not admit anonymously. */
  it("treats an empty name as a refusal", async () => {
    const { base } = await serve({ auth: { authorize: () => "" } });
    expect((await fetch(base + "/")).status).toBe(401);
  });

  it("says nothing when the credential names nobody", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    const dashboard = await handler.serveDashboard({ port: 0, auth: { token: "a-token-long-enough" }, controls: { editGuard: true } });
    running.push(dashboard);
    await fetch(dashboard.url.replace(/\/$/, "") + "/api/guard", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer a-token-long-enough" },
      body: JSON.stringify({ falsePositivePolicy: "balanced" }),
    });
    // A token is a credential, not an identity, and inventing one would be worse than
    // admitting the gap.
    expect(warnings.some((message) => message.includes("Guard settings changed at runtime:"))).toBe(true);
    expect(warnings.some((message) => message.includes(" by "))).toBe(false);
  });
});

/**
 * Acting on one client rather than on a class of request.
 *
 * The allowlist is the consequential one: an address on it is not judged leniently, it
 * is not judged at all.
 */
describe("acting on an actor", () => {
  it("is refused when the control is off", async () => {
    const { base } = await serve({ controls: { editPolicy: true } });
    expect((await post(base + "/api/actor", { key: "203.0.113.7", action: "forget" })).status).toBe(403);
    expect((await post(base + "/api/ranges", { name: "allowlist", add: ["203.0.113.0/24"] })).status).toBe(403);
  });

  it("forgets an actor's history without touching anybody else's", async () => {
    const { handler, base } = await serve({ controls: { editRanges: true } });
    await hit(handler, "curl/8.4.0");
    expect(handler.registry.peek("203.0.113.7")).toBeDefined();

    const result = await post(base + "/api/actor", { key: "203.0.113.7", action: "forget" });
    expect(result.status).toBe(200);
    expect(handler.registry.peek("203.0.113.7")).toBeUndefined();
  });

  it("grants clearance for a bounded time", async () => {
    const { handler, base } = await serve({ controls: { editRanges: true } });
    await post(base + "/api/actor", { key: "203.0.113.7", action: "clear", forMs: 60_000 });
    expect(handler.registry.peek("203.0.113.7")?.snapshot(Date.now()).cleared).toBe(true);
  });

  it("adds and removes range entries against what is there now", async () => {
    const { handler, base } = await serve({ controls: { editRanges: true } }, { allowlist: ["198.51.100.0/24"] });
    await post(base + "/api/ranges", { name: "allowlist", add: ["203.0.113.7"] });
    expect(handler.rangeEntries("allowlist")).toEqual(["198.51.100.0/24", "203.0.113.7"]);
    expect(handler.isAllowlisted("203.0.113.7")).toBe(true);

    await post(base + "/api/ranges", { name: "allowlist", remove: ["198.51.100.0/24"] });
    expect(handler.rangeEntries("allowlist")).toEqual(["203.0.113.7"]);
  });

  it("refuses an address it cannot parse, and leaves the set alone", async () => {
    const { handler, base } = await serve({ controls: { editRanges: true } }, { allowlist: ["198.51.100.0/24"] });
    const result = await post(base + "/api/ranges", { name: "allowlist", add: ["not-an-address"] });
    expect(result.status).toBe(400);
    expect(handler.rangeEntries("allowlist")).toEqual(["198.51.100.0/24"]);
  });

  it("shows what is in a set, not just how many", async () => {
    const { base } = await serve({}, { allowlist: ["198.51.100.0/24"] });
    const body = await json<{ ranges: Array<{ name: string; entries: string[] }>; editable: boolean }>(await fetch(base + "/api/ranges"));
    expect(body.ranges.find((range) => range.name === "allowlist")?.entries).toEqual(["198.51.100.0/24"]);
    expect(body.editable).toBe(false);
  });

  /**
   * A masked key names a `/24`; the registry is keyed by the address. Acting on the
   * wrong key silently would be worse than not offering the button, so the whole
   * control goes.
   */
  it("is unavailable when addresses are masked, because the key shown is not the key held", async () => {
    const { base } = await serve({ controls: { editRanges: true }, redact: { maskIp: true } });
    expect((await post(base + "/api/actor", { key: "203.0.113.0/24", action: "forget" })).status).toBe(403);
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('\\"allowActing\\":false');
  });

  it("records every one of them on the timeline", async () => {
    const { handler, base } = await serve({ controls: { editRanges: true } });
    await post(base + "/api/ranges", { name: "allowlist", add: ["203.0.113.7"] });
    await post(base + "/api/actor", { key: "203.0.113.7", action: "forget" });
    const stats = await json<{ changes: Array<{ kind: string; summary: string }> }>(await fetch(base + "/api/stats"));
    expect(stats.changes.map((change) => change.kind)).toEqual(["range", "actor"]);
    expect(handler.registry.size).toBe(0);
  });
});

/** The registry's own view of who is here, which the feed's ring cannot answer. */
describe("the actors screen", () => {
  it("lists the busiest actors the registry is holding", async () => {
    const { handler, base } = await serve();
    await hit(handler, "curl/8.4.0");
    await hit(handler, "curl/8.4.0", "/other");
    const body = await json<{ actors: Array<{ key: string; requests: number }>; tracked: number }>(await fetch(base + "/api/actors"));
    expect(body.tracked).toBe(1);
    expect(body.actors[0]).toMatchObject({ key: "203.0.113.7", requests: 2, distinctPaths: 2 });
  });

  it("masks the keys it lists when the feed's are masked", async () => {
    const { handler, base } = await serve({ redact: { maskIp: true } });
    await hit(handler, "curl/8.4.0");
    const body = await json<{ actors: Array<{ key: string }> }>(await fetch(base + "/api/actors"));
    expect(body.actors[0]?.key).toBe("203.0.113.0/24");
  });

  it("is gone with its section", async () => {
    const { base } = await serve({ sections: { registry: false } });
    expect((await fetch(base + "/api/actors")).status).toBe(403);
  });
});

/**
 * The request tester.
 *
 * A dry run: the verdict and the decision are real, and nothing anywhere is recorded.
 * The last of those is the property that makes it safe to put on a page whose job is to
 * describe traffic honestly.
 */
describe("testing a request", () => {
  it("assesses a pasted User-Agent and names the rule that would fire", async () => {
    const { base } = await serve({}, { preset: "protect-content" });
    const result = await post(base + "/api/test", { raw: "curl/8.4.0" });
    expect(result.status).toBe(200);
    expect(result.body.entry.verdict).toBe("confirmed-bot");
    expect(result.body.entry.action).toBeDefined();
    expect(result.body.entry.evidence.length).toBeGreaterThan(0);
  });

  it("reads a curl command out of devtools", async () => {
    const { base } = await serve();
    const result = await post(base + "/api/test", { raw: "curl 'https://shop.example/api' -A 'python-requests/2.32.3'" });
    expect(result.body.entry.userAgent).toBe("python-requests/2.32.3");
    expect(result.body.entry.path).toBe("/api");
  });

  it("records nothing: not a counter, not an actor, not an event", async () => {
    const { handler, base } = await serve();
    const seen: unknown[] = [];
    handler.on("assessment", (assessment) => seen.push(assessment));

    await post(base + "/api/test", { raw: "curl/8.4.0", ip: "198.51.100.99" });

    expect(handler.metrics()!.requests).toBe(0);
    expect(handler.registry.peek("198.51.100.99")).toBeUndefined();
    expect(seen).toEqual([]);
    expect(await json<{ entries: unknown[] }>(await fetch(base + "/api/feed"))).toEqual({ entries: [] });
  });

  it("says what it had to invent", async () => {
    const { base } = await serve();
    const result = await post(base + "/api/test", { raw: "curl/8.4.0" });
    expect(result.body.assumed).toContain("Host: test.invalid");
  });

  it("refuses an empty paste", async () => {
    const { base } = await serve();
    expect((await post(base + "/api/test", { raw: "" })).status).toBe(400);
  });

  it("is gone with its section", async () => {
    const { base } = await serve({ sections: { tester: false } });
    expect((await post(base + "/api/test", { raw: "curl/8.4.0" })).status).toBe(403);
  });
});

/**
 * The stream's rate cap.
 *
 * A dashboard on a busy origin is a firehose: every assessment to every open browser.
 * What is capped is the *stream*; the ring keeps everything, because that is what the
 * preview runs over and a thinned ring would silently answer a different question.
 */
describe("the rate cap", () => {
  it("keeps the surplus out of the stream and in the window", async () => {
    const { handler, base } = await serve({ maxEventsPerSecond: 2 });
    for (let i = 0; i < 8; i++) await hit(handler, "curl/8.4.0", `/p${i}`);
    await settle();

    const stats = await json<{ skipped: number }>(await fetch(base + "/api/stats"));
    expect(stats.skipped).toBeGreaterThan(0);
    // Every request is still there to preview against, to export, and to be replayed
    // to whoever reconnects.
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries).toHaveLength(8);
  });

  it("is off when the caller says so", async () => {
    const { handler, base } = await serve({ maxEventsPerSecond: 0 });
    for (let i = 0; i < 20; i++) await hit(handler, "curl/8.4.0", `/p${i}`);
    await settle();
    expect((await json<{ skipped: number }>(await fetch(base + "/api/stats"))).skipped).toBe(0);
  });
});

describe("which process this is", () => {
  it("names itself, because a dashboard reports on one process and not on a fleet", async () => {
    const { base } = await serve({ instance: "web-3" });
    expect((await json<{ instance: string }>(await fetch(base + "/api/stats"))).instance).toBe("web-3");
  });

  it("falls back to the hostname rather than to nothing", async () => {
    const { base } = await serve();
    expect((await json<{ instance: string }>(await fetch(base + "/api/stats"))).instance).not.toBe("");
  });
});

/**
 * The dashboard on a listener you already have.
 *
 * The reason people ask for this is TLS: the certificate lives at an ingress, or
 * everything has to be reachable under one hostname, or the platform exposes one port.
 * None of that is an argument against a dashboard separate from the application — it is
 * an argument about which server serves it.
 */
describe("mounted on somebody else's server", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length > 0) closers.pop()?.();
  });

  async function mount(options: Parameters<typeof createDashboardHandler>[1], handler = new BotHandler()): Promise<{ handler: BotHandler; at: (path: string) => string; dashboard: ReturnType<typeof createDashboardHandler> }> {
    const dashboard = createDashboardHandler(handler, options);
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/_bots") === true) return dashboard(request, response);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("the app");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    closers.push(() => {
      void dashboard.close();
      server.close();
    });
    return { handler, dashboard, at: (path: string) => `http://127.0.0.1:${port}${path}` };
  }

  const bearer = { authorization: "Bearer a-token-long-enough" };

  it("serves the dashboard without taking the server over", async () => {
    const { at } = await mount({ basePath: "/_bots", auth: { token: "a-token-long-enough" } });
    expect(await (await fetch(at("/"))).text()).toBe("the app");
    expect((await fetch(at("/_bots/"), { headers: bearer })).status).toBe(200);
    expect((await fetch(at("/_bots/api/stats"), { headers: bearer })).status).toBe(200);
  });

  it("still refuses everyone without a credential", async () => {
    const { at } = await mount({ basePath: "/_bots", auth: { token: "a-token-long-enough" } });
    expect((await fetch(at("/_bots/"))).status).toBe(401);
    expect((await fetch(at("/_bots/api/stats"))).status).toBe(401);
  });

  /**
   * The listening form may skip `auth` on loopback, because the operating system is
   * then the access control. Mounted there is no bind address to inspect, so nothing
   * can be assumed and the assumption made is "public".
   */
  it("insists on an explicit decision about access", () => {
    const handler = new BotHandler();
    expect(() => createDashboardHandler(handler, {} as never)).toThrow(/mounted dashboard needs .auth./);
    expect(() => createDashboardHandler(handler, { auth: false })).not.toThrow();
    expect(() => createDashboardHandler(handler, { auth: false, controls: { editPolicy: true } })).toThrow(/editPolicy/);
  });

  it("tells the page which path it is served under", async () => {
    const { at } = await mount({ basePath: "/_bots", auth: { token: "a-token-long-enough" } });
    const html = await (await fetch(at("/_bots/"), { headers: bearer })).text();
    expect(html).toContain('\\"base\\":\\"/_bots\\"');
  });

  /** Express strips the mount point before calling a handler; a bare server does not. */
  it("routes whether or not the surrounding router stripped the prefix", async () => {
    const dashboard = createDashboardHandler(new BotHandler(), { basePath: "/_bots", auth: false });
    const server = createServer((request, response) => {
      request.url = (request.url ?? "").replace("/_bots", "") || "/";
      dashboard(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    closers.push(() => {
      void dashboard.close();
      server.close();
    });
    expect((await fetch(`http://127.0.0.1:${port}/_bots/api/stats`)).status).toBe(200);
  });

  it("closes its own subscriptions and not your server", async () => {
    const { handler, dashboard, at } = await mount({ auth: false, basePath: "/_bots" });
    await hit(handler);
    await settle();
    expect((await json<FeedBody>(await fetch(at("/_bots/api/feed")))).entries).toHaveLength(1);

    await dashboard.close();

    // It has stopped listening to the engine: new traffic no longer reaches its ring.
    await hit(handler);
    await settle();
    expect((await json<FeedBody>(await fetch(at("/_bots/api/feed")))).entries).toHaveLength(0);
    // And the server it was mounted on is still answering, because it was never ours.
    expect(await (await fetch(at("/"))).text()).toBe("the app");
  });
});

/**
 * Slowing down a wrong credential.
 *
 * Constant-time comparison defeats a timing attack and does nothing about the obvious
 * one, which is trying again.
 */
describe("failed credentials", () => {
  const wrong = { authorization: `Basic ${Buffer.from("ops:wrong").toString("base64")}` };
  const right = { authorization: `Basic ${Buffer.from("ops:correct-horse").toString("base64")}` };
  const auth = { username: "ops", password: "correct-horse" };

  it("locks an address out after a handful of failures", async () => {
    const { base } = await serve({ auth, authThrottle: { maxAttempts: 3, lockoutMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await fetch(base + "/", { headers: wrong })).status).toBe(401);

    const locked = await fetch(base + "/", { headers: wrong });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    // And the lockout is about the address, not the credential: the right password does
    // not get through it either, which is what stops it being an oracle.
    expect((await fetch(base + "/", { headers: right })).status).toBe(429);
  });

  it("forgets the failures as soon as somebody gets it right", async () => {
    const { base } = await serve({ auth, authThrottle: { maxAttempts: 3, lockoutMs: 60_000 } });
    for (let i = 0; i < 2; i++) await fetch(base + "/", { headers: wrong });
    expect((await fetch(base + "/", { headers: right })).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await fetch(base + "/", { headers: wrong })).status).toBe(401);
  });

  /** A 429 would tell a prober there is a credential here worth guessing. */
  it("stays silent when the dashboard is configured to be", async () => {
    const { base } = await serve({ auth: { token: "a-token-long-enough" }, refusal: "not-found", authThrottle: { maxAttempts: 2, lockoutMs: 60_000 } });
    for (let i = 0; i < 3; i++) await fetch(base + "/");
    const locked = await fetch(base + "/");
    expect(locked.status).toBe(404);
    expect(locked.headers.get("retry-after")).toBeNull();
  });

  it("can be switched off for something in front of it", async () => {
    const { base } = await serve({ auth, authThrottle: false });
    for (let i = 0; i < 10; i++) expect((await fetch(base + "/", { headers: wrong })).status).toBe(401);
  });
});

/** Who may connect at all, which is a different question from which name they asked for. */
describe("the client allowlist", () => {
  it("answers only the addresses it was given", async () => {
    const { base } = await serve({ allowedClients: ["198.51.100.0/24"] });
    expect((await fetch(base + "/")).status).toBe(403);
  });

  it("lets a listed address through to the credential", async () => {
    const { base } = await serve({ allowedClients: ["127.0.0.1/32", "::1/128"] });
    expect((await fetch(base + "/")).status).toBe(200);
  });

  it("is checked before authentication, so an outsider cannot even try one", async () => {
    const { base } = await serve({ allowedClients: ["198.51.100.0/24"], auth: { username: "ops", password: "correct-horse" } });
    const response = await fetch(base + "/", { headers: { authorization: `Basic ${Buffer.from("ops:correct-horse").toString("base64")}` } });
    expect(response.status).toBe(403);
  });

  it("refuses a list nothing could match rather than locking everybody out quietly", async () => {
    const handler = new BotHandler();
    await expect(handler.serveDashboard({ port: 0, allowedClients: ["not-an-address"] })).rejects.toThrow(/allowedClients/);
  });
});

/**
 * Retention, which is a promise about time rather than about memory.
 *
 * `feedLimit` bounds the count; on a quiet service five hundred requests can be a
 * fortnight of them, each holding somebody's address, User-Agent and headers.
 */
describe("how long a request stays", () => {
  it("drops entries older than the TTL", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const handler = new BotHandler({ clock });
    const dashboard = await handler.serveDashboard({ port: 0, feedTtlMs: 60_000 });
    running.push(dashboard);
    const base = dashboard.url.replace(/\/$/, "");

    await hitAt(handler, clock.now());
    await settle();
    expect((await json<FeedBody>(await fetch(base + "/api/feed"))).entries).toHaveLength(1);

    clock.advance(61_000);
    await hitAt(handler, clock.now());
    await settle();
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries).toHaveLength(1);
  });

  it("keeps them until the ring evicts them when the TTL is off", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const handler = new BotHandler({ clock });
    const dashboard = await handler.serveDashboard({ port: 0, feedTtlMs: 0 });
    running.push(dashboard);
    await hitAt(handler, clock.now());
    clock.advance(30 * 24 * 60 * 60_000);
    await hitAt(handler, clock.now());
    await settle();
    expect((await json<FeedBody>(await fetch(dashboard.url.replace(/\/$/, "") + "/api/feed"))).entries).toHaveLength(2);
  });
});

/**
 * A viewer that stops reading.
 *
 * `response.write()` returns false when the socket's buffer is full, and nothing used
 * to look at that: the frames for a laptop that slept with its tab open accumulated in
 * this process's memory, one queue per viewer, without limit.
 */
describe("a stalled viewer", () => {
  it("does not stall the server, and is told what it missed", async () => {
    const { handler, dashboard, base } = await serve({ maxEventsPerSecond: 0, feedLimit: 5000 });

    // A reader that connects and then stops reading. The kernel buffer fills, and the
    // server's writes start returning false.
    const socket = connect(dashboard.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write("GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
    socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Fat entries rather than many, because what has to overflow is a buffer measured
    // in megabytes: the feed keeps up to forty headers of up to three hundred
    // characters, so one request like this is about twelve kilobytes on the wire.
    const headers: Record<string, string> = { host: "shop.example", "user-agent": "curl/8.4.0" };
    for (let i = 0; i < 38; i++) headers[`x-pad-${i}`] = "p".repeat(300);
    for (let i = 0; i < 400; i++) {
      const facts = createFacts({ method: "GET", url: `/p${i}`, headers, ip: "203.0.113.7", protocol: "https", httpVersion: "1.1" });
      handler.decide(await handler.assess(facts));
    }
    await settle();

    // The server is still serving everybody else.
    expect((await fetch(base + "/api/stats")).status).toBe(200);
    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries.length).toBe(400);

    // And when it starts reading again it is told the size of the hole rather than
    // being left to think the traffic stopped.
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(received).toContain("event: lagged");
    socket.destroy();
  }, 30_000);
});

/** Everything this page holds is bounded, and a long run is how you find out it is not. */
describe("under sustained load", () => {
  it("keeps every structure it owns bounded", async () => {
    const { handler, base } = await serve({ feedLimit: 100, maxEventsPerSecond: 5 });
    for (let i = 0; i < 3000; i++) await hit(handler, i % 2 === 0 ? "curl/8.4.0" : "python-requests/2.32.3", `/p${i % 50}`);
    await settle();

    const feed = await json<FeedBody>(await fetch(base + "/api/feed"));
    expect(feed.entries).toHaveLength(100);

    const stats = await json<StatsBody & { skipped: number; changes: unknown[] }>(await fetch(base + "/api/stats"));
    expect(stats.notices.length).toBeLessThanOrEqual(100);
    expect(stats.changes.length).toBeLessThanOrEqual(50);
    // The stream was capped; the window was not.
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.metrics.requests).toBe(3000);

    // The registry is bounded by its own configuration rather than by traffic.
    expect(handler.registry.size).toBeLessThanOrEqual(20_000);
  }, 30_000);
});

/**
 * What the page must never stop being, checked without a browser.
 *
 * The behavioural half of this — arrow keys, focus, sticky offsets, narrow layouts —
 * now lives in `tests/browser`, driven by a real Chromium. What is left here are the
 * two invariants worth failing `npm test` for on a machine with no browser installed:
 * markup is never assembled from client-written text, and the sticky offset is
 * measured rather than guessed. Both are one careless edit away and neither needs a
 * renderer to check.
 */
describe("the page's standing invariants", () => {
  async function page(): Promise<string> {
    const { base } = await serve();
    return (await fetch(base + "/")).text();
  }

  it("adds no way to turn a User-Agent into markup", async () => {
    const html = await page();
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  /**
   * The column headers were pinned to a hard-coded 54px — the top row alone, with the
   * tab strip unaccounted for — and the panel around them was a scroll container, so
   * they never stuck at all. Both halves are fixed; this guards the half that is a
   * constant somebody might reintroduce.
   */
  it("measures the header height rather than hard-coding it", async () => {
    const html = await page();
    expect(html).toContain("top: var(--header-h");
    expect(html).toContain('setProperty("--header-h"');
    expect(html).not.toMatch(/position: sticky; top: \d+px/);
  });
});

