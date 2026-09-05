import { describe, expect, it } from "vitest";
import { browsingCoherenceDetector } from "../src/detectors/browsing-coherence.js";
import { clientHintsDetector } from "../src/detectors/client-hints.js";
import { headerIntegrityDetector } from "../src/detectors/header-integrity.js";
import { probeSignatureDetector } from "../src/detectors/probe-signature.js";
import { uaCoherenceDetector } from "../src/detectors/ua-coherence.js";
import { selfIdentifiedDetector } from "../src/detectors/self-identified.js";
import { combineEvidence } from "../src/evidence.js";
import { CHROME_HEADERS, collect, makeContext } from "./helpers.js";
import type { Evidence } from "../src/types.js";

const COMBINE = { suspectThreshold: 60, strictEvidence: true };

function summaries(evidence: readonly Evidence[]): string {
  return evidence.map((item) => item.summary).join(" | ");
}

/**
 * The User-Agent read against itself.
 *
 * Each case here is a string that describes a client which has never shipped. The
 * population that produces them is a UA randomiser — and, importantly, also a person
 * with a spoofing extension, which is why every assertion below checks that the
 * evidence stayed short of `certain`.
 */
describe("ua-coherence", () => {
  const detector = uaCoherenceDetector();

  async function inspect(userAgent: string) {
    return collect(detector, makeContext({ headers: { ...CHROME_HEADERS, "user-agent": userAgent } }));
  }

  it("leaves every real browser in the corpus of profiles alone", async () => {
    const real = [
      CHROME_HEADERS["user-agent"]!,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.7258.67 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/148.0 Mobile/15E148 Safari/605.1.15",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
      "Mozilla/5.0 (Android 15; Mobile; rv:148.0) Gecko/20100101 Firefox/148.0",
      "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edge/44.18363.8131",
      "Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    ];
    for (const userAgent of real) {
      expect(summaries(await inspect(userAgent)), userAgent).toBe("");
    }
  });

  it("catches Chrome claimed on an iOS device, which reports CriOS", async () => {
    const evidence = await inspect("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
    expect(summaries(evidence)).toContain("CriOS");
    expect(evidence.every((item) => item.certainty !== "certain")).toBe(true);
  });

  it("catches two operating systems in one string", async () => {
    const evidence = await inspect("Mozilla/5.0 (Windows NT 10.0; Win64; x64; Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
    expect(summaries(evidence)).toContain("Windows and macOS");
  });

  it("catches two rendering engines in one string", async () => {
    const evidence = await inspect("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Firefox/141.0");
    expect(summaries(evidence)).toContain("Firefox and Chrome");
  });

  it("catches Gecko claiming the WebKit engine", async () => {
    const evidence = await inspect("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/141.0");
    expect(summaries(evidence)).toContain("AppleWebKit");
  });

  // Safari's product token carries the WebKit build (`Safari/605.1.15`), not the
  // marketing version — so a version-plausibility band that includes it reports a
  // contradiction on every Mac and iPhone. The corpus caught this; the test keeps it.
  it("does not read Safari's WebKit build as an impossible version", async () => {
    const evidence = await inspect("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15");
    expect(summaries(evidence)).not.toContain("version");
  });

  it("reports a browser version its platform never received, and only at moderate", async () => {
    const evidence = await inspect("Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
    expect(summaries(evidence)).toContain("Windows 7");
    // Supermium and Thorium ship current Chromium on Windows 7 to real people.
    expect(evidence.every((item) => item.certainty === "moderate" || item.certainty === "weak")).toBe(true);
  });

  it("says nothing about a bare library token, which self-identified owns", async () => {
    expect(summaries(await inspect("curl/8.4.0"))).toBe("");
    expect(summaries(await inspect("MyInternalService/1.0"))).toBe("");
  });
});

/**
 * Protocol framing. The two additions here are `certain`, and both reason from what
 * is *present* — which is the property that makes them safe.
 */
describe("header-integrity protocol framing", () => {
  const detector = headerIntegrityDetector();

  it("proves a message that carries both Content-Length and Transfer-Encoding", async () => {
    const headers = { ...CHROME_HEADERS, "content-length": "6", "transfer-encoding": "chunked" };
    const evidence = await collect(detector, makeContext({ headers, method: "POST" }));
    const framing = evidence.find((item) => item.certainty === "certain");
    expect(framing?.summary).toContain("Content-Length and Transfer-Encoding");
    expect(framing?.deterministicBasis).toContain("RFC 9112");
  });

  it("proves a repeated Host header", async () => {
    const order = ["host", "host", "user-agent", "accept"];
    const evidence = await collect(detector, makeContext({ headers: { host: "a.example", "user-agent": CHROME_HEADERS["user-agent"]!, accept: "*/*" }, headerOrder: order }));
    expect(evidence.find((item) => item.certainty === "certain")?.summary).toContain("repeats the host");
  });

  it("reports a repeated singleton header as strong rather than proven", async () => {
    const order = ["host", "user-agent", "accept", "accept", "accept-encoding"];
    const evidence = await collect(detector, makeContext({ headers: CHROME_HEADERS, headerOrder: order }));
    const repeated = evidence.find((item) => item.summary.includes("more than once"));
    expect(repeated?.certainty).toBe("strong");
  });

  // A duplicated field over HTTP/2 is the protocol's doing, not the client's: cookies
  // are explicitly permitted to arrive split across several fields.
  it("does not read a repeated singleton over HTTP/2 as the client's doing", async () => {
    const order = ["user-agent", "accept", "accept"];
    const evidence = await collect(detector, makeContext({ headers: CHROME_HEADERS, headerOrder: order, httpVersion: "2.0" }));
    expect(evidence.some((item) => item.summary.includes("more than once"))).toBe(false);
  });

  // The rule that keeps the certainty tier honest: a header missing from the facts is
  // not a header missing from the request, so no absence may ever be `certain`.
  it("never proves anything from an absence, however clear the violation", async () => {
    const { host: _host, ...withoutHost } = CHROME_HEADERS;
    const evidence = await collect(detector, makeContext({ headers: withoutHost, headerOrder: Object.keys(withoutHost) }));
    expect(evidence.every((item) => item.certainty !== "certain")).toBe(true);
  });
});

describe("client-hints, high-entropy set", () => {
  const detector = clientHintsDetector();

  it("catches a full-version-list that disagrees with the User-Agent", async () => {
    const headers = { ...CHROME_HEADERS, "sec-ch-ua-full-version-list": '"Chromium";v="118.0.5993.88", "Not(A:Brand";v="24.0.0.0", "Google Chrome";v="118.0.5993.88"' };
    const evidence = await collect(detector, makeContext({ headers }));
    expect(summaries(evidence)).toContain("Full-Version-List");
  });

  it("catches a device model reported beside a desktop platform", async () => {
    const headers = { ...CHROME_HEADERS, "sec-ch-ua-model": '"Pixel 9"' };
    const evidence = await collect(detector, makeContext({ headers }));
    expect(summaries(evidence)).toContain("Sec-CH-UA-Model");
  });

  it("leaves an empty model alone, which is what a desktop actually sends", async () => {
    const headers = { ...CHROME_HEADERS, "sec-ch-ua-model": '""' };
    expect(summaries(await collect(detector, makeContext({ headers })))).toBe("");
  });

  it("leaves a phone's model alone", async () => {
    const headers = {
      ...CHROME_HEADERS,
      "user-agent": "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
      "sec-ch-ua-platform": '"Android"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-model": '"SM-S931B"',
    };
    expect(summaries(await collect(detector, makeContext({ headers })))).toBe("");
  });
});

describe("probe-signature", () => {
  const detector = probeSignatureDetector();

  it("says nothing about ordinary paths", async () => {
    for (const path of ["/", "/products/42", "/blog/backup-your-data-a-guide", "/search?q=how+to+use+select+in+sql", "/pmatters", "/admin-guide"]) {
      expect(summaries(await collect(detector, makeContext({ path }))), path).toBe("");
    }
  });

  it("reports a credential or version-control target as strong, never proven", async () => {
    for (const path of ["/.env", "/.env.production", "/.git/config", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/actuator/heapdump"]) {
      const evidence = await collect(detector, makeContext({ path }));
      expect(evidence[0]?.certainty, path).toBe("strong");
      expect(evidence[0]?.botClass).toBe("scanner");
    }
  });

  it("reads a traversal that normalisation has already resolved", async () => {
    const evidence = await collect(detector, makeContext({ path: "/assets/..%2f..%2fetc/passwd" }));
    expect(summaries(evidence)).toContain("/etc/passwd");
  });

  it("caps a platform administration path at moderate and says why", async () => {
    const evidence = await collect(detector, makeContext({ path: "/wp-login.php" }));
    expect(evidence[0]?.certainty).toBe("moderate");
    expect(evidence[0]?.metadata?.["note"]).toContain("ignore");
  });

  it("stands down on a platform path the site declares it serves", async () => {
    const configured = probeSignatureDetector({ ignore: ["/wp-login.php", "/wp-admin"] });
    expect(summaries(await collect(configured, makeContext({ path: "/wp-login.php" })))).toBe("");
    expect(summaries(await collect(configured, makeContext({ path: "/wp-admin/post.php" })))).toBe("");
  });

  it("reports a JNDI lookup in a parameter", async () => {
    const evidence = await collect(detector, makeContext({ path: "/search?q=%24%7Bjndi%3Aldap%3A%2F%2Fscanner.example%2Fa%7D" }));
    expect(summaries(evidence)).toContain("JNDI");
    expect(evidence[0]?.certainty).toBe("strong");
  });

  // The split that keeps a documentation site's search box out of trouble.
  it("separates SQL a person typed from SQL that would execute", async () => {
    const typed = await collect(detector, makeContext({ path: "/search?q=union+select+examples" }));
    expect(typed[0]?.certainty).toBe("moderate");

    const injected = await collect(detector, makeContext({ path: "/item?id=1%27+union+select+password+from+users--" }));
    expect(injected[0]?.certainty).toBe("strong");
  });

  it("reports a TRACE request", async () => {
    const evidence = await collect(detector, makeContext({ method: "TRACE" }));
    expect(summaries(evidence)).toContain("TRACE");
  });
});

describe("browsing-coherence", () => {
  const detector = browsingCoherenceDetector();

  it("reports a cache revalidation as human-pointing", async () => {
    const headers = { ...CHROME_HEADERS, "if-none-match": 'W/"41d-19a0b2f3c11"' };
    const evidence = await collect(detector, makeContext({ headers }));
    expect(evidence.some((item) => item.direction === "human" && item.summary.includes("revalidates"))).toBe(true);
  });

  it("never reaches certain, because every property it reads is copyable", async () => {
    const headers = { ...CHROME_HEADERS, cookie: "session=1", "if-none-match": '"x"' };
    const evidence = await collect(detector, makeContext({ headers }));
    expect(evidence.length).toBeGreaterThan(1);
    expect(evidence.every((item) => item.certainty !== "certain" && item.certainty !== "strong")).toBe(true);
  });

  it("says nothing about a client that does not claim to be a browser", async () => {
    const headers = { host: "shop.example", "user-agent": "curl/8.4.0", cookie: "session=1" };
    expect(summaries(await collect(detector, makeContext({ headers })))).toBe("");
  });

  // The whole set is one circumstance seen four ways, so it collapses to its
  // strongest member rather than compounding into a large discount.
  it("shares one family, so a session's marks cannot stack into a big discount", async () => {
    const headers = { ...CHROME_HEADERS, cookie: "session=1", "if-none-match": '"x"' };
    const evidence = await collect(detector, makeContext({ headers }));
    expect(new Set(evidence.map((item) => item.family)).size).toBe(1);

    const bot: Evidence = { detector: "test", summary: "suspicious", direction: "bot", certainty: "strong", weight: 0.6 };
    const combined = combineEvidence([bot, ...evidence], COMBINE);
    expect(combined.score).toBe(42);
  });
});

/**
 * The correlation model.
 *
 * Noisy-OR is sound over independent signals, and a stripping intermediary makes
 * several detectors dependent in the worst possible way: they all fire, at once, about
 * one person behind one appliance.
 */
describe("correlated evidence", () => {
  const stripped = (weight: number, id: string): Evidence => ({ detector: id, summary: id, direction: "bot", certainty: "strong", weight, family: "stripped-headers" });

  it("collapses one cause reported four times to its strongest observation", () => {
    const four = [stripped(0.6, "a"), stripped(0.6, "b"), stripped(0.35, "c"), stripped(0.3, "d")];
    expect(combineEvidence(four, COMBINE).score).toBe(60);
  });

  it("still compounds observations that name different causes", () => {
    const mixed: Evidence[] = [stripped(0.6, "a"), { detector: "e", summary: "e", direction: "bot", certainty: "strong", weight: 0.6, family: "ua-rewritten" }];
    expect(combineEvidence(mixed, COMBINE).score).toBe(84);
  });

  it("leaves unfamilied evidence exactly as it was", () => {
    const loose: Evidence[] = [
      { detector: "a", summary: "a", direction: "bot", certainty: "strong", weight: 0.6 },
      { detector: "b", summary: "b", direction: "bot", certainty: "strong", weight: 0.6 },
    ];
    expect(combineEvidence(loose, COMBINE).score).toBe(84);
  });

  // Families are a scoring correction. They have no reach into the proven path.
  it("cannot weaken a proven verdict", () => {
    const proven: Evidence = {
      detector: "self-identified",
      summary: "curl",
      direction: "bot",
      certainty: "certain",
      botClass: "http-client",
      family: "stripped-headers",
      deterministicBasis: "No browser sends curl/8.4.0.",
    };
    const combined = combineEvidence([proven, stripped(0.6, "a")], COMBINE);
    expect(combined.certain).toBe(true);
    expect(combined.score).toBe(100);
  });
});

describe("the expanded signature database", () => {
  const detector = selfIdentifiedDetector();

  async function identify(userAgent: string) {
    const evidence = await collect(detector, makeContext({ headers: { host: "shop.example", "user-agent": userAgent } }));
    return evidence[0];
  }

  it("names clients that previously reached only the bare-token rule", async () => {
    const cases: Array<[string, string]> = [
      ["reqwest/0.12.12", "rust"],
      ["ureq/3.0.5", "rust"],
      ["Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.26100; en-GB) PowerShell/7.5.0", "shell"],
      ["Deno/2.1.9", "node"],
      ["Bun/1.2.4", "node"],
      ["HTTrack/3.49-2", "site-mirrors"],
      ["yt-dlp/2025.01.15", "media-fetchers"],
      ["Mozilla/5.0 (compatible; coccocbot-web/1.0; +http://help.coccoc.com/searchengine)", "coccoc"],
      ["Mozilla/5.0 (compatible; YisouSpider/5.0; http://www.yisou.com/help/help_faq.html)", "yisouspider"],
      ["Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)", "mistral-ai"],
      ["Mozilla/5.0 (compatible; SISTRIX Crawler; http://crawler.sistrix.net/)", "sistrix"],
      ["Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)", "bluesky"],
      ["kube-probe/1.31", "platform-probes"],
      ["WhatWeb/0.5.5", "app-scanners"],
      ["Mozilla/5.0 (compatible; Katana/1.1.0)", "attack-crawlers"],
    ];
    for (const [userAgent, identity] of cases) {
      expect((await identify(userAgent))?.identity, userAgent).toBe(identity);
    }
  });

  // Two populations, one token. The Electron precedent, applied to the networking
  // stack every iOS application uses.
  it("records an Apple media or app stack without proving anything about it", async () => {
    for (const userAgent of ["AppleCoreMedia/1.0.0.22F76 (iPhone; U; CPU OS 18_5 like Mac OS X; en_gb)", "Shop/4.2 CFNetwork/1568.200.51 Darwin/24.1.0", "VLC/3.0.20 LibVLC/3.0.20"]) {
      const evidence = await identify(userAgent);
      expect(evidence?.certainty, userAgent).toBe("weak");
      expect(evidence?.metadata?.["caveat"], userAgent).toBeDefined();
    }
  });

  // A load generator sits in `library` rather than `monitoring` on purpose: benign
  // categories are on the default allow path, and a flood must not arrive pre-allowed.
  it("does not file a load generator under benign monitoring", async () => {
    const evidence = await identify("k6/0.56.0 (https://k6.io/)");
    expect(evidence?.identity).toBe("k6");
    expect(evidence?.metadata?.["benign"]).toBe(false);
  });
});
