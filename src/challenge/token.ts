import { base64UrlDecode, base64UrlEncode, constantTimeEqual, randomId, sign } from "../internal/crypto.js";

/**
 * Signed, stateless tokens.
 *
 * Everything here is **signed and not encrypted**, and that is a deliberate,
 * documented choice rather than an omission. The client can read every claim, so
 * nothing secret may ever go in one — no user id, no email, no internal path. What
 * the signature buys is integrity: the client cannot change the expiry, cannot move
 * a token to a different actor, and cannot mint one.
 *
 * Key rotation is built in. `secrets[0]` signs; every entry verifies. To rotate,
 * prepend the new secret and keep the old one for at least one token lifetime, then
 * drop it.
 */

export interface ClearanceClaims {
  v: 1;
  /** Actor this token is bound to. A token stolen from one actor is invalid for another. */
  sub: string;
  /** Issued-at, ms since epoch. */
  iat: number;
  /** Expiry, ms since epoch. */
  exp: number;
  /** Unique id, so a solution can be spent exactly once. */
  jti: string;
  /** What was actually demonstrated. See {@link ClearanceLevel}. */
  lvl: ClearanceLevel;
}

/**
 * What a clearance token proves — and, just as importantly, what it does not.
 *
 * - `pow` — the client ran JavaScript, has WebCrypto, and spent measurable CPU. This
 *   rules out cheap stateless scrapers. It does **not** prove a person is present: a
 *   headless browser solves a proof of work exactly as well as a human's laptop, only
 *   paying for the electricity. Treat it as a cost imposed, not as an identity.
 * - `interaction` — a trusted input event was observed. Stronger, still forgeable by
 *   a driven browser.
 * - `operator` — your own application asserted this is a human, e.g. an authenticated
 *   session. The only level this library treats as conclusive, because the assertion
 *   comes from you rather than from the client.
 */
export type ClearanceLevel = "pow" | "interaction" | "operator";

export interface ChallengeClaims {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  /** Random value the proof of work is computed over. */
  nonce: string;
  /** Required leading zero bits in the digest. */
  diff: number;
}

export type TokenVerification<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "wrong-actor" };

/** Longest token we will parse. A signed blob this size is already far past anything legitimate. */
const MAX_TOKEN_LENGTH = 2048;

export function issueToken<T extends object>(payload: T, secrets: readonly string[]): string {
  const secret = secrets[0];
  if (secret === undefined) throw new Error("At least one signing secret is required to issue a token");
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verifies signature and expiry.
 *
 * The order matters and is not arbitrary: the signature is checked *before* the
 * claims are trusted for anything. Reading `exp` from an unverified token to decide
 * whether to bother checking the signature is a classic way to turn a signed token
 * into an unsigned one.
 */
export function verifyToken<T extends { exp: number; sub: string }>(
  token: string,
  secrets: readonly string[],
  now: number,
  expectedSubject?: string | readonly string[],
): TokenVerification<T> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return { ok: false, reason: "malformed" };

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Every configured secret is tried, and each comparison is constant-time. Trying
  // them all on failure also keeps the timing of a bad signature independent of how
  // many keys are mid-rotation.
  let valid = false;
  for (const secret of secrets) {
    if (constantTimeEqual(signature, sign(body, secret))) valid = true;
  }
  if (!valid) return { ok: false, reason: "bad-signature" };

  let payload: T;
  try {
    const decoded = base64UrlDecode(body).toString("utf8");
    payload = JSON.parse(decoded) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "malformed" };
  if (typeof payload.exp !== "number" || typeof payload.sub !== "string") return { ok: false, reason: "malformed" };
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  // A list rather than a single value because the subject is derived under a secret,
  // and mid-rotation an actor legitimately has one subject per configured secret. Every
  // candidate is compared, without an early exit, so the time taken does not reveal
  // which key a token was minted under.
  if (expectedSubject !== undefined) {
    let bound = false;
    for (const candidate of typeof expectedSubject === "string" ? [expectedSubject] : expectedSubject) {
      if (constantTimeEqual(payload.sub, candidate)) bound = true;
    }
    if (!bound) return { ok: false, reason: "wrong-actor" };
  }

  return { ok: true, payload };
}

export function newChallenge(subject: string, difficulty: number, ttlMs: number, now: number): ChallengeClaims {
  return { v: 1, sub: subject, iat: now, exp: now + ttlMs, nonce: randomId(12), diff: difficulty };
}

export function newClearance(subject: string, level: ClearanceLevel, ttlMs: number, now: number): ClearanceClaims {
  return { v: 1, sub: subject, iat: now, exp: now + ttlMs, jti: randomId(9), lvl: level };
}
