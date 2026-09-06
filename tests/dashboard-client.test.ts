import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/dashboard/parse-request.js";
import { corpusCase, replayFile, replayLine } from "../src/dashboard/client/replay.js";
import { draftRule } from "../src/dashboard/client/draft.js";
import { matchesFilter, matchesQuery, parseQuery, searchableText } from "../src/dashboard/client/query.js";
import { actionKind, outcome, verdictBadge } from "../src/dashboard/client/outcome.js";
import { clearFeed, state } from "../src/dashboard/client/store.js";
import { n, pct, rangeLabel, uptime, windowLabel } from "../src/dashboard/client/format.js";
import type { DashboardEntry } from "../src/dashboard/types.js";

/**
 * The dashboard's browser code, tested by calling it.
 *
 * This file could not have existed before. The client was two thousand lines of
 * JavaScript inside a template literal in `page.ts`, where TypeScript could not see it,
 * Biome did not lint it and nothing could import a function out of it — which is how a
 * call to a function nobody had written shipped and blanked the whole Statistics tab
 * until a browser ran it. It is a real module now, and the parts of it that are pure —
 * the search, the outcome classification, the rule drafting, the replay formats — are
 * exactly the parts most likely to be quietly wrong.
 *
 * Everything here is DOM-free by construction: these modules import nothing from
 * `dom.ts`, which is what lets them run under `npm test` with no browser at all.
 */

function entry(overrides: Partial<DashboardEntry> = {}): DashboardEntry {
  return {
    seq: 1,
    requestId: "req-1",
    at: 1_700_000_000_000,
    method: "GET",
    path: "/api/items",
    actor: "203.0.113.4",
    userAgent: "curl/8.4.0",
    verdict: "confirmed-bot",
    botClass: "http-client",
    score: 100,
    certain: true,
    durationMs: 0.4,
    evidence: [],
    failures: [],
    actorStats: { requests: 3, distinctPaths: 2, priorConfirmations: 1, cleared: false, firstSeen: 1_699_999_000_000 },
    query: {},
    ...overrides,
  };
}

describe("the feed's search", () => {
  const rows = [
    entry({ requestId: "a", path: "/api/items", actor: "203.0.113.4", userAgent: "curl/8.4.0", verdict: "confirmed-bot", action: "block", rule: "http-clients" }),
    entry({ requestId: "b", path: "/health", actor: "203.0.113.4", userAgent: "kube-probe/1.29", verdict: "unknown", certain: false, score: 12, action: "allow", rule: "default" }),
    entry({
      requestId: "c",
      path: "/products",
      actor: "198.51.100.9",
      userAgent: "Mozilla/5.0",
      verdict: "suspected-bot",
      certain: false,
      score: 71,
      action: "challenge",
      evidence: [{ detector: "header-order", summary: "unusual header order", certainty: "moderate", direction: "bot" }],
    }),
  ];

  function search(query: string): string[] {
    const terms = parseQuery(query);
    return rows.filter((row) => matchesQuery(terms, row, searchableText(row))).map((row) => row.requestId);
  }

  it("matches a bare word anywhere, the way it always did", () => {
    expect(search("curl")).toEqual(["a"]);
    expect(search("203.0.113.4")).toEqual(["a", "b"]);
  });

  it("narrows to a field when one is named", () => {
    // The address appears in nothing but the actor here, but the point is that
    // `actor:` cannot be satisfied by a User-Agent that happens to quote an address.
    expect(search("actor:203.0.113.4")).toEqual(["a", "b"]);
    expect(search("path:/health")).toEqual(["b"]);
    expect(search("rule:default")).toEqual(["b"]);
    expect(search("detector:header-order")).toEqual(["c"]);
  });

  it("excludes with a leading dash", () => {
    expect(search("actor:203.0.113.4 -path:/health")).toEqual(["a"]);
    expect(search("-curl")).toEqual(["b", "c"]);
  });

  it("ands every term together, because that is what narrowing means", () => {
    expect(search("actor:203.0.113.4 path:/health")).toEqual(["b"]);
    expect(search("actor:203.0.113.4 path:/nothing")).toEqual([]);
  });

  it("compares scores rather than matching their digits", () => {
    expect(search("score:>50")).toEqual(["a", "c"]);
    expect(search("score:<50")).toEqual(["b"]);
    expect(search("score:12")).toEqual(["b"]);
  });

  it("keeps a quoted phrase together", () => {
    expect(parseQuery('"GET /api/v2"')).toEqual([{ field: undefined, value: "get /api/v2", negated: false }]);
  });

  /** A path can contain a colon, and so can a User-Agent. Only known names make a field. */
  it("treats an unknown prefix as an ordinary word", () => {
    expect(parseQuery("weird:thing")).toEqual([{ field: undefined, value: "weird:thing", negated: false }]);
  });

  it("matches everything when it is empty", () => {
    expect(search("")).toEqual(["a", "b", "c"]);
    expect(search("   ")).toEqual(["a", "b", "c"]);
  });

  it("still supports the named filter buttons alongside it", () => {
    expect(rows.filter((row) => matchesFilter("deny", row)).map((row) => row.requestId)).toEqual(["a"]);
    expect(rows.filter((row) => matchesFilter("mitigate", row)).map((row) => row.requestId)).toEqual(["c"]);
    expect(rows.filter((row) => matchesFilter("proven", row)).map((row) => row.requestId)).toEqual(["a"]);
    expect(rows.filter((row) => matchesFilter("all", row))).toHaveLength(3);
  });
});

describe("one request, one outcome", () => {
  it("agrees with the policy about what a denial is", () => {
    expect(outcome(entry({ action: "block" }))).toBe("deny");
    expect(outcome(entry({ action: "drop" }))).toBe("deny");
    expect(outcome(entry({ action: "redirect" }))).toBe("deny");
    expect(outcome(entry({ action: "challenge" }))).toBe("mitigate");
    expect(outcome(entry({ action: "rate-limit" }))).toBe("mitigate");
    expect(outcome(entry({ action: "delay" }))).toBe("mitigate");
    expect(outcome(entry({ action: "tag" }))).toBe("allow");
  });

  /** `assess()` with no `decide()` — a monitor deployment — is a row with no action. */
  it("calls an undecided request pending rather than served", () => {
    expect(outcome(entry())).toBe("pending");
    expect(actionKind(undefined)).toBe("pending");
  });

  it("names a bypassed request as skipped, with the reason", () => {
    expect(verdictBadge(entry({ verdict: "unknown", bypass: "allowlist" }))).toEqual(["b-unknown", "skipped · allowlist"]);
    expect(verdictBadge(entry({ verdict: "verified-bot" }))).toEqual(["b-proven", "verified-bot"]);
    expect(verdictBadge(entry({ verdict: "human" }))).toEqual(["b-human", "human"]);
  });
});

describe("drafting a rule from a request", () => {
  it("never drafts an action that can deny anybody", () => {
    const drafted = draftRule(entry({ verdict: "confirmed-bot", certain: true, evidence: [{ detector: "self-identified", summary: "says it is a bot", certainty: "certain", direction: "bot" }] }));
    expect(drafted.rule.action).toBe("tag");
  });

  it("matches a verified identity on proof, so a claim alone does not match", () => {
    const drafted = draftRule(entry({ identity: "googlebot", verdict: "verified-bot", certain: true }));
    expect(drafted.rule.match).toEqual({ identity: ["googlebot"], certain: true });
    expect(drafted.rule.id).toBe("from-googlebot");
  });

  it("says so when the identity is only claimed", () => {
    const drafted = draftRule(entry({ identity: "gptbot", verdict: "suspected-bot", certain: false, score: 40 }));
    expect(drafted.rule.match).toEqual({ identity: ["gptbot"] });
    expect(drafted.because).toMatch(/Nothing has verified it/);
  });

  it("falls back to the detectors whose evidence was proven", () => {
    const drafted = draftRule(
      entry({
        certain: true,
        evidence: [
          { detector: "trap", summary: "requested a trap path", certainty: "certain", direction: "bot" },
          { detector: "header-order", summary: "unusual order", certainty: "moderate", direction: "bot" },
        ],
      }),
    );
    expect(drafted.rule.match).toEqual({ detector: ["trap"], certain: true });
  });

  /** A probabilistic draft has to be honest that the guard will not let it deny anybody. */
  it("floors the score for a probabilistic request and says what that means", () => {
    const drafted = draftRule(
      entry({ verdict: "suspected-bot", certain: false, score: 74, evidence: [{ detector: "cadence", summary: "metronomic", certainty: "moderate", direction: "bot" }] }),
    );
    expect(drafted.rule.match).toEqual({ verdict: ["suspected-bot"], detector: ["cadence"], minScore: 70 });
    expect(drafted.because).toMatch(/guard will not let this rule deny anybody/);
  });

  it("does not silently reuse an id another rule already has", () => {
    const first = draftRule(entry({ identity: "gptbot" }), []);
    const second = draftRule(entry({ identity: "gptbot" }), [first.rule.id]);
    expect(second.rule.id).toBe("from-gptbot-2");
  });

  it("leaves the path out, because the request having one is not the rule being about it", () => {
    const drafted = draftRule(entry({ identity: "gptbot", path: "/products/42" }));
    expect(drafted.rule.match["path"]).toBeUndefined();
  });
});

describe("a row as something you can keep", () => {
  const captured = entry({
    headers: [
      ["host", "shop.example"],
      ["user-agent", "curl/8.4.0"],
      ["cookie", "[redacted]"],
    ],
    query: { token: "[redacted]" },
    protocol: "https",
  });

  it("writes a replay line the CLI can read", () => {
    const line = JSON.parse(replayLine(captured)) as { url: string; headers: Record<string, string>; ip: string };
    expect(line.url).toBe("/api/items?token=%5Bredacted%5D");
    expect(line.headers["user-agent"]).toBe("curl/8.4.0");
    expect(line.ip).toBe("203.0.113.4");
  });

  it("keeps redacted values redacted, because the shape is what replays", () => {
    expect(replayLine(captured)).toContain("[redacted]");
    expect(replayLine(captured)).not.toContain("session=");
  });

  it("writes one line per request, oldest first", () => {
    const file = replayFile([captured, entry({ requestId: "req-2", path: "/other" })]);
    expect(file.split("\n")).toHaveLength(2);
    expect(file.split("\n")[1]).toContain("/other");
  });

  it("writes a corpus case that names the verdict it is pinning", () => {
    const text = corpusCase(captured);
    expect(text).toContain('expect: { verdict: "confirmed-bot", certain: true }');
    expect(text).toContain('["user-agent", "curl/8.4.0"]');
  });
});

describe("formatting", () => {
  it("says how much window there is, rather than just saying window", () => {
    expect(windowLabel(0, undefined, 1_000_000)).toBe("this window · empty");
    expect(windowLabel(500, 1_000_000 - 240_000, 1_000_000)).toBe("last 500 requests · 4 min");
  });

  it("keeps small durations legible and large ones short", () => {
    expect(rangeLabel(45_000)).toBe("45s");
    expect(rangeLabel(300_000)).toBe("5 min");
    expect(rangeLabel(7_200_000)).toBe("2h");
    expect(uptime(30_000)).toBe("30s");
    expect(uptime(3_600_000)).toBe("60m");
  });

  it("does not divide by zero", () => {
    expect(pct(0, 0)).toBe("—");
    expect(pct(1, 4)).toBe("25%");
    expect(n(undefined)).toBe("0");
  });
});

/**
 * What somebody pasted into the request tester.
 *
 * Three shapes, because those are the three things a person has to hand when they want
 * to ask "why is this client being challenged?": a curl command out of devtools, a
 * header block out of a log, or a bare User-Agent out of a support ticket. Guessing
 * between them is safe — they are unambiguous — and asking somebody to pick would be
 * asking them to know.
 */
describe("reading a pasted request", () => {
  it("reads a curl command, flags and all", () => {
    const parsed = parseRequest(`curl 'https://shop.example/api/items?page=2' -X POST -H 'accept: application/json' -A 'python-requests/2.32.3' -b 'session=abc'`);
    expect(parsed.method).toBe("POST");
    expect(parsed.url).toBe("/api/items?page=2");
    expect(parsed.headers["user-agent"]).toBe("python-requests/2.32.3");
    expect(parsed.headers["accept"]).toBe("application/json");
    expect(parsed.headers["cookie"]).toBe("session=abc");
    // The URL carried a host, so nothing had to be invented for it.
    expect(parsed.headers["host"]).toBe("shop.example");
    expect(parsed.assumed).not.toContain("Host: test.invalid");
  });

  it("survives the line continuations devtools writes", () => {
    const parsed = parseRequest("curl 'https://shop.example/' \\\n  -H 'accept: */*' \\\n  -H 'user-agent: Mozilla/5.0'");
    expect(parsed.headers["accept"]).toBe("*/*");
    expect(parsed.headers["user-agent"]).toBe("Mozilla/5.0");
  });

  /** `header-order` reads the order a client sends its headers in, so the order is data. */
  it("keeps a header block in the order it was pasted", () => {
    const parsed = parseRequest(["GET /products HTTP/1.1", "Host: shop.example", "User-Agent: curl/8.4.0", "Accept: */*"].join("\n"));
    expect(parsed.method).toBe("GET");
    expect(parsed.url).toBe("/products");
    expect(Object.keys(parsed.headers)).toEqual(["host", "user-agent", "accept"]);
  });

  /**
   * The single most likely paste, and the one that used to break: `curl/8.4.0` is a
   * User-Agent, not a command. Reading it as a command produced a request with no
   * User-Agent at all and an assessment of "unknown" — the most misleading answer
   * available, because it looks like an answer.
   */
  it("knows a curl User-Agent from a curl command", () => {
    expect(parseRequest("curl/8.4.0").headers["user-agent"]).toBe("curl/8.4.0");
    expect(parseRequest("curl 'https://shop.example/' -A 'curl/8.4.0'").headers["user-agent"]).toBe("curl/8.4.0");
  });

  it("takes a bare User-Agent, which is what a support ticket contains", () => {
    const parsed = parseRequest("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    expect(parsed.headers["user-agent"]).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    expect(parsed.method).toBe("GET");
    expect(parsed.url).toBe("/");
  });

  /**
   * The tester says what it invented, every time. A tester that silently supplies a
   * client address is one whose answer about `ip-intelligence` cannot be trusted, and
   * the reader has no way to tell which run was which.
   */
  it("says what it had to invent", () => {
    const parsed = parseRequest("curl/8.4.0");
    expect(parsed.ip).toBe("203.0.113.1");
    expect(parsed.assumed).toContain("client address 203.0.113.1");
    expect(parsed.assumed).toContain("Host: test.invalid");
    expect(parsed.assumed).toContain("method GET");
  });

  it("prefers what the operator typed into the fields beside the box", () => {
    const parsed = parseRequest("curl/8.4.0", { ip: "198.51.100.9", url: "/checkout", method: "post" });
    expect(parsed.ip).toBe("198.51.100.9");
    expect(parsed.url).toBe("/checkout");
    expect(parsed.method).toBe("POST");
    expect(parsed.assumed).not.toContain("client address 203.0.113.1");
  });

  it("refuses an empty paste rather than assessing an empty request", () => {
    expect(() => parseRequest("   ")).toThrow(/Nothing to test/);
  });
});

/**
 * Clearing the feed, and what has to go with it.
 *
 * The "N not streamed" badge adds two counts: the rate cap's, which lives on the server
 * and is reset by `FeedRing.clear()`, and this connection's lagged drops, which live here.
 * Only one of them was being reset, so after a Reset — or after the replace-sync that
 * follows a dropped stream, which is the *likelier* of the two, since a viewer dropped for
 * lagging reconnects with a stale cursor — the badge went on reporting a gap in a feed
 * that no longer contained it, under a tooltip promising those entries were still in the
 * window.
 */
describe("clearing the feed", () => {
  it("drops the lag count along with the rows it described", () => {
    state.rows = [{ entry: { requestId: "a" } } as never];
    state.bufferedWhilePaused = 4;
    state.laggedDrops = 53;

    clearFeed();

    expect(state.rows).toEqual([]);
    expect(state.bufferedWhilePaused).toBe(0);
    // The badge's other half is reset on the server; this is the half that was not.
    expect(state.laggedDrops).toBe(0);
  });
});
