import { describe, expect, it } from "vitest";
import { BotHandler, ConfigError, createFacts, fetchAddressList, fetchCrawlerRanges, refreshCrawlerRanges } from "../src/index.js";
import { failingResolver, makeFacts } from "./helpers.js";

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
