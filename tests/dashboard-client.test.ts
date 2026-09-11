import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/dashboard/parse-request.js";
import { corpusCase, replayFile, replayLine } from "../src/dashboard/client/replay.js";
import { draftRule } from "../src/dashboard/client/draft.js";
import { FIELD_NAMES, OPERATORS, matches as matchesFilterExpression, matchesFilter, parseFilter, searchableText, suggestFor } from "../src/dashboard/client/query.js";
import { actionKind, outcome, provenBots, verdictBadge } from "../src/dashboard/client/outcome.js";
import { clearFeed, feedPage, goToFeedPage, ingest, matches, resetPaging, setSearch, setTimeframe, sortRows, state } from "../src/dashboard/client/store.js";
import { clockDate, clockStamp, clockTime, n, pct, rangeLabel, uptime, windowLabel } from "../src/dashboard/client/format.js";
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
    const filter = parseFilter(query);
    return rows.filter((row) => matchesFilterExpression(filter, row, searchableText(row))).map((row) => row.requestId);
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
    expect(parseFilter('"GET /api/v2"')).toEqual({ kind: "term", term: { field: undefined, value: "get /api/v2", negated: false } });
  });

  /** A path can contain a colon, and so can a User-Agent. Only known names make a field. */
  it("treats an unknown prefix as an ordinary word", () => {
    expect(parseFilter("weird:thing")).toEqual({ kind: "term", term: { field: undefined, value: "weird:thing", negated: false } });
  });

  /**
   * The operators. `$or` is the reason the parser produces a tree at all: a flat list of
   * terms cannot express it, which the previous version communicated by silently
   * ignoring the word.
   */
  it("ors two terms together", () => {
    expect(search("path:/health $or path:/api/items").sort()).toEqual(["a", "b"]);
  });

  it("binds $and tighter than $or, the conventional way round", () => {
    // Reads as `curl $or (path:/health $and score:<50)`. Grouped the other way it would
    // be empty, because nothing here is both curl and /health.
    expect(search("curl $or path:/health $and score:<50").sort()).toEqual(["a", "b"]);
  });

  it("takes brackets when that is not what you meant", () => {
    expect(search("(curl $or path:/health) $and score:<50")).toEqual(["b"]);
  });

  it("spells negation as $not as well as a dash", () => {
    expect(search("$not curl").sort()).toEqual(["b", "c"]);
    expect(search("actor:203.0.113.4 $not path:/health")).toEqual(["a"]);
    expect(search("$not (curl $or path:/health)")).toEqual(["c"]);
  });

  it("reads $and as the juxtaposition it already was", () => {
    expect(search("actor:203.0.113.4 $and path:/health")).toEqual(search("actor:203.0.113.4 path:/health"));
  });

  it("matches a set with $in and refuses one with $notin", () => {
    expect(search("path:$in(/health, /api/items)").sort()).toEqual(["a", "b"]);
    expect(search("path:$notin(/health)").sort()).toEqual(["a", "c"]);
    // Spacing inside the brackets is somebody's habit, not a syntax.
    expect(search("path:$in(/health,/api/items)").sort()).toEqual(["a", "b"]);
  });

  /**
   * Quotes of every kind a person actually types.
   *
   * Only straight double quotes used to work, because the tokenizer happened to know
   * them. Anything else was taken as a literal character — so a filter pasted from chat
   * or documentation, where smart punctuation turns `"` into `“ ”`, asked for an actor
   * whose key began with a curly quote. None does, so `$notin` excluded nothing and `$in`
   * matched nothing, and there was no sign either had gone wrong.
   */
  it("reads every kind of quote as a quote", () => {
    for (const quoted of ['"203.0.113.4"', "'203.0.113.4'", "\u201c203.0.113.4\u201d", "\u2018203.0.113.4\u2019"]) {
      expect(search(`actor:$notin(${quoted})`), `$notin(${quoted})`).toEqual(["c"]);
      expect(search(`actor:$in(${quoted})`).sort(), `$in(${quoted})`).toEqual(["a", "b"]);
      expect(search(`actor:${quoted}`).sort(), `actor:${quoted}`).toEqual(["a", "b"]);
    }
  });

  /** A comma is a separator only outside quotes — which is what quoting a value is for. */
  it("keeps a comma inside a quoted set value", () => {
    expect(parseFilter('actor:$in("a,b", c)')).toMatchObject({ term: { values: ["a,b", "c"] } });
    expect(parseFilter("actor:$in('a,b', c)")).toMatchObject({ term: { values: ["a,b", "c"] } });
  });

  /**
   * An apostrophe is not a quote.
   *
   * A single quote opens a phrase only where a value begins. In the middle of a word it is
   * the apostrophe in `don't` or `o'reilly`, and treating it as the start of a phrase would
   * swallow everything typed after it.
   */
  it("leaves an apostrophe in the middle of a word alone", () => {
    expect(parseFilter("don't")).toEqual({ kind: "term", term: { field: undefined, value: "don't", negated: false } });
    expect(parseFilter("path:/o'reilly curl")).toMatchObject({ kind: "and" });
  });

  /**
   * An address is an identifier, not text.
   *
   * Matched as a substring, `actor:1.2.3.4` also caught `1.2.3.40` to `1.2.3.49` and
   * `11.2.3.4` — so excluding one client removed several, and including one let in its
   * neighbours. It matches a whole component at a time now, which still leaves a network
   * prefix and an address's tail findable.
   */
  it("matches an actor a component at a time, not a digit at a time", () => {
    const neighbours = [
      entry({ requestId: "exact", actor: "1.2.3.4" }),
      entry({ requestId: "longer", actor: "1.2.3.45" }),
      entry({ requestId: "wider", actor: "11.2.3.4" }),
      entry({ requestId: "network", actor: "1.2.3.0/24" }),
    ];
    const pick = (query: string): string[] =>
      neighbours.filter((row) => matchesFilterExpression(parseFilter(query), row, searchableText(row))).map((row) => row.requestId);

    expect(pick("actor:1.2.3.4")).toEqual(["exact"]);
    expect(pick("actor:$in(1.2.3.4)")).toEqual(["exact"]);
    expect(pick("actor:$notin(1.2.3.4)")).toEqual(["longer", "wider", "network"]);
    // A prefix that stops on a separator is a network, and still finds all of it.
    expect(pick("actor:1.2.3").sort()).toEqual(["exact", "longer", "network"]);
    // And an address can still be found by its tail.
    expect(pick("actor:3.45")).toEqual(["longer"]);
  });

  /**
   * A named actor answers to its name.
   *
   * The name is passed in rather than read off the entry, because it is given after the
   * fact: to requests already in the feed, which is what makes filtering by it
   * retroactive rather than only working for what arrives next.
   */
  it("finds an actor by the name it was given, as well as by its key", () => {
    const named = (query: string): string[] =>
      rows
        .filter((row) => matchesFilterExpression(parseFilter(query), row, searchableText(row), row.actor === "203.0.113.4" ? "the noisy one" : undefined))
        .map((row) => row.requestId);
    expect(named("actor:noisy").sort()).toEqual(["a", "b"]);
    expect(named('actor:$notin("the noisy one")')).toEqual(["c"]);
    expect(named("noisy").sort(), "and a free word finds it too").toEqual(["a", "b"]);
    // The key still works after the name is given.
    expect(named("actor:203.0.113.4").sort()).toEqual(["a", "b"]);
  });

  it("matches nothing for an empty set rather than everything", () => {
    // Half-typed input is the normal state of a live search box, and a filter that
    // widens while somebody is still typing it is a filter that lies.
    expect(search("path:$in()")).toEqual([]);
  });

  /**
   * Every one of these is a query somebody is in the middle of typing. None may throw,
   * and none may match a set the typed part does not describe.
   */
  it("survives half-written input", () => {
    for (const half of ["$", "$n", "$not", "$or", "(", "(curl", "curl $or", "path:$in(", "path:$in(/health", ")", "((a)", "$and $and", "-", '"']) {
      expect(() => search(half), half).not.toThrow();
    }
    expect(search("$not")).toEqual(["a", "b", "c"]);
    expect(search("curl $or")).toEqual(["a"]);
    expect(search("(curl")).toEqual(["a"]);
  });

  /**
   * The parser is recursive descent over input somebody can paste, and it runs on every
   * keystroke *and* on load, because the query lives in the URL. Five thousand nested
   * brackets overflowed the stack and threw a `RangeError` out of `setSearch` — which
   * from a shared link breaks the dashboard for whoever opens it, and contradicts the
   * promise written above this function that nothing here throws.
   */
  it("survives brackets nested past any reasonable depth", () => {
    for (const depth of [32, 5_000, 200_000]) {
      const nested = `${"(".repeat(depth)}curl${")".repeat(depth)}`;
      expect(() => search(nested), `depth ${depth}`).not.toThrow();
    }
    // And ordinary grouping is untouched by the cap.
    expect(search("(curl $or path:/health)").sort()).toEqual(["a", "b"]);
    expect(search("(path:/nope $or path:/health)")).toEqual(["b"]);
  });

  it("does not turn an ordinary word into an operator", () => {
    // The reason the operators carry a `$`. "or" and "not" appear in User-Agents and
    // paths, and a language where a search word silently becomes an operator lies about
    // what it matched.
    expect(OPERATORS.every((name) => name.startsWith("$"))).toBe(true);
    // "or" is a substring of "header-order", and it stays a search word: the row that
    // mentions it matches, and the two either side of it are not or-ed together.
    expect(search("or")).toEqual(["c"]);
    expect(search("path:/health or path:/api/items")).toEqual([]);
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

/**
 * The counter tile that said the opposite of the truth.
 *
 * `metrics.proven` counts assessments resting on proven evidence, and evidence has a
 * direction — an operator or interaction clearance is *certain human* evidence. The tile
 * showed that number under the words "Proven bots", so a dashboard watching a logged-in
 * audience reported "23, 100% of traffic" while every one of those verdicts was `human`,
 * and counted the same requests again under Unremarkable.
 */
describe("counting proven bots", () => {
  it("counts the two verdicts only the proven path can reach", () => {
    expect(provenBots({ "confirmed-bot": 3, "verified-bot": 2, "suspected-bot": 9, human: 40, unknown: 7 })).toBe(5);
  });

  it("does not count a proven human", () => {
    // The reported case: every request a cleared human, every verdict `human`, and the
    // tile reading 100%.
    expect(provenBots({ "confirmed-bot": 0, "verified-bot": 0, "suspected-bot": 0, human: 23, unknown: 0 })).toBe(0);
  });

  it("does not count suspicion, however strong", () => {
    // `suspected-bot` is the probabilistic path's verdict and never proven — that
    // separation is the whole point of the evidence tiers.
    expect(provenBots({ "suspected-bot": 100, human: 0, unknown: 0 })).toBe(0);
  });

  it("survives a snapshot missing a key", () => {
    expect(provenBots({})).toBe(0);
  });
});

/**
 * Paging the feed.
 *
 * The list is newest-first and it grows at the newest end, so a reader on page three is
 * standing on ground that moves: one arriving request pushes every row down by one, and
 * they are quietly reading different rows than the ones they were looking at. Page zero
 * follows the feed; every other page reads the list as it was when they left page zero.
 */
describe("paging the feed", () => {
  const fill = (count: number): void => {
    clearFeed();
    state.rows = [];
    state.byId = new Map();
    for (let i = 0; i < count; i++) {
      ingest(entry({ requestId: `r${i}`, at: 1_700_000_000_000 + i }));
    }
  };

  it("cuts the newest-first list into pages", () => {
    fill(120);
    resetPaging();
    const first = feedPage(50);
    expect(first.total).toBe(120);
    expect(first.pages).toBe(3);
    expect(first.rows).toHaveLength(50);
    // Newest first: the last ingested is the top row.
    expect(first.rows[0]?.entry.requestId).toBe("r119");

    goToFeedPage(1);
    const second = feedPage(50);
    expect(second.page).toBe(1);
    expect(second.rows[0]?.entry.requestId).toBe("r69");

    goToFeedPage(2);
    const last = feedPage(50);
    expect(last.rows).toHaveLength(20);
    expect(last.rows[19]?.entry.requestId).toBe("r0");
  });

  it("holds a page still while the feed grows under it", () => {
    fill(120);
    resetPaging();
    goToFeedPage(1);
    const before = feedPage(50).rows.map((row) => row.entry.requestId);

    for (let i = 0; i < 10; i++) ingest(entry({ requestId: `late${i}`, at: 1_700_000_001_000 + i }));

    expect(feedPage(50).rows.map((row) => row.entry.requestId)).toEqual(before);
    // And the new ones are there the moment the reader comes back to the front.
    goToFeedPage(0);
    const live = feedPage(50);
    expect(live.total).toBe(130);
    expect(live.rows[0]?.entry.requestId).toBe("late9");
  });

  it("does not strand a reader past the end when the list shrinks", () => {
    fill(120);
    resetPaging();
    goToFeedPage(2);
    expect(feedPage(50).page).toBe(2);
    // Whatever they were reading is gone — a reset, or a filter that now matches less.
    fill(10);
    const clamped = feedPage(50);
    expect(clamped.page).toBe(0);
    expect(clamped.rows).toHaveLength(10);
  });

  it("puts a merged backlog back in time order", () => {
    // What the catch-up fetch does: `ingest` appends, and an entry fetched over HTTP is
    // older than what is already held, so without the sort it would sit at the newest end.
    fill(3);
    ingest(entry({ requestId: "older", at: 1_699_000_000_000 }));
    expect(state.rows[state.rows.length - 1]?.entry.requestId).toBe("older");
    sortRows();
    expect(state.rows[0]?.entry.requestId).toBe("older");
    resetPaging();
    expect(feedPage(50).rows[0]?.entry.requestId).toBe("r2");
  });
});

/**
 * One clock, one calendar, everywhere.
 *
 * These were `toLocaleTimeString`, which answers in whatever the reader's locale prefers —
 * so the same feed read "4:40:46 PM" on one operator's screen and "16:40:46" on the next,
 * and two people looking at one dashboard together saw it disagree with itself.
 */
describe("how the dashboard writes times and dates", () => {
  // A fixed local wall-clock instant: the components are what the reader sees, so the
  // expectations are built the same way rather than from a UTC string that would move
  // with the machine's zone.
  const at = new Date(2026, 1, 3, 9, 4, 5).getTime();
  const evening = new Date(2026, 10, 28, 16, 40, 46).getTime();

  it("writes the time as 24-hour, zero-padded", () => {
    expect(clockTime(at)).toBe("09:04:05");
    // The case that gave the format away: an afternoon, which used to read "4:40:46 PM".
    expect(clockTime(evening)).toBe("16:40:46");
  });

  it("writes the date as dd-mm-yyyy", () => {
    expect(clockDate(at)).toBe("03-02-2026");
    expect(clockDate(evening)).toBe("28-11-2026");
  });

  it("puts both together where a bare time would mislead", () => {
    // "first seen 09:04:05" invites the reader to assume it was this morning.
    expect(clockStamp(at)).toBe("03-02-2026 09:04:05");
  });

  it("never says AM or PM", () => {
    for (let hour = 0; hour < 24; hour++) {
      const stamp = clockTime(new Date(2026, 5, 15, hour, 30, 0).getTime());
      expect(stamp).not.toMatch(/[ap]m/i);
      expect(stamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});

/**
 * Completing a filter as it is typed.
 *
 * The options come from the parser's own field map rather than a list kept beside it, so
 * a field added to the language is offered the day it exists — and one that never existed
 * is never offered, which is the failure that would teach somebody a syntax the parser
 * does not have.
 */
describe("suggesting filter terms", () => {
  it("completes a field name from what has been typed", () => {
    const { options } = suggestFor("ver", 3);
    expect(options).toEqual(["verdict:"]);
  });

  it("completes the values of a field whose set is closed", () => {
    const { options } = suggestFor("verdict:con", 11);
    expect(options).toEqual(["verdict:confirmed-bot"]);
  });

  it("offers nothing for a field that takes anything", () => {
    // `rule`, `identity` and `path` are open sets. Guessing there would be inventing
    // options rather than completing them.
    expect(suggestFor("rule:no-", 8).options).toEqual([]);
    expect(suggestFor("path:/ap", 8).options).toEqual([]);
  });

  it("keeps a negation on the front of what it completes", () => {
    expect(suggestFor("-verd", 5).options).toEqual(["-verdict:"]);
    expect(suggestFor("-verdict:hum", 12).options).toEqual(["-verdict:human"]);
  });

  it("completes only the token the caret is in", () => {
    const input = "actor:203.0.113.4 ver";
    const { options, from, to } = suggestFor(input, input.length);
    expect(options).toEqual(["verdict:"]);
    // The replacement covers `ver` and nothing before it.
    expect(input.slice(from, to)).toBe("ver");
  });

  it("only offers names the parser actually accepts", () => {
    for (const name of FIELD_NAMES) expect(suggestFor(name.slice(0, 2), 2).options.length).toBeGreaterThan(0);
  });
});

/**
 * Traffic somebody never wants to see, and the window they are looking at.
 *
 * Both narrow what `matches` accepts, so both apply to the feed, the counts and the export
 * together — "hidden" has to mean the same thing everywhere or the export quietly disagrees
 * with the screen.
 */
describe("exclusions and the timeframe", () => {
  const at = 1_700_000_000_000;
  const rows = (): void => {
    clearFeed();
    state.rows = [];
    state.byId = new Map();
    // Reset the narrowing too. A failing assertion leaves whatever it set behind, and a
    // leaked filter fails the *next* test with a message about the wrong thing.
    setSearch("");
    setTimeframe(undefined, undefined);
    ingest(entry({ requestId: "a", at, path: "/health" }));
    ingest(entry({ requestId: "b", at: at + 60_000, path: "/products" }));
    ingest(entry({ requestId: "c", at: at + 120_000, path: "/health" }));
    ingest(entry({ requestId: "d", at: at + 180_000, path: "/checkout" }));
  };

  it("hides everything $not matches", () => {
    // What the Exclude button used to do, said in the query language instead. One
    // mechanism rather than two, and it is in the URL like every other narrowing.
    rows();
    setSearch("$not path:/health");
    expect(state.rows.filter(matches).map((row) => row.entry.requestId)).toEqual(["b", "d"]);
    setSearch("");
    expect(state.rows.filter(matches)).toHaveLength(4);
  });

  it("hides two things with a set", () => {
    // The old exclusion list treated its entries as "either", which is what a set does.
    rows();
    setSearch("path:$notin(/health, /checkout)");
    expect(state.rows.filter(matches).map((row) => row.entry.requestId)).toEqual(["b"]);
    setSearch("");
  });

  it("answers all three questions people ask about a window", () => {
    rows();
    setTimeframe(at + 120_000, undefined);
    expect(state.rows.filter(matches).map((row) => row.entry.requestId)).toEqual(["c", "d"]);

    setTimeframe(undefined, at + 60_000);
    expect(state.rows.filter(matches).map((row) => row.entry.requestId)).toEqual(["a", "b"]);

    setTimeframe(at + 60_000, at + 120_000);
    expect(state.rows.filter(matches).map((row) => row.entry.requestId)).toEqual(["b", "c"]);

    setTimeframe(undefined, undefined);
    expect(state.rows.filter(matches)).toHaveLength(4);
  });

  it("selects nothing when the window runs backwards, rather than everything", () => {
    rows();
    setTimeframe(at + 180_000, at);
    expect(state.rows.filter(matches)).toHaveLength(0);
    setTimeframe(undefined, undefined);
  });
});
