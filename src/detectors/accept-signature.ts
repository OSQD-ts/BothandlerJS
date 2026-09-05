import { claimsBrowser } from "../internal/ua.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/** RFC 9110 language-range list: `en-US,en;q=0.9,fr;q=0.8`, plus the `*` wildcard. */
const LANGUAGE_LIST = /^\s*(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)(?:\s*;\s*q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?(?:\s*,\s*(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)(?:\s*;\s*q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?)*\s*$/;

/**
 * Reads the content-negotiation headers as a signature of the client.
 *
 * A browser asking for a page sends a long, specific `Accept` describing the
 * document formats it renders. A scraper asks for `*/ /*` because it will take
 * whatever arrives. Similarly, a browser's `Accept-Language` reflects a real
 * language preference list; automation tends to send a single bare tag or a value
 * that is not valid grammar at all.
 *
 * All moderate-to-strong, never certain. Content negotiation is exactly the sort of
 * thing an intermediary rewrites, and plenty of legitimate integrations against your
 * own site send `*/ /*` on purpose.
 */
export function acceptSignatureDetector(): Detector {
  return {
    id: "accept-signature",
    description: "Reads Accept and Accept-Language as a fingerprint of the client's content negotiation",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      if (!claimsBrowser(ctx.ua)) return undefined;
      const { headers } = ctx.facts;
      const results: Evidence[] = [];

      const accept = headers["accept"];
      if (accept !== undefined) {
        const destination = headers["sec-fetch-dest"];
        const isDocument = destination === "document";
        const wildcardOnly = accept.trim() === "*/*";

        // `Accept: */*` is *correct* for a fetch() or an XHR, and page script sends
        // millions of those. Firing on it penalised every single-page application on
        // the web for behaving exactly as specified. Where the destination header
        // tells us this is not a navigation, there is nothing here to report.
        const nonDocumentContext = destination !== undefined && !isDocument;

        if (wildcardOnly && !nonDocumentContext) {
          results.push({
            detector: "accept-signature",
            summary: isDocument
              ? "Navigation request claiming a browser sent Accept: */* — browsers send an explicit document format list"
              : "Client claiming a browser sent Accept: */* with no Fetch Metadata to explain it",
            direction: "bot",
            certainty: isDocument ? "strong" : "weak",
            ...(isDocument ? { weight: 0.65 } : {}),
            botClass: "impersonator",
            metadata: { accept, secFetchDest: destination ?? null },
          });
        } else if (isDocument && !accept.includes("text/html")) {
          results.push({
            detector: "accept-signature",
            summary: `Navigation request does not accept text/html: "${accept.slice(0, 60)}"`,
            direction: "bot",
            certainty: "strong",
            weight: 0.6,
            botClass: "impersonator",
            metadata: { accept: accept.slice(0, 120) },
          });
        }
      }

      const language = headers["accept-language"];
      if (language !== undefined && language.length > 0) {
        if (language.length > 256 || !LANGUAGE_LIST.test(language)) {
          results.push({
            detector: "accept-signature",
            summary: `Accept-Language is not a valid language-range list: "${language.slice(0, 60)}"`,
            direction: "bot",
            certainty: "moderate",
            botClass: "impersonator",
            metadata: { acceptLanguage: language.slice(0, 120) },
          });
        } else if (!language.includes(",") && !language.includes(";")) {
          // A single bare tag with no quality values. Browsers ship a fallback chain
          // by default; a lone `en-US` is the shape a hard-coded client sends.
          results.push({
            detector: "accept-signature",
            summary: `Accept-Language is a single bare tag ("${language.trim()}") with no fallback chain`,
            direction: "bot",
            certainty: "weak",
            botClass: "impersonator",
            metadata: { acceptLanguage: language.trim() },
          });
        }
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
