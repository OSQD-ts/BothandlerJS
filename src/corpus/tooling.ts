import { plain } from "./headers.js";
import { bot } from "./schema.js";
import type { CaseRequest, TrafficCase } from "./schema.js";

/**
 * Tools: HTTP libraries, automation runtimes, and security scanners.
 *
 * These are the cases the library is most confident about, and it is worth being
 * exact about *why*. A request saying `python-requests/2.32.3` is not evidence that
 * anyone is hostile — it is evidence that no human is looking at the response, which
 * is a much narrower and much safer claim. Plenty of this traffic is somebody's own
 * integration, which is why the recommended treatment is a challenge or an allowlist
 * entry rather than a block.
 *
 * Header *order* carries as much information as the User-Agent here. python-requests
 * sends `Accept-Encoding` before `Accept`; no browser does. The cases below reproduce
 * each library's real order so the ordering detector is genuinely exercised rather
 * than fed a plausible-looking guess.
 */

function library(id: string, title: string, headers: CaseRequest["headers"], provenance: string, identity?: string, notes?: string): TrafficCase {
  return bot({
    id,
    title,
    audience: "unwanted-bot",
    category: "http-library",
    provenance,
    ...(notes !== undefined ? { notes } : {}),
    requests: [{ headers, protocol: "https", httpVersion: "1.1" }],
    expect: {
      verdict: "confirmed-bot",
      botClass: "http-client",
      certain: true,
      ...(identity !== undefined ? { identity } : {}),
      detectors: ["self-identified"],
    },
  });
}

export const TOOLING_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // HTTP libraries, in the header order each actually sends.
  // ---------------------------------------------------------------------------
  library(
    "python-requests",
    "python-requests",
    [["Host", "shop.example"], ["User-Agent", "python-requests/2.32.3"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["Connection", "keep-alive"]],
    "requests sends User-Agent, Accept-Encoding, Accept, Connection — Accept-Encoding ahead of Accept, which no browser does",
    "python",
    "Exercises both the signature and the header-order invariant at once.",
  ),
  library(
    "python-httpx",
    "httpx",
    [["Host", "shop.example"], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br"], ["Connection", "keep-alive"], ["User-Agent", "python-httpx/0.27.2"]],
    "httpx sorts differently from requests and sends User-Agent last",
    "python",
  ),
  library(
    "python-aiohttp",
    "aiohttp",
    [["Host", "shop.example"], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate"], ["User-Agent", "Python/3.12 aiohttp/3.10.5"]],
    "aiohttp's default client header set",
    "python",
  ),
  library(
    "python-urllib",
    "urllib",
    [["Accept-Encoding", "identity"], ["Host", "shop.example"], ["User-Agent", "Python-urllib/3.12"], ["Connection", "close"]],
    "urllib sends Host *second* and Accept-Encoding: identity — a request shape no browser produces",
    "python",
  ),
  library(
    "scrapy",
    "Scrapy",
    [["Host", "shop.example"], ["User-Agent", "Scrapy/2.11.2 (+https://scrapy.org)"], ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en"], ["Accept-Encoding", "gzip, deflate"]],
    "Scrapy's default crawler headers; it names a contact URL like a polite crawler",
    "python",
  ),
  library(
    "curl",
    "curl",
    [["Host", "shop.example"], ["User-Agent", "curl/8.11.1"], ["Accept", "*/*"]],
    "curl sends exactly three headers by default",
    "curl",
  ),
  library("wget", "Wget", [["Host", "shop.example"], ["User-Agent", "Wget/1.24.5"], ["Accept", "*/*"], ["Accept-Encoding", "identity"], ["Connection", "Keep-Alive"]], "Wget's default header set", "wget"),
  library(
    "go-http-client",
    "Go's net/http",
    [["Host", "shop.example"], ["User-Agent", "Go-http-client/2.0"], ["Accept-Encoding", "gzip"]],
    "Go sends only a User-Agent and Accept-Encoding by default — no Accept at all",
    "go",
  ),
  library("node-fetch", "node-fetch", [["Host", "shop.example"], ["Accept", "*/*"], ["User-Agent", "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)"], ["Accept-Encoding", "gzip,deflate"], ["Connection", "close"]], "node-fetch default headers; it sends Accept before User-Agent, unlike any browser", "node"),
  library("axios", "axios", [["Host", "shop.example"], ["Accept", "application/json, text/plain, */*"], ["User-Agent", "axios/1.7.7"], ["Accept-Encoding", "gzip, compress, deflate, br"]], "axios in Node; in a browser it cannot set User-Agent at all", "node"),
  library("okhttp", "OkHttp", [["Host", "shop.example"], ["User-Agent", "okhttp/4.12.0"], ["Connection", "Keep-Alive"], ["Accept-Encoding", "gzip"]], "The default client for most Android apps", "java"),
  library("java-httpclient", "Java HttpClient", [["Host", "shop.example"], ["User-Agent", "Java-http-client/21.0.4"], ["Connection", "Upgrade, HTTP2-Settings"]], "The JDK's built-in client", "java"),
  library("apache-httpclient", "Apache HttpClient", [["Host", "shop.example"], ["User-Agent", "Apache-HttpClient/5.3.1 (Java/21.0.4)"], ["Accept-Encoding", "gzip, x-gzip, deflate"], ["Connection", "keep-alive"]], "Ubiquitous in JVM services", "java"),
  library("guzzle", "Guzzle", [["Host", "shop.example"], ["User-Agent", "GuzzleHttp/7.9.2 curl/8.11.1 PHP/8.3.12"], ["Accept", "*/*"]], "The default PHP HTTP client; note it names curl and PHP too", "php"),
  library("wordpress", "WordPress", [["Host", "shop.example"], ["User-Agent", "WordPress/6.7.1; https://blog.example"], ["Accept", "*/*"], ["Accept-Encoding", "deflate;q=1.0, compress;q=0.5, gzip;q=0.5"]], "WordPress pingbacks and feed fetches identify the calling site", "php", "Honest automation from somebody else's blog. A block here breaks a pingback, not an attack."),
  library("ruby-faraday", "Ruby Faraday", [["Host", "shop.example"], ["User-Agent", "Faraday v2.12.0"], ["Accept-Encoding", "gzip;q=1.0,deflate;q=0.6,identity;q=0.3"], ["Accept", "*/*"]], "A common Ruby client stack", "ruby"),
  library("dotnet-httpclient", ".NET HttpClient", [["Host", "shop.example"], ["User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HttpClient/8.0"], ["Accept-Encoding", "gzip, deflate, br"]], "Note the Mozilla prefix: even library clients sometimes wear a browser preamble", "dotnet"),
  library("postman", "Postman", [["Host", "shop.example"], ["User-Agent", "PostmanRuntime/7.42.0"], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br"], ["Connection", "keep-alive"]], "A person clicking Send in Postman — automation by shape, a human by intent", "misc-cli", "Worth remembering when choosing an action: there is a developer on the other end of this one."),
  library("httpie", "HTTPie", [["Host", "shop.example"], ["User-Agent", "HTTPie/3.2.4"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["Connection", "keep-alive"]], "A command-line client aimed at people", "misc-cli"),
  library("libwww-perl", "LWP", [["Host", "shop.example"], ["User-Agent", "libwww-perl/6.77"], ["TE", "deflate,gzip;q=0.3"]], "One of the oldest scripted clients still in circulation", "perl"),

  bot({
    id: "unknown-bare-token",
    title: "An unrecognised internal service client",
    audience: "unwanted-bot",
    category: "http-library",
    provenance: "A hand-rolled User-Agent from somebody's internal integration",
    notes:
      "Not in any signature database and never will be. The shape alone — a bare product token with no browser preamble — is enough for `strong`, and no more. This is the case the allowlist exists for.",
    requests: [plain("AcmeInventorySync/2.3")],
    expect: { verdict: "suspected-bot", botClass: "http-client", certain: false, minScore: 55 },
  }),

  bot({
    id: "no-user-agent-at-all",
    title: "A request with no User-Agent",
    audience: "unwanted-bot",
    category: "http-library",
    provenance: "Common in scripts, and also produced by some stripped-down proxies",
    notes: "Deliberately only `moderate`. Header-stripping intermediaries do this to real people.",
    requests: [{ headers: [["Host", "shop.example"], ["Accept", "*/*"]], protocol: "https", httpVersion: "1.1" }],
    expect: { certain: false, maxScore: 60 },
  }),

  // ---------------------------------------------------------------------------
  // Automation runtimes that are not hiding.
  // ---------------------------------------------------------------------------
  bot({
    id: "headless-chrome-default",
    title: "Headless Chrome with its default User-Agent",
    audience: "unwanted-bot",
    category: "automation",
    provenance: "Puppeteer and Playwright leave HeadlessChrome in the UA unless told otherwise",
    requests: [plain("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36")],
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true },
  }),
  bot({
    id: "headless-chrome-client-hints",
    title: "Headless Chrome that hid the UA but not the Client Hints",
    audience: "unwanted-bot",
    category: "automation",
    provenance: "Overriding navigator.userAgent does not rewrite Sec-CH-UA, so the brand list still says HeadlessChrome",
    notes: "A self-declaration in a place the operator forgot to edit — which makes it a statement rather than an inference, and therefore `certain`.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Connection", "keep-alive"],
          ["sec-ch-ua", '"HeadlessChrome";v="152", "Chromium";v="152", "Not(A:Brand";v="24"'],
          ["sec-ch-ua-mobile", "?0"],
          ["sec-ch-ua-platform", '"Linux"'],
          ["User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Accept-Language", "en-US"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true, detectors: ["client-hints"] },
  }),
  bot({
    id: "selenium-webdriver",
    title: "Selenium WebDriver",
    audience: "unwanted-bot",
    category: "automation",
    provenance: "Some grid configurations leave a webdriver token in the UA",
    requests: [plain("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 selenium/4.25.0")],
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true },
  }),
  bot({
    id: "phantomjs",
    title: "PhantomJS",
    audience: "unwanted-bot",
    category: "automation",
    provenance: "Long unmaintained, still seen in old scraping stacks",
    requests: [plain("Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1")],
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true },
  }),
  bot({
    id: "splash-renderer",
    title: "Splash, a scriptable rendering service",
    audience: "unwanted-bot",
    category: "automation",
    provenance: "Scrapy's JavaScript rendering companion",
    requests: [plain("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/602.1 (KHTML, like Gecko) splash/3.5 Safari/602.1")],
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true },
  }),

  // ---------------------------------------------------------------------------
  // Security tooling. A hit proves automation, not malice — you may be scanning
  // yourself, which is what the allowlist is for.
  // ---------------------------------------------------------------------------
  bot({
    id: "sqlmap",
    title: "sqlmap",
    audience: "hostile",
    category: "scanner",
    provenance: "The standard SQL injection tool; announces itself by default",
    requests: [{ ...plain("sqlmap/1.8.11#stable (https://sqlmap.org)"), path: "/products?id=1%27%20AND%20SLEEP(5)--" }],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true, identity: "sqlmap" },
  }),
  bot({
    id: "nikto",
    title: "Nikto",
    audience: "hostile",
    category: "scanner",
    provenance: "Web server scanner; the UA embeds a Mozilla/5.00 typo that has never been fixed",
    requests: [{ ...plain("Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:Port Check)"), path: "/admin.php" }],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true, identity: "nikto" },
  }),
  bot({
    id: "nuclei",
    title: "Nuclei",
    audience: "hostile",
    category: "scanner",
    provenance: "Template-driven vulnerability scanner from ProjectDiscovery",
    requests: [{ ...plain("Nuclei - Open-source project (github.com/projectdiscovery/nuclei)"), path: "/.git/config" }],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true, identity: "nuclei" },
  }),
  bot({
    id: "gobuster",
    title: "Directory brute-forcing with gobuster",
    audience: "hostile",
    category: "scanner",
    provenance: "Content discovery tool",
    requests: [{ ...plain("gobuster/3.6"), path: "/backup" }],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true },
  }),
  bot({
    id: "acunetix",
    title: "Acunetix",
    audience: "hostile",
    category: "scanner",
    provenance: "Commercial DAST scanner",
    requests: [plain("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 acunetix-product")],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true },
  }),
  bot({
    id: "masscan",
    title: "masscan hitting an HTTP port",
    audience: "hostile",
    category: "scanner",
    provenance: "Internet-wide port scanner",
    requests: [{ headers: [["Host", "shop.example"], ["User-Agent", "masscan/1.3 (https://github.com/robertdavidgraham/masscan)"], ["Accept", "*/*"]], protocol: "http", httpVersion: "1.1" }],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true },
  }),
  bot({
    id: "censys-scanner",
    title: "Censys internet-wide measurement",
    audience: "hostile",
    category: "scanner",
    provenance: "Research scanning that publishes an opt-out address",
    notes: "Classified alongside scanners because that is what it is, but it is a research project that honours opt-outs — a good candidate for your allowlist rather than a block.",
    requests: [plain("Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)")],
    expect: { verdict: "confirmed-bot", botClass: "scanner", certain: true },
  }),
  bot({
    id: "internet-measurement",
    title: "Anonymous internet measurement",
    audience: "hostile",
    category: "scanner",
    provenance: "Driftnet and similar projects scan the whole address space continuously",
    requests: [plain("Mozilla/5.0 (compatible; InternetMeasurement/1.0; +https://internet-measurement.com/)")],
    expect: { verdict: "confirmed-bot", certain: true },
  }),
];
