import { issueToken, verifyToken } from "../challenge/token.js";
import { randomId } from "../internal/crypto.js";
import { serializeCookie } from "../internal/http.js";
import type { RequestFacts } from "../types.js";
import type { ParsedUserAgent } from "../internal/ua.js";

/**
 * A marker the client carries, so its requests can be read as a series.
 *
 * Everything else in this library correlates requests by **actor key**, which is
 * derived from the address. That is the only join available without asking the client
 * to hold anything, and it is wrong in both directions: a household, an office and a
 * mobile carrier put thousands of unrelated people behind one key, while a single
 * scraper on a proxy pool spreads one operator across thousands of keys. The
 * consequence was a detector this library could not write — `identity-rotation`, the
 * client that arrives as Chrome, then as curl, then as Googlebot. From headers alone
 * it is indistinguishable from three people sharing an address, so it was left unbuilt.
 *
 * A signed cookie closes exactly that gap. It is minted by this server, carries an
 * HMAC only this server can produce, and comes back only from the client that received
 * it. Two requests bearing the same marker are the same browser profile — not the same
 * address, not the same network, the same *client* — and that is what makes a change of
 * claimed identity between them evidence rather than speculation.
 *
 * **What is in it, and what is deliberately not.** Tokens here are signed and never
 * encrypted, so the client can read every claim and nothing secret may go in one. The
 * marker holds a random id, the usual validity window, and three short hashes standing
 * for the identity the client claimed when it was issued. The hashes are of data the
 * client sent us in the first place, so they tell it nothing it did not already know,
 * and hashing them keeps the cookie from being a readable fingerprint echoed back on
 * every response.
 *
 * **Why the identity is stored coarsely.** A browser that updates from version 130 to
 * 131 has not changed identity, and a detector that says otherwise would report every
 * visitor in the week after a Chrome release. So the version is excluded and the three
 * parts are kept apart rather than hashed together, because *which* part changed is the
 * difference between a strong signal and a benign one: a browser family that changes
 * from Chrome to curl has no innocent reading, while a platform that changes from
 * iPhone to Mac is what "Request desktop site" does to a real person's phone.
 */

/** Claims inside a marker. `sub` is the marker's own id, not an actor: see below. */
export interface MarkerClaims {
  v: 1;
  /**
   * The marker's own random id.
   *
   * Deliberately *not* the actor. Binding a marker to an address-derived key would
   * invalidate it the moment a phone moved between wifi and cellular, which is the
   * ordinary behaviour of the visitors this is supposed to leave alone — and it would
   * throw away the property that makes the marker worth having, that it identifies a
   * client across exactly those changes.
   */
  sub: string;
  iat: number;
  exp: number;
  /** Browser family, coarse. */
  b: string;
  /** Operating system or platform, coarse. */
  o: string;
  /** Primary language subtag. */
  l: string;
}

/** How the claimed identity looked, reduced to the parts worth comparing. */
export interface IdentityShape {
  b: string;
  o: string;
  l: string;
}

/** Which parts of a claimed identity differ between two requests. */
export interface ShapeDrift {
  browser: boolean;
  platform: boolean;
  language: boolean;
}

/**
 * The claimed identity, reduced to three coarse parts.
 *
 * Stored as short plain text rather than hashed, which is both cheaper and more honest.
 * An earlier version ran each part through an HMAC so the cookie would not carry a
 * "readable fingerprint" — but there is no privacy in hashing a value the client wrote
 * itself and sent to us, in a token the client can already read. It bought nothing and
 * cost three HMACs on every single request, which more than doubled the price of an
 * assessment. Now it costs a `slice`.
 *
 * The version is deliberately absent. A browser updating from 130 to 131 has not changed
 * identity, and a detector that says otherwise reports every visitor in the week after a
 * Chrome release.
 */
export function identityShape(facts: RequestFacts, ua: ParsedUserAgent): IdentityShape {
  const platform = facts.headers["sec-ch-ua-platform"]?.replace(/"/g, "").trim().toLowerCase();
  // The primary subtag only: `en-GB` and `en-US` are one person changing region, and a
  // full `Accept-Language` list reorders itself for reasons that are not identity.
  const language = facts.headers["accept-language"]?.split(",")[0]?.split("-")[0]?.trim().toLowerCase();
  return {
    // A client that names no browser is its own category, and an empty User-Agent must
    // not read as equal to every other empty one by accident — it reads as "none", which
    // is exactly what it is, and changing away from it is a real change.
    b: part(ua.browser ?? (ua.raw.length === 0 ? "none" : `t:${withoutVersions(ua.raw)}`)),
    o: part(ua.os ?? platform ?? "none"),
    l: part(language ?? "none"),
  };
}

/** Short and lower-case, so the cookie stays small and comparisons are exact. */
function part(value: string): string {
  const trimmed = value.length > 40 ? value.slice(0, 40) : value;
  return trimmed.toLowerCase();
}

/**
 * A client's self-description with the version numbers taken out.
 *
 * The version is excluded for a *recognised* browser because updating from 130 to 131 is
 * not a change of identity, and a detector saying otherwise reports every visitor in the
 * week after a Chrome release. Everything unrecognised — a mobile app, a feed reader, an
 * API client, a monitoring agent — was getting the opposite treatment: its whole
 * User-Agent, version and all, so `curl/8.4.0` and `curl/8.5.0` read as two different
 * clients and any auto-updating integration accused itself of impersonation at `strong`
 * the first time it upgraded mid-marker.
 *
 * Numbers become `#`, which keeps the products distinguishable — `Mozilla/5.0
 * (compatible; Foo/1.0)` stays distinct from any other Mozilla-prefixed client — while
 * removing the churn that has nothing to do with identity.
 */
function withoutVersions(raw: string): string {
  return raw.replace(VERSION_NUMBERS, "#");
}

const VERSION_NUMBERS = /\d+(?:[._]\d+)*/g;

/** Which parts changed. All three false means the client looks the same as it did. */
export function driftBetween(issued: IdentityShape, now: IdentityShape): ShapeDrift {
  return { browser: issued.b !== now.b, platform: issued.o !== now.o, language: issued.l !== now.l };
}

export function newMarker(shape: IdentityShape, ttlMs: number, now: number): MarkerClaims {
  return { v: 1, sub: randomId(9), iat: now, exp: now + ttlMs, ...shape };
}

/** The `Set-Cookie` that hands a client its marker. */
export function markerCookie(name: string, claims: MarkerClaims, secrets: readonly string[], options: MarkerCookieOptions): string {
  return serializeCookie(name, issueToken(claims, secrets), {
    maxAgeMs: claims.exp - claims.iat,
    sameSite: options.sameSite ?? "Lax",
    secure: options.secure ?? true,
    // Nothing in a page needs to read this, and a marker readable by script is one a
    // cross-site script can lift.
    httpOnly: true,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
  });
}

export interface MarkerCookieOptions {
  sameSite?: "Strict" | "Lax" | "None";
  secure?: boolean;
  domain?: string;
}

export type MarkerReading =
  /** No marker was presented. */
  | { kind: "absent" }
  /** Presented, signed by us, still valid. */
  | { kind: "valid"; claims: MarkerClaims }
  /** Presented and past its expiry — ordinary, and not evidence of anything. */
  | { kind: "expired" }
  /**
   * Presented, and not something this server signed.
   *
   * The interesting case. A browser does not edit its own cookies, so a marker that
   * fails its signature was changed by whoever is holding it.
   */
  | { kind: "forged" };

/**
 * The shape of a token this server issues: two base64url segments and a dot.
 *
 * Checked before the signature, so that a value which is not even shaped like one of
 * ours is reported as *absent* rather than as forged. The difference matters because
 * `forged` is `strong` evidence: a cookie of the same name set by something else — a
 * sibling host under a shared `domain`, an application that reuses the name — would
 * otherwise make every visitor holding it look like a client editing signed values.
 * Tampering keeps the shape, because tampering means altering what we sent.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function readMarker(value: string | undefined, secrets: readonly string[], now: number): MarkerReading {
  if (value === undefined || value.length === 0) return { kind: "absent" };
  if (!TOKEN_SHAPE.test(value)) return { kind: "absent" };
  const verified = verifyToken<MarkerClaims>(value, secrets, now);
  if (verified.ok) return { kind: "valid", claims: verified.payload };
  // Expiry is separated from tampering because only one of them says anything about
  // the client: a cookie outliving its window is what cookies do.
  return verified.reason === "expired" ? { kind: "expired" } : { kind: "forged" };
}
