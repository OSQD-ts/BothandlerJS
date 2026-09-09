import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * What the marker cookie said about a client across its requests.
 *
 * These three read the same observation from three angles, and none of them can say
 * anything at all unless `probe` is configured — a marker nobody issued is a marker
 * nobody can fail to return. When the probe is off they return `undefined` on every
 * request, which is the correct answer rather than a silent failure: absence of a
 * marker is absence of information.
 *
 * See `docs/detection/correlation.md` for why a marker exists and what it costs.
 */

export interface IdentityDriftOptions {
  /** Report a platform-only or language-only change. Default true, at `moderate`. */
  reportSoftDrift?: boolean;
}

/**
 * One client, two identities.
 *
 * This is the detector this library could not previously write. Correlating by address
 * cannot distinguish "a client that claimed to be Chrome and then curl" from "two
 * people behind one office connection", and guessing between them would either miss
 * every rotation or accuse every shared network. A marker removes the ambiguity: both
 * requests carried an HMAC only this server can produce, so they came from one client,
 * and that client described itself two different ways.
 *
 * **The parts are weighed separately, because they are not equally suspicious.**
 * A browser family that changes — Chrome to curl, Firefox to Googlebot — has no benign
 * reading; software does not change what it is. A *platform* that changes does have
 * one, and it is common: "Request desktop site" on a phone rewrites the User-Agent to
 * claim a desktop, and the person doing it is a person. Language changes when someone
 * changes their language. So the family carries the weight and the rest is reported
 * softly, which is the difference between catching a rotation and blaming a visitor for
 * using a browser feature.
 */
export function identityDriftDetector(options: IdentityDriftOptions = {}): Detector {
  const reportSoft = options.reportSoftDrift ?? true;

  return {
    id: "identity-drift",
    description: "Compares the identity a client claims now with the one it claimed when it was given its marker",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const drift = ctx.marker?.drift;
      if (drift === undefined) return undefined;

      if (drift.browser) {
        return {
          detector: "identity-drift",
          summary: "Client is holding a marker this server issued to a different browser, so one of the two identities it has claimed is false",
          direction: "bot",
          certainty: "strong",
          botClass: "impersonator",
        };
      }

      if (!reportSoft || !(drift.platform || drift.language)) return undefined;
      const what = drift.platform && drift.language ? "platform and language" : drift.platform ? "platform" : "language";
      return {
        detector: "identity-drift",
        // Named precisely, because the operator reading this needs to know it is the
        // soft case: a person switching to the desktop site produces exactly this.
        summary: `Client's claimed ${what} changed while holding one marker, which a person can also do deliberately`,
        direction: "bot",
        certainty: "moderate",
        botClass: "unknown",
      };
    },
  };
}

export interface MarkerIntegrityOptions {
  /** Ignored below this many forged presentations. Default 1. */
  minForgeries?: number;
}

/**
 * A marker that this server did not sign.
 *
 * Browsers do not edit their cookies. A marker that fails its HMAC was altered by
 * whoever was holding it, and the only reason to alter an opaque signed value is to
 * find out what the server does with a different one — which is what a scanner does and
 * what a person browsing does not.
 *
 * **Why this stops at `strong`.** `certain` in this library means no benign explanation
 * exists, and one does, thinly: a middlebox or a broken cookie jar can truncate or
 * re-encode a value in transit. It is rare, it is not the client's fault, and it should
 * cost a challenge rather than a door.
 */
export function markerIntegrityDetector(options: MarkerIntegrityOptions = {}): Detector {
  const minForgeries = options.minForgeries ?? 1;

  return {
    id: "marker-integrity",
    description: "Reports a marker cookie presented with a signature this server could not have produced",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      if (ctx.marker?.reading.kind !== "forged") return undefined;
      const { forged } = ctx.state.markers;
      if (forged < minForgeries) return undefined;
      return {
        detector: "marker-integrity",
        summary:
          forged > 1
            ? `Presented a marker cookie this server never signed, ${forged} times`
            : "Presented a marker cookie this server never signed",
        direction: "bot",
        certainty: "strong",
        botClass: "scanner",
      };
    },
  };
}

export interface MarkerPersistenceOptions {
  /** Markers handed out with none returned before this says anything. Default 5. */
  minIssued?: number;
}

/**
 * A client that keeps cookies, but never ours.
 *
 * The obvious version of this detector reports any client that is handed a marker and
 * never returns one — and that version is worth almost nothing, because
 * `session-integrity` already reports a client that sends no cookie at all, and it does
 * so with a better-calibrated weight. Two moderate signals for one observation is a
 * double count, and the population it lands on is people who block cookies. Measured on
 * the corpus, the overlapping version took `cookies-blocked` from 21 to 38 and put +24
 * on five ordinary browsing sessions.
 *
 * So this asks the narrower question the marker can uniquely answer: the client is
 * *demonstrably* keeping cookies — it sent some — and ours is not among them. A browser
 * with a cookie jar puts every first-party cookie in it; a scraper replaying a captured
 * session header sends the one cookie it was told to and stores nothing new.
 *
 * **Why `moderate` and never more.** A marker can go missing for reasons that are the
 * operator's fault rather than the client's: `secure: true` on a page served over plain
 * HTTP is never stored at all, and a `domain` that does not match the host is not sent
 * back. Both would produce this for every visitor, which is exactly why it may never
 * deny anybody on its own. Verified crawlers are never issued a marker, so they never
 * appear here.
 */
export function markerPersistenceDetector(options: MarkerPersistenceOptions = {}): Detector {
  const minIssued = options.minIssued ?? 5;

  return {
    id: "marker-persistence",
    description: "Reports a client that has been handed a marker repeatedly and has never returned one",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      if (ctx.marker === undefined) return undefined;
      // A client sending nothing at all is `session-integrity`'s business, not this
      // one's: without a cookie jar there is nothing here that the older signal has not
      // already said, at a weight chosen for the people who produce it.
      if (ctx.facts.headers["cookie"] === undefined) return undefined;
      const { issued, returned } = ctx.state.markers;
      if (returned > 0 || issued < minIssued) return undefined;
      return {
        detector: "marker-persistence",
        summary: `Sends cookies but has never returned the one this server set, across ${issued} responses that offered it`,
        direction: "bot",
        certainty: "moderate",
        botClass: "http-client",
        // The same cause `session-integrity` reports when it sees no cookie at all: one
        // client that does not keep state. Without this they are two moderate signals
        // for one observation, and the population that produces it is people who block
        // cookies — so the double count landed squarely on them. Measured on the corpus:
        // it took `cookies-blocked` from 21 to 38 before the family was named.
        family: "no-session",
      };
    },
  };
}

export interface MarkerFanoutOptions {
  /** Distinct networks one marker may be presented from before this says anything. Default 16. */
  minNetworks?: number;
}

/**
 * One client, many networks.
 *
 * A marker comes back only from the client that received it, so a marker presented from
 * sixteen different networks is one client that has moved across sixteen networks. The
 * shape that produces is a scraper on a rotating proxy pool that keeps its cookie jar —
 * which most of them do, because discarding it breaks the sites they are scraping.
 *
 * **Why this is capped at `moderate` and offered no higher.** The honest reading is that
 * this signal cannot separate a proxy pool from a heavily mobile person. A phone on a
 * carrier using CGNAT can be renumbered across a great many `/24`s in the twelve hours a
 * marker lives, and so can anyone whose employer egresses through a rotating pool. Those
 * are people. The count is real and it is worth combining with everything else, and it
 * is never worth denying somebody on by itself.
 *
 * The counting is per process and bounded, so across replicas each sees only its share.
 * That direction is deliberate: it undercounts, and undercounting says nothing where
 * overcounting would accuse somebody.
 */
export function markerFanoutDetector(options: MarkerFanoutOptions = {}): Detector {
  const minNetworks = options.minNetworks ?? 16;

  return {
    id: "marker-fanout",
    description: "Counts the distinct networks one marker cookie has been presented from",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const networks = ctx.marker?.networks ?? 0;
      if (networks < minNetworks) return undefined;
      return {
        detector: "marker-fanout",
        summary: `One client has presented the same marker from ${networks} different networks`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scraper",
      };
    },
  };
}
