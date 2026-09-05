import { sendsModernHeaders } from "../internal/ua.js";
import { absenceIsMeaningful } from "./types.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Cross-checks User-Agent Client Hints against the legacy User-Agent string.
 *
 * A real Chromium browser generates both from the same internal state, so they
 * always agree. A client that rewrites one and forgets the other contradicts itself,
 * and a contradiction is visible from a single request with no history, no state and
 * no network call — which makes this one of the cheapest high-value checks there is.
 *
 * **Why none of this is `certain`, despite being a genuine contradiction.** The
 * population that rewrites a User-Agent without touching Client Hints is not only
 * scrapers: it is also every person running a UA-spoofing privacy extension, every
 * enterprise browser with a rewritten UA policy, and every developer with device
 * emulation open. Those are real people, and a `certain` tier that swept them up
 * would make the word meaningless. So these observations score — sometimes heavily —
 * and never block on their own. The lone exception is a hint that *self-declares*
 * headless operation, which is a statement rather than an inference.
 */
export function clientHintsDetector(): Detector {
  return {
    id: "client-hints",
    description: "Cross-checks Sec-CH-UA hints against the User-Agent string for self-contradiction",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const { headers, protocol } = ctx.facts;
      const brandsHeader = headers["sec-ch-ua"];
      const results: Evidence[] = [];
      const claimsChromium = ctx.ua.engine === "blink";

      if (brandsHeader !== undefined) {
        const brands = parseBrandList(brandsHeader);

        // A brand list is client-supplied text, and some automation runtimes leave
        // "HeadlessChrome" in it. That is a declaration, not a deduction.
        const headless = brands.find((brand) => /headless/i.test(brand.name));
        if (headless) {
          results.push({
            detector: "client-hints",
            summary: `Sec-CH-UA brand list names "${headless.name}"`,
            direction: "bot",
            certainty: "certain",
            botClass: "automation",
            deterministicBasis: "The client's own Client Hints brand list states that it is a headless browser build. As with a self-declaring User-Agent, believing the client's statement about itself cannot misclassify an honest client.",
            metadata: { brands: brands.map((brand) => brand.name) },
          });
        }

        if (!claimsChromium) {
          results.push({
            detector: "client-hints",
            summary: `Sec-CH-UA present but User-Agent claims ${ctx.ua.browser ?? "a non-Chromium client"}, which does not send it`,
            direction: "bot",
            certainty: "strong",
            weight: 0.65,
            botClass: "impersonator",
            family: "ua-rewritten",
              metadata: { brands: brands.map((brand) => brand.name), userAgentBrowser: ctx.ua.browser },
          });
        } else {
          const versionConflict = findVersionConflict(brands, ctx.ua.majorVersion);
          if (versionConflict) {
            results.push({
              detector: "client-hints",
              summary: versionConflict,
              direction: "bot",
              certainty: "strong",
              weight: 0.6,
              botClass: "impersonator",
              family: "ua-rewritten",
              metadata: { brands: brands.map((brand) => `${brand.name}/${brand.version}`), userAgentVersion: ctx.ua.majorVersion },
            });
          }
        }

        const platform = headers["sec-ch-ua-platform"];
        if (platform !== undefined && ctx.ua.os !== undefined) {
          const hinted = normalizePlatform(platform);
          if (hinted !== undefined && hinted !== ctx.ua.os) {
            results.push({
              detector: "client-hints",
              summary: `Sec-CH-UA-Platform says ${hinted} but the User-Agent describes ${ctx.ua.os}`,
              direction: "bot",
              certainty: "strong",
              weight: 0.7,
              botClass: "impersonator",
              family: "ua-rewritten",
              metadata: { hintedPlatform: hinted, userAgentOs: ctx.ua.os },
            });
          }
        }

        // `Sec-CH-UA-Full-Version-List` is the high-entropy twin of `Sec-CH-UA`,
        // sent once a server has advertised `Accept-CH`. It carries the same brands
        // with complete version numbers, from the same internal state — so it agrees
        // with the User-Agent in a real browser, and a client that rewrote one header
        // and not the other contradicts itself twice.
        const fullList = headers["sec-ch-ua-full-version-list"];
        if (fullList !== undefined && claimsChromium) {
          const fullConflict = findVersionConflict(parseBrandList(fullList), ctx.ua.majorVersion);
          if (fullConflict) {
            results.push({
              detector: "client-hints",
              summary: fullConflict.replace("Sec-CH-UA", "Sec-CH-UA-Full-Version-List"),
              direction: "bot",
              certainty: "strong",
              weight: 0.6,
              botClass: "impersonator",
              family: "ua-rewritten",
              metadata: { header: "sec-ch-ua-full-version-list", userAgentVersion: ctx.ua.majorVersion },
            });
          }
        }

        // `Sec-CH-UA-Model` is the device model, and Chromium sends a non-empty value
        // on Android and on nothing else — a desktop reports `""`. A populated model
        // beside a desktop platform is two answers to the same question.
        //
        // The neighbouring high-entropy hints are deliberately *not* cross-checked.
        // `Sec-CH-UA-Arch` and `-Bitness` describe the real machine while the
        // User-Agent's architecture tokens have been frozen for years — Chrome on
        // Apple Silicon still says `Intel Mac OS X 10_15_7` — so every honest ARM Mac
        // "contradicts" itself, and a detector that reported it would be reading the
        // freeze rather than the client.
        const model = headers["sec-ch-ua-model"];
        const platformName = headers["sec-ch-ua-platform"] !== undefined ? normalizePlatform(headers["sec-ch-ua-platform"]) : undefined;
        if (model !== undefined && model.replace(/"/g, "").trim().length > 0 && platformName !== undefined && DESKTOP_PLATFORMS.has(platformName)) {
          results.push({
            detector: "client-hints",
            summary: `Sec-CH-UA-Model names a device (${model.replace(/"/g, "").trim().slice(0, 40)}) while Sec-CH-UA-Platform says ${platformName}, which reports no model`,
            direction: "bot",
            certainty: "moderate",
            botClass: "impersonator",
            family: "ua-rewritten",
            metadata: { model: model.slice(0, 60), platform: platformName },
          });
        }

        const mobileHint = headers["sec-ch-ua-mobile"];
        if (mobileHint !== undefined) {
          const hintsMobile = mobileHint.trim() === "?1";
          // The `Mobile` product token, not the operating system name. Chromium adds
          // `Mobile` on phones and omits it on tablets, and sets `Sec-CH-UA-Mobile`
          // from the same state — so an Android *tablet* correctly reports `?0` while
          // its User-Agent still says Android. Testing for the OS instead of the token
          // reported a contradiction on every Android tablet on the web.
          const uaMobile = /\bmobile\b/i.test(ctx.ua.lower) || ctx.ua.lower.includes("iphone");
          if (hintsMobile !== uaMobile) {
            results.push({
              detector: "client-hints",
              summary: `Sec-CH-UA-Mobile says ${hintsMobile ? "mobile" : "desktop"} but the User-Agent says the opposite`,
              direction: "bot",
              certainty: "moderate",
              botClass: "impersonator",
              family: "ua-rewritten",
              metadata: { hint: mobileHint, userAgent: ctx.ua.raw.slice(0, 160) },
            });
          }
        }
      } else if (absenceIsMeaningful(ctx) && sendsModernHeaders(ctx.ua) && claimsChromium && protocol === "https" && (ctx.ua.majorVersion ?? 0) >= 89) {
        // Chromium has sent low-entropy hints on secure connections since v89. Their
        // absence is not a protocol violation — an intermediary can strip them, and
        // the header is omitted on plaintext — but on HTTPS it is a strong tell.
        results.push({
          detector: "client-hints",
          summary: `User-Agent claims Chromium ${ctx.ua.majorVersion} over HTTPS but sent no Sec-CH-UA hints`,
          direction: "bot",
          certainty: "strong",
          weight: 0.6,
          botClass: "impersonator",
          // The same intermediary that strips these strips the Fetch Metadata group
          // and the negotiation headers; see `Evidence.family`.
          family: "stripped-headers",
          metadata: { browser: ctx.ua.browser, majorVersion: ctx.ua.majorVersion },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

/** Platforms whose Chromium builds report an empty `Sec-CH-UA-Model`. */
const DESKTOP_PLATFORMS: ReadonlySet<string> = new Set(["windows", "macos", "linux", "chromeos"]);

interface Brand {
  name: string;
  version: string;
}

/** Parses `"Chromium";v="122", "Not(A:Brand";v="24"` into brand/version pairs. */
function parseBrandList(value: string): Brand[] {
  const brands: Brand[] = [];
  // Bounded: a hostile client can send a very long header, and this runs per request.
  const source = value.length > 512 ? value.slice(0, 512) : value;
  const pattern = /"((?:[^"\\]|\\.){0,64})"\s*;\s*v\s*=\s*"([^"]{0,16})"/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    brands.push({ name: match[1]!, version: match[2]! });
    if (brands.length >= 12) break;
  }
  return brands;
}

/**
 * Chromium's "GREASE" brand — a deliberately nonsensical entry browsers include so
 * that servers cannot hard-code the brand list. Ignoring it is required for
 * correctness, not an optimisation.
 */
function isGrease(name: string): boolean {
  return /not[^a-z0-9]*a[^a-z0-9]*brand/i.test(name) || /^\s*$/.test(name);
}

function findVersionConflict(brands: Brand[], uaMajor: number | undefined): string | undefined {
  if (uaMajor === undefined || !Number.isFinite(uaMajor)) return undefined;
  const real = brands.filter((brand) => !isGrease(brand.name));
  if (real.length === 0) return undefined;
  // A real Chromium reports the same major version in every non-GREASE brand.
  const agrees = real.some((brand) => Number.parseInt(brand.version, 10) === uaMajor);
  if (agrees) return undefined;
  return `Sec-CH-UA reports version ${real.map((brand) => brand.version).join("/")} but the User-Agent claims ${uaMajor}`;
}

function normalizePlatform(header: string): string | undefined {
  const value = header.replace(/"/g, "").trim().toLowerCase();
  switch (value) {
    case "windows":
      return "windows";
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    case "android":
      return "android";
    case "ios":
      return "ios";
    case "chrome os":
    case "chromeos":
      return "chromeos";
    default:
      // "Unknown" and anything unrecognised: no claim, so nothing to contradict.
      return undefined;
  }
}
