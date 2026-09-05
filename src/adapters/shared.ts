import type { IncomingMessage } from "node:http";
import type { ActionOutcome } from "../actions/types.js";

/** Largest challenge-solution body we will read. A solution is a few hundred bytes. */
export const MAX_VERIFY_BODY = 4096;

/**
 * Waits, with the timer unreferenced.
 *
 * The `unref` is what stops a pending `delay` action from holding a process open at
 * shutdown — which in a serverless runtime is the difference between a request that
 * finishes and an invocation that is billed until it is killed.
 */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/** True when the outcome means the request should reach the application. */
export function isContinue(outcome: ActionOutcome): outcome is Extract<ActionOutcome, { kind: "continue" }> {
  return outcome.kind === "continue";
}

/**
 * Parses a JSON body defensively.
 *
 * Returns `undefined` rather than throwing on anything malformed. This parses input
 * from a client that is, by construction, already under suspicion.
 */
export function parseJson(text: string): unknown {
  if (text.length === 0 || text.length > MAX_VERIFY_BODY) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads at most {@link MAX_VERIFY_BODY} bytes from a Node request stream.
 *
 * The cap is enforced by destroying the socket rather than by buffering and then
 * discarding: a client that keeps sending after the limit is spending its own
 * bandwidth against a buffer that stopped growing. Errors resolve to an empty string,
 * because a malformed submission is a rejected challenge, not an exception.
 */
export function readBoundedBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_VERIFY_BODY) {
        request.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    request.on("end", () => resolve(data));
    request.on("error", () => resolve(""));
  });
}

/** The JSON body of a challenge verification response, shared by every adapter. */
export function verificationBody(outcome: { ok: true } | { ok: false; reason: string }): string {
  return JSON.stringify(outcome.ok ? { ok: true } : { ok: false, error: outcome.reason });
}
