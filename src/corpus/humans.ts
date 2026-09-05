import { browser, plain, userAgentOf } from "./headers.js";
import { DENYING_ACTIONS, human, humanPaced } from "./schema.js";
import type { CaseRequest, TrafficCase } from "./schema.js";

/**
 * People.
 *
 * Every case here is a person at a keyboard or a phone, and every one of them is a
 * false positive if the library denies it service. That guarantee is enforced for the
 * whole file by {@link human}, which attaches `neverAction: ["block","drop","redirect"]`
 * to each case so it cannot be forgotten.
 *
 * The file is deliberately unflattering. Roughly a third of it is people whose setup
 * genuinely does look automated — privacy browsers, stripped headers, cookie
 * blocking, corporate proxies, ten-year-old devices — and their expectations record
 * what the library *actually* does to them rather than what we would like it to do.
 * Where the honest answer is "this person gets challenged", the case says so. That is
 * the cost of the policy, written down where it can be argued about, instead of
 * hidden behind an average.
 */

/**
 * Inserts the revalidation headers where Chrome actually puts them — straight after
 * `Connection`, ahead of the Client Hints block.
 */
function withCacheValidators(request: CaseRequest): CaseRequest {
  const headers = [...request.headers];
  headers.splice(2, 0, ["Cache-Control", "max-age=0"], ["If-None-Match", '"a1b2c3d4"']);
  return { ...request, headers };
}

const CLEAN: readonly string[] = [
  "self-identified",
  "header-integrity",
  "client-hints",
  "fetch-metadata",
  "accept-signature",
  "header-order",
  "trap",
  "ip-intelligence",
];

/** A person on a current, unmodified browser. Nothing at all should fire. */
function pristine(id: string, title: string, request: ReturnType<typeof browser>, provenance: string): TrafficCase {
  return human({
    id,
    title,
    category: "mainstream-browser",
    provenance,
    requests: [request],
    expect: { verdict: "unknown", maxScore: 0, notDetectors: CLEAN, action: "allow" },
  });
}

export const HUMAN_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Applications that put their own address in the User-Agent.
  //
  // A great many do — native apps with a webview, desktop clients, anything whose
  // author wanted a server operator to be able to reach them. None of it says the
  // request is automated, and the person behind it is an ordinary customer. The
  // `self-identified` detector used to read a bare URL or email as the whole of a
  // self-declaration and reach `certain` on it, which is a proven bot verdict on a
  // person and the one thing this corpus exists to make impossible.
  // ---------------------------------------------------------------------------
  human({
    id: "app-webview-support-email",
    title: "A banking app's webview, naming its support address",
    category: "in-app-browser",
    provenance: "Native apps commonly append a product token and a contact to the system webview's User-Agent",
    notes: "Contains an email address and no crawler word anywhere. Believing a client's declaration is safe; inventing one for it is not.",
    requests: [
      plain(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Notes/3.1 (support@notes.example)",
      ),
    ],
    expect: { certain: false, neverAction: DENYING_ACTIONS },
  }),

  human({
    id: "desktop-client-homepage-url",
    title: "A desktop client naming its homepage",
    category: "in-app-browser",
    provenance: "A bare https:// URL in a User-Agent, without the `+` crawler convention and without a crawler word",
    requests: [
      plain(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15 Ledger/2.4 (https://ledger.example)",
      ),
    ],
    expect: { certain: false, neverAction: DENYING_ACTIONS },
  }),

  // ---------------------------------------------------------------------------
  // Mainstream desktop. If any of these ever fails, stop and fix it before
  // anything else in the library.
  // ---------------------------------------------------------------------------
  pristine("chrome-windows", "Chrome 152 on Windows 11", browser("chromeWindows"), "2026 User-Agent lists; Chromium freezes the minor version to 0.0.0"),
  pristine("chrome-macos", "Chrome 152 on macOS", browser("chromeMac"), "2026 User-Agent lists"),
  pristine("chrome-linux", "Chrome 152 on Linux", browser("chromeLinux"), "2026 User-Agent lists"),
  pristine("edge-windows", "Edge 150 on Windows", browser("edgeWindows"), "Edge reports Chromium brands alongside its own; UA carries Edg/"),
  pristine("firefox-windows", "Firefox 148 on Windows", browser("firefoxWindows"), "2026 User-Agent lists; Gecko sends no Client Hints"),
  pristine("firefox-linux", "Firefox 148 on Linux, German locale", browser("firefoxLinux"), "2026 User-Agent lists"),
  pristine("safari-macos", "Safari 18.7 on macOS", browser("safariMac"), "WebKit interleaves Sec-Fetch-* with content negotiation"),

  // ---------------------------------------------------------------------------
  // Mainstream mobile. More than half the web.
  // ---------------------------------------------------------------------------
  pristine("safari-ios", "Safari 18.7 on iPhone", browser("safariIos"), "2026 User-Agent lists"),
  pristine("chrome-android", "Chrome 150 on Android", browser("chromeAndroid"), "Android UA frozen to 'Android 10; K' since Chrome 110"),
  pristine("samsung-internet", "Samsung Internet 27 on a Galaxy S24", browser("samsungInternet"), "Chromium fork with its own product token; very common in Korea and India"),

  human({
    id: "chrome-android-cross-site-arrival",
    title: "Arriving on Android from a Google search result",
    category: "mainstream-browser",
    provenance: "Fetch Metadata spec: a cross-origin navigation reports Sec-Fetch-Site: cross-site",
    requests: [browser("chromeAndroid", { kind: "cross-site-navigate", referer: "https://www.google.com/" })],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
  }),

  human({
    id: "safari-ios-xhr",
    title: "An in-page fetch() for JSON from iOS Safari",
    category: "mainstream-browser",
    provenance: "Fetch Metadata spec: same-origin cors/empty",
    notes: "Accept is */* here, and that is correct for fetch(). The accept-signature detector must not read it as a navigation.",
    requests: [{ ...browser("safariIos", { kind: "xhr" }), path: "/api/cart" }],
    expect: { verdict: "unknown", maxScore: 0, notDetectors: ["accept-signature"], action: "allow" },
  }),

  human({
    id: "chrome-subresource-image",
    title: "Chrome loading an image on the page",
    category: "mainstream-browser",
    provenance: "Fetch Metadata spec: no-cors/image",
    requests: [browser("chromeWindows", { kind: "subresource" })],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
  }),

  // ---------------------------------------------------------------------------
  // In-app browsers. A large and growing share of mobile traffic, and the group
  // most likely to be misread: the UA is a real engine wearing an app's badge.
  // ---------------------------------------------------------------------------
  human({
    id: "instagram-webview-ios",
    title: "Tapping a link in Instagram on iOS",
    category: "in-app-webview",
    provenance: "Instagram appends an 'Instagram <version>' token plus device metadata; no Safari/ token remains",
    requests: [
      plain(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 361.0.0.31.98 (iPhone16,2; iOS 18_5; en_US; en; scale=3.00; 1290x2796; 682468081)",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-US,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { verdict: "unknown", maxScore: 30, action: ["allow", "tag", "log"] },
  }),

  human({
    id: "facebook-webview-android",
    title: "Tapping a link in Facebook on Android",
    category: "in-app-webview",
    provenance: "Android Facebook webviews carry FB_IAB and FBAV tokens",
    requests: [
      plain(
        "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/149.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/491.0.0.42.63;]",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"], ["Accept-Language", "en-GB,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"], ["Sec-Fetch-Site", "none"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-Dest", "document"]],
      ),
    ],
    expect: { verdict: ["unknown", "suspected-bot"], action: ["allow", "tag", "log", "delay", "challenge"] },
    notes: "An Android webview claims Chrome but sends no Sec-CH-UA, so it scores. It must never be denied.",
  }),

  human({
    id: "tiktok-webview",
    title: "Tapping a link in TikTok",
    category: "in-app-webview",
    provenance: "TikTok webviews carry musical_ly or BytedanceWebview tokens",
    requests: [
      plain(
        "Mozilla/5.0 (Linux; Android 13; V2145 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.0.0 Mobile Safari/537.36 musical_ly_2023905040 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/39.5.4 ByteLocale/en ByteFullLocale/en Region/GB BytedanceWebview/d8a21c6",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"], ["Accept-Language", "en-GB,en;q=0.9"], ["Accept-Encoding", "gzip, deflate"]],
      ),
    ],
    expect: { verdict: ["unknown", "suspected-bot"], action: ["allow", "tag", "log", "delay", "challenge"] },
    notes: "Contains 'Bytedance' but NOT 'Bytespider'. A substring match on the vendor name here would block a person.",
  }),

  human({
    id: "snapchat-webview",
    title: "Tapping a link in Snapchat",
    category: "in-app-webview",
    provenance: "Snapchat webviews append a Snapchat token",
    requests: [
      plain(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.24.0.44 (like Safari/605.1.15)",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-US,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { verdict: ["unknown", "suspected-bot"], action: ["allow", "tag", "log", "delay", "challenge"] },
  }),

  human({
    id: "linkedin-webview",
    title: "Tapping a link in the LinkedIn app",
    category: "in-app-webview",
    provenance: "LinkedIn webviews carry a LinkedInApp token",
    notes: "Distinct from LinkedInBot, which is the unfurler. One is a person; the other is not.",
    requests: [
      plain(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-US,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { verdict: ["unknown", "suspected-bot"], action: ["allow", "tag", "log", "delay", "challenge"] },
  }),

  human({
    id: "vscode-simple-browser",
    title: "A developer opening a page in VS Code's Simple Browser",
    category: "embedded-app",
    provenance: "Electron UA emitted by VS Code webviews. This exact case was a shipped bug: Electron sat in the headless signature set and produced a proven-automation verdict for a person, which then looped on the challenge.",
    requests: [
      plain(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.95.3 Chrome/128.0.6613.36 Electron/32.2.1 Safari/537.36",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"], ["Accept-Language", "en-US"], ["Accept-Encoding", "gzip, deflate, br"], ["Sec-Fetch-Site", "none"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-Dest", "document"]],
      ),
    ],
    expect: { certain: false, botClass: ["unknown", "impersonator"], action: ["allow", "tag", "log", "delay", "challenge"] },
    tags: ["regression"],
  }),

  human({
    id: "slack-desktop",
    title: "Slack's desktop app opening a link internally",
    category: "embedded-app",
    provenance: "Electron-based desktop client",
    requests: [
      plain(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.44.65 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-GB"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge"] },
  }),

  // ---------------------------------------------------------------------------
  // Privacy-hardened clients. The population most likely to be misclassified, and
  // the one with the strongest reasons for its configuration.
  // ---------------------------------------------------------------------------
  human({
    id: "tor-browser",
    title: "Tor Browser",
    category: "privacy-hardened",
    provenance: "Tor Browser ships one frozen Firefox UA for every user on every platform, and normalises Accept-Language to en-US,en;q=0.5",
    notes: "The whole design goal is that every Tor user looks identical. It is Firefox-shaped and complete, so it should assess cleanly.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["User-Agent", "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"],
          ["Accept-Language", "en-US,en;q=0.5"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Connection", "keep-alive"],
          ["Upgrade-Insecure-Requests", "1"],
          ["Sec-Fetch-Dest", "document"],
          ["Sec-Fetch-Mode", "navigate"],
          ["Sec-Fetch-Site", "none"],
          ["Sec-Fetch-User", "?1"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
  }),

  human({
    id: "firefox-resist-fingerprinting",
    title: "Firefox with privacy.resistFingerprinting enabled",
    category: "privacy-hardened",
    provenance: "resistFingerprinting freezes the UA to a generic Windows Firefox ESR and pins Accept-Language to en-US",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["User-Agent", "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
          ["Accept-Language", "en-US, en"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Connection", "keep-alive"],
          ["Upgrade-Insecure-Requests", "1"],
          ["Sec-Fetch-Dest", "document"],
          ["Sec-Fetch-Mode", "navigate"],
          ["Sec-Fetch-Site", "none"],
          ["Sec-Fetch-User", "?1"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "unknown", maxScore: 20, action: ["allow", "tag", "log"] },
  }),

  human({
    id: "brave-shields",
    title: "Brave with Shields up",
    category: "privacy-hardened",
    provenance: "Brave presents an unmodified Chrome UA by design and does send Client Hints",
    requests: [browser("chromeWindows", { acceptLanguage: "en-US,en;q=0.9" })],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
  }),

  human({
    id: "ua-spoofing-extension",
    title: "A person running a User-Agent spoofing extension",
    category: "privacy-hardened",
    provenance: "Extensions rewrite navigator.userAgent and the UA header but cannot rewrite Sec-CH-UA, so the two disagree",
    notes:
      "A real person, and the library will score them: this is the exact contradiction the client-hints detector looks for. It is why that detector is capped at `strong` and can never block. The corpus records the cost — a challenge — rather than pretending it is zero.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Connection", "keep-alive"],
          ["sec-ch-ua", '"Not(A:Brand";v="99", "Google Chrome";v="152", "Chromium";v="152"'],
          ["sec-ch-ua-mobile", "?0"],
          ["sec-ch-ua-platform", '"Windows"'],
          ["Upgrade-Insecure-Requests", "1"],
          ["User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
          ["Sec-Fetch-Site", "none"],
          ["Sec-Fetch-Mode", "navigate"],
          ["Sec-Fetch-User", "?1"],
          ["Sec-Fetch-Dest", "document"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Accept-Language", "en-US,en;q=0.9"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  human({
    id: "cookies-blocked",
    title: "Somebody who blocks all cookies, browsing at length",
    category: "privacy-hardened",
    provenance: "session-integrity reports an actor that never returns any cookie after a dozen requests",
    notes: "Blocking cookies is a legitimate choice made by real people. The detector is capped at moderate for exactly this case.",
    requests: humanPaced(browser("chromeWindows", { kind: "same-origin-navigate", referer: "https://shop.example/" }), [
      "/", "/products", "/products/7", "/products/12", "/about", "/products/31", "/search?q=lamp",
      "/products/44", "/basket", "/products/9", "/delivery", "/products/18", "/contact", "/products/2",
    ]),
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  // ---------------------------------------------------------------------------
  // Assistive technology and text clients. Small populations, high stakes: these
  // are people for whom an alternative route around a block usually does not exist.
  // ---------------------------------------------------------------------------
  human({
    id: "lynx-text-browser",
    title: "Lynx, a text-mode browser",
    category: "assistive",
    provenance: "Lynx is used with refreshable braille displays and over slow links; it renders no JavaScript at all",
    notes: "A JavaScript challenge locks this person out permanently. That is the argument for contactHtml being mandatory.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Accept", "text/html, text/plain, text/sgml, text/css, application/xhtml+xml, */*;q=0.01"],
          ["Accept-Encoding", "gzip, compress, bzip2"],
          ["Accept-Language", "en"],
          ["User-Agent", "Lynx/2.9.2 libwww-FM/2.14 SSL-MM/1.4.1 OpenSSL/3.0.14"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost", "accessibility"],
  }),

  human({
    id: "w3m-text-browser",
    title: "w3m, a text-mode browser",
    category: "assistive",
    provenance: "Common in terminal workflows and on low-bandwidth connections",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["User-Agent", "w3m/0.5.3+git20230121"],
          ["Accept", "text/html, text/*;q=0.5, image/*, application/*, audio/*, */*;q=0.1"],
          ["Accept-Encoding", "gzip, deflate, br"],
          ["Accept-Language", "en;q=1.0"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost", "accessibility"],
  }),

  human({
    id: "screen-reader-firefox",
    title: "NVDA driving Firefox",
    category: "assistive",
    provenance: "A screen reader reads the rendered page; the HTTP request is an ordinary Firefox request",
    notes: "There is no header that distinguishes this from any other Firefox. It is here to make that point explicit: assistive technology is invisible at the HTTP layer, and any heuristic claiming to spot it is wrong.",
    requests: [browser("firefoxWindows")],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
    tags: ["accessibility"],
  }),

  // ---------------------------------------------------------------------------
  // Old and unusual devices. Disproportionately owned by people who cannot
  // simply buy a newer one.
  // ---------------------------------------------------------------------------
  human({
    id: "internet-explorer-11",
    title: "Internet Explorer 11 on Windows 10",
    category: "legacy-client",
    provenance: "Still present in government, healthcare and industrial deployments",
    requests: [
      {
        headers: [
          ["Accept", "text/html, application/xhtml+xml, image/jxr, */*"],
          ["Accept-Language", "en-GB"],
          ["User-Agent", "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko"],
          ["Accept-Encoding", "gzip, deflate"],
          ["Host", "shop.example"],
          ["Connection", "Keep-Alive"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    notes: "Note the header order: IE sends Host near the end, which trips the weakest header-order rule.",
    tags: ["known-cost"],
  }),

  human({
    id: "android-4-webview",
    title: "A ten-year-old Android tablet",
    category: "legacy-client",
    provenance: "Android 4.4 stock browser UA",
    requests: [
      plain(
        "Mozilla/5.0 (Linux; U; Android 4.4.2; en-gb; SM-T230 Build/KOT49H) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Safari/534.30",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-GB, en-US"], ["Accept-Encoding", "gzip, deflate"]],
      ),
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
  }),

  human({
    id: "smart-tv-browser",
    title: "A smart TV browser",
    category: "legacy-client",
    provenance: "Tizen browser on a Samsung television",
    requests: [
      plain(
        "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-US"], ["Accept-Encoding", "gzip, deflate"]],
      ),
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
  }),

  human({
    id: "playstation-browser",
    title: "A games console browser",
    category: "legacy-client",
    provenance: "PlayStation 5 system browser",
    requests: [
      plain(
        "Mozilla/5.0 (PlayStation; PlayStation 5/8.20) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-GB"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
  }),

  // ---------------------------------------------------------------------------
  // Normal browsing shapes. These exercise the behavioural detectors with traffic
  // that must not trigger them.
  // ---------------------------------------------------------------------------
  human({
    id: "reading-session",
    title: "A person reading a shop at human pace",
    category: "behaviour",
    provenance: "Irregular gaps, repeat visits, a referer chain and a session cookie",
    notes: "The revisits matter: a person's distinct-path ratio stays well below one, which is what separates reading from enumerating.",
    requests: humanPaced(browser("chromeWindows", { kind: "same-origin-navigate", cookie: "sid=a1b2c3; consent=1", referer: "https://shop.example/products" }), [
      "/", "/products", "/products/14", "/products", "/products/9", "/products/14", "/basket", "/products", "/products/9", "/checkout",
    ]),
    expect: { verdict: "unknown", maxScore: 20, notDetectors: ["cadence", "crawl-breadth", "session-integrity"], action: "allow" },
  }),

  human({
    id: "tab-restore-burst",
    title: "Restoring twelve pinned tabs at once after a browser restart",
    category: "behaviour",
    provenance: "A browser reopening a session issues a dozen navigations within a second",
    notes: "A burst that looks exactly like a flood, from one person pressing one button. It is why rate is capped at moderate and cannot deny service.",
    requests: Array.from({ length: 12 }, (_, index) => ({
      ...browser("chromeWindows", { cookie: "sid=restore-1" }),
      path: `/products/${index + 1}`,
      atMs: index * 40,
    })),
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  human({
    id: "documentation-reader",
    title: "A developer clicking through a documentation sidebar",
    category: "behaviour",
    provenance: "High distinct-path count with almost no revisits — the same shape as a crawler",
    notes: "Genuinely indistinguishable from enumeration by path pattern alone, which is why crawl-breadth is only `weak`.",
    requests: humanPaced(browser("firefoxWindows", { kind: "same-origin-navigate", cookie: "sid=docs-9", referer: "https://shop.example/docs" }), [
      "/docs/intro", "/docs/install", "/docs/config", "/docs/api/client", "/docs/api/server", "/docs/api/types",
      "/docs/guides/auth", "/docs/guides/deploy", "/docs/faq", "/docs/changelog", "/docs/api/errors", "/docs/api/events",
    ]),
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  human({
    id: "form-submission",
    title: "Submitting a login form",
    category: "behaviour",
    provenance: "POST with Origin and Referer, Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: navigate",
    requests: [
      { ...browser("chromeWindows", { kind: "same-origin-navigate", cookie: "sid=login-1", referer: "https://shop.example/login" }), method: "POST", path: "/login" },
    ],
    expect: { verdict: "unknown", maxScore: 0, action: ["allow", "delay"] },
  }),

  human({
    id: "conditional-revalidation",
    title: "A cache revalidation from a returning visitor",
    category: "behaviour",
    provenance: "Chrome adds If-None-Match and Cache-Control when revisiting a cached page",
    requests: [withCacheValidators(browser("chromeWindows", { kind: "navigate", cookie: "sid=return-4" }))],
    expect: { verdict: "unknown", maxScore: 0, action: "allow" },
  }),

  // ---------------------------------------------------------------------------
  // People behind infrastructure that mangles their requests. The site sees the
  // intermediary, not the person, and the person pays for it.
  // ---------------------------------------------------------------------------
  human({
    id: "corporate-proxy-stripped",
    title: "A person behind a corporate proxy that strips Sec-Fetch and Client Hints",
    category: "mangled-by-infrastructure",
    provenance: "Enterprise TLS-inspecting proxies routinely rebuild requests and drop headers they do not understand",
    notes: "Two of the strongest impersonation signals fire on a real employee. Neither may deny service; both are capped below `certain` for this reason.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Connection", "keep-alive"],
          ["User-Agent", userAgentOf("chromeWindows")],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
          ["Accept-Encoding", "gzip, deflate"],
          ["Accept-Language", "en-US,en;q=0.9"],
          ["Via", "1.1 corporate-proxy.internal (squid/6.6)"],
          ["X-Forwarded-For", "10.14.2.88"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  human({
    id: "carrier-transcoder",
    title: "A person on a mobile carrier that transcodes pages",
    category: "mangled-by-infrastructure",
    provenance: "Some carriers proxy and rewrite requests, adding their own headers and reordering the rest",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Accept-Encoding", "gzip"],
          ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
          ["User-Agent", userAgentOf("chromeAndroid")],
          ["Accept-Language", "en-GB,en;q=0.9"],
          ["Via", "1.1 wtp-proxy"],
          ["X-Forwarded-For", "100.64.12.9"],
        ],
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    notes: "Accept-Encoding arrives before Accept — the same ordering python-requests produces. A person, via a carrier.",
    tags: ["known-cost"],
  }),

  human({
    id: "http2-normalised",
    title: "A browser over HTTP/2, where header order carries no meaning",
    category: "mangled-by-infrastructure",
    provenance: "HTTP/2 uses HPACK and does not preserve a meaningful header order",
    notes:
      "The header-order detector must stand down entirely rather than read the normalised order as a fingerprint. Note also what is *absent*: HTTP/2 forbids connection-specific headers, so a genuine h2 request has no Connection. Leaving one in while claiming h2 — which an adapter does if it reads the version from a forwarded header rather than from its own socket — manufactures a proven protocol violation for a real browser.",
    requests: [
      {
        ...browser("chromeWindows"),
        httpVersion: "2.0",
        headers: browser("chromeWindows").headers.filter(([name]) => name.toLowerCase() !== "connection"),
      },
    ],
    expect: { verdict: "unknown", maxScore: 0, notDetectors: ["header-order"], action: "allow" },
  }),

  human({
    id: "cgnat-shared-address",
    title: "Many people behind one carrier-grade NAT address",
    category: "mangled-by-infrastructure",
    provenance: "CGNAT presents thousands of subscribers as a single address; RFC 6598 reserves 100.64.0.0/10 for it",
    notes: "Different devices, different browsers, one address. Under an IP-based actor key this is one very busy 'actor' — which is why identity-rotation ships disabled by default.",
    requests: [
      { ...browser("safariIos"), ip: "100.64.3.17", atMs: 0 },
      { ...browser("chromeAndroid"), ip: "100.64.3.17", atMs: 220 },
      { ...browser("samsungInternet"), ip: "100.64.3.17", atMs: 480 },
      { ...browser("safariIos"), ip: "100.64.3.17", atMs: 700 },
      { ...browser("chromeAndroid"), ip: "100.64.3.17", atMs: 910 },
      { ...browser("chromeWindows"), ip: "100.64.3.17", atMs: 1_150 },
    ],
    expect: { certain: false, action: ["allow", "tag", "log", "delay", "challenge", "rate-limit"] },
    tags: ["known-cost"],
  }),

  // ---------------------------------------------------------------------------
  // People doing the things a probe detector was built to notice.
  //
  // Every path-based signal has a population of real people who ask for the same
  // thing for an ordinary reason, and these are them. Both cases are tagged
  // `known-cost` because both do accumulate some suspicion — the point is the size of
  // it: enough to appear in a dashboard, nowhere near enough to interrupt anybody.
  // ---------------------------------------------------------------------------
  human({
    id: "wordpress-author-signing-in",
    title: "An author signing in to their own WordPress site",
    category: "platform-front-door",
    provenance: "/wp-login.php is a probe on the sites that do not run WordPress and the front door on the roughly forty per cent that do",
    notes:
      "`probe-signature` reports this at `moderate` and says so in its metadata, which is the honest reading: from a single request the library cannot know whether this site runs the platform. Configure the detector's `ignore` list, or the engine's `ignorePaths`, if it does — and note what the cap buys in the meantime, which is that forgetting costs a tag rather than a locked-out author.",
    requests: [{ ...browser("chromeWindows", { kind: "same-origin-navigate", referer: "https://shop.example/" }), path: "/wp-login.php" }],
    expect: { verdict: "unknown", maxScore: 40, action: ["allow", "tag", "log"] },
    tags: ["known-cost"],
  }),
  human({
    id: "developer-searching-for-sql-syntax",
    title: "Someone searching a documentation site for SQL syntax",
    category: "platform-front-door",
    provenance: "A search box on a site whose subject is databases, with the phrase a payload detector looks for typed into it",
    notes:
      "The reason the payload tiers are split by punctuation. `union select` typed into a search box is a person reading about SQL; `' union select` with the quote that makes it execute is not. Without that split, the population penalised most is the one reading documentation about the attack.",
    requests: [{ ...browser("chromeWindows", { kind: "same-origin-navigate", referer: "https://shop.example/docs" }), path: "/search?q=union+select+examples" }],
    // `rate-limit` is in the list because `protect-data` rate-limits search endpoints
    // for everybody, which is a policy decision about the path rather than a judgement
    // about this client. What the case asserts is the score.
    expect: { verdict: "unknown", maxScore: 40, action: ["allow", "tag", "log", "rate-limit"] },
    tags: ["known-cost"],
  }),
  human({
    id: "returning-reader-revalidating",
    title: "A returning reader whose browser still holds the page",
    category: "ordinary-browsing",
    provenance: "A revisit to a page the browser cached, sending the validators it was given",
    notes:
      "The evidence here points the other way. A client that revalidates a cached copy has been here before and kept what it was served, which is a property of a browsing session rather than of a fetch loop — `browsing-coherence` reports it as human-pointing, and the engine discounts any suspicion the behavioural detectors raise.",
    requests: [
      { ...browser("chromeWindows", { kind: "navigate", cookie: "session=8f2c1b; consent=1" }), path: "/guides/shipping", atMs: 0 },
      { ...browser("chromeWindows", { kind: "same-origin-navigate", cookie: "session=8f2c1b; consent=1", referer: "https://shop.example/guides/shipping", revalidate: { etag: 'W/"41d-19a0b2f3c11"' } }), path: "/guides/returns", atMs: 9_400 },
    ],
    expect: { verdict: ["unknown", "human"], maxScore: 20, detectors: ["browsing-coherence"], action: ["allow", "tag", "log"] },
  }),
];
