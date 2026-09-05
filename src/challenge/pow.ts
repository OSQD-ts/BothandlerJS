import { createHash } from "node:crypto";

/**
 * Proof of work.
 *
 * The client must find a counter such that `SHA-256(nonce + ":" + counter)` begins
 * with `difficulty` zero bits. Verification is one hash; solving takes on average
 * `2^difficulty` of them.
 *
 * **What this actually buys, stated plainly.** It does not identify anyone and it
 * does not prove a human is present — a headless Chrome solves it as readily as a
 * person's phone, just paying for the CPU. What it does is convert a scrape from
 * free into merely cheap, and change the shape of the attack: a stateless scraper
 * pulling a million pages must now run a JavaScript engine and burn CPU on every
 * single one. That is often enough to make bulk extraction not worth doing, and it
 * costs a real visitor a fraction of a second, once.
 *
 * Difficulty is in *bits*, so each step doubles the work. The default of 16 is around
 * 65k hashes — tens of milliseconds in any modern browser. Past about 20 you are
 * charging real people a visible delay, and the oldest and slowest devices — which
 * disproportionately belong to the users least able to replace them — pay the most.
 */

/** Default difficulty in leading zero bits. ~65k hashes; a few tens of ms in a browser. */
export const DEFAULT_DIFFICULTY = 16;
/** Refuse to issue beyond this. Above it the wait becomes a usability problem for real visitors. */
export const MAX_DIFFICULTY = 24;

export function countLeadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** True when `solution` satisfies the challenge. One hash — cheap enough for the request path. */
export function verifyProofOfWork(nonce: string, solution: string, difficulty: number): boolean {
  // Bound the input: `solution` is attacker-supplied and would otherwise let a
  // client make the server hash an arbitrarily large buffer.
  if (solution.length === 0 || solution.length > 64) return false;
  if (!/^[0-9]+$/.test(solution)) return false;
  const digest = createHash("sha256").update(`${nonce}:${solution}`, "utf8").digest();
  return countLeadingZeroBits(digest) >= difficulty;
}

/**
 * Solves a challenge. Present for tests, examples and load simulation — the real
 * solver is the browser-side script, and no server-side path calls this.
 */
export function solveProofOfWork(nonce: string, difficulty: number, maxIterations = 50_000_000): string | undefined {
  for (let counter = 0; counter < maxIterations; counter++) {
    const digest = createHash("sha256").update(`${nonce}:${counter}`, "utf8").digest();
    if (countLeadingZeroBits(digest) >= difficulty) return String(counter);
  }
  return undefined;
}

export function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return DEFAULT_DIFFICULTY;
  return Math.min(MAX_DIFFICULTY, Math.max(1, Math.round(difficulty)));
}
