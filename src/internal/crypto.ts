import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing and comparison primitives for clearance tokens.
 *
 * Two rules govern everything in this file. Tokens are signed, never encrypted —
 * their contents are readable by the client and must contain nothing secret. And
 * every comparison of a secret-derived value goes through {@link constantTimeEqual},
 * because a token verifier is exactly the kind of oracle a timing attack likes.
 */

export function base64UrlEncode(input: Uint8Array | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buffer.toString("base64url");
}

export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** HMAC-SHA256, returned as base64url. */
export function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/**
 * Constant-time string comparison. Falls back to a `false` return on
 * length mismatch — the length of a signature is not a secret, so leaking it is
 * fine, and `timingSafeEqual` throws on unequal lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Bytes drawn from the CSPRNG in bulk.
 *
 * `randomBytes` is a syscall-backed call, and at roughly three microseconds it was
 * the most expensive single operation in assessing a request — more than every
 * detector put together. Drawing 4 KB at a time and handing out slices amortises that
 * over several hundred ids.
 *
 * This is a batching change, not a weakening one: the bytes still come from the same
 * CSPRNG, no byte is ever handed out twice, and the pool is refilled rather than
 * cycled. Node's `child_process`/`cluster` spawn re-executes the module, so a worker
 * never inherits a parent's partially-consumed pool the way a real `fork(2)` would.
 */
const POOL_BYTES = 4096;
let pool = randomBytes(POOL_BYTES);
let poolOffset = 0;

/** URL-safe random id. 16 bytes is 128 bits — collision-free for request ids and nonces. */
export function randomId(bytes = 16): string {
  if (bytes > POOL_BYTES) return randomBytes(bytes).toString("base64url");
  if (poolOffset + bytes > POOL_BYTES) {
    pool = randomBytes(POOL_BYTES);
    poolOffset = 0;
  }
  const id = pool.toString("base64url", poolOffset, poolOffset + bytes);
  poolOffset += bytes;
  return id;
}

/**
 * SHA-256 truncated to 128 bits, base64url. Used to derive stable, non-reversible
 * keys from values we do not want to store in the clear (IP-based actor keys when
 * `hashActorKeys` is on, header-order fingerprints).
 */
export function shortHash(value: string, secret = ""): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url").slice(0, 22);
}
