/**
 * User-Agent shape analysis.
 *
 * This is deliberately *not* a full UA-parsing library. Naming the exact browser and
 * version is a losing game — the string is client-controlled, frozen by vendors, and
 * lies constantly. What we extract instead is **structure**: does this string have
 * the shape a real browser emits, and do its parts agree with each other?
 *
 * Structure is far harder to fake convincingly than a product token, and — more
 * importantly — a structural contradiction is *deterministic* evidence in a way that
 * "the string says curl" never is.
 */

export type UaShape = "browser-like" | "declared-bot" | "library" | "empty" | "malformed" | "other";

export interface ParsedUserAgent {
  raw: string;
  lower: string;
  shape: UaShape;
  /** Product token we believe identifies the client, e.g. `"chrome"`, `"safari"`. */
  browser?: string | undefined;
  /** Major version as an integer, when one is present and plausible. */
  majorVersion?: number | undefined;
  /** Rendering engine token: `"blink"`, `"gecko"`, `"webkit"`. */
  engine?: string | undefined;
  /** Normalised OS family: `"windows"`, `"macos"`, `"linux"`, `"android"`, `"ios"`. */
  os?: string | undefined;
  /**
   * Every `Product/Version` pair, in order.
   *
   * Computed on first access and cached. Tokenising the whole string costs more than
   * every other part of parsing put together, and a mainstream browser User-Agent
   * never needs it — only unrecognised and library-shaped strings do. Reading this
   * property is cheap; reading it on a hot path for a browser is not.
   */
  readonly products: ReadonlyArray<UserAgentProduct>;
  /** True when the string names a URL or an email address anywhere. */
  declaresContact: boolean;
  /**
   * True when the string contains a word like `bot`, `crawler` or `spider`.
   *
   * Kept apart from {@link declaresContact} because the two together are a
   * declaration and either alone is not, and conflating them let a UA reach the
   * `certain` tier on the strength of a URL by itself.
   */
  declaresAutomation: boolean;
  /**
   * True when contact is published using the crawler convention — a `+` before the
   * URL or address, as in `+http://www.google.com/bot.html`.
   *
   * A bare URL in a User-Agent means very little: plenty of applications put their
   * own homepage or support address in one, and the people behind those are people.
   * The `+` prefix is the long-standing convention specifically for automation
   * announcing its operator, so it carries the intent that a bare URL does not.
   */
  usesContactConvention: boolean;
  /**
   * A Chromium fork or embedded build that does not reliably implement the modern
   * header set, named by its product token.
   *
   * This distinction is not pedantry, it is a very large population. "Chromium 89 and
   * later sends `Sec-CH-UA`" is true of Google Chrome and of the mainstream forks
   * that track it closely — Edge, Opera, Vivaldi, Brave, Samsung Internet — and false
   * of UC Browser, MIUI Browser, Huawei Browser, QQ Browser, Amazon Silk, television
   * and console builds, and many in-app WebViews, all of which are pinned to an older
   * Chromium or strip the headers. Between them those are hundreds of millions of
   * people, concentrated in South and East Asia.
   *
   * Detectors reasoning from the *absence* of Client Hints or Fetch Metadata must
   * stand down for these; detectors reading what is present carry on unchanged.
   */
  chromiumFork?: string | undefined;
}

export interface UserAgentProduct {
  name: string;
  version?: string | undefined;
}

const PRODUCT_PATTERN = /([A-Za-z][A-Za-z0-9._+-]{0,40})(?:\/([0-9][0-9A-Za-z._-]{0,20}))?/g;
const CONTACT_PATTERN = /https?:\/\/|\+http|@[a-z0-9-]+\.[a-z]{2,}/i;
/**
 * The convention crawlers use to name their operator.
 *
 * Usually a `+` prefix — `+http://www.google.com/bot.html` — which is the long-standing
 * form. A bare `mailto:` counts too: no browser has ever put one in a User-Agent, so
 * it carries the same declarative intent even without the plus, and several academic
 * and library crawlers use exactly that form.
 */
const CONTACT_CONVENTION = /\+(?:https?:\/\/|mailto:|[a-z0-9._%+-]+@)|mailto:[a-z0-9._%+-]+@/i;
/**
 * Words that mark a client as automated.
 *
 * Two alternatives, and the second one matters more than it looks. The first matches
 * a standalone word — `... compatible; Some Spider 1.0`. The second matches the
 * *compound* form that is by far the commonest crawler naming convention on the web:
 * `CrossrefBot`, `SmartNewsBot`, `PhishTankBot`, `AdzunaBot`. A pattern requiring a
 * non-letter before `bot` misses every one of them, which is how a corpus of real
 * crawler User-Agents found this: a well-behaved academic crawler naming itself and
 * publishing an address scored 15 and sailed through as unknown.
 *
 * The compound form requires at least two letters before the suffix, so a bare `bot`
 * is handled by the first alternative and a word like `robot` matches — which is
 * correct.
 */
const BOT_WORD =
  /(?:^|[^a-z])(?:bot|crawler|spider|scraper|crawl|indexer|fetcher|archiver|monitor(?:ing)?|checker|preview|slurp)(?:[^a-z]|$)|[a-z]{2,}(?:bot|crawler|spider|scraper|indexer|fetcher)(?:[^a-z]|$)/;

/** Longest UA we will process. Beyond this the string is not a UA, it is a payload. */
export const MAX_USER_AGENT_LENGTH = 512;

export function parseUserAgent(raw: string | undefined): ParsedUserAgent {
  if (raw === undefined || raw.trim().length === 0) {
    return { raw: raw ?? "", lower: "", shape: "empty", products: [], declaresContact: false, declaresAutomation: false, usesContactConvention: false };
  }

  // Truncate rather than reject: an over-long UA is itself a signal, and the
  // detectors that care see the raw length through `RequestFacts`.
  const value = raw.length > MAX_USER_AGENT_LENGTH ? raw.slice(0, MAX_USER_AGENT_LENGTH) : raw;
  const lower = value.toLowerCase();

  const parsed = new LazyUserAgent(value, lower, CONTACT_PATTERN.test(value), BOT_WORD.test(lower), CONTACT_CONVENTION.test(value));

  const os = detectOs(lower);
  if (os) parsed.os = os;

  const engine = detectEngine(lower);
  if (engine) parsed.engine = engine;

  const fork = NON_MAINSTREAM_CHROMIUM.find((token) => lower.includes(token));
  if (fork !== undefined) parsed.chromiumFork = fork;

  const browser = detectBrowser(lower);
  if (browser) {
    parsed.browser = browser.name;
    if (browser.majorVersion !== undefined) parsed.majorVersion = browser.majorVersion;
  }

  parsed.shape = classifyShape(lower, parsed);
  return parsed;
}

/** Backs {@link ParsedUserAgent.products} with a cache, so the tokeniser runs at most once. */
class LazyUserAgent implements ParsedUserAgent {
  shape: UaShape = "other";
  browser?: string | undefined;
  majorVersion?: number | undefined;
  engine?: string | undefined;
  os?: string | undefined;
  chromiumFork?: string | undefined;
  private cached: ReadonlyArray<UserAgentProduct> | undefined;

  constructor(
    readonly raw: string,
    readonly lower: string,
    readonly declaresContact: boolean,
    readonly declaresAutomation: boolean,
    readonly usesContactConvention: boolean,
  ) {}

  get products(): ReadonlyArray<UserAgentProduct> {
    if (this.cached !== undefined) return this.cached;
    const products: UserAgentProduct[] = [];
    PRODUCT_PATTERN.lastIndex = 0;
    for (let match = PRODUCT_PATTERN.exec(this.raw); match !== null; match = PRODUCT_PATTERN.exec(this.raw)) {
      products.push({ name: match[1]!.toLowerCase(), version: match[2] });
      if (products.length >= 24) break;
    }
    this.cached = products;
    return products;
  }
}

function classifyShape(lower: string, parsed: ParsedUserAgent): UaShape {
  if (parsed.declaresAutomation || parsed.declaresContact) return "declared-bot";
  // Bare library clients: a single product token, no Mozilla preamble.
  if (!lower.startsWith("mozilla/") && parsed.products.length <= 3 && parsed.browser === undefined) {
    return parsed.products.length === 0 ? "malformed" : "library";
  }
  if (parsed.browser !== undefined && parsed.engine !== undefined) return "browser-like";
  if (lower.startsWith("mozilla/")) return "browser-like";
  return "other";
}

function detectOs(lower: string): string | undefined {
  if (lower.includes("windows nt") || lower.includes("windows phone")) return "windows";
  if (lower.includes("android")) return "android";
  if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ios ")) return "ios";
  if (lower.includes("mac os x") || lower.includes("macintosh")) return "macos";
  if (lower.includes("cros ")) return "chromeos";
  if (lower.includes("linux") || lower.includes("x11")) return "linux";
  return undefined;
}

function detectEngine(lower: string): string | undefined {
  // Order matters: every Blink UA also claims "applewebkit" and "gecko" for
  // historical compatibility, so the most specific engine must win.
  if (lower.includes("edg/") || lower.includes("chrome/") || lower.includes("chromium/")) return "blink";
  if (lower.includes("firefox/") || lower.includes("gecko/")) return "gecko";
  if (lower.includes("applewebkit/")) return "webkit";
  return undefined;
}

/**
 * Product tokens marking a Chromium build that cannot be assumed to send the modern
 * header set — either a regional fork pinned to an old Chromium, an embedded WebView,
 * or a television and console browser.
 */
const NON_MAINSTREAM_CHROMIUM = [
  "ucbrowser",
  "miuibrowser",
  "huaweibrowser",
  "mqqbrowser",
  "qqbrowser",
  "heytapbrowser",
  "vivobrowser",
  "oppobrowser",
  "quark",
  "baidubrowser",
  "sogoumobilebrowser",
  "2345explorer",
  "maxthon",
  "puffin",
  "silk/",
  "; wv)",
  "smart-tv",
  "smarttv",
  "web0s",
  "tizen",
  "crkey",
  "nintendobrowser",
  "playstation",
  "xbox",
  "webappmanager",
] as const;

const BROWSER_TOKENS = ["edg", "edga", "edgios", "opr", "opera", "vivaldi", "brave", "samsungbrowser", "yabrowser", "duckduckgo", "firefox", "fxios", "chrome", "crios", "chromium", "safari"] as const;

function detectBrowser(lower: string): { name: string; majorVersion?: number | undefined } | undefined {
  // Most specific first: Edge and Opera both also claim "Chrome/", and every
  // Chromium browser also claims "Safari/".
  for (const token of BROWSER_TOKENS) {
    const at = lower.indexOf(`${token}/`);
    if (at === -1) continue;
    const major = readMajorVersion(lower, at + token.length + 1);
    return major === undefined ? { name: token } : { name: token, majorVersion: major };
  }
  return undefined;
}

/**
 * Reads the leading integer of a version at `start`. A hand-rolled scan rather than a
 * `parseInt` on a sliced substring, because this runs on every request and slicing
 * allocates a string purely to throw it away.
 */
function readMajorVersion(lower: string, start: number): number | undefined {
  let value = 0;
  let digits = 0;
  for (let i = start; i < lower.length && digits < 7; i++) {
    const code = lower.charCodeAt(i);
    if (code < 48 || code > 57) break;
    value = value * 10 + (code - 48);
    digits++;
  }
  return digits === 0 ? undefined : value;
}

/**
 * True when the string has the *shape* of a mainstream browser UA. Says nothing
 * about whether the claim is honest — that is what the consistency detectors are
 * for. Its job is to identify strings whose claims are worth cross-checking.
 */
export function claimsBrowser(parsed: ParsedUserAgent): boolean {
  return parsed.shape === "browser-like" && parsed.browser !== undefined;
}

/**
 * True when this client can be expected to implement Client Hints and Fetch Metadata.
 *
 * Only mainstream Chromium and Gecko qualify. Checks that reason from those headers
 * being *missing* must consult this first, or they report a strong signal on every
 * regional fork, television and in-app WebView on the internet.
 */
export function sendsModernHeaders(parsed: ParsedUserAgent): boolean {
  return parsed.chromiumFork === undefined;
}
