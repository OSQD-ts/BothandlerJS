import type { CaseRequest } from "./schema.js";

/**
 * Header profiles for real clients.
 *
 * Three things here are load-bearing and easy to get wrong when writing fixtures by
 * hand.
 *
 * **Order.** Each engine emits headers in a fixed sequence that differs between
 * Chromium, Gecko and WebKit and barely changes across releases. It is one of the few
 * properties a scraper cannot fix by copying a User-Agent, so a corpus that gets the
 * order wrong is testing a client that does not exist.
 *
 * **Completeness.** A real browser sends a whole cluster together — the negotiation
 * headers, the `Sec-Fetch-*` set, the Client Hints on Chromium, a dozen cookies it
 * never asked for. Omitting one because it seemed unimportant turns a human fixture
 * into a bot fixture and quietly inverts what the case proves.
 *
 * **The optional apparatus.** Modern browsers carry a long tail of conditional
 * headers: high-entropy Client Hints once a server has asked for them, `Sec-GPC` from
 * privacy-preserving builds, `Save-Data` on metered connections, `Sec-Purpose` on
 * speculative loads, `Early-Data` on a TLS 1.3 resumption, cache validators on a
 * revisit. Each is modelled here because each is something a hand-rolled client
 * forgets, and because a corpus of only the happy path tests only the happy path.
 *
 * Sources: 2026 User-Agent lists; W3C `TR/fetch-metadata` for the `Sec-Fetch-*`
 * combinations; the UA Client Hints specification for the `Sec-CH-*` set; observed
 * request captures.
 */

export type Header = readonly [name: string, value: string];

/** What kind of request this is. Decides the `Sec-Fetch-*` set and the `Accept` value. */
export type RequestKind =
  /** Typing a URL or following a bookmark: no referrer, user-initiated. */
  | "navigate"
  /** Following a link within the site. */
  | "same-origin-navigate"
  /** Arriving from another site. */
  | "cross-site-navigate"
  /** A form POST back to the same origin. */
  | "form-post"
  /** `fetch()` for JSON from page script. */
  | "xhr"
  /** A cross-origin `fetch()` that will be preflighted. */
  | "cors"
  /** An image, font or stylesheet. */
  | "subresource"
  /** A stylesheet specifically. */
  | "stylesheet"
  /** A script tag. */
  | "script"
  /** A media byte-range request from a `<video>`. */
  | "media"
  /** An `EventSource` stream. */
  | "eventsource"
  /** A `<iframe>` load. */
  | "iframe";

export interface ProfileOptions {
  kind?: RequestKind;
  host?: string;
  /** Cookie header value. See `cookies.ts` for realistic jars. */
  cookie?: string;
  referer?: string;
  origin?: string;
  /** Overrides the profile's default language list — a real setting people change. */
  acceptLanguage?: string;
  /** High-entropy Client Hints, sent only after a server advertises `Accept-CH`. */
  highEntropyHints?: boolean;
  /** `DNT: 1`. Still sent by a meaningful minority despite being deprecated. */
  dnt?: boolean;
  /** `Sec-GPC: 1` — Global Privacy Control, sent by Brave, DuckDuckGo and others. */
  gpc?: boolean;
  /** `Save-Data: on` — a metered or data-saver connection. */
  saveData?: boolean;
  /** Network Information hints (`RTT`, `Downlink`, `ECT`), also gated behind `Accept-CH`. */
  networkHints?: { rtt: number; downlink: number; ect: "slow-2g" | "2g" | "3g" | "4g" };
  /** Layout hints (`Viewport-Width`, `DPR`, `Width`), gated behind `Accept-CH`. */
  layoutHints?: { viewportWidth: number; dpr: number };
  /** Conditional request headers from a revisit. */
  revalidate?: { etag?: string; modifiedSince?: string };
  /** `Cache-Control: max-age=0`, which a browser sends on an explicit reload. */
  reload?: boolean;
  /** `Sec-Purpose: prefetch` plus the legacy `Purpose` header. */
  prefetch?: boolean;
  /** `Sec-Fetch-Storage-Access`, sent by recent Chromium in third-party contexts. */
  storageAccess?: "none" | "active" | "inactive";
  /** User preference hints, sent when the server asks for them. */
  prefers?: { colorScheme?: "light" | "dark"; reducedMotion?: "no-preference" | "reduce" };
  /** `Early-Data: 1` — a TLS 1.3 0-RTT resumption replayed by an intermediary. */
  earlyData?: boolean;
  /** Byte range for a media request. */
  range?: string;
  /** Body content type for a POST. */
  contentType?: string;
  contentLength?: number;
}

const HOST = "shop.example";

interface EngineProfile {
  userAgent: string;
  acceptDocument: string;
  acceptEncoding: string;
  acceptLanguage: string;
  build: (options: ResolvedOptions, self: EngineProfile) => Header[];
}

type ResolvedOptions = ProfileOptions & Required<Pick<ProfileOptions, "host" | "kind" | "acceptLanguage">>;

// --- Fetch Metadata, per W3C TR/fetch-metadata -------------------------------

function fetchMetadata(kind: RequestKind): Header[] {
  switch (kind) {
    case "navigate":
      return [["Sec-Fetch-Site", "none"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-User", "?1"], ["Sec-Fetch-Dest", "document"]];
    case "same-origin-navigate":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-User", "?1"], ["Sec-Fetch-Dest", "document"]];
    case "cross-site-navigate":
      return [["Sec-Fetch-Site", "cross-site"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-User", "?1"], ["Sec-Fetch-Dest", "document"]];
    case "form-post":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-User", "?1"], ["Sec-Fetch-Dest", "document"]];
    case "xhr":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "cors"], ["Sec-Fetch-Dest", "empty"]];
    case "cors":
      return [["Sec-Fetch-Site", "cross-site"], ["Sec-Fetch-Mode", "cors"], ["Sec-Fetch-Dest", "empty"]];
    case "subresource":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "no-cors"], ["Sec-Fetch-Dest", "image"]];
    case "stylesheet":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "no-cors"], ["Sec-Fetch-Dest", "style"]];
    case "script":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "no-cors"], ["Sec-Fetch-Dest", "script"]];
    case "media":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "no-cors"], ["Sec-Fetch-Dest", "video"]];
    case "eventsource":
      return [["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "cors"], ["Sec-Fetch-Dest", "empty"]];
    case "iframe":
      return [["Sec-Fetch-Site", "cross-site"], ["Sec-Fetch-Mode", "navigate"], ["Sec-Fetch-Dest", "iframe"]];
  }
}

function acceptFor(kind: RequestKind, documentAccept: string): string {
  switch (kind) {
    case "xhr":
    case "cors":
      return "*/*";
    case "eventsource":
      return "text/event-stream";
    case "subresource":
      return "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
    case "stylesheet":
      return "text/css,*/*;q=0.1";
    case "script":
      return "*/*";
    case "media":
      return "*/*";
    default:
      return documentAccept;
  }
}

const isNavigation = (kind: RequestKind): boolean => kind.endsWith("navigate") || kind === "form-post";

/** Headers a browser adds only in particular circumstances. Shared by every engine. */
function conditional(options: ResolvedOptions): { early: Header[]; late: Header[] } {
  const early: Header[] = [];
  const late: Header[] = [];

  if (options.reload === true) early.push(["Cache-Control", "max-age=0"]);
  if (options.earlyData === true) early.push(["Early-Data", "1"]);
  if (options.revalidate?.etag !== undefined) early.push(["If-None-Match", options.revalidate.etag]);
  if (options.revalidate?.modifiedSince !== undefined) early.push(["If-Modified-Since", options.revalidate.modifiedSince]);
  if (options.range !== undefined) early.push(["Range", options.range]);

  if (options.dnt === true) late.push(["DNT", "1"]);
  if (options.gpc === true) late.push(["Sec-GPC", "1"]);
  if (options.saveData === true) late.push(["Save-Data", "on"]);
  if (options.networkHints) {
    late.push(["RTT", String(options.networkHints.rtt)], ["Downlink", String(options.networkHints.downlink)], ["ECT", options.networkHints.ect]);
  }
  if (options.layoutHints) {
    late.push(["Viewport-Width", String(options.layoutHints.viewportWidth)], ["DPR", String(options.layoutHints.dpr)]);
  }
  if (options.prefetch === true) late.push(["Sec-Purpose", "prefetch"], ["Purpose", "prefetch"]);

  return { early, late };
}

function body(options: ResolvedOptions): Header[] {
  if (options.contentType === undefined) return [];
  const headers: Header[] = [["Content-Type", options.contentType]];
  if (options.contentLength !== undefined) headers.push(["Content-Length", String(options.contentLength)]);
  return headers;
}

// --- Chromium ----------------------------------------------------------------

interface ChromiumBrands {
  /** Low-entropy brand list, always sent on a secure context. */
  brands: string;
  /** Full-version list, sent only once the server has advertised `Accept-CH`. */
  fullVersions: string;
  platform: string;
  platformVersion: string;
  mobile: boolean;
  model?: string;
  arch?: string;
  bitness?: string;
}

/**
 * Chromium's order: connection management, then the Client Hints block, then the
 * identity, then content negotiation split either side of the Fetch Metadata group.
 */
function chromiumBuild(brands: ChromiumBrands) {
  return (options: ResolvedOptions, self: EngineProfile): Header[] => {
    const nav = isNavigation(options.kind);
    const { early, late } = conditional(options);
    const hints: Header[] = [
      ["sec-ch-ua", brands.brands],
      ["sec-ch-ua-mobile", brands.mobile ? "?1" : "?0"],
      ["sec-ch-ua-platform", `"${brands.platform}"`],
    ];
    if (options.highEntropyHints === true) {
      hints.push(
        ["sec-ch-ua-full-version-list", brands.fullVersions],
        ["sec-ch-ua-platform-version", `"${brands.platformVersion}"`],
        ["sec-ch-ua-arch", `"${brands.arch ?? (brands.mobile ? "arm" : "x86")}"`],
        ["sec-ch-ua-bitness", `"${brands.bitness ?? "64"}"`],
        ["sec-ch-ua-model", `"${brands.model ?? ""}"`],
      );
    }
    if (options.prefers?.colorScheme !== undefined) hints.push(["Sec-CH-Prefers-Color-Scheme", options.prefers.colorScheme]);
    if (options.prefers?.reducedMotion !== undefined) hints.push(["Sec-CH-Prefers-Reduced-Motion", options.prefers.reducedMotion]);

    return [
      ["Host", options.host],
      ["Connection", "keep-alive"],
      ...early,
      ...hints,
      ...(nav ? ([["Upgrade-Insecure-Requests", "1"]] as Header[]) : []),
      ["User-Agent", self.userAgent],
      ...(options.origin !== undefined ? ([["Origin", options.origin]] as Header[]) : []),
      ...body(options),
      ["Accept", acceptFor(options.kind, self.acceptDocument)],
      ...fetchMetadata(options.kind),
      ...(options.storageAccess !== undefined ? ([["Sec-Fetch-Storage-Access", options.storageAccess]] as Header[]) : []),
      ...(options.referer !== undefined ? ([["Referer", options.referer]] as Header[]) : []),
      ["Accept-Encoding", self.acceptEncoding],
      ["Accept-Language", options.acceptLanguage],
      ...late,
      ["Priority", nav ? "u=0, i" : "u=1, i"],
      ...(options.cookie !== undefined ? ([["Cookie", options.cookie]] as Header[]) : []),
    ];
  };
}

// --- Gecko -------------------------------------------------------------------

/** Firefox leads with identity and content negotiation, and closes with Fetch Metadata. */
function geckoBuild(options: ResolvedOptions, self: EngineProfile): Header[] {
  const nav = isNavigation(options.kind);
  const { early, late } = conditional(options);
  return [
    ["Host", options.host],
    ["User-Agent", self.userAgent],
    ["Accept", acceptFor(options.kind, self.acceptDocument)],
    ["Accept-Language", options.acceptLanguage],
    ["Accept-Encoding", self.acceptEncoding],
    ...(options.referer !== undefined ? ([["Referer", options.referer]] as Header[]) : []),
    ...(options.origin !== undefined ? ([["Origin", options.origin]] as Header[]) : []),
    ...body(options),
    ...late,
    ["Connection", "keep-alive"],
    ...(options.cookie !== undefined ? ([["Cookie", options.cookie]] as Header[]) : []),
    ...early,
    ...(nav ? ([["Upgrade-Insecure-Requests", "1"]] as Header[]) : []),
    ...reorderForGecko(fetchMetadata(options.kind)),
    ["Priority", nav ? "u=0, i" : "u=4"],
    ["TE", "trailers"],
  ];
}

/** Gecko emits Dest, Mode, Site, User — the reverse of Chromium's grouping. */
function reorderForGecko(headers: Header[]): Header[] {
  const order = ["Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User"];
  return order.flatMap((name) => headers.filter(([header]) => header === name));
}

// --- WebKit ------------------------------------------------------------------

/** Safari interleaves Fetch Metadata with content negotiation rather than grouping it. */
function webkitBuild(options: ResolvedOptions, self: EngineProfile): Header[] {
  const metadata = new Map(fetchMetadata(options.kind));
  const { early, late } = conditional(options);
  return [
    ["Host", options.host],
    ...early,
    ...(metadata.has("Sec-Fetch-Dest") ? ([["Sec-Fetch-Dest", metadata.get("Sec-Fetch-Dest")!]] as Header[]) : []),
    ["User-Agent", self.userAgent],
    ...(options.origin !== undefined ? ([["Origin", options.origin]] as Header[]) : []),
    ...body(options),
    ["Accept", acceptFor(options.kind, self.acceptDocument)],
    ...(metadata.has("Sec-Fetch-Site") ? ([["Sec-Fetch-Site", metadata.get("Sec-Fetch-Site")!]] as Header[]) : []),
    ["Accept-Language", options.acceptLanguage],
    ...(metadata.has("Sec-Fetch-Mode") ? ([["Sec-Fetch-Mode", metadata.get("Sec-Fetch-Mode")!]] as Header[]) : []),
    ["Accept-Encoding", self.acceptEncoding],
    ...(metadata.has("Sec-Fetch-User") ? ([["Sec-Fetch-User", metadata.get("Sec-Fetch-User")!]] as Header[]) : []),
    ...(options.referer !== undefined ? ([["Referer", options.referer]] as Header[]) : []),
    ...late,
    ["Connection", "keep-alive"],
    ...(options.cookie !== undefined ? ([["Cookie", options.cookie]] as Header[]) : []),
  ];
}

/** Older WebKit and embedded builds: no Fetch Metadata at all. */
function legacyWebkitBuild(options: ResolvedOptions, self: EngineProfile): Header[] {
  const { early, late } = conditional(options);
  return [
    ["Host", options.host],
    ...early,
    ["User-Agent", self.userAgent],
    ...body(options),
    ["Accept", acceptFor(options.kind, self.acceptDocument)],
    ["Accept-Language", options.acceptLanguage],
    ["Accept-Encoding", self.acceptEncoding],
    ...(options.referer !== undefined ? ([["Referer", options.referer]] as Header[]) : []),
    ...late,
    ["Connection", "keep-alive"],
    ...(options.cookie !== undefined ? ([["Cookie", options.cookie]] as Header[]) : []),
  ];
}

// --- Accept values -----------------------------------------------------------

const CHROME_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const FIREFOX_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8";
const SAFARI_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const LEGACY_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function chromium(version: string, fullVersion: string, platform: string, platformVersion: string, mobile: boolean, extra?: Partial<ChromiumBrands>): ChromiumBrands {
  return {
    brands: `"Not(A:Brand";v="99", "Google Chrome";v="${version}", "Chromium";v="${version}"`,
    fullVersions: `"Not(A:Brand";v="99.0.0.0", "Google Chrome";v="${fullVersion}", "Chromium";v="${fullVersion}"`,
    platform,
    platformVersion,
    mobile,
    ...extra,
  };
}

// --- The profiles ------------------------------------------------------------

export const PROFILES = {
  // ---- Chromium desktop ----
  chromeWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild(chromium("152", "152.0.7258.67", "Windows", "15.0.0", false)),
  },
  chromeMac: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-GB,en-US;q=0.9,en;q=0.8",
    build: chromiumBuild(chromium("152", "152.0.7258.67", "macOS", "15.6.0", false, { arch: "arm" })),
  },
  chromeLinux: {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild(chromium("152", "152.0.7258.67", "Linux", "6.11.0", false)),
  },
  chromeChromeOs: {
    userAgent: "Mozilla/5.0 (X11; CrOS x86_64 15886.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild(chromium("151", "151.0.7204.183", "Chrome OS", "15886.69.0", false)),
  },
  edgeWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild({
      brands: '"Microsoft Edge";v="150", "Not(A:Brand";v="24", "Chromium";v="150"',
      fullVersions: '"Microsoft Edge";v="150.0.3296.62", "Not(A:Brand";v="24.0.0.0", "Chromium";v="150.0.7061.181"',
      platform: "Windows",
      platformVersion: "15.0.0",
      mobile: false,
    }),
  },
  edgeMac: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild({
      brands: '"Microsoft Edge";v="150", "Not(A:Brand";v="24", "Chromium";v="150"',
      fullVersions: '"Microsoft Edge";v="150.0.3296.62", "Not(A:Brand";v="24.0.0.0", "Chromium";v="150.0.7061.181"',
      platform: "macOS",
      platformVersion: "15.6.0",
      mobile: false,
    }),
  },
  operaWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 OPR/135.0.0.0",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild({
      brands: '"Chromium";v="149", "Not(A:Brand";v="24", "Opera";v="135"',
      fullVersions: '"Chromium";v="149.0.7003.108", "Not(A:Brand";v="24.0.0.0", "Opera";v="135.0.6312.44"',
      platform: "Windows",
      platformVersion: "15.0.0",
      mobile: false,
    }),
  },
  vivaldiWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Vivaldi/7.6.3797.48",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild({
      brands: '"Chromium";v="148", "Not(A:Brand";v="24", "Vivaldi";v="7.6"',
      fullVersions: '"Chromium";v="148.0.6873.120", "Not(A:Brand";v="24.0.0.0", "Vivaldi";v="7.6.3797.48"',
      platform: "Windows",
      platformVersion: "15.0.0",
      mobile: false,
    }),
  },
  /** Brave presents an unmodified Chrome identity by design, and adds Sec-GPC. */
  braveWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild(chromium("152", "152.0.0.0", "Windows", "15.0.0", false)),
  },
  yandexWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 YaBrowser/25.8.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "ru,en;q=0.9",
    build: chromiumBuild({
      brands: '"Chromium";v="146", "YaBrowser";v="25.8", "Not(A:Brand";v="24", "Yowser";v="2.5"',
      fullVersions: '"Chromium";v="146.0.6664.111", "YaBrowser";v="25.8.0.1234", "Not(A:Brand";v="24.0.0.0"',
      platform: "Windows",
      platformVersion: "15.0.0",
      mobile: false,
    }),
  },

  // ---- Gecko ----
  firefoxWindows: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
    acceptDocument: FIREFOX_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.5",
    build: geckoBuild,
  },
  firefoxMac: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    acceptDocument: FIREFOX_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-GB,en;q=0.5",
    build: geckoBuild,
  },
  firefoxLinux: {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
    acceptDocument: FIREFOX_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "de-DE,de;q=0.8,en-US;q=0.5,en;q=0.3",
    build: geckoBuild,
  },
  firefoxEsr: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    acceptDocument: FIREFOX_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.5",
    build: geckoBuild,
  },
  firefoxAndroid: {
    userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:148.0) Gecko/148.0 Firefox/148.0",
    acceptDocument: FIREFOX_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-GB,en;q=0.5",
    build: geckoBuild,
  },

  // ---- WebKit ----
  safariMac: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-GB,en;q=0.9",
    build: webkitBuild,
  },
  safariIos: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-US,en;q=0.9",
    build: webkitBuild,
  },
  safariIpad: {
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-GB,en;q=0.9",
    build: webkitBuild,
  },
  /** Chrome on iOS is WebKit underneath — the engine, and so the header order, is Safari's. */
  chromeIos: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.7258.60 Mobile/15E148 Safari/604.1",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-US,en;q=0.9",
    build: webkitBuild,
  },
  firefoxIos: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-US,en;q=0.9",
    build: webkitBuild,
  },
  edgeIos: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/150.0.3296.60 Mobile/15E148 Safari/605.1.15",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-US,en;q=0.9",
    build: webkitBuild,
  },
  duckduckgoIos: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1 DuckDuckGo/7",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-US,en;q=0.9",
    build: webkitBuild,
  },

  // ---- Chromium mobile ----
  chromeAndroid: {
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-GB,en;q=0.9",
    build: chromiumBuild(chromium("150", "150.0.7061.181", "Android", "15.0.0", true, { model: "Pixel 9" })),
  },
  chromeAndroidTablet: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild(chromium("150", "150.0.7061.181", "Android", "15.0.0", false, { model: "SM-X910" })),
  },
  samsungInternet: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/147.0.0.0 Mobile Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    build: chromiumBuild({
      brands: '"Chromium";v="147", "Not(A:Brand";v="24", "Samsung Internet";v="29.0"',
      fullVersions: '"Chromium";v="147.0.6929.94", "Not(A:Brand";v="24.0.0.0", "Samsung Internet";v="29.0.0.0"',
      platform: "Android",
      platformVersion: "15.0.0",
      mobile: true,
      model: "SM-S938B",
    }),
  },
  operaAndroid: {
    userAgent: "Mozilla/5.0 (Linux; Android 14; CPH2451) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36 OPR/91.0.0.0",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "id-ID,id;q=0.9,en-US;q=0.8",
    build: chromiumBuild({
      brands: '"Chromium";v="146", "Not(A:Brand";v="24", "Opera";v="91"',
      fullVersions: '"Chromium";v="146.0.6664.111", "Not(A:Brand";v="24.0.0.0", "Opera";v="91.0.4516.22"',
      platform: "Android",
      platformVersion: "14.0.0",
      mobile: true,
      model: "CPH2451",
    }),
  },
  edgeAndroid: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 EdgA/150.0.3296.60",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    build: chromiumBuild({
      brands: '"Microsoft Edge";v="150", "Not(A:Brand";v="24", "Chromium";v="150"',
      fullVersions: '"Microsoft Edge";v="150.0.3296.60", "Not(A:Brand";v="24.0.0.0", "Chromium";v="150.0.7061.181"',
      platform: "Android",
      platformVersion: "15.0.0",
      mobile: true,
      model: "Pixel 9",
    }),
  },
  /** UC Browser — very large user base across South and Southeast Asia. */
  ucBrowser: {
    userAgent: "Mozilla/5.0 (Linux; U; Android 13; en-IN; RMX3771 Build/TP1A.220905.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/13.7.5.1329 Mobile Safari/537.36",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "en-IN,en-US;q=0.9,en;q=0.8,hi;q=0.7",
    build: legacyWebkitBuild,
  },
  miBrowser: {
    userAgent: "Mozilla/5.0 (Linux; U; Android 14; en-in; 23049PCD8I Build/UKQ1.230917.001) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/533.1 XiaoMi/MiuiBrowser/19.4.220521",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "en-IN,en;q=0.9",
    build: legacyWebkitBuild,
  },
  huaweiBrowser: {
    userAgent: "Mozilla/5.0 (Linux; Android 12; ELS-NX9; HMSCore 6.14.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.186 HuaweiBrowser/15.0.5.310 Mobile Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    build: legacyWebkitBuild,
  },
  qqBrowser: {
    userAgent: "Mozilla/5.0 (Linux; U; Android 14; zh-cn; 2211133C Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 MQQBrowser/15.7 Mobile Safari/537.36",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "zh-CN,zh;q=0.9",
    build: legacyWebkitBuild,
  },

  // ---- Consoles, televisions and embedded ----
  silkKindle: {
    userAgent: "Mozilla/5.0 (Linux; Android 11; KFRAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/128.1.2 like Chrome/128.0.6613.146 Safari/537.36",
    acceptDocument: CHROME_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-GB,en;q=0.9",
    build: legacyWebkitBuild,
  },
  tizenTv: {
    userAgent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) AppleWebKit/537.36 (KHTML, like Gecko) 108.0.5359.1/8.0 TV Safari/537.36",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "en-US",
    build: legacyWebkitBuild,
  },
  webOsTv: {
    userAgent: "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.215 Safari/537.36 WebAppManager",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "en-GB",
    build: legacyWebkitBuild,
  },
  playstation: {
    userAgent: "Mozilla/5.0 (PlayStation; PlayStation 5/9.60) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    acceptDocument: SAFARI_ACCEPT,
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-GB",
    build: legacyWebkitBuild,
  },
  nintendoSwitch: {
    userAgent: "Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/609.4 (KHTML, like Gecko) NF/6.0.2.23.4 NintendoBrowser/5.1.0.23519",
    acceptDocument: LEGACY_ACCEPT,
    acceptEncoding: "gzip, deflate",
    acceptLanguage: "en-GB",
    build: legacyWebkitBuild,
  },
} as const satisfies Record<string, EngineProfile>;

export type ProfileName = keyof typeof PROFILES;
export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

/** Builds a request from a named profile. The normal way to write a human case. */
export function browser(name: ProfileName, options: ProfileOptions = {}): CaseRequest {
  const profile = PROFILES[name] as EngineProfile;
  const resolved: ResolvedOptions = {
    ...options,
    host: options.host ?? HOST,
    kind: options.kind ?? "navigate",
    acceptLanguage: options.acceptLanguage ?? profile.acceptLanguage,
  };
  return {
    headers: profile.build(resolved, profile),
    protocol: "https",
    httpVersion: "1.1",
    ...(options.kind === "form-post" ? { method: "POST" } : {}),
  };
}

/** The raw User-Agent of a profile, for cases that alter it deliberately. */
export function userAgentOf(name: ProfileName): string {
  return (PROFILES[name] as EngineProfile).userAgent;
}

/**
 * A minimal bot-shaped request: a User-Agent and whatever else you name.
 *
 * Most automation really does send this little. Where a specific client is known to
 * send more, the case says so explicitly rather than using this helper.
 */
export function plain(userAgent: string, extra: readonly Header[] = [], host = HOST): CaseRequest {
  // `extra` *replaces* a default of the same name rather than following it. A client
  // that sent `Accept: */*` and then a second, different `Accept` does not exist, and
  // building one here made two human fixtures look hand-assembled the moment
  // `header-integrity` learned to read repeated fields.
  const overridden = new Set(extra.map(([name]) => name.toLowerCase()));
  const defaults: Header[] = ([["Host", host], ["User-Agent", userAgent], ["Accept", "*/*"]] as Header[]).filter(([name]) => !overridden.has(name.toLowerCase()));
  return {
    headers: [...defaults, ...extra],
    protocol: "https",
    httpVersion: "1.1",
  };
}

/**
 * A well-behaved crawler's request: identity, a contact address, and the negotiation
 * headers a fetcher that intends to parse HTML actually sends.
 */
export function crawler(userAgent: string, options: { from?: string; accept?: string; encoding?: string; host?: string; extra?: readonly Header[] } = {}): CaseRequest {
  return {
    headers: [
      ["Host", options.host ?? HOST],
      ["User-Agent", userAgent],
      ["Accept", options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
      ["Accept-Encoding", options.encoding ?? "gzip, deflate, br"],
      ...(options.from !== undefined ? ([["From", options.from]] as Header[]) : []),
      ["Connection", "keep-alive"],
      ...(options.extra ?? []),
    ],
    protocol: "https",
    httpVersion: "1.1",
  };
}
