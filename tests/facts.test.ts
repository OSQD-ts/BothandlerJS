import { describe, expect, it } from "vitest";
import { createFacts } from "../src/facts.js";
import { resolveClientIp } from "../src/config.js";
import { IpRangeSet } from "../src/internal/ip.js";
import { parseCookies, serializeCookie } from "../src/internal/http.js";
import { TtlLru } from "../src/internal/lru.js";
import { ManualClock } from "../src/internal/clock.js";
import { MultiPatternMatcher } from "../src/internal/matcher.js";

describe("createFacts", () => {
  const base = { headers: { Host: "example.test" }, ip: "203.0.113.1" };

  it("lowercases header names and joins repeated values", () => {
    const facts = createFacts({ ...base, headers: { "User-Agent": "curl/8", "X-Multi": ["a", "b"] } });
    expect(facts.headers["user-agent"]).toBe("curl/8");
    expect(facts.headers["x-multi"]).toBe("a, b");
  });

  // A rule scoped to a path prefix is worth nothing if the same resource can be
  // reached by spelling the path differently.
  it.each([
    ["/admin", "/admin"],
    ["/%61dmin", "/admin"],
    ["/./admin", "/admin"],
    ["/public/../admin", "/admin"],
    ["//admin//", "/admin"],
    ["/admin/", "/admin"],
    ["\\admin", "/admin"],
  ])("normalises %s to %s", (input, expected) => {
    expect(createFacts({ ...base, url: input }).path).toBe(expected);
  });

  it("decodes only once, so %2525 does not become a percent sign", () => {
    expect(createFacts({ ...base, url: "/a%2525b" }).path).toBe("/a%25b");
  });

  it("keeps a malformed percent escape rather than inventing a decoding", () => {
    expect(createFacts({ ...base, url: "/a%zzb" }).path).toBe("/a%zzb");
  });

  it("exposes a __proto__ query parameter as an own key", () => {
    const facts = createFacts({ ...base, url: "/?__proto__=polluted" });
    expect(Object.prototype.hasOwnProperty.call(facts.query, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("reads header order from Node's alternating rawHeaders array", () => {
    const facts = createFacts({ ...base, rawHeaders: ["Host", "example.test", "User-Agent", "curl/8"] });
    expect(facts.headerOrder).toEqual(["host", "user-agent"]);
  });

  it("accepts a plain list of header names too", () => {
    expect(createFacts({ ...base, rawHeaders: ["Host", "User-Agent", "Accept"] }).headerOrder).toEqual(["host", "user-agent", "accept"]);
  });

  it("bounds the URL, the query and the header order", () => {
    const facts = createFacts({
      ...base,
      url: `/?${Array.from({ length: 500 }, (_, index) => `k${index}=v`).join("&")}`,
      rawHeaders: Array.from({ length: 500 }, (_, index) => `h${index}`),
    });
    expect(Object.keys(facts.query).length).toBeLessThanOrEqual(64);
    expect(facts.headerOrder.length).toBeLessThanOrEqual(64);
  });
});

describe("resolveClientIp", () => {
  const off = { trustProxy: false, hops: 1, header: "x-forwarded-for", trustedProxies: undefined };

  it("ignores the forwarded header entirely when proxies are not trusted", () => {
    expect(resolveClientIp("198.51.100.7", { "x-forwarded-for": "1.2.3.4" }, off)).toBe("198.51.100.7");
  });

  // The whole point of the hop count: a client that prepends its own entry must not
  // get to choose the address it is tracked under.
  it("is not fooled by a client-prepended entry", () => {
    const proxy = { ...off, trustProxy: true, hops: 1 };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.9" }, proxy)).toBe("203.0.113.9");
  });

  it("walks past every trusted proxy and stops at the first address that is not ours", () => {
    const proxy = { ...off, trustProxy: true, trustedProxies: new IpRangeSet(["10.0.0.0/8"]) };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.9, 10.0.0.5, 10.0.0.6" }, proxy)).toBe("203.0.113.9");
  });

  it("falls back to the socket address when the whole chain is our own infrastructure", () => {
    const proxy = { ...off, trustProxy: true, trustedProxies: new IpRangeSet(["10.0.0.0/8"]) };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "10.0.0.5, 10.0.0.6" }, proxy)).toBe("10.0.0.1");
  });

  it("discards junk entries in the chain", () => {
    const proxy = { ...off, trustProxy: true, hops: 1 };
    expect(resolveClientIp("10.0.0.1", { "x-forwarded-for": "not-an-ip, <script>, 203.0.113.9" }, proxy)).toBe("203.0.113.9");
  });

  it("normalises the address it returns", () => {
    expect(resolveClientIp("::ffff:203.0.113.9", {}, off)).toBe("203.0.113.9");
  });

  /**
   * The peer is the first hop, and it is checked like every other one.
   *
   * This is the case where a forwarded header is not evidence of anything: the
   * request never went through the proxies it claims to have come through, so
   * believing it would let a caller who can reach this server directly choose the
   * address every per-actor mechanism here keys on.
   */
  describe("when the connecting peer is not one of our proxies", () => {
    const proxy = { ...off, trustProxy: true, trustedProxies: new IpRangeSet(["10.0.0.0/8"]) };

    it("ignores the forwarded header and uses the socket address", () => {
      expect(resolveClientIp("203.0.113.9", { "x-forwarded-for": "8.8.8.8" }, proxy)).toBe("203.0.113.9");
    });

    it("cannot be talked round with a chain of plausible-looking hops", () => {
      expect(resolveClientIp("203.0.113.9", { "x-forwarded-for": "8.8.8.8, 10.0.0.5, 10.0.0.6" }, proxy)).toBe("203.0.113.9");
    });

    it("still reads the header for a peer that is one of ours", () => {
      expect(resolveClientIp("10.0.0.5", { "x-forwarded-for": "8.8.8.8" }, proxy)).toBe("8.8.8.8");
    });

    /** No socket address at all — a replayed log line — leaves the header as the only thing there is. */
    it("keeps working on a request that has no peer", () => {
      expect(resolveClientIp(undefined, { "x-forwarded-for": "8.8.8.8" }, proxy)).toBe("8.8.8.8");
    });
  });
});

describe("cookies", () => {
  it("parses into a null-prototype bag", () => {
    const cookies = parseCookies("a=1; b=hello%20world; __proto__=x");
    expect(cookies["b"]).toBe("hello world");
    expect(Object.getPrototypeOf(cookies)).toBeNull();
  });

  it("survives malformed input", () => {
    expect(() => parseCookies("=; ;; a; b=%E0%A4%A")).not.toThrow();
  });

  it("rejects names and domains that could inject attributes", () => {
    expect(() => serializeCookie("bad name", "v")).toThrow();
    expect(() => serializeCookie("ok", "v", { domain: "evil.example; Path=/" })).toThrow();
    expect(() => serializeCookie("ok", "v", { sameSite: "None", secure: false })).toThrow(/Secure/);
  });

  it("percent-encodes the value", () => {
    expect(serializeCookie("t", "a; Path=/evil")).toContain("t=a%3B%20Path%3D%2Fevil");
  });
});

describe("TtlLru", () => {
  it("expires entries and enforces its capacity", () => {
    const clock = new ManualClock(0);
    const lru = new TtlLru<number>(2, 100, clock);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.size).toBeLessThanOrEqual(2);
    expect(lru.get("a")).toBeUndefined();
    clock.advance(200);
    expect(lru.get("c")).toBeUndefined();
  });

  it("evicts the least recently used, never the one still being touched", () => {
    const lru = new TtlLru<number>(2, 10_000, new ManualClock(0));
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });
});

describe("MultiPatternMatcher", () => {
  it("finds every pattern in one pass, including overlaps", () => {
    const matcher = new MultiPatternMatcher([
      ["bot", "A"],
      ["robot", "B"],
      ["curl/", "C"],
    ]);
    expect(new Set(matcher.matchAll("mozilla robot and curl/8"))).toEqual(new Set(["A", "B", "C"]));
    expect(matcher.has("nothing here")).toBe(false);
  });

  it("handles an empty pattern set", () => {
    const matcher = new MultiPatternMatcher<string>([]);
    expect(matcher.matchAll("anything")).toEqual([]);
    expect(matcher.matchFirst("anything")).toBeUndefined();
  });
});
