import { MAX_USER_AGENT_LENGTH, claimsBrowser } from "../internal/ua.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Does this User-Agent contradict *itself*?
 *
 * Every other single-request detector compares the User-Agent against something else
 * — the Client Hints, the header set, the header order. This one needs nothing but
 * the string, which makes it the only consistency check that still works on a source
 * with no headers at all: an nginx access line, a CDN log, a WAF event. That is not a
 * small population, and until now every one of those requests reached the engine with
 * exactly one usable detector.
 *
 * What it looks for is a string describing a client that has never existed. Two
 * rendering engines at once. Two operating systems at once. Chrome on an iPhone,
 * where Apple's rules mean Chrome is WebKit and says `CriOS`. A browser preamble no
 * browser has emitted since 2009. These are not "unusual" — they are impossible, and
 * they are what a User-Agent *randomiser* produces, because randomisers assemble a
 * string from independent lists of browsers, versions and platforms and never check
 * that the combination is one that ships.
 *
 * **Why none of it is `certain`.** The same reason `client-hints` is not: the client
 * controls this string end to end, and the population that rewrites it badly includes
 * privacy extensions, enterprise UA policies, developer emulation, and a long tail of
 * embedded devices whose vendor concatenated two templates. A self-contradiction is
 * excellent evidence that the string is fabricated; it is not evidence about who
 * fabricated it, and a person with a UA-spoofing extension has fabricated one too.
 *
 * The version-versus-platform checks are deliberately the weakest thing here, because
 * the "impossible" combination is only impossible on the vendor's own builds. Chrome
 * ended Windows 7 support at 109, and Supermium and Thorium then shipped Chrome 120+
 * on Windows 7 to a real, if small, population. Reported as `moderate`; never more.
 */
export function uaCoherenceDetector(): Detector {
  return {
    id: "ua-coherence",
    description: "Reads the User-Agent against itself: engines, platforms and versions that never shipped together",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const ua = ctx.ua;
      if (ua.shape === "empty" || ua.raw.length === 0) return undefined;
      const lower = ua.lower;
      const results: Evidence[] = [];

      // --- Two engines in one string. ---
      //
      // Gecko never carries `AppleWebKit`, WebKit never carries `Firefox/`, and
      // Trident predates both. Chromium claims `AppleWebKit/537.36 (KHTML, like
      // Gecko)` for historical compatibility, which is why the pairs below are stated
      // as explicit product tokens rather than as engine families.
      const engines: string[] = [];
      if (lower.includes("firefox/")) engines.push("Firefox");
      if (lower.includes("chrome/") || lower.includes("chromium/")) engines.push("Chrome");
      if (lower.includes("trident/") || lower.includes("msie ")) engines.push("Trident");
      if (engines.length > 1) {
        results.push({
          detector: "ua-coherence",
          summary: `User-Agent claims ${engines.join(" and ")} at once, which is not a browser that exists`,
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { engines, userAgent: ua.raw.slice(0, 200) },
        });
      } else if (lower.includes("firefox/") && lower.includes("applewebkit/")) {
        // Firefox on iOS is the exception that proves this: it is WebKit, and it says
        // `FxiOS`, never `Firefox/`.
        results.push({
          detector: "ua-coherence",
          summary: "User-Agent claims Firefox but also claims the AppleWebKit engine, which Gecko never reports",
          direction: "bot",
          certainty: "strong",
          weight: 0.65,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { userAgent: ua.raw.slice(0, 200) },
        });
      }

      // --- Two platforms in one string. ---
      const platforms = platformTokens(lower);
      if (platforms.length > 1) {
        results.push({
          detector: "ua-coherence",
          summary: `User-Agent names ${platforms.join(" and ")} in the same string`,
          direction: "bot",
          certainty: "strong",
          weight: 0.65,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { platforms, userAgent: ua.raw.slice(0, 200) },
        });
      }

      // --- Chrome and Firefox on iOS. ---
      //
      // Apple's App Store rules require every iOS browser to use the system WebKit, so
      // Chrome for iOS reports `CriOS` and Firefox for iOS reports `FxiOS`. A string
      // that says `iPhone` and `Chrome/` is describing a build that Apple does not
      // permit to exist.
      const isApplePhone = lower.includes("iphone") || lower.includes("ipad") || lower.includes("ipod");
      if (isApplePhone && lower.includes("chrome/") && !lower.includes("crios/")) {
        results.push({
          detector: "ua-coherence",
          summary: "User-Agent claims Chrome on an iOS device, which reports CriOS because iOS browsers must use WebKit",
          direction: "bot",
          certainty: "strong",
          weight: 0.6,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { userAgent: ua.raw.slice(0, 200) },
        });
      }
      if (isApplePhone && lower.includes("firefox/") && !lower.includes("fxios/")) {
        results.push({
          detector: "ua-coherence",
          summary: "User-Agent claims Firefox on an iOS device, which reports FxiOS because iOS browsers must use WebKit",
          direction: "bot",
          certainty: "strong",
          weight: 0.6,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { userAgent: ua.raw.slice(0, 200) },
        });
      }

      // --- The preamble. ---
      //
      // Every mainstream browser since Netscape has opened with `Mozilla/5.0`. The
      // check is scoped to strings that claim a browser, so a library sending
      // `MyService/1.0` is left to `self-identified`, which reads it correctly as a
      // bare product token rather than as a browser telling a lie.
      if (claimsBrowser(ua) && !lower.startsWith("mozilla/5.0")) {
        results.push({
          detector: "ua-coherence",
          summary: `User-Agent claims ${ua.browser} but does not open with the Mozilla/5.0 preamble every browser sends`,
          direction: "bot",
          certainty: lower.startsWith("mozilla/") ? "moderate" : "strong",
          weight: lower.startsWith("mozilla/") ? 0.35 : 0.55,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { userAgent: ua.raw.slice(0, 200) },
        });
      }

      // --- A version nothing has shipped. ---
      //
      // A band rather than a ceiling that goes stale: browsers are at 1xx and gain
      // roughly ten majors a year, so 400 is comfortably beyond anything real for the
      // next two decades, and a zero major is a template somebody forgot to fill in.
      //
      // Safari is excluded, and the reason is a genuine trap. Its product token
      // carries the *WebKit build* — `Safari/605.1.15` — while the marketing version
      // lives in a separate `Version/18.7` token, so the number this parser reads for
      // Safari is six hundred and something on every Mac and iPhone on the internet.
      // The corpus caught it: every Safari case scored 28 for owning a version that
      // "has never shipped".
      const major = ua.majorVersion;
      const versionIsMarketing = ua.browser !== undefined && ua.browser !== "safari";
      if (claimsBrowser(ua) && versionIsMarketing && major !== undefined && (major === 0 || major > 400)) {
        results.push({
          detector: "ua-coherence",
          summary: `User-Agent reports ${ua.browser} version ${major}, which no release has ever carried`,
          direction: "bot",
          certainty: "moderate",
          weight: 0.4,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { browser: ua.browser, majorVersion: major },
        });
      }

      // --- A browser version its stated platform never received. ---
      const stranded = strandedRelease(lower, ua.browser, major);
      if (stranded !== undefined) {
        results.push({
          detector: "ua-coherence",
          summary: stranded.summary,
          direction: "bot",
          // Deliberately the weakest thing this detector emits. The vendor stopped
          // shipping; third-party forks did not, and the people running them are
          // people.
          certainty: "moderate",
          weight: 0.3,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { ...stranded.metadata, note: "Forks such as Supermium and Thorium ship current Chromium on retired Windows releases" },
        });
      }

      // --- Structural damage. ---
      //
      // A UA assembled by string concatenation, or truncated by something in the
      // middle, tends to leave the parentheses unbalanced. Real clients never do, but
      // an intermediary that truncates a long header can produce it for a real
      // browser, so this is a nudge.
      // A string that hit the parser's length cap was truncated by us, so its
      // parentheses are unbalanced by our own doing.
      if (ua.raw.length < MAX_USER_AGENT_LENGTH && unbalanced(ua.raw)) {
        results.push({
          detector: "ua-coherence",
          summary: "User-Agent has unbalanced parentheses, the mark of a string assembled or truncated in transit",
          direction: "bot",
          certainty: "weak",
          weight: 0.2,
          botClass: "impersonator",
          family: "ua-rewritten",
          metadata: { userAgent: ua.raw.slice(0, 200) },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

/**
 * Operating systems the string names, at most one of which can be true.
 *
 * The overlaps are the whole difficulty. Android User-Agents contain `Linux`, and iOS
 * User-Agents contain `like Mac OS X` — so a naive scan for platform words reports a
 * contradiction on every phone on the internet. Each family below is therefore
 * recognised by a token the others do not carry, and the more specific families are
 * tested first.
 */
function platformTokens(lower: string): string[] {
  const found: string[] = [];
  if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ipod")) found.push("iOS");
  if (lower.includes("android")) found.push("Android");
  if (lower.includes("windows nt") || lower.includes("windows phone")) found.push("Windows");
  // `Macintosh` rather than `Mac OS X`: iOS says "CPU iPhone OS 17_0 like Mac OS X",
  // and Android never says either. Safari on an iPad in desktop mode sends the
  // Macintosh string *without* an iPad token, so the pair cannot collide there.
  if (lower.includes("macintosh")) found.push("macOS");
  return found;
}

interface StrandedRelease {
  summary: string;
  metadata: Record<string, unknown>;
}

/**
 * A browser major version paired with a platform release that never received it.
 *
 * Only the two transitions that are documented, dated and enormous are encoded here.
 * A table of every vendor's support matrix would be a maintenance burden that goes
 * quietly wrong, and "quietly wrong" in this library means accusing somebody.
 */
function strandedRelease(lower: string, browser: string | undefined, major: number | undefined): StrandedRelease | undefined {
  if (major === undefined || !Number.isFinite(major)) return undefined;

  const windowsVersion = readWindowsVersion(lower);
  if (windowsVersion === undefined) return undefined;
  const isChromium = browser === "chrome" || browser === "chromium" || browser === "edg" || browser === "opr";

  // Windows XP and Vista: Chrome stopped at 49 in April 2016, Firefox at 52 ESR.
  if (windowsVersion <= 6.0) {
    if (isChromium && major > 49) {
      return {
        summary: `User-Agent claims Chromium ${major} on Windows ${windowsVersion === 6.0 ? "Vista" : "XP"}, which Google last supported at version 49`,
        metadata: { browser, majorVersion: major, windowsVersion },
      };
    }
    if (browser === "firefox" && major > 52) {
      return {
        summary: `User-Agent claims Firefox ${major} on Windows ${windowsVersion === 6.0 ? "Vista" : "XP"}, which Mozilla last supported at 52 ESR`,
        metadata: { browser, majorVersion: major, windowsVersion },
      };
    }
    return undefined;
  }

  // Windows 7 and 8.x: Chrome stopped at 109 in January 2023, Firefox at 115 ESR.
  if (windowsVersion <= 6.3) {
    if (isChromium && major > 109) {
      return {
        summary: `User-Agent claims Chromium ${major} on Windows ${windowsVersion === 6.1 ? "7" : "8"}, which Google last supported at version 109`,
        metadata: { browser, majorVersion: major, windowsVersion },
      };
    }
    if (browser === "firefox" && major > 115) {
      return {
        summary: `User-Agent claims Firefox ${major} on Windows ${windowsVersion === 6.1 ? "7" : "8"}, which Mozilla last supported at 115 ESR`,
        metadata: { browser, majorVersion: major, windowsVersion },
      };
    }
  }

  return undefined;
}

/** Reads the `Windows NT x.y` version as a number, e.g. 6.1 for Windows 7. */
function readWindowsVersion(lower: string): number | undefined {
  const at = lower.indexOf("windows nt ");
  if (at === -1) return undefined;
  const match = /^(\d{1,2})(?:\.(\d))?/.exec(lower.slice(at + 11, at + 17));
  if (match === null) return undefined;
  const value = Number.parseFloat(match[2] === undefined ? match[1]! : `${match[1]}.${match[2]}`);
  return Number.isFinite(value) ? value : undefined;
}

/** Whether the parentheses in a User-Agent close. Bounded scan; never throws. */
function unbalanced(raw: string): boolean {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x28) depth++;
    else if (code === 0x29) {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}
