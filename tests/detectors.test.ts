import { describe, expect, it } from "vitest";
import { acceptSignatureDetector } from "../src/detectors/accept-signature.js";
import { cadenceDetector } from "../src/detectors/cadence.js";
import { crawlBreadthDetector } from "../src/detectors/crawl-breadth.js";
import { clientHintsDetector } from "../src/detectors/client-hints.js";
import { crawlerVerificationDetector } from "../src/detectors/crawler-verification.js";
import { fetchMetadataDetector } from "../src/detectors/fetch-metadata.js";
import { headerIntegrityDetector } from "../src/detectors/header-integrity.js";
import { headerOrderDetector } from "../src/detectors/header-order.js";
import { ipIntelligenceDetector } from "../src/detectors/ip-intelligence.js";
import { identityRotationDetector } from "../src/detectors/identity-rotation.js";
import { rateAnomalyDetector } from "../src/detectors/rate-anomaly.js";
import { selfIdentifiedDetector } from "../src/detectors/self-identified.js";
import { TRAP_FIELD_SOURCE, trapDetector } from "../src/detectors/trap.js";
import { MAX_TRACKED_ARRIVALS, MAX_TRACKED_PATHS, MAX_TRACKED_USER_AGENTS } from "../src/state.js";
import { ActorState } from "../src/state.js";
import { CHROME_HEADERS, collect, fakeResolver, failingResolver, makeContext, makeFacts } from "./helpers.js";

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

describe("a real browser request", () => {
  // The single most important test in the suite. Everything else measures how well
  // we catch bots; this measures whether we leave people alone.
  it("produces no bot evidence from any default detector", async () => {
    const context = makeContext();
    const detectors = [
      selfIdentifiedDetector(),
      headerIntegrityDetector(),
      clientHintsDetector(),
      fetchMetadataDetector(),
      acceptSignatureDetector(),
      headerOrderDetector(),
      rateAnomalyDetector(),
      cadenceDetector(),
      trapDetector(),
      ipIntelligenceDetector(),
    ];
    for (const detector of detectors) {
      const evidence = await collect(detector, context);
      const bot = evidence.filter((item) => item.direction === "bot");
      expect(bot, `${detector.id} fired on a genuine Chrome request: ${JSON.stringify(bot)}`).toHaveLength(0);
    }
  });
});

describe("selfIdentifiedDetector", () => {
  it("treats a library user agent as proven", async () => {
    const [evidence] = await collect(selfIdentifiedDetector(), makeContext({ headers: { "user-agent": "curl/8.4.0" } }));
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.botClass).toBe("http-client");
    expect(evidence?.deterministicBasis).toBeTruthy();
  });

  it("recognises a declared crawler", async () => {
    const evidence = await collect(selfIdentifiedDetector(), makeContext({ headers: { "user-agent": GOOGLEBOT_UA } }));
    expect(evidence[0]?.identity).toBe("googlebot");
    expect(evidence[0]?.certainty).toBe("certain");
  });

  it("accepts an unknown crawler that publishes a contact address", async () => {
    const [evidence] = await collect(
      selfIdentifiedDetector(),
      makeContext({ headers: { "user-agent": "Mozilla/5.0 (compatible; BrandNewBot/1.0; +https://example.com/bot)" } }),
    );
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.botClass).toBe("declared-bot");
  });

  it("holds back from certainty when a crawler-like word has no contact address", async () => {
    const [evidence] = await collect(selfIdentifiedDetector(), makeContext({ headers: { "user-agent": "Mozilla/5.0 (compatible; Some Spider 1.0)" } }));
    expect(evidence?.certainty).toBe("strong");
    expect(evidence?.botClass).toBe("declared-bot");
  });

  it("flags an unrecognised bare client token, without claiming to know what it is", async () => {
    const [evidence] = await collect(selfIdentifiedDetector(), makeContext({ headers: { "user-agent": "AcmeInternalSync/2.3" } }));
    expect(evidence?.certainty).toBe("strong");
    expect(evidence?.botClass).toBe("http-client");
  });

  it("treats a missing User-Agent as merely suggestive", async () => {
    const [evidence] = await collect(selfIdentifiedDetector(), makeContext({ headers: { host: "example.test" } }));
    expect(evidence?.certainty).toBe("moderate");
  });
});

describe("crawlerVerificationDetector", () => {
  const googlebotContext = (resolver: ReturnType<typeof failingResolver>) =>
    makeContext({ headers: { "user-agent": GOOGLEBOT_UA }, ip: "66.249.66.1", resolver });

  it("confirms a crawler when forward-confirmed reverse DNS agrees", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"] }, { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] });
    const [evidence] = await collect(crawlerVerificationDetector(), googlebotContext(resolver));
    expect(evidence?.botClass).toBe("verified-bot");
    expect(evidence?.certainty).toBe("certain");
  });

  it("calls out a forgery when the PTR record points elsewhere", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["vps-1234.cheap-hosting.example"] }, {});
    const [evidence] = await collect(crawlerVerificationDetector(), googlebotContext(resolver));
    expect(evidence?.botClass).toBe("impersonator");
    expect(evidence?.certainty).toBe("certain");
  });

  it("calls out a forgery when the PTR name does not resolve back to the client", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["crawl.googlebot.com"] }, { "crawl.googlebot.com": ["8.8.8.8"] });
    const [evidence] = await collect(crawlerVerificationDetector(), googlebotContext(resolver));
    expect(evidence?.botClass).toBe("impersonator");
  });

  it("is not fooled by a PTR name that merely contains the domain", async () => {
    const resolver = fakeResolver({ "66.249.66.1": ["googlebot.com.evil.example"] }, { "googlebot.com.evil.example": ["66.249.66.1"] });
    const [evidence] = await collect(crawlerVerificationDetector(), googlebotContext(resolver));
    expect(evidence?.botClass).toBe("impersonator");
  });

  // Silence on failure is the property that keeps a resolver outage from turning
  // into an accusation against every crawler on the internet.
  it("says nothing at all when DNS gives no answer", async () => {
    const evidence = await collect(crawlerVerificationDetector(), googlebotContext(failingResolver()));
    expect(evidence).toHaveLength(0);
  });

  it("confirms an ip-ranges crawler only when ranges are configured", async () => {
    const withoutRanges = makeContext({ headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" }, ip: "198.51.100.5" });
    expect(await collect(crawlerVerificationDetector(), withoutRanges)).toHaveLength(0);

    const inside = makeContext({
      headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" },
      ip: "198.51.100.5",
      ranges: { "crawler:gptbot": ["198.51.100.0/24"] },
    });
    expect((await collect(crawlerVerificationDetector(), inside))[0]?.botClass).toBe("verified-bot");

    const outside = makeContext({
      headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" },
      ip: "203.0.113.5",
      ranges: { "crawler:gptbot": ["198.51.100.0/24"] },
    });
    expect((await collect(crawlerVerificationDetector(), outside))[0]?.botClass).toBe("impersonator");
  });
});

describe("headerIntegrityDetector", () => {
  it("treats a connection header on HTTP/2 as a protocol violation", async () => {
    const [evidence] = await collect(
      headerIntegrityDetector(),
      makeContext({ headers: { ...CHROME_HEADERS, connection: "keep-alive" }, httpVersion: "2.0" }),
    );
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.summary).toMatch(/connection-specific/);
  });

  it("flags a browser claim with no Accept header, but only as strong", async () => {
    const headers = { ...CHROME_HEADERS };
    delete headers["accept"];
    const [evidence] = await collect(headerIntegrityDetector(), makeContext({ headers }));
    expect(evidence?.certainty).toBe("strong");
  });

  it("keeps a missing Accept-Language at moderate, because privacy tooling strips it", async () => {
    const headers = { ...CHROME_HEADERS };
    delete headers["accept-language"];
    const [evidence] = await collect(headerIntegrityDetector(), makeContext({ headers }));
    expect(evidence?.certainty).toBe("moderate");
  });
});

describe("clientHintsDetector", () => {
  it("catches a platform hint that contradicts the User-Agent", async () => {
    const [evidence] = await collect(
      clientHintsDetector(),
      makeContext({ headers: { ...CHROME_HEADERS, "sec-ch-ua-platform": '"Windows"' } }),
    );
    expect(evidence?.summary).toMatch(/Platform/);
    expect(evidence?.certainty).toBe("strong");
  });

  it("does not treat the GREASE brand as a version disagreement", async () => {
    const evidence = await collect(clientHintsDetector(), makeContext());
    expect(evidence).toHaveLength(0);
  });

  it("treats a self-declared headless brand as proven", async () => {
    const [evidence] = await collect(
      clientHintsDetector(),
      makeContext({ headers: { ...CHROME_HEADERS, "sec-ch-ua": '"HeadlessChrome";v="122", "Chromium";v="122"' } }),
    );
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.botClass).toBe("automation");
  });

  it("notices Chromium over HTTPS sending no hints at all", async () => {
    const headers = { ...CHROME_HEADERS };
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    const [evidence] = await collect(clientHintsDetector(), makeContext({ headers }));
    expect(evidence?.certainty).toBe("strong");
  });
});

describe("fetchMetadataDetector", () => {
  it("rejects an incoherent dest/mode pairing", async () => {
    const [evidence] = await collect(
      fetchMetadataDetector(),
      makeContext({ headers: { ...CHROME_HEADERS, "sec-fetch-mode": "no-cors" } }),
    );
    expect(evidence?.summary).toMatch(/Incoherent/);
  });

  it("stays quiet for a client that plausibly predates the headers", async () => {
    const headers: Record<string, string> = { ...CHROME_HEADERS, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" };
    delete headers["sec-fetch-site"];
    delete headers["sec-fetch-mode"];
    delete headers["sec-fetch-user"];
    delete headers["sec-fetch-dest"];
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    expect(await collect(fetchMetadataDetector(), makeContext({ headers }))).toHaveLength(0);
  });
});

describe("acceptSignatureDetector", () => {
  it("flags a navigation that accepts anything", async () => {
    const [evidence] = await collect(acceptSignatureDetector(), makeContext({ headers: { ...CHROME_HEADERS, accept: "*/*" } }));
    expect(evidence?.certainty).toBe("strong");
  });

  it("flags an Accept-Language that is not valid grammar", async () => {
    const [evidence] = await collect(acceptSignatureDetector(), makeContext({ headers: { ...CHROME_HEADERS, "accept-language": "en_US;;q=zzz" } }));
    expect(evidence?.summary).toMatch(/language-range/);
  });
});

describe("headerOrderDetector", () => {
  it("catches the python-requests ordering", async () => {
    const headers = { ...CHROME_HEADERS };
    const order = ["host", "user-agent", "accept-encoding", "accept", "connection"];
    const [evidence] = await collect(headerOrderDetector(), makeContext({ headers, headerOrder: order }));
    expect(evidence?.summary).toMatch(/accept-encoding before accept/);
  });

  it("says nothing on HTTP/2, where order carries no meaning", async () => {
    const order = ["accept-encoding", "accept", "host", "user-agent"];
    expect(await collect(headerOrderDetector(), makeContext({ headerOrder: order, httpVersion: "2.0" }))).toHaveLength(0);
  });

  it("says nothing when the transport exposed no order", async () => {
    expect(await collect(headerOrderDetector(), makeContext({ headerOrder: [] }))).toHaveLength(0);
  });
});

describe("trapDetector", () => {
  it("is certain about a trap path", async () => {
    const [evidence] = await collect(trapDetector({ paths: ["/internal/export.csv"] }), makeContext({ path: "/internal/export.csv" }));
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.deterministicBasis).toBeTruthy();
  });

  it("is certain about a filled hidden field, and silent about an empty one", async () => {
    const filled = await collect(trapDetector({ formFields: ["website"] }), makeContext({ path: "/contact?website=http://spam.example" }));
    expect(filled[0]?.certainty).toBe("certain");
    expect(await collect(trapDetector({ formFields: ["website"] }), makeContext({ path: "/contact?website=" }))).toHaveLength(0);
  });

  // The forms a honeypot is worth putting on — sign-up, contact, comment, login — are
  // POSTs, so the field arrives in a body this library never reads. Checking only the
  // query string meant `renderTrapField` produced a field that was rendered, filled,
  // and ignored.
  it("sees a hidden field submitted in a POST body", async () => {
    const detector = trapDetector({ formFields: ["company_url"] });
    const filled = await collect(
      detector,
      makeContext({ method: "POST", path: "/contact", extra: { [TRAP_FIELD_SOURCE]: { email: "a@b.com", company_url: "http://spam.example" } } }),
    );
    expect(filled[0]?.certainty).toBe("certain");
    expect(filled[0]?.metadata?.["source"]).toBe("body");
  });

  it("stays silent when the hidden field arrives empty, as a person's submission does", async () => {
    const detector = trapDetector({ formFields: ["company_url"] });
    const context = makeContext({ method: "POST", path: "/contact", extra: { [TRAP_FIELD_SOURCE]: { email: "a@b.com", company_url: "" } } });
    expect(await collect(detector, context)).toHaveLength(0);
  });

  // This feeds a `certain` verdict, so anything that is not plainly a filled-in
  // string must not be read as one.
  it("ignores a body it cannot read as fields", async () => {
    const detector = trapDetector({ formFields: ["company_url"] });
    for (const extra of [{ [TRAP_FIELD_SOURCE]: "company_url=x" }, { [TRAP_FIELD_SOURCE]: null }, { [TRAP_FIELD_SOURCE]: { company_url: { nested: true } } }, {}]) {
      expect(await collect(detector, makeContext({ method: "POST", path: "/contact", extra })), JSON.stringify(extra)).toHaveLength(0);
    }
  });
});

describe("ipIntelligenceDetector", () => {
  it("treats an operator denylist as a decision rather than an inference", async () => {
    const [evidence] = await collect(ipIntelligenceDetector(), makeContext({ ip: "198.51.100.9", ranges: { denylist: ["198.51.100.0/24"] } }));
    expect(evidence?.certainty).toBe("certain");
    expect(evidence?.deterministicBasis).toMatch(/local policy/);
  });

  it("keeps datacenter ranges at moderate", async () => {
    const [evidence] = await collect(ipIntelligenceDetector(), makeContext({ ip: "198.51.100.9", ranges: { datacenter: ["198.51.100.0/24"] } }));
    expect(evidence?.certainty).toBe("moderate");
  });
});

describe("behavioural detectors", () => {
  it("reports a high rate without ever calling it proof", async () => {
    const state = new ActorState("actor", 0);
    for (let i = 0; i < 60; i++) state.record(makeFacts({ timestamp: 1000 + i * 10, path: `/p${i}` }));
    const [evidence] = await collect(rateAnomalyDetector(), makeContext({ state, timestamp: 1600 }));
    expect(evidence?.certainty).toBe("moderate");
    // Even at its most extreme this signal is capped well below `strong`, so it can
    // never on its own reach a terminal action.
    expect(evidence?.weight).toBeLessThanOrEqual(0.4);
    expect(evidence?.metadata?.["undercounted"]).toBe(true);
  });

  it("notices machine-regular pacing", async () => {
    const state = new ActorState("actor", 0);
    for (let i = 0; i < 12; i++) state.record(makeFacts({ timestamp: 1000 + i * 2000, path: `/p${i}` }));
    const [evidence] = await collect(cadenceDetector(), makeContext({ state, timestamp: 1000 + 12 * 2000 }));
    expect(evidence?.summary).toMatch(/machine-regular/);
  });

  it("leaves ragged human pacing alone", async () => {
    const gaps = [1200, 8400, 400, 15000, 2300, 60000, 900, 4300, 30000, 1100];
    const state = new ActorState("actor", 0);
    let now = 1000;
    for (const [index, gap] of gaps.entries()) {
      now += gap;
      state.record(makeFacts({ timestamp: now, path: `/p${index}` }));
    }
    expect(await collect(cadenceDetector(), makeContext({ state, timestamp: now }))).toHaveLength(0);
  });
});

describe("thresholds that could never be reached", () => {
  // Both counts saturate per actor, so a threshold above the cap leaves a detector
  // running on every request and firing on none — the "configured but inert" failure
  // this library refuses to ship anywhere else.
  it("refuses a rotation threshold above what an actor remembers", () => {
    expect(() => identityRotationDetector({ threshold: MAX_TRACKED_USER_AGENTS + 1 })).toThrow(RangeError);
    expect(() => identityRotationDetector({ threshold: MAX_TRACKED_USER_AGENTS })).not.toThrow();
  });

  it("refuses a rate threshold above the arrival ring", () => {
    expect(() => rateAnomalyDetector({ threshold: MAX_TRACKED_ARRIVALS + 1 })).toThrow(RangeError);
    expect(() => rateAnomalyDetector({ hardThreshold: MAX_TRACKED_ARRIVALS + 1 })).toThrow(RangeError);
    expect(() => rateAnomalyDetector({ threshold: 20, hardThreshold: MAX_TRACKED_ARRIVALS })).not.toThrow();
  });

  // The count an actor reports is capped, which is exactly why the guard is needed:
  // thirty spoofed User-Agents still read as four.
  it("saturates the rotation count, as the guard assumes", () => {
    const state = new ActorState("actor", 0);
    for (let i = 0; i < 30; i++) {
      state.record(makeFacts({ headers: { "user-agent": `Rotator/${i}` }, headerOrder: ["user-agent"], timestamp: i * 100 }));
    }
    expect(state.total).toBe(30);
    expect(state.distinctUserAgents).toBe(MAX_TRACKED_USER_AGENTS);
  });

  // A coefficient of variation from one gap is identically zero whatever the data,
  // so a single-sample cadence check would call every actor machine-regular.
  it("will not compute a cadence from a single gap", async () => {
    const state = new ActorState("actor", 0);
    for (const at of [0, 1000]) state.record(makeFacts({ timestamp: at }));
    const evidence = await collect(cadenceDetector({ minSamples: 1 }), makeContext({ state }));
    expect(evidence).toEqual([]);
  });
});

describe("crawlBreadthDetector at scale", () => {
  function crawl(pages: number, revisitsEach = 0): ActorState {
    const state = new ActorState("actor", 0);
    let at = 0;
    for (let page = 0; page < pages; page++) {
      state.record(makeFacts({ path: `/article/${page}`, timestamp: at++ * 500 }));
      for (let r = 0; r < revisitsEach; r++) state.record(makeFacts({ path: "/index", timestamp: at++ * 500 }));
    }
    return state;
  }

  // The distinct-path count saturates and the request total does not, so dividing one
  // by the other made the ratio fall as an actor kept crawling: the detector went
  // quiet in proportion to how hard something was enumerating the site.
  it("still fires on a crawl far larger than the count it can hold", async () => {
    for (const pages of [40, 100, 300]) {
      const evidence = await collect(crawlBreadthDetector(), makeContext({ state: crawl(pages) }));
      expect(evidence, `${pages} distinct pages, never revisited`).toHaveLength(1);
      expect(evidence[0]?.metadata?.["saturated"]).toBe(pages > 64);
    }
  });

  // The direction that costs a person their page: heavy revisiting is what reading
  // looks like, and it must stay silent however many pages it eventually covers.
  it("stays silent for someone who revisits, however far they get", async () => {
    for (const revisits of [1, 2, 3]) {
      const state = crawl(90, revisits);
      expect(state.distinctPaths, "the reader reached the cap").toBe(MAX_TRACKED_PATHS);
      expect(await collect(crawlBreadthDetector(), makeContext({ state })), `revisiting ${revisits}x`).toEqual([]);
    }
  });

  it("refuses a threshold above the count it can hold", () => {
    expect(() => crawlBreadthDetector({ threshold: MAX_TRACKED_PATHS + 1 })).toThrow(RangeError);
    expect(() => crawlBreadthDetector({ threshold: MAX_TRACKED_PATHS })).not.toThrow();
  });
});

describe("fetchMetadataDetector and Sec-Fetch-User", () => {
  const NAV = { ...CHROME_HEADERS, "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" };

  it("says nothing about a real navigation", async () => {
    expect(await collect(fetchMetadataDetector(), makeContext({ headers: NAV, headerOrder: Object.keys(NAV) }))).toEqual([]);
  });

  // The `?1` a browser sent is exactly right; the accusation came entirely from a
  // header that was not in front of us. The destination check beside it already
  // guarded for this.
  it("does not accuse a navigation whose mode header was never recorded", async () => {
    const { "sec-fetch-mode": _mode, ...withoutMode } = NAV;
    const headers = withoutMode as Record<string, string>;
    expect(await collect(fetchMetadataDetector(), makeContext({ headers, headerOrder: Object.keys(headers) }))).toEqual([]);
  });

  it("still reports a Sec-Fetch-User that contradicts the mode it arrived with", async () => {
    const headers = { ...CHROME_HEADERS, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-user": "?1" };
    const evidence = await collect(fetchMetadataDetector(), makeContext({ headers, headerOrder: Object.keys(headers) }));
    expect(evidence.map((item) => item.summary).join(" ")).toContain("Sec-Fetch-User");
  });

  it("still reports a value browsers never send", async () => {
    const headers = { ...NAV, "sec-fetch-user": "?0" };
    const evidence = await collect(fetchMetadataDetector(), makeContext({ headers, headerOrder: Object.keys(headers) }));
    expect(evidence.map((item) => item.summary).join(" ")).toContain("Sec-Fetch-User");
  });
});

describe("what counts as a client declaring itself", () => {
  const declare = async (userAgent: string) => {
    const headers = { ...CHROME_HEADERS, "user-agent": userAgent };
    return collect(selfIdentifiedDetector(), makeContext({ headers, headerOrder: Object.keys(headers) }));
  };

  // The rule is both halves: automation announced, and an operator named. Deciding it
  // on the contact alone made a proven bot of anyone whose app puts its own address in
  // the string.
  it("is certain about a crawler that says so and names its operator", async () => {
    const evidence = await declare("Mozilla/5.0 (compatible; ExampleCrawler/1.0; +https://example.test/bot)");
    expect(evidence[0]?.certainty).toBe("certain");
  });

  // The `+URL` convention announces automation on its own, which is how a crawler that
  // never uses the word "bot" still declares itself.
  it("is certain about a crawler that uses only the +URL convention", async () => {
    const evidence = await declare("Mozilla/5.0 (compatible; Mozilla/5.0; +https://search.marginalia.nu/)");
    expect(evidence[0]?.certainty).toBe("certain");
  });

  // But only in a string that is not also a browser. A podcast app sends one
  // User-Agent for fetching feeds and for opening the links a listener taps, and it
  // carries the convention either way — so the convention alone reached certainty
  // about a person. A rendering engine in the string is what tells them apart.
  it("is not certain about an app that carries the convention and a rendering engine", async () => {
    const evidence = await declare(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ExampleCast/2025.4 (+http://examplecast.test/; iOS podcast app)",
    );
    expect(evidence.length, "an unrecognised app is still worth noting, just not proving").toBeGreaterThan(0);
    for (const item of evidence) expect(item.certainty, item.summary).not.toBe("certain");
  });

  it("is not certain about a bare URL or address with no announcement at all", async () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Notes/3.1 (support@notes.example)",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15 Ledger/2.4 (https://ledger.example)",
    ]) {
      for (const item of await declare(ua)) expect(item.certainty, ua.slice(0, 40)).not.toBe("certain");
    }
  });
});
