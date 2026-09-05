import { browser } from "./headers.js";
import { cookieJar, freshVisitorJar, returningCustomerJar } from "./cookies.js";
import { human } from "./schema.js";
import type { ProfileName, ProfileOptions } from "./headers.js";
import type { TrafficCase } from "./schema.js";

/**
 * People, browser by browser.
 *
 * Every current engine on every platform that carries meaningful traffic, each
 * request built with the whole apparatus a real browser sends: the Client Hints
 * block, the Fetch Metadata group, a cookie jar from a visitor who has actually used
 * the web, cache validators on a revisit, `Priority`, and the long tail of
 * conditional headers — `Sec-GPC`, `Save-Data`, `Sec-Purpose`, `Early-Data`,
 * `Sec-CH-Prefers-*`, the Network Information hints.
 *
 * The point of the volume is coverage of *populations*, not of code paths. Amazon
 * Silk, UC Browser, MIUI Browser and QQ Browser between them carry hundreds of
 * millions of people who are invisible in a corpus assembled from a European
 * developer's own devices — and they are precisely the clients that a naive "modern
 * Chromium sends Client Hints" check misclassifies.
 */

const SITE = "https://shop.example";

interface Scenario {
  suffix: string;
  title: string;
  options: ProfileOptions;
  path?: string;
}

/** One realistic first visit per profile: fresh cookies, no referrer, user-initiated. */
function landing(name: ProfileName, title: string, provenance: string, options: ProfileOptions = {}, notes?: string): TrafficCase {
  return human({
    id: `browse-${kebab(name)}`,
    title,
    category: "browser-population",
    provenance,
    ...(notes !== undefined ? { notes } : {}),
    requests: [{ ...browser(name, { cookie: freshVisitorJar(name), ...options }), path: "/" }],
    expect: { certain: false, verdict: ["unknown", "human"] },
  });
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Extra scenarios for the profiles that carry the most traffic. */
function scenarios(name: ProfileName, label: string, list: readonly Scenario[]): TrafficCase[] {
  return list.map((scenario) =>
    human({
      id: `browse-${kebab(name)}-${scenario.suffix}`,
      title: `${label}: ${scenario.title}`,
      category: "browser-scenario",
      provenance: "Header set derived from the engine's documented behaviour for this request kind",
      requests: [{ ...browser(name, scenario.options), ...(scenario.path !== undefined ? { path: scenario.path } : {}) }],
      expect: { certain: false, verdict: ["unknown", "human"] },
    }),
  );
}

const COMMON: readonly Scenario[] = [
  {
    suffix: "returning",
    title: "a returning customer following an internal link",
    path: "/products/1184",
    options: { kind: "same-origin-navigate", referer: `${SITE}/products`, cookie: returningCustomerJar("regular") },
  },
  {
    suffix: "high-entropy-hints",
    title: "after the server asked for high-entropy Client Hints",
    path: "/checkout",
    options: { kind: "same-origin-navigate", referer: `${SITE}/basket`, cookie: returningCustomerJar("hints"), highEntropyHints: true, prefers: { colorScheme: "dark", reducedMotion: "no-preference" } },
  },
  {
    suffix: "xhr",
    title: "an in-page fetch() for JSON",
    path: "/api/basket",
    options: { kind: "xhr", cookie: returningCustomerJar("xhr"), origin: SITE },
  },
  {
    suffix: "reload",
    title: "pressing reload on a page it already has cached",
    path: "/products/1184",
    options: { kind: "navigate", cookie: returningCustomerJar("reload"), reload: true, revalidate: { etag: 'W/"6a9-19256f0c1d8"', modifiedSince: "Fri, 29 Aug 2026 14:22:10 GMT" } },
  },
  {
    suffix: "form-post",
    title: "submitting the checkout form",
    path: "/checkout/confirm",
    options: { kind: "form-post", referer: `${SITE}/checkout`, origin: SITE, cookie: returningCustomerJar("post"), contentType: "application/x-www-form-urlencoded", contentLength: 284 },
  },
];

const MOBILE_EXTRAS: readonly Scenario[] = [
  {
    suffix: "metered",
    title: "on a metered connection with data saver on",
    path: "/products",
    options: { kind: "same-origin-navigate", referer: `${SITE}/`, cookie: cookieJar({ visitor: "metered" }), saveData: true, networkHints: { rtt: 300, downlink: 0.4, ect: "3g" } },
  },
  {
    suffix: "prefetch",
    title: "a speculative prefetch while a link is hovered",
    path: "/products/2210",
    options: { kind: "same-origin-navigate", referer: `${SITE}/products`, cookie: cookieJar({ visitor: "prefetch" }), prefetch: true },
  },
];

export const HUMAN_BROWSER_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Chromium desktop
  // ---------------------------------------------------------------------------
  landing("chromeWindows", "Chrome 152 on Windows 11", "2026 User-Agent lists; Chromium freezes the minor version fields to 0.0.0 so the header leaks less"),
  landing("chromeMac", "Chrome 152 on an Apple-silicon Mac", "2026 User-Agent lists; the platform is reported as macOS through Client Hints while the UA still says Mac OS X 10_15_7"),
  landing("chromeLinux", "Chrome 152 on Linux", "2026 User-Agent lists. A small population that trips heuristics keyed on desktop operating-system share"),
  landing("chromeChromeOs", "Chrome 151 on a Chromebook", "CrOS builds carry a board and milestone in the UA and report 'Chrome OS' as the platform hint"),
  landing("edgeWindows", "Edge 150 on Windows", "Edge reports Chromium brands alongside its own and truncates its version to major.0.0.0 in the UA"),
  landing("edgeMac", "Edge 150 on macOS", "The same build on a different platform; only the platform hint and UA platform token differ"),
  landing("operaWindows", "Opera 135 on Windows", "Opera carries an OPR/ token after the Chrome/ token and reports an Opera brand"),
  landing("vivaldiWindows", "Vivaldi 7.6 on Windows", "Vivaldi appends its own token and reports a Vivaldi brand alongside Chromium"),
  landing(
    "braveWindows",
    "Brave on Windows with Shields up",
    "Brave presents an unmodified Chrome identity by design so that its users are not singled out, and adds Sec-GPC",
    { gpc: true, dnt: true },
    "Deliberately indistinguishable from Chrome in the UA. The only tell is Sec-GPC, which is a privacy signal rather than an automation one — reading it as suspicious would invert its purpose.",
  ),
  landing("yandexWindows", "Yandex Browser 25.8 on Windows", "The dominant browser in Russia; reports YaBrowser and Yowser brands alongside Chromium"),

  // ---------------------------------------------------------------------------
  // Gecko
  // ---------------------------------------------------------------------------
  landing("firefoxWindows", "Firefox 148 on Windows", "2026 User-Agent lists. Gecko implements no Client Hints at all, which is correct and must not read as an omission"),
  landing("firefoxMac", "Firefox 148 on macOS", "2026 User-Agent lists"),
  landing("firefoxLinux", "Firefox 148 on Linux, German locale", "2026 User-Agent lists; a four-entry Accept-Language chain is entirely ordinary in Europe"),
  landing("firefoxEsr", "Firefox 140 ESR in a managed enterprise fleet", "ESR trails the release channel by roughly a year and is what most managed desktops run"),
  landing("firefoxAndroid", "Firefox 148 on Android", "Gecko on Android reports Mobile in the UA and, like desktop Gecko, sends no Client Hints"),

  // ---------------------------------------------------------------------------
  // WebKit
  // ---------------------------------------------------------------------------
  landing("safariMac", "Safari 18.7 on macOS", "WebKit interleaves the Fetch Metadata headers with content negotiation rather than grouping them"),
  landing("safariIos", "Safari 18.7 on an iPhone", "2026 User-Agent lists; the Mobile/15E148 build token has been frozen for years"),
  landing("safariIpad", "Safari 18.7 on an iPad", "iPadOS reports an iPad UA in mobile mode; in desktop-class mode it reports a Macintosh UA instead"),
  landing("chromeIos", "Chrome on iOS", "CriOS is WebKit underneath — iOS permits no other engine — so its header order is Safari's, not Chromium's", {}, "A client whose User-Agent says Chrome and whose header order says Safari. Both are true, and a naive engine-versus-order consistency check would call it a forgery."),
  landing("firefoxIos", "Firefox on iOS", "FxiOS is likewise WebKit; the Gecko name in the product token describes the brand, not the engine"),
  landing("edgeIos", "Edge on iOS", "EdgiOS is WebKit too; iOS permits no other engine, so every browser there shares Safari's header order"),
  landing("duckduckgoIos", "DuckDuckGo browser on iOS", "Appends a DuckDuckGo token to an otherwise standard Safari string", { gpc: true }),

  // ---------------------------------------------------------------------------
  // Chromium mobile
  // ---------------------------------------------------------------------------
  landing("chromeAndroid", "Chrome 150 on an Android phone", "The device string has been frozen to 'Android 10; K' since Chrome 110 to reduce passive fingerprinting"),
  landing(
    "chromeAndroidTablet",
    "Chrome 150 on an Android tablet",
    "Chromium omits the Mobile product token on tablets and sets Sec-CH-UA-Mobile to ?0 from the same internal state",
    {},
    "The case that caught a real bug: a check testing the User-Agent for the operating system rather than for the Mobile token read this correct pairing as a contradiction, on every Android tablet on the web.",
  ),
  landing("samsungInternet", "Samsung Internet 29 on a Galaxy S25", "The default browser on Samsung devices and the second most-used mobile browser worldwide"),
  landing("operaAndroid", "Opera 91 on Android, Indonesian locale", "Opera has a large share across Southeast Asia"),
  landing("edgeAndroid", "Edge 150 on Android", "EdgA is genuine Chromium and does send Client Hints"),

  // ---------------------------------------------------------------------------
  // Regional Chromium forks. Hundreds of millions of people, pinned to older
  // Chromium releases and not sending the modern header set.
  // ---------------------------------------------------------------------------
  landing(
    "ucBrowser",
    "UC Browser on Android in India",
    "UC Browser runs a Chromium fork pinned well behind the release channel and does not send Client Hints or Fetch Metadata",
    {},
    "A client claiming Chrome 100 with none of the headers Chrome 100 sends. Read literally that is a strong impersonation signal; read correctly it is one of the most-used browsers in South Asia.",
  ),
  landing("miBrowser", "MIUI Browser on a Xiaomi phone", "The default browser on Xiaomi devices, based on an older Chromium and shipping a reduced header set"),
  landing("huaweiBrowser", "Huawei Browser on an HMS device", "The default browser on Huawei devices outside Google Mobile Services"),
  landing("qqBrowser", "QQ Browser on Android in China", "One of the most-used mobile browsers in China; a Chromium fork with its own release cadence"),

  // ---------------------------------------------------------------------------
  // Televisions, consoles and embedded. Old engines, odd header sets, real people.
  // ---------------------------------------------------------------------------
  landing("silkKindle", "Amazon Silk on a Fire tablet", "Silk identifies itself as 'like Chrome' rather than as Chrome, and is a Chromium fork on Amazon's own cadence"),
  landing("tizenTv", "A Samsung television browser", "Tizen builds report SMART-TV and a Chromium version years behind the desktop channel"),
  landing("webOsTv", "An LG television browser", "webOS builds append WebAppManager and carry an old Chromium"),
  landing("playstation", "A PlayStation 5 system browser", "WebKit-based, with a frozen Version/16.0 and no Fetch Metadata"),
  landing("nintendoSwitch", "A Nintendo Switch browser", "The Switch's captive-portal browser, an old WebKit with a distinctive NintendoBrowser token"),

  // ---------------------------------------------------------------------------
  // The same clients doing the things people actually do with them.
  // ---------------------------------------------------------------------------
  ...scenarios("chromeWindows", "Chrome on Windows", COMMON),
  ...scenarios("firefoxWindows", "Firefox on Windows", COMMON),
  ...scenarios("safariMac", "Safari on macOS", COMMON),
  ...scenarios("edgeWindows", "Edge on Windows", COMMON),
  ...scenarios("safariIos", "Safari on iPhone", [...COMMON, ...MOBILE_EXTRAS]),
  ...scenarios("chromeAndroid", "Chrome on Android", [...COMMON, ...MOBILE_EXTRAS]),
  ...scenarios("samsungInternet", "Samsung Internet", MOBILE_EXTRAS),
  ...scenarios("chromeMac", "Chrome on macOS", COMMON.slice(0, 3)),
  ...scenarios("firefoxAndroid", "Firefox on Android", MOBILE_EXTRAS),

  // ---------------------------------------------------------------------------
  // The awkward edges of ordinary browsing.
  // ---------------------------------------------------------------------------
  human({
    id: "browse-early-data-resumption",
    title: "A TLS 1.3 resumption replayed as early data",
    category: "browser-scenario",
    provenance: "0-RTT resumption; the terminating proxy marks the request Early-Data: 1 so the origin can decide whether to risk replaying it",
    requests: [{ ...browser("chromeWindows", { cookie: returningCustomerJar("early"), earlyData: true, kind: "same-origin-navigate", referer: `${SITE}/` }), path: "/products" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-third-party-iframe",
    title: "A page embedded in a third-party iframe",
    category: "browser-scenario",
    provenance: "Cross-site iframe load; recent Chromium adds Sec-Fetch-Storage-Access to describe its storage partition",
    requests: [{ ...browser("chromeWindows", { kind: "iframe", referer: "https://partner.example/", storageAccess: "none" }), path: "/embed/widget" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-video-range-request",
    title: "A video player asking for a byte range",
    category: "browser-scenario",
    provenance: "HTML media elements issue Range requests with Sec-Fetch-Dest: video",
    requests: [{ ...browser("safariMac", { kind: "media", range: "bytes=2097152-4194303", referer: `${SITE}/products/1184` }), path: "/media/demo.mp4" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-eventsource-stream",
    title: "An EventSource stream for live stock updates",
    category: "browser-scenario",
    provenance: "EventSource sends Accept: text/event-stream and holds the connection open",
    requests: [{ ...browser("chromeWindows", { kind: "eventsource", cookie: returningCustomerJar("sse"), origin: SITE }), path: "/api/stock-stream" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-cross-origin-cors",
    title: "A cross-origin API call from a partner's page",
    category: "browser-scenario",
    provenance: "Cross-site fetch with an Origin header and Sec-Fetch-Site: cross-site",
    requests: [{ ...browser("chromeWindows", { kind: "cors", origin: "https://partner.example" }), path: "/api/public/catalog" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-stylesheet-and-script",
    title: "The subresources of a page load",
    category: "browser-scenario",
    provenance: "Stylesheet and script requests carry their own Accept values and Sec-Fetch-Dest",
    requests: [
      { ...browser("chromeWindows", { kind: "stylesheet", referer: `${SITE}/` }), path: "/assets/app.css", atMs: 0 },
      { ...browser("chromeWindows", { kind: "script", referer: `${SITE}/` }), path: "/assets/app.js", atMs: 40 },
      { ...browser("chromeWindows", { kind: "subresource", referer: `${SITE}/` }), path: "/assets/hero.avif", atMs: 90 },
    ],
    expect: { certain: false },
  }),
  human({
    id: "browse-dark-mode-reduced-motion",
    title: "Somebody who prefers dark mode and reduced motion",
    category: "browser-scenario",
    provenance: "Sec-CH-Prefers-Color-Scheme and Sec-CH-Prefers-Reduced-Motion, sent once a server advertises Accept-CH",
    notes: "Reduced motion is frequently an accessibility setting rather than a taste. A signal that read unusual preferences as suspicious would land hardest on the people least able to work around it.",
    requests: [{ ...browser("chromeWindows", { cookie: returningCustomerJar("prefs"), prefers: { colorScheme: "dark", reducedMotion: "reduce" }, highEntropyHints: true }), path: "/" }],
    expect: { certain: false },
    tags: ["accessibility"],
  }),
  human({
    id: "browse-layout-hints",
    title: "A responsive image request carrying layout hints",
    category: "browser-scenario",
    provenance: "Viewport-Width and DPR, sent when the server asks for them so it can pick an image size",
    requests: [{ ...browser("chromeAndroid", { kind: "subresource", layoutHints: { viewportWidth: 412, dpr: 2.625 }, referer: `${SITE}/products/1184` }), path: "/img/1184.avif" }],
    expect: { certain: false },
  }),
  human({
    id: "browse-do-not-track",
    title: "Somebody sending the deprecated DNT header",
    category: "browser-scenario",
    provenance: "DNT is deprecated and still sent by a meaningful minority, often alongside Sec-GPC",
    requests: [{ ...browser("firefoxWindows", { dnt: true, gpc: true, cookie: freshVisitorJar("dnt") }), path: "/" }],
    expect: { certain: false, verdict: "unknown" },
  }),
];
